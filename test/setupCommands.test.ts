import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { cmdArgs, startWaitLine } from '../src/main/cmdLine'
import { installCommand, loginPlan, setupInstallCommand, spawnInstall, spawnLogin } from '../src/main/setupCommands'

// 설치·로그인 명령 — 진짜로 띄우지 않는다(spawn·파일 쓰기·끄기를 갈아끼운다). mac 길은 platform 인자로

const PS_ARGS = [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; irm https://claude.ai/install.ps1 | iex',
]
const MAC_CLAUDE = { command: '/Users/a/.local/bin/claude', argsPrefix: [] as string[] }
const WIN_CLAUDE = { command: String.raw`C:\Users\a b\.local\bin\claude.exe`, argsPrefix: [] as string[] }

describe('installCommand', () => {
  it('win32_설치는_powershell_인자_그대로', () => {
    expect(installCommand('win32')).toEqual({ command: 'powershell.exe', args: PS_ARGS })
  })

  it('darwin_설치는_/bin/bash_-c_curl…|_bash — 공식 install.sh, 절대 경로라 PATH 와 무관 · pipefail 이라 받기 실패가 설치 실패로', () => {
    // pipefail 이 없으면 파이프의 끝 코드는 마지막 bash 의 것 — curl 이 못 받아도(빈 입력) 0 이라 '설치가 끝났는데 claude 를 찾지 못했어요' 가 뜬다
    expect(installCommand('darwin')).toEqual({ command: '/bin/bash', args: ['-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'] })
    // 공식 명령 자체는 글자 그대로(준비 화면이 보여 주는 '직접 할 명령'과 같은 줄)
    expect(installCommand('darwin').args[1]!.endsWith('curl -fsSL https://claude.ai/install.sh | bash')).toBe(true)
  })

  it('DURE_SETUP_INSTALL(JSON argv 배열)이 있으면 그것 — 틀리면 던진다(시험용 손잡이 그대로)', () => {
    expect(setupInstallCommand('win32', undefined)).toEqual(installCommand('win32'))
    expect(setupInstallCommand('darwin', '')).toEqual(installCommand('darwin'))
    expect(setupInstallCommand('darwin', '["node","fake.mjs","x"]')).toEqual({ command: 'node', args: ['fake.mjs', 'x'] })
    for (const bad of ['{', '[]', '[1]', '"x"', '{"a":1}']) {
      expect(() => setupInstallCommand('win32', bad)).toThrow('DURE_SETUP_INSTALL 은 JSON 배열이어야 해요')
    }
  })
})

