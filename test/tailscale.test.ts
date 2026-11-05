import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTailscale, enableUrlIn, resolveTailscaleCommand, runCommand, stateFromStatus, type Runner,
} from '../src/main/phone/tailscale'

// Tailscale 감싸기 — 진짜 tailscale 은 부르지 않는다. 가짜(test/fakeTailscale.mjs)가 실측(probe28) 꼴 그대로 답한다.
// 이름·주소는 모두 가짜(fake-pc.tail0000.ts.net · someone@example.com)

const FAKE = path.resolve('test/fakeTailscale.mjs')
const DNS = 'fake-pc.tail0000.ts.net'
const EMAIL = 'someone@example.com'
const ENABLE_URL = 'https://login.tailscale.com/f/serve?node=nFAKE0000CNTRL'

/** 사용자가 직접 연 serve 설정(`tailscale serve --bg 3000` 꼴 — 443 → 127.0.0.1:3000) */
const USER_443 = {
  TCP: { '443': { HTTPS: true } },
  Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
}

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
  vi.restoreAllMocks()
})

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-tailscale-'))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return d
}

/** 바깥의 FAKE_TAILSCALE_*·DURE_TAILSCALE_* 는 버린다 */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('FAKE_TAILSCALE_') || k.startsWith('DURE_TAILSCALE_')) delete env[k]
  return env
}

type State = 'missing' | 'logged-out' | 'no-https' | 'ready'

