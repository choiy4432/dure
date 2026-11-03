import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSetupFlow, type SetupDeps } from '../src/main/setupFlow'
import type { SetupState } from '../src/shared/appTypes'

const CLAUDE = { command: 'claude.exe', argsPrefix: [] as string[] }

function setup(over: Partial<SetupDeps> = {}) {
  const states: SetupState[] = []
  let found: typeof CLAUDE | null = null
  let loggedIn = false
  const install = { onLine: (_l: string) => {}, finish: (_r: { code: number | null }) => {}, kill: vi.fn() }
  const login = { kill: vi.fn() }
  const deps = {
    claude: vi.fn(() => found),
    loggedIn: vi.fn(async () => loggedIn),
    version: vi.fn(async () => '2.1.304'),
    spawnInstall: vi.fn((onLine: (l: string) => void) => {
      install.onLine = onLine
      return {
        done: new Promise<{ code: number | null }>((res) => {
          install.finish = res
        }),
        kill: install.kill,
      }
    }),
    spawnLogin: vi.fn(() => login),
    relaunch: vi.fn(),
    hasEngine: true,
    emit: (s: SetupState) => states.push(s),
    pollMs: 2000,
    loginTimeoutMs: 600000,
    keepLines: 6,
    ...over,
  } satisfies SetupDeps
  const flow = createSetupFlow(deps)
  return {
    flow, deps, states, install, login,
    setFound: (c: typeof CLAUDE | null) => { found = c },
    setLoggedIn: (b: boolean) => { loggedIn = b },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('setupFlow', () => {
  it('처음 상태는 checking', () => {
    expect(setup().flow.state()).toEqual({ phase: 'checking' })
  })

  it('claude 없음 → 설치 할 일', async () => {
    const s = setup()
    await s.flow.check()
    expect(s.flow.state()).toEqual({ phase: 'needs', install: { state: 'todo' }, login: { state: 'locked' } })
    expect(s.states.at(-1)).toEqual(s.flow.state())
    expect(s.deps.relaunch).not.toHaveBeenCalled()
  })

  it('로그인 안 됨 → 설치 끝(버전), 로그인 할 일', async () => {
    const s = setup()
    s.setFound(CLAUDE)
    await s.flow.check()
    expect(s.flow.state()).toEqual({ phase: 'needs', install: { state: 'done', version: '2.1.304' }, login: { state: 'todo' } })
  })

  it('로그인 됨 + 엔진 있음 → ready', async () => {
    const s = setup()
    s.setFound(CLAUDE)
    s.setLoggedIn(true)
    await s.flow.check()
    expect(s.flow.state()).toEqual({ phase: 'ready' })
    expect(s.deps.relaunch).not.toHaveBeenCalled()
  })

  it('로그인 됨 + 엔진 없음 → relaunching 과 relaunch', async () => {
    const s = setup({ hasEngine: false })
    s.setFound(CLAUDE)
    s.setLoggedIn(true)
    await s.flow.check()
    expect(s.flow.state()).toEqual({ phase: 'relaunching' })
    expect(s.deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('설치 — 줄을 마지막 6개만', async () => {
    const s = setup()
    await s.flow.check()
    const p = s.flow.install()
    expect(s.flow.state()).toMatchObject({ phase: 'needs', install: { state: 'running', lines: [] } })
    for (let i = 1; i <= 9; i++) s.install.onLine(`줄 ${i}`)
    s.install.onLine('   ') // 빈 줄은 안 센다
    expect(s.flow.state()).toMatchObject({
      install: { state: 'running', lines: ['줄 4', '줄 5', '줄 6', '줄 7', '줄 8', '줄 9'] },
    })
    s.setFound(CLAUDE)
    s.install.finish({ code: 0 })
    await p
    expect(s.flow.state()).toEqual({ phase: 'needs', install: { state: 'done', version: '2.1.304' }, login: { state: 'todo' } })
  })

  it('설치 실패 — 마지막 줄이 글', async () => {
    const s = setup()
    await s.flow.check()
    const p = s.flow.install()
    s.install.onLine('받는 중')
    s.install.onLine('네트워크 오류')
    s.install.onLine('')
    s.install.finish({ code: 1 })
    await p
    expect(s.flow.state()).toEqual({
      phase: 'needs',
      install: { state: 'failed', message: '네트워크 오류', lines: ['받는 중', '네트워크 오류'] },
      login: { state: 'locked' },
    })
  })

  it('설치 0 인데 claude 없음 → 찾지 못했어요, relaunch 안 함', async () => {
    const s = setup({ hasEngine: false })
    await s.flow.check()
    const p = s.flow.install()
    s.install.finish({ code: 0 })
    await p
    expect(s.flow.state()).toMatchObject({ install: { state: 'failed', message: '설치가 끝났는데 claude 를 찾지 못했어요' } })
    expect(s.deps.relaunch).not.toHaveBeenCalled()
  })

  it('설치가 도는 중 또 누르면 무시', async () => {
    const s = setup()
    await s.flow.check()
    const p = s.flow.install()
    await s.flow.install()
    expect(s.deps.spawnInstall).toHaveBeenCalledTimes(1)
    s.install.finish({ code: 1 })
    await p
  })

  it('로그인 — 폴링하다 됨 (엔진 있음 → ready)', async () => {
    const s = setup()
    s.setFound(CLAUDE)
    await s.flow.check()
    await s.flow.login()
    expect(s.deps.spawnLogin).toHaveBeenCalledWith(CLAUDE)
    expect(s.flow.state()).toEqual({ phase: 'needs', install: { state: 'done', version: '2.1.304' }, login: { state: 'waiting' } })
    await vi.advanceTimersByTimeAsync(4000)
    expect(s.deps.loggedIn).toHaveBeenCalledTimes(3) // check 1 + 폴링 2
    expect(s.flow.state()).toMatchObject({ login: { state: 'waiting' } })
    s.setLoggedIn(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(s.flow.state()).toEqual({ phase: 'ready' })
    expect(s.deps.relaunch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10000) // 폴링 멈춤
    expect(s.deps.loggedIn).toHaveBeenCalledTimes(4)
  })

  it('로그인 됨 + 엔진 없음 → relaunch', async () => {
    const s = setup({ hasEngine: false })
    s.setFound(CLAUDE)
    await s.flow.check()
    await s.flow.login()
    s.setLoggedIn(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(s.flow.state()).toEqual({ phase: 'relaunching' })
    expect(s.deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('로그인 상한 — failed', async () => {
    const s = setup()
    s.setFound(CLAUDE)
    await s.flow.check()
    await s.flow.login()
    await vi.advanceTimersByTimeAsync(600000)
    expect(s.flow.state()).toEqual({
      phase: 'needs',
      install: { state: 'done', version: '2.1.304' },
      login: { state: 'failed', message: '로그인을 확인하지 못했어요 — 다시 해 주세요' },
    })
    expect(s.login.kill).toHaveBeenCalled()
    const calls = (s.deps.loggedIn as ReturnType<typeof vi.fn>).mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect((s.deps.loggedIn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
    // 다시 해 볼 수 있다
    await s.flow.login()
    expect(s.flow.state()).toMatchObject({ login: { state: 'waiting' } })
  })

  it('claude 가 없으면 login 은 아무것도 안 한다', async () => {
    const s = setup()
    await s.flow.check()
    await s.flow.login()
    expect(s.deps.spawnLogin).not.toHaveBeenCalled()
  })

  it('dispose — 도는 설치·로그인을 끈다', async () => {
    const s = setup()
    await s.flow.check()
    const p = s.flow.install()
    s.flow.dispose()
    expect(s.install.kill).toHaveBeenCalled()
    s.install.finish({ code: null })
    await p
    const n = s.states.length
    expect(s.states.length).toBe(n)

    const t = setup()
    t.setFound(CLAUDE)
    await t.flow.check()
    await t.flow.login()
    t.flow.dispose()
    expect(t.login.kill).toHaveBeenCalled()
    const m = t.states.length
    t.setLoggedIn(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect(t.states.length).toBe(m)
    expect(t.deps.relaunch).not.toHaveBeenCalled()
  })

  it('relaunch 는 claude 를 찾았을 때만', async () => {
    const s = setup({ hasEngine: false })
    await s.flow.check() // claude 없음
    await s.flow.login()
    await vi.advanceTimersByTimeAsync(10000)
    expect(s.deps.relaunch).not.toHaveBeenCalled()
    const p = s.flow.install()
    s.install.finish({ code: 0 }) // 설치 0 이지만 못 찾음
    await p
    expect(s.deps.relaunch).not.toHaveBeenCalled()
  })
})