describe('loginPlan', () => {
  it('win32_로그인_줄은_지금과_글자까지_같다 — cmd.exe start /wait · 옵션도', () => {
    const p = loginPlan('win32', WIN_CLAUDE, String.raw`C:\Temp`)
    expect(p.command).toBe('cmd.exe')
    expect(p.args).toEqual([
      '/d', '/v:off', '/s', '/c',
      String.raw`"start "" /wait ^"C:\Users\a^ b\.local\bin\claude.exe^" ^"auth^" ^"login^" ^"--claudeai^""`,
    ])
    expect(p.args).toEqual(cmdArgs(startWaitLine(WIN_CLAUDE.command, ['auth', 'login', '--claudeai'])))
    expect(p.options).toEqual({ windowsHide: true, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' })
    expect(Object.keys(p.options)).toEqual(['windowsHide', 'windowsVerbatimArguments', 'detached', 'stdio'])
    expect(p.file).toBeUndefined()
    // 앞 인자(DURE_CLAUDE_ARGS — 가짜 claude)도 지금처럼 claude 뒤·auth 앞
    const fake = loginPlan('win32', { command: 'node', argsPrefix: ['fake & x.mjs'] }, 'C:\\Temp')
    expect(fake.args).toEqual(cmdArgs(startWaitLine('node', ['fake & x.mjs', 'auth', 'login', '--claudeai'])))
  })

  it('darwin_로그인은_.command_파일(0755)_과_open_-a_Terminal', () => {
    const p = loginPlan('darwin', MAC_CLAUDE, '/var/folders/x/T', () => 'abc123')
    expect(p.file).toEqual({
      path: '/var/folders/x/T/dure-login-abc123.command',
      mode: 0o755,
      content: "#!/bin/bash\nunset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN\nexec '/Users/a/.local/bin/claude' auth login --claudeai\n",
    })
    expect(p.command).toBe('/usr/bin/open')
    expect(p.args).toEqual(['-a', 'Terminal', '/var/folders/x/T/dure-login-abc123.command'])
    expect(p.options).toEqual({ stdio: 'ignore' })
  })

  it('darwin — 파일 이름은 난수(16자리 16진)라 부를 때마다 다르다 · 임시 폴더 끝의 / 도 한 번', () => {
    const a = loginPlan('darwin', MAC_CLAUDE, '/tmp/')
    const b = loginPlan('darwin', MAC_CLAUDE, '/tmp/')
    expect(a.file!.path).toMatch(/^\/tmp\/dure-login-[0-9a-f]{16}\.command$/)
    expect(a.file!.path).not.toBe(b.file!.path)
    expect(a.args[2]).toBe(a.file!.path)
  })

  it('darwin — 앞 인자(가짜 claude)도 따옴표로 싸 claude 뒤에', () => {
    const p = loginPlan('darwin', { command: '/usr/local/bin/node', argsPrefix: ['/x/fake claude.mjs'] }, '/tmp', () => 'r')
    expect(p.file!.content).toContain("\nexec '/usr/local/bin/node' '/x/fake claude.mjs' auth login --claudeai\n")
  })

  const hasBash = spawnSync('bash', ['-c', 'exit 0'], { timeout: 10_000 }).status === 0
  it('claude_경로에_공백·따옴표가_있어도_.command_가_안전하다 — 셸이 나누거나 펼치지 않는다', () => {
    const odd = `/Users/a b/it's "q" $(touch /tmp/pwned) \`id\` $HOME ; * \\ ~/claude`
    const p = loginPlan('darwin', { command: odd, argsPrefix: [] }, '/tmp', () => 'r')
    const exec = p.file!.content.split('\n').find((l) => l.startsWith('exec '))!
    expect(exec).toBe(`exec '/Users/a b/it'\\''s "q" $(touch /tmp/pwned) \`id\` $HOME ; * \\ ~/claude' auth login --claudeai`)
    if (!hasBash) return
    // 진짜 bash 로 — exec 대신 printf 로 인자를 한 줄씩 찍어 본다
    const r = spawnSync('bash', ['-c', exec.replace(/^exec /, "printf '%s\\n' ")], { encoding: 'utf8', timeout: 10_000 })
    expect(r.status).toBe(0)
    expect(r.stdout.split('\n').slice(0, -1)).toEqual([odd, 'auth', 'login', '--claudeai'])
  })
})

/** 가짜 자식 — 사건을 직접 낸다 */
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn(),
  })
}