function setup(state: State, o: { serve?: unknown; extra?: Record<string, string> } = {}) {
  const root = tempDir()
  const log = path.join(root, 'argv.log')
  const serveFile = path.join(root, 'serve.json')
  if (o.serve !== undefined) fs.writeFileSync(serveFile, JSON.stringify(o.serve))
  const env = { ...baseEnv(), FAKE_TAILSCALE_STATE: state, FAKE_TAILSCALE_ROOT: root, FAKE_TAILSCALE_LOG: log, ...o.extra }
  const run: Runner = (command, args, ro) => runCommand(command, args, { ...ro, env })
  const ts = createTailscale({ command: process.execPath, args: [FAKE], run })
  /** 가짜가 받은 인자(한 줄에 하나 — { argv, pid }) */
  const calls = (): { argv: string[]; pid: number }[] =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const serve = (): unknown => (fs.existsSync(serveFile) ? JSON.parse(fs.readFileSync(serveFile, 'utf8')) : {})
  return { ts, root, calls, serve, env }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 두레가 절대 쓰지 않는 명령 — serve reset · funnel */
function noForbidden(calls: { argv: string[] }[]): void {
  for (const c of calls) {
    expect(c.argv).not.toContain('reset')
    expect(c.argv).not.toContain('funnel')
  }
}

describe('tailscale — 가짜 tailscale', () => {
  it('상태 네 가지', async () => {
    const nowhere = createTailscale({ command: path.join(tempDir(), 'no-such', 'tailscale.exe'), args: [] })
    expect(await nowhere.status()).toEqual({ kind: 'missing' })

    const missing = setup('missing') // CLI 는 있는데 Tailscale 서비스가 안 돎
    expect(await missing.ts.status()).toEqual({ kind: 'missing' })

    const out = setup('logged-out')
    expect(await out.ts.status()).toEqual({ kind: 'logged-out' })

    const noHttps = setup('no-https')
    expect(await noHttps.ts.status()).toEqual({ kind: 'no-https', enableUrl: null })

    const ready = setup('ready')
    expect(await ready.ts.status()).toEqual({ kind: 'ready', dnsName: DNS }) // 끝 '.' 뗌
    expect(ready.calls().map((c) => c.argv)).toEqual([['status', '--json']])
  }, 30_000)

  it('상태 칸 읽기 — BackendState·DNS 이름·인증서 칸만', () => {
    const j = (o: unknown) => JSON.stringify(o)
    expect(stateFromStatus(j({ BackendState: 'NeedsLogin', Self: { DNSName: `${DNS}.` }, CertDomains: [DNS] }))).toEqual({ kind: 'logged-out' })
    expect(stateFromStatus(j({ BackendState: 'Stopped', Self: { DNSName: `${DNS}.` }, CertDomains: [DNS] }))).toEqual({ kind: 'logged-out' })
    expect(stateFromStatus(j({ BackendState: 'Running', Self: { DNSName: '' }, CertDomains: [DNS] }))).toEqual({ kind: 'logged-out' })
    expect(stateFromStatus(j({ BackendState: 'Running', Self: { DNSName: 'bad host/x.' }, CertDomains: [DNS] }))).toEqual({ kind: 'logged-out' })
    expect(stateFromStatus(j({ BackendState: 'Running', Self: { DNSName: `${DNS}.` }, CertDomains: null }))).toEqual({ kind: 'no-https', enableUrl: null })
    expect(stateFromStatus(j({ BackendState: 'Running', Self: { DNSName: 'Fake-PC.Tail0000.ts.net.' }, CertDomains: [DNS] }))).toEqual({ kind: 'ready', dnsName: DNS })
    // 상태를 알 수 없는 출력 — 부르는 쪽이 'missing'(Tailscale 을 쓸 수 없음)으로
    expect(stateFromStatus('failed to connect to local Tailscale service')).toBeNull()
    expect(stateFromStatus(j({ Self: { DNSName: `${DNS}.` } }))).toBeNull()
    expect(stateFromStatus('[]')).toBeNull()
  })

  it('serveOn·serveOff — 그 포트 하나만', async () => {
    const t = setup('ready', { serve: USER_443 })
    expect(await t.ts.serveOn(47615, 47615)).toEqual({ kind: 'on' })
    expect(t.serve()).toEqual({
      TCP: { '443': { HTTPS: true }, '47615': { HTTPS: true } },
      Web: {
        ...USER_443.Web,
        [`${DNS}:47615`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:47615' } } },
      },
    })
    await t.ts.serveOff(47615, 47615)
    expect(t.serve()).toEqual(USER_443) // 사용자의 443 그대로
    const argv = t.calls().map((c) => c.argv)
    expect(argv).toContainEqual(['serve', '--bg', '--https=47615', 'http://127.0.0.1:47615'])
    expect(argv).toContainEqual(['serve', '--https=47615', 'off'])
    expect(argv.filter((a) => a.includes('off'))).toHaveLength(1)
    noForbidden(t.calls())

    // https 포트와 127.0.0.1 포트가 달라도 — 443 이 비었으면 443
    const t2 = setup('ready')
    expect(await t2.ts.serveOn(443, 47616)).toEqual({ kind: 'on' })
    expect(t2.calls().map((c) => c.argv)).toContainEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:47616'])
    await t2.ts.serveOff(443, 47616)
    expect(t2.serve()).toEqual({})

    // 이미 꺼져 있으면 아무 명령도 안 보낸다
    const before = t2.calls().length
    await t2.ts.serveOff(443, 47616)
    expect(t2.calls().slice(before).map((c) => c.argv)).toEqual([['serve', 'status', '--json']])

    // 포트 꼴이 틀리면 부르지도 않는다
    await expect(t2.ts.serveOn(70000, 47616)).rejects.toThrow()
    await expect(t2.ts.serveOn(443, 0)).rejects.toThrow()
  }, 30_000)

  it('serveOff — 그 https 포트가 남의 길이면 건드리지 않음', async () => {
    const t = setup('ready', { serve: USER_443 })
    await t.ts.serveOff(443, 47615) // 443 은 127.0.0.1:3000 — 두레 것이 아님
    expect(t.serve()).toEqual(USER_443)
    expect(t.calls().map((c) => c.argv)).toEqual([['serve', 'status', '--json']])
  }, 30_000)

  it('serveOn — Serve 꺼진 tailnet: 켜기 링크를 읽고 프로세스를 끔', async () => {
    const t = setup('no-https')
    const t0 = Date.now()
    expect(await t.ts.serveOn(47615, 47615)).toEqual({ kind: 'no-https', enableUrl: ENABLE_URL })
    expect(Date.now() - t0).toBeLessThan(10_000) // 20초 상한까지 기다리지 않는다
    const call = t.calls().find((c) => c.argv[0] === 'serve' && c.argv[1] === '--bg')!
    expect(call).toBeTruthy()
    expect(alive(call.pid)).toBe(false) // 기다리던 serve --bg 는 꺼졌다
    expect(t.serve()).toEqual({})
  }, 30_000)

  it('serveOn 실패 — 한국어 오류, 출력·경로 없음', async () => {
    const t = setup('ready', { extra: { FAKE_TAILSCALE_SERVE_FAIL: '1' } })
    const err = await t.ts.serveOn(47615, 47615).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/[가-힣]/)
    expect(err!.message).not.toContain(EMAIL)
    expect(err!.message).not.toMatch(/[A-Za-z]:\\|Users|fake failure/i)

    const nowhere = createTailscale({ command: path.join(tempDir(), 'no-such', 'tailscale.exe'), args: [] })
    await expect(nowhere.serveOn(47615, 47615)).rejects.toThrow('Tailscale 을 찾지 못했어요')
  }, 30_000)

  it('serveOn — 시간 상한이면 한국어 오류', async () => {
    const run: Runner = async () => ({ kind: 'timeout', stdout: 'Available within your tailnet:', stderr: '' })
    const ts = createTailscale({ command: 'tailscale', args: [], run })
    await expect(ts.serveOn(47615, 47615)).rejects.toThrow(/[가-힣]/)
    // 시간 상한 안에 링크까지 찍고 멈췄으면 그 링크
    const run2: Runner = async () => ({ kind: 'timeout', stdout: `To enable, visit:\n\n         ${ENABLE_URL}`, stderr: '' })
    expect(await createTailscale({ command: 'tailscale', args: [], run: run2 }).serveOn(47615, 47615)).toEqual({ kind: 'no-https', enableUrl: ENABLE_URL })
  })

  it('runCommand — 시간 상한이면 나무째 끈다', async () => {
    const t = setup('no-https')
    const r = await runCommand(process.execPath, [FAKE, 'serve', '--bg', '--https=47615', 'http://127.0.0.1:47615'], { timeoutMs: 1500, env: t.env })
    expect(r.kind).toBe('timeout')
    const call = t.calls().find((c) => c.argv[1] === '--bg')!
    expect(alive(call.pid)).toBe(false)
  }, 30_000)

  it('켜기 링크 — 링크 뒤 글자가 와야 끝까지 받은 것', () => {
    expect(enableUrlIn(`To enable, visit:\n\n         ${ENABLE_URL.slice(0, 50)}`, false)).toBeNull()
    expect(enableUrlIn(`To enable, visit:\n\n         ${ENABLE_URL}`, false)).toBeNull()
    expect(enableUrlIn(`To enable, visit:\n\n         ${ENABLE_URL}\n`, false)).toBe(ENABLE_URL)
    expect(enableUrlIn(`To enable, visit:\n\n         ${ENABLE_URL}`, true)).toBe(ENABLE_URL)
    expect(enableUrlIn('https://login.tailscale.com.evil.example/f/serve?node=x\n', true)).toBeNull()
    expect(enableUrlIn('Available within your tailnet:\n', true)).toBeNull()
  })

  it('httpsPortFree — serve 설정(TCP·Web·앞쪽 세션)에 그 포트가 없을 때만', async () => {
    const t = setup('ready', {
      serve: {
        ...USER_443,
        TCP: { ...USER_443.TCP, '5432': { TCPForward: '127.0.0.1:5432' } },
        Web: { ...USER_443.Web, [`${DNS}:8443`]: { Handlers: { '/': { Path: '/srv' } } } },
        Foreground: { abc: { TCP: { '10000': { HTTPS: true } }, Web: { [`${DNS}:10000`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9' } } } } } },
      },
    })
    expect(await t.ts.httpsPortFree(443)).toBe(false)
    expect(await t.ts.httpsPortFree(5432)).toBe(false)
    expect(await t.ts.httpsPortFree(8443)).toBe(false)
    expect(await t.ts.httpsPortFree(10000)).toBe(false)
    expect(await t.ts.httpsPortFree(47615)).toBe(true)
    expect(t.calls().every((c) => c.argv.join(' ') === 'serve status --json')).toBe(true)

    // 설정을 못 읽으면 쓰이는 것으로 친다(443 대신 47615 로)
    expect(await setup('missing').ts.httpsPortFree(443)).toBe(false)
  }, 30_000)

  it('남은 길 정리 — 두레 포트만', async () => {
    const ours = { '/': { Proxy: 'http://127.0.0.1:47615' } }
    const userOnly = {
      TCP: { ...USER_443.TCP, '10443': { HTTPS: true } },
      Web: {
        ...USER_443.Web,
        // 같은 127.0.0.1:47615 라도 사용자가 길을 더 붙인 포트는 두레 것이 아니다
        [`${DNS}:10443`]: { Handlers: { ...ours, '/docs': { Path: 'C:\\srv' } } },
      },
    }
    const t = setup('ready', {
      serve: { TCP: { ...userOnly.TCP, '47615': { HTTPS: true } }, Web: { ...userOnly.Web, [`${DNS}:47615`]: { Handlers: ours } } },
    })
    expect(await t.ts.cleanup(443, 47615)).toBe(false) // 443 → 127.0.0.1:3000 은 사용자 것
    expect(await t.ts.cleanup(10443, 47615)).toBe(false)
    expect(await t.ts.cleanup(47615, 47615)).toBe(true) // 비정상 종료로 남은 두레 길
    expect(t.serve()).toEqual(userOnly)
    expect(await t.ts.cleanup(47615, 47615)).toBe(false) // 두 번째는 할 일 없음
    const offs = t.calls().filter((c) => c.argv.includes('off')).map((c) => c.argv)
    expect(offs).toEqual([['serve', '--https=47615', 'off']])
    noForbidden(t.calls())

    // Tailscale 을 못 쓰면 조용히 넘어간다(던지지 않음)
    expect(await setup('missing').ts.cleanup(47615, 47615)).toBe(false)
    const nowhere = createTailscale({ command: path.join(tempDir(), 'no-such', 'tailscale.exe'), args: [] })
    expect(await nowhere.cleanup(47615, 47615)).toBe(false)
  }, 30_000)

  it('출력의 사용자 칸은 결과에 없음', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const seen: unknown[] = []
    const keep = async (p: Promise<unknown>) => seen.push(await p.then((v) => v, (e: Error) => ({ error: e.message, stack: e.stack })))
    for (const state of ['missing', 'logged-out', 'no-https', 'ready'] as const) {
      const t = setup(state, { serve: USER_443 })
      // 가짜 status 출력에는 사용자 칸(LoginName·DisplayName)이 정말 들어 있다
      if (state !== 'missing') {
        const raw = await runCommand(process.execPath, [FAKE, 'status', '--json'], { timeoutMs: 10_000, env: t.env })
        expect(raw.kind === 'exit' && raw.stdout).toContain(EMAIL)
      }
      await keep(t.ts.status())
      await keep(t.ts.serveOn(47615, 47615))
      await keep(t.ts.httpsPortFree(443))
      await keep(t.ts.serveOff(47615, 47615))
      await keep(t.ts.cleanup(47615, 47615))
    }
    const failing = setup('ready', { extra: { FAKE_TAILSCALE_SERVE_FAIL: '1' } })
    await keep(failing.ts.serveOn(47615, 47615))
    const text = JSON.stringify(seen)
    expect(text).not.toContain(EMAIL)
    expect(text).not.toContain('LoginName')
    expect(text).not.toContain('Fake User')
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(EMAIL)
    // 결과에 담기는 칸은 kind·dnsName·enableUrl 뿐
    const full = JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${DNS}.`, Online: true, UserID: 1 }, CertDomains: [DNS], User: { '1': { LoginName: EMAIL, DisplayName: 'Fake User' } } })
    expect(stateFromStatus(full)).toEqual({ kind: 'ready', dnsName: DNS })
  }, 60_000)
})

describe('resolveTailscaleCommand', () => {
  it('DURE_TAILSCALE_COMMAND + JSON 인자(가짜)', () => {
    expect(resolveTailscaleCommand({ DURE_TAILSCALE_COMMAND: 'node', DURE_TAILSCALE_ARGS: '["fakeTailscale.mjs"]' }, () => true)).toEqual({ command: 'node', args: ['fakeTailscale.mjs'] })
    expect(resolveTailscaleCommand({ DURE_TAILSCALE_COMMAND: 'node' }, () => true)).toEqual({ command: 'node', args: [] })
    const msg = 'DURE_TAILSCALE_ARGS 는 JSON 배열이어야 해요'
    expect(() => resolveTailscaleCommand({ DURE_TAILSCALE_COMMAND: 'n', DURE_TAILSCALE_ARGS: '{oops' }, () => true)).toThrow(msg)
    expect(() => resolveTailscaleCommand({ DURE_TAILSCALE_COMMAND: 'n', DURE_TAILSCALE_ARGS: '[1]' }, () => true)).toThrow(msg)
  })
  it('PATH 의 tailscale.exe → 없으면 %ProgramFiles%\\Tailscale\\tailscale.exe', () => {
    const inB = path.join('C:\\b', 'tailscale.exe')
    expect(resolveTailscaleCommand({ Path: 'C:\\a;"C:\\b";', ProgramFiles: 'D:\\PF' }, (p) => p === inB)).toEqual({ command: inB, args: [] })
    expect(resolveTailscaleCommand({ PATH: 'C:\\a', ProgramFiles: 'D:\\PF' }, () => false)).toEqual({ command: path.join('D:\\PF', 'Tailscale', 'tailscale.exe'), args: [] })
    expect(resolveTailscaleCommand({}, () => false)).toEqual({ command: path.join('C:\\Program Files', 'Tailscale', 'tailscale.exe'), args: [] })
  })
})
