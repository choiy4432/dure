import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyShellPath, importShellPath, mergePath, parseShellPath, shellRunner, SHELL_PATH_TIMEOUT_MS } from '../src/main/shellPath'

// mac — Finder 로 켠 두레의 빈약한 PATH 를 로그인 셸의 PATH 로 메운다. 진짜 셸은 띄우지 않는다(run·spawn 을 갈아끼운다)

const S = '__DURE_PATH_START__'
const E = '__DURE_PATH_END__'
const wrap = (p: string) => `${S}${p}${E}`
const PRINTF = `printf "${S}%s${E}" "$PATH"`

afterEach(() => {
  vi.useRealTimers()
})

describe('parseShellPath', () => {
  it('표식_사이만_뽑는다(앞뒤에 .zshrc 잡음)', () => {
    const noisy = `Last login: Mon\n\u001b[1mWelcome\u001b[0m oh-my-zsh\nexport PATH=/fake\n${wrap('/opt/homebrew/bin:/usr/bin:/bin')}\nlogout noise\n${S}`
    expect(parseShellPath(noisy)).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('표식이_없으면_null — 시작만·끝만·사이가 비었음도', () => {
    expect(parseShellPath('')).toBeNull()
    expect(parseShellPath('/usr/bin:/bin')).toBeNull()
    expect(parseShellPath(`${S}/usr/bin`)).toBeNull()
    expect(parseShellPath(`/usr/bin${E}`)).toBeNull()
    expect(parseShellPath(wrap(''))).toBeNull()
  })

  it('줄바꿈·NUL 이 든 값은 믿지 않는다 · 절대 경로가 아닌 칸은 버린다', () => {
    expect(parseShellPath(wrap('/usr/bin\n/bin'))).toBeNull()
    expect(parseShellPath(wrap('/usr/bin\u0000:/bin'))).toBeNull()
    expect(parseShellPath(wrap('.:bin::/usr/bin:~/x:/bin'))).toBe('/usr/bin:/bin')
    expect(parseShellPath(wrap('$PATH'))).toBeNull() // 셸이 펼치지 못함(다른 문법의 셸)
    // 옛 fish 처럼 빈칸으로 이으면 한 칸으로 읽힌다 — fish 는 string join 으로 따로 묻는다(아래)
    expect(parseShellPath(wrap('/usr/bin /bin'))).toBe('/usr/bin /bin')
  })
})

describe('mergePath', () => {
  it('merge_는_셸_것이_앞_중복_없음 — 구분자 :', () => {
    expect(mergePath('/usr/bin:/bin:/usr/sbin:/sbin', '/opt/homebrew/bin:/Users/a/.local/bin:/usr/bin:/bin')).toBe(
      '/opt/homebrew/bin:/Users/a/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    )
    expect(mergePath(undefined, '/a:/b')).toBe('/a:/b')
    expect(mergePath('/a', '/a:/a')).toBe('/a')
    expect(mergePath('/x::/y', null)).toBe('/x:/y')
  })
})

describe('importShellPath', () => {
  it('darwin_아니면_run_을_안_부른다', async () => {
    const run = vi.fn(async () => wrap('/x'))
    expect(await importShellPath({ platform: 'win32', env: { SHELL: '/bin/zsh' }, run })).toBeNull()
    expect(await importShellPath({ platform: 'linux', env: { SHELL: '/bin/zsh' }, run })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it("셸 명령 — $SHELL -ilc 'printf …\"$PATH\"' · 상한 3000ms", async () => {
    expect(SHELL_PATH_TIMEOUT_MS).toBe(3000)
    const run = vi.fn(async () => `noise\n${wrap('/opt/homebrew/bin:/usr/bin')}`)
    expect(await importShellPath({ platform: 'darwin', env: { SHELL: '/bin/bash' }, run })).toBe('/opt/homebrew/bin:/usr/bin')
    expect(run).toHaveBeenCalledWith('/bin/bash', ['-ilc', PRINTF], 3000)
  })

  it('$SHELL 이 없거나 절대 경로가 아니면 /bin/zsh', async () => {
    for (const env of [{}, { SHELL: '' }, { SHELL: 'zsh' }]) {
      const run = vi.fn(async () => wrap('/usr/bin'))
      await importShellPath({ platform: 'darwin', env, run })
      expect(run).toHaveBeenCalledWith('/bin/zsh', ['-ilc', PRINTF], 3000)
    }
  })

  it("fish 는 목록을 string join 으로 ':' 이어 찍는다", async () => {
    const run = vi.fn(async () => wrap('/opt/homebrew/bin:/usr/bin'))
    expect(await importShellPath({ platform: 'darwin', env: { SHELL: '/opt/homebrew/bin/fish' }, run })).toBe('/opt/homebrew/bin:/usr/bin')
    expect(run).toHaveBeenCalledWith('/opt/homebrew/bin/fish', ['-ilc', `printf "${S}%s${E}" (string join : $PATH)`], 3000)
  })

  it('run_이_던지거나_시간_초과면_null — 없는 셸(ENOENT)·표식 없음도', async () => {
    const env = { SHELL: '/bin/zsh' }
    expect(await importShellPath({ platform: 'darwin', env, run: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) } })).toBeNull()
    expect(await importShellPath({ platform: 'darwin', env, run: () => { throw new Error('sync') } })).toBeNull()
    expect(await importShellPath({ platform: 'darwin', env, run: async () => 'zsh: command not found: printf' })).toBeNull()
    // 프로필이 멈춤 — run 이 끝나지 않아도 상한에 null
    vi.useFakeTimers()
    const hung = importShellPath({ platform: 'darwin', env, run: () => new Promise<string>(() => {}) })
    let done: string | null | undefined
    void hung.then((v) => (done = v))
    await vi.advanceTimersByTimeAsync(SHELL_PATH_TIMEOUT_MS - 1)
    expect(done).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBeNull()
  })
})

describe('applyShellPath', () => {
  it('들여온_뒤_process.env_에서_바뀐_열쇠는_PATH_하나 — 셸이 무엇을 찍어도', async () => {
    const before: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/Users/a', SHELL: '/bin/zsh', LANG: 'ko_KR.UTF-8' }
    const env = { ...before }
    // 프로필이 API 키·다른 변수를 찍어도 표식 사이(PATH)만 읽는다
    const run = async () => `ANTHROPIC_API_KEY=sk-ant-xxx\nNODE_OPTIONS=--inspect\n${wrap('/opt/homebrew/bin:/usr/bin')}\nCLAUDE_CODE_USE_BEDROCK=1`
    applyShellPath(env, await importShellPath({ platform: 'darwin', env, run }))
    const changed = Object.keys({ ...before, ...env }).filter((k) => before[k] !== env[k])
    expect(changed).toEqual(['PATH'])
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('들여온 것이 없으면(null) 아무것도 안 바꾼다', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/x::/y' }
    applyShellPath(env, null)
    expect(env).toEqual({ PATH: '/x::/y' })
  })
})

describe('shellRunner — 기본 run', () => {
  function fakeChild() {
    return Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), kill: vi.fn() })
  }

  it('새 프로세스 그룹으로(detached) · 입력 없음 · stderr 는 버린다 — 표식 없이 닫히면 그때까지의 stdout', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const kill = vi.fn(async () => {})
    const env = { HOME: '/Users/a' }
    const p = shellRunner({ spawn: spawn as any, kill, env })('/bin/zsh', ['-ilc', 'x'], 3000)
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-ilc', 'x'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env })
    child.stdout.write('noise ')
    child.stdout.write(`${S}/a`) // 끝 표식이 오지 않음(printf 가 없는 셸 등)
    child.stdout.end()
    await new Promise((r) => setImmediate(r))
    child.emit('close', 1) // 끝 코드는 보지 않는다 — 표식이 말한다
    expect(await p).toBe(`noise ${S}/a`)
    expect(kill).not.toHaveBeenCalled()
  })

  it('끝 표식이 오면 닫히길 기다리지 않는다 — 프로필의 뒷일이 stdout 을 쥐고 안 닫혀도 곧 돌려주고, 셸은 그룹째 끄고 더 듣지 않는다', async () => {
    const child = fakeChild()
    const kill = vi.fn(async () => {})
    // 상한을 크게 — 기다렸다면 이 시험의 상한(2초)에 걸린다
    const p = shellRunner({ spawn: (() => child) as any, kill, env: {} })('/bin/zsh', ['-ilc', 'x'], 60_000)
    child.stdout.write(`Last login\n${S}/opt/homebrew/bin:/u`)
    await new Promise((r) => setImmediate(r))
    expect(kill).not.toHaveBeenCalled() // 표식이 반만 — 아직
    child.stdout.write(`sr/bin${E}\n`) // 끝 표식이 조각 사이에 갈려 와도
    // close 도 end 도 내지 않는다
    expect(await p).toBe(`Last login\n${wrap('/opt/homebrew/bin:/usr/bin')}\n`)
    expect(parseShellPath(await p)).toBe('/opt/homebrew/bin:/usr/bin')
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(4242)
    expect(child.stdout.listenerCount('data')).toBe(0)
    // 뒤늦은 close 는 아무 일도 아니다(한 번만 끈다)
    child.emit('close', 0)
    await new Promise((r) => setImmediate(r))
    expect(kill).toHaveBeenCalledTimes(1)
  }, 2000)

  it('끝 표식만(시작 표식 없이) 와서는 돌려주지 않는다 — 닫힐 때까지 기다린다', async () => {
    const child = fakeChild()
    const kill = vi.fn(async () => {})
    const p = shellRunner({ spawn: (() => child) as any, kill, env: {} })('/bin/zsh', ['-ilc', 'x'], 60_000)
    let done = false
    void p.then(() => (done = true))
    child.stdout.write(`echo ${E} in profile\n`)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(done).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    child.emit('close', 0)
    expect(await p).toBe(`echo ${E} in profile\n`)
  })

  it('띄우지 못하면(ENOENT — $SHELL 이 없는 파일) 거절', async () => {
    const child = fakeChild()
    const p = shellRunner({ spawn: (() => child) as any, kill: vi.fn(async () => {}), env: {} })('/no/such', ['-ilc', 'x'], 3000)
    child.emit('error', Object.assign(new Error('spawn /no/such ENOENT'), { code: 'ENOENT' }))
    await expect(p).rejects.toThrow('ENOENT')
  })

  it('상한이면 셸을 그룹째 끄고 거절 — 프로필이 멈춰도', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const kill = vi.fn(async () => {})
    const p = shellRunner({ spawn: (() => child) as any, kill, env: {} })('/bin/zsh', ['-ilc', 'x'], 3000)
    const settled = p.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(2999)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(kill).toHaveBeenCalledWith(4242)
    expect(await settled).toBeInstanceOf(Error)
  })
})