describe('spawnLogin', () => {
  it('win32 — cmd.exe 를 지금 옵션 그대로(+ API 키 뺀 env) · unref · kill 은 나무째, 끝난 창은 끄지 않는다', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const killTree = vi.fn(async () => {})
    const write = vi.fn()
    const remove = vi.fn()
    const env = { PATH: 'C:\\x', ANTHROPIC_API_KEY: 'sk-x' }
    const proc = spawnLogin(WIN_CLAUDE, { platform: 'win32', tmpDir: 'C:\\Temp', env, spawn: spawn as any, killTree, write, remove })
    expect(spawn).toHaveBeenCalledWith('cmd.exe', cmdArgs(startWaitLine(WIN_CLAUDE.command, ['auth', 'login', '--claudeai'])), {
      windowsHide: true, windowsVerbatimArguments: true, detached: true, stdio: 'ignore', env: { PATH: 'C:\\x' },
    })
    expect(child.unref).toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    await proc.kill()
    expect(killTree).toHaveBeenCalledWith(4242, { platform: 'win32' })
    child.emit('exit', 0)
    await proc.kill()
    expect(killTree).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
  })

  it('darwin — .command 를 먼저 쓰고(0755·새 파일만) open -a Terminal · kill 은 파일만 지운다(창은 못 닫는다)', async () => {
    const order: string[] = []
    const child = fakeChild()
    const spawn = vi.fn(() => (order.push('spawn'), child))
    const killTree = vi.fn(async () => {})
    const write = vi.fn(() => void order.push('write'))
    const remove = vi.fn()
    const env = { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 't' }
    const proc = spawnLogin(MAC_CLAUDE, { platform: 'darwin', tmpDir: '/var/folders/x/T', env, spawn: spawn as any, killTree, write, remove, rand: () => 'abc' })
    const file = '/var/folders/x/T/dure-login-abc.command'
    expect(order).toEqual(['write', 'spawn'])
    expect(write).toHaveBeenCalledWith(file, expect.stringContaining("exec '/Users/a/.local/bin/claude' auth login --claudeai\n"), 0o755)
    expect(spawn).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Terminal', file], { stdio: 'ignore', env: { PATH: '/usr/bin' } })
    await proc.kill()
    expect(remove).toHaveBeenCalledWith(file)
    expect(killTree).not.toHaveBeenCalled()
    await proc.kill() // 두 번 — 한 번만 지운다
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('darwin — 지우기가 던져도(이미 없음) kill 은 풀린다 · open 을 못 띄우면 파일을 지우고 던진다', async () => {
    const child = fakeChild()
    const remove = vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
    const proc = spawnLogin(MAC_CLAUDE, { platform: 'darwin', tmpDir: '/tmp', env: {}, spawn: (() => child) as any, killTree: vi.fn(), write: vi.fn(), remove, rand: () => 'r' })
    await expect(proc.kill()).resolves.toBeUndefined()

    const remove2 = vi.fn()
    const boom = () => { throw new Error('spawn 실패') }
    expect(() => spawnLogin(MAC_CLAUDE, { platform: 'darwin', tmpDir: '/tmp', env: {}, spawn: boom as any, killTree: vi.fn(), write: vi.fn(), remove: remove2, rand: () => 'r' })).toThrow('spawn 실패')
    expect(remove2).toHaveBeenCalledWith('/tmp/dure-login-r.command')
  })

  it('darwin — 기본 쓰기·지우기(진짜 파일): 새 파일로만 쓰고(같은 이름이 있으면 던진다) kill 이 지운다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dure-login-'))
    try {
      const tmpDir = dir.replace(/\\/g, '/') // posix.join 이 잇는다 — 이 PC 에서도 열 수 있는 꼴로
      const proc = spawnLogin(MAC_CLAUDE, { platform: 'darwin', tmpDir, env: {}, spawn: (() => fakeChild()) as any, killTree: vi.fn(), rand: () => 'real' })
      const file = join(dir, 'dure-login-real.command')
      expect(readFileSync(file, 'utf8')).toBe(loginPlan('darwin', MAC_CLAUDE, tmpDir, () => 'real').file!.content)
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o755)
      // 같은 이름(남이 미리 만든 파일·링크)이면 덮어쓰지 않고 던진다
      expect(() => spawnLogin(MAC_CLAUDE, { platform: 'darwin', tmpDir, env: {}, spawn: (() => fakeChild()) as any, killTree: vi.fn(), rand: () => 'real' })).toThrow(/EEXIST/)
      await proc.kill()
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('darwin — 파일을 못 쓰면 던진다(띄우지 않는다)', () => {
    const spawn = vi.fn()
    const write = vi.fn(() => { throw new Error('EEXIST') })
    expect(() => spawnLogin(MAC_CLAUDE, { platform: 'darwin', tmpDir: '/tmp', env: {}, spawn: spawn as any, killTree: vi.fn(), write, remove: vi.fn() })).toThrow('EEXIST')
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('spawnInstall', () => {
  const cmd = { command: '/bin/bash', args: ['-c', 'x'] }

  it('win32 — 옵션은 지금 그대로({ windowsHide, stdio, env }) · kill 은 그 platform 으로 나무째', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const killTree = vi.fn(async () => {})
    const run = spawnInstall(installCommand('win32'), () => {}, { platform: 'win32', env: { A: '1', ANTHROPIC_API_KEY: 'k' }, spawn: spawn as any, killTree })
    expect(spawn).toHaveBeenCalledWith('powershell.exe', PS_ARGS, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { A: '1' } })
    await run.kill()
    expect(killTree).toHaveBeenCalledWith(4242, { platform: 'win32' })
    child.emit('close', 0)
    expect(await run.done).toEqual({ code: 0 })
  })

  it('darwin — 새 프로세스 그룹으로(detached — bash·curl·설치기를 그룹째 끈다) · 줄은 stdout·stderr 를 \\r\\n|\\n|\\r 로', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const killTree = vi.fn(async () => {})
    const lines: string[] = []
    const run = spawnInstall(cmd, (l) => lines.push(l), { platform: 'darwin', env: {}, spawn: spawn as any, killTree })
    expect(spawn).toHaveBeenCalledWith('/bin/bash', ['-c', 'x'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {} })
    child.stdout.write('a\r\nb\nc')
    child.stderr.write('e\r')
    child.stdout.end('d')
    child.stderr.end()
    await new Promise((r) => setImmediate(r))
    child.emit('close', 1)
    expect(await run.done).toEqual({ code: 1 })
    expect(lines.sort()).toEqual(['a', 'b', 'cd', 'e'])
    await run.kill()
    expect(killTree).toHaveBeenCalledWith(4242, { platform: 'darwin' })
  })

  it('못 띄우면(error) done 이 거절', async () => {
    const child = fakeChild()
    const run = spawnInstall(cmd, () => {}, { platform: 'darwin', env: {}, spawn: (() => child) as any, killTree: vi.fn() })
    child.emit('error', new Error('spawn /bin/bash ENOENT'))
    await expect(run.done).rejects.toThrow('ENOENT')
  })
})
