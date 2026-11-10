import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import type { Dispatch } from '../src/main/dispatch'
import { createPhoneController, phoneStaticDir, type PhoneController, type PhoneControllerOptions } from '../src/main/phone/phoneController'
import { startPhoneServer, type PhoneClient, type PhoneServer, type PhoneServerOptions } from '../src/main/phone/phoneServer'
import { EVENT_NAMES } from '../src/shared/ipcContract'
import { PHONE_DENIED } from '../src/shared/phoneAccess'
import { DEFAULT_PHONE_SETTINGS, PAIR_TTL_MS, PHONE_IDLE_MS, type PhoneState, type TailscaleState } from '../src/shared/phoneTypes'
import { phoneCookieName } from '../src/shared/phoneWire'

/** 443 으로 연 길의 기기 토큰 쿠키 이름 */
const PHONE_COOKIE = phoneCookieName(443)

// 휴대폰 연결 묶기 — 가짜 tailscale·절전 막기·로그인 항목·서버·푸시, 임시 폴더만.
// 🔴 진짜 tailscale·로그인 항목·powerSaveBlocker·웹 푸시는 부르지 않는다(진짜 서버 시험 하나만 127.0.0.1 에 연다)

const DNS = 'fake-pc.tail0000.ts.net'
const READY: TailscaleState = { kind: 'ready', dnsName: DNS }
const LINK = 'https://login.tailscale.com/f/serve?node=nFAKE0000CNTRL'
const HASH = 'a'.repeat(64)
const SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') },
}

let dir: string
const controllers: PhoneController[] = []
const cleanup: (() => void)[] = []
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-phonectl-'))
})
afterEach(async () => {
  vi.useRealTimers()
  for (const f of cleanup.splice(0)) f()
  for (const c of controllers.splice(0)) await c.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

const fileOf = (d = dir) => path.join(d, 'phone.json')
const saved = (d = dir) => JSON.parse(fs.readFileSync(fileOf(d), 'utf8'))
const seed = (v: Record<string, unknown>, d = dir) => {
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(fileOf(d), JSON.stringify({ settings: DEFAULT_PHONE_SETTINGS, devices: [], ...v }))
}
const inboxOf = (d = dir) => path.join(d, 'phone-inbox')
const inboxFiles = (d = dir) => (fs.existsSync(inboxOf(d)) ? fs.readdirSync(inboxOf(d)) : [])
const putInbox = (name: string, d = dir) => {
  fs.mkdirSync(inboxOf(d), { recursive: true })
  fs.writeFileSync(path.join(inboxOf(d), name), 'x')
}

/** 가짜 tailscale — 두레 길(routes)과 사용자 길(others)을 따로 둔다. serveOff 는 진짜처럼 그 짝(포트·로컬 포트·이름)이 맞을 때만 끈다 */
function fakeTailscale(start: TailscaleState = READY, order: string[] = []) {
  const routes = new Map<number, { localPort: number; dnsName?: string }>()
  const others = new Set<number>()
  /** 사용자가 Funnel(인터넷 공개)을 켠 https 포트 — serve status 의 AllowFunnel */
  const funnels = new Set<number>()
  const calls: string[] = []
  const log = (s: string) => {
    calls.push(s)
    order.push(s)
  }
  const t = {
    state: start,
    /** serveOn 이 돌려줄 것 — Error 면 길을 연 채로 던진다(시간 상한처럼) */
    onResult: null as null | { kind: 'no-https'; enableUrl: string } | Error,
    offError: null as Error | null,
    routes, others, funnels, calls,
    status: vi.fn(async (): Promise<TailscaleState> => {
      log('status')
      return t.state
    }),
    httpsPortFree: vi.fn(async (p: number) => {
      log(`free ${p}`)
      return !others.has(p) && !routes.has(p) && !funnels.has(p)
    }),
    funnelOn: vi.fn(async (p: number) => {
      log(`funnel ${p}`)
      return funnels.has(p)
    }),
    serveOn: vi.fn(async (h: number, l: number, d?: string) => {
      log(`on ${h} ${l} ${d ?? '-'}`)
      if (funnels.has(h)) throw new Error('이 포트가 인터넷에 공개(Funnel)돼 있어요 — Tailscale 에서 Funnel 을 꺼 주세요')
      const r = t.onResult
      if (r && !(r instanceof Error)) return r
      routes.set(h, { localPort: l, dnsName: d })
      if (r instanceof Error) throw r
      return { kind: 'on' as const }
    }),
    /** 참이면 — 예전 PC 이름 아래의 두레 길을 다른 serve 설정 때문에 남겨 둔다('left' · 그 포트는 쓰이는 채) */
    leave: false,
    serveOff: vi.fn(async (h: number, l: number, d?: string): Promise<boolean | 'left'> => {
      log(`off ${h} ${l} ${d ?? '-'}`)
      if (t.offError) throw t.offError
      const r = routes.get(h)
      if (!r || r.localPort !== l || (d !== undefined && r.dnsName !== d)) return false
      routes.delete(h)
      if (t.leave && t.state.kind === 'ready' && r.dnsName !== undefined && r.dnsName !== t.state.dnsName) {
        others.add(h)
        return 'left'
      }
      return true
    }),
  }
  return t
}

type FakeServer = PhoneServer & { opts: PhoneServerOptions; closed: boolean; list: PhoneClient[] }
/** 가짜 서버 — bump 만큼 옮긴 포트에 연 것처럼(쓰이고 있던 포트) */
function fakeServers(o: { bump?: number; order?: string[] } = {}) {
  const made: FakeServer[] = []
  const start = vi.fn(async (opts: PhoneServerOptions): Promise<PhoneServer> => {
    const s: FakeServer = {
      opts,
      port: opts.port + (o.bump ?? 0),
      closed: false,
      list: [],
      close: vi.fn(async () => {
        o.order?.push('close')
        s.closed = true
      }),
      kick: vi.fn(),
      clients: () => s.list,
    }
    made.push(s)
    return s
  })
  return { start, made, last: () => made[made.length - 1] }
}

function fakePower(order: string[] = []) {
  let n = 0
  const on = new Set<number>()
  return {
    on,
    start: vi.fn(() => {
      order.push('power on')
      on.add(++n)
      return n
    }),
    stop: vi.fn((id: number) => {
      order.push('power off')
      on.delete(id)
    }),
  }
}

function make(over: Partial<PhoneControllerOptions> & {
  dataDir?: string
  ts?: ReturnType<typeof fakeTailscale>
  servers?: ReturnType<typeof fakeServers>
  power?: ReturnType<typeof fakePower>
} = {}) {
  const ts = over.ts ?? fakeTailscale()
  const servers = over.servers ?? fakeServers()
  const power = over.power ?? fakePower()
  const loginItem = { set: vi.fn() }
  const emitted: PhoneState[] = []
  const inner = vi.fn<Dispatch>(async (method) => ({ ok: true, value: method }))
  const push = { publicKey: vi.fn(() => 'PUBKEY'), subscribe: vi.fn(), sendTo: vi.fn(async (): Promise<'retry' | undefined> => undefined) }
  const idle = { now: 'locked' as 'active' | 'idle' | 'locked' | 'unknown' }
  const dataDir = over.dataDir ?? dir
  const c = createPhoneController({
    engine: null,
    dispatch: inner,
    staticDir: path.join(dataDir, 'static'),
    androidDir: path.join(dataDir, 'android'),
    idle: () => idle.now,
    loginItem,
    emit: (s) => emitted.push(s),
    push,
    startServer: servers.start,
    ...over,
    dataDir,
    tailscale: ts,
    power,
  })
  controllers.push(c)
  return { c, ts, servers, power, loginItem, emitted, inner, push, idle }
}

test('켜기 — ready 일 때만 서버·serve·절전', async () => {
  const ts = fakeTailscale({ kind: 'missing' })
  const { c, servers, power, emitted } = make({ ts })
  await c.ready
  expect(ts.calls).toEqual([]) // 꺼져 있으면 시작 때 tailscale 을 부르지 않는다
  expect(c.state()).toMatchObject({ settings: { enabled: false }, tailscale: null, url: null, connected: 0, pairing: null, problem: null })

  await c.set({ enabled: true })
  expect(c.state()).toMatchObject({ settings: { enabled: true }, tailscale: { kind: 'missing' }, url: null, problem: null })
  ts.state = { kind: 'logged-out' }
  expect(await c.check()).toEqual({ kind: 'logged-out' })
  expect(c.state()).toMatchObject({ settings: { enabled: true }, tailscale: { kind: 'logged-out' }, url: null })
  expect(servers.start).not.toHaveBeenCalled()
  expect(ts.serveOn).not.toHaveBeenCalled()
  expect(power.start).not.toHaveBeenCalled()

  ts.state = READY
  expect(await c.check()).toEqual(READY)
  expect(servers.start).toHaveBeenCalledTimes(1)
  const s = servers.last()
  expect(s.opts.port).toBe(47615)
  expect(ts.serveOn).toHaveBeenCalledWith(443, 47615, DNS)
  expect(power.start).toHaveBeenCalledTimes(1)
  expect(c.state()).toMatchObject({ tailscale: READY, url: `https://${DNS}/mobile.html`, problem: null })
  expect(s.opts.allowedHost()).toBe(DNS)
  expect(emitted.at(-1)).toEqual(c.state())
  // 이미 열렸으면 다시 켜도 그대로
  await c.set({ enabled: true })
  expect(servers.start).toHaveBeenCalledTimes(1)
  expect(ts.serveOn).toHaveBeenCalledTimes(1)
})

test('https 포트 — 443 이 비면 443 · 남이 쓰면 47615 · 둘 다 쓰이면 까닭(serve 안 부름) · 다음엔 지난 포트 먼저', async () => {
  const tsA = fakeTailscale()
  tsA.others.add(443)
  const a = make({ ts: tsA, dataDir: path.join(dir, 'a') })
  await a.c.set({ enabled: true })
  expect(tsA.serveOn).toHaveBeenCalledWith(47615, 47615, DNS)
  expect(a.c.state().url).toBe(`https://${DNS}:47615/mobile.html`)
  expect(a.servers.last().opts.allowedHost()).toBe(`${DNS}:47615`)
  // 사용자의 443 이 비어도 다음 켜기는 지난번 포트 — 주소가 바뀌면 홈 화면 앱·알림 구독이 끊긴다
  await a.c.set({ enabled: false })
  tsA.others.delete(443)
  await a.c.set({ enabled: true })
  expect(tsA.serveOn).toHaveBeenLastCalledWith(47615, 47615, DNS)
  expect(saved(path.join(dir, 'a')).funnelPort).toBeUndefined() // 남이 쓴 것(Funnel 아님)은 돌아갈 포트가 아니다
  expect(a.c.state().notice).toBeNull()

  const tsB = fakeTailscale()
  tsB.others.add(443).add(47615)
  const b = make({ ts: tsB, dataDir: path.join(dir, 'b') })
  await b.c.set({ enabled: true })
  expect(tsB.serveOn).not.toHaveBeenCalled()
  expect(b.c.state()).toMatchObject({ settings: { enabled: true }, url: null })
  expect(b.c.state().problem).toMatch(/443.*47615/)
  expect(b.servers.last().closed).toBe(true)
  expect(b.power.start).not.toHaveBeenCalled()
  expect(saved(path.join(dir, 'b')).serve).toBeUndefined()
})

test('켜기 — serve 를 열기 전에 그 짝을 phone.json 에 적는다(서버가 옮긴 실제 포트로)', async () => {
  const ts = fakeTailscale()
  let seen: unknown = 'not called'
  ts.serveOn.mockImplementationOnce(async (h: number, l: number, d?: string) => {
    seen = saved().serve
    ts.routes.set(h, { localPort: l, dnsName: d })
    return { kind: 'on' as const }
  })
  const { c } = make({ ts, servers: fakeServers({ bump: 1 }) })
  await c.set({ enabled: true })
  expect(seen).toEqual({ httpsPort: 443, localPort: 47616, dnsName: DNS })
  expect(ts.serveOn).toHaveBeenCalledWith(443, 47616, DNS)
  expect(saved().serve).toEqual({ httpsPort: 443, localPort: 47616, dnsName: DNS })
  expect(saved().settings.port).toBe(47616) // 다음에도 그 포트부터
})

test('no-https — 켜기 멈춤, 이유 보임(켜기 링크) · 시작 때는 링크를 받으러 열어 보지 않음', async () => {
  const ts = fakeTailscale({ kind: 'no-https', enableUrl: null })
  ts.onResult = { kind: 'no-https', enableUrl: LINK }
  const { c, servers, power } = make({ ts })
  await c.set({ enabled: true })
  // 링크를 받으려고 이름 없이 한 번 열어 본다 — 그 전에 짝을 적고, 뒤에 그 짝만 정리
  expect(ts.serveOn).toHaveBeenCalledWith(443, 47615, undefined)
  expect(ts.serveOff).toHaveBeenCalledWith(443, 47615, undefined)
  expect(c.state()).toMatchObject({ settings: { enabled: true }, tailscale: { kind: 'no-https', enableUrl: LINK }, url: null, problem: null })
  expect(servers.last().closed).toBe(true)
  expect(power.start).not.toHaveBeenCalled()
  expect(saved().serve).toBeUndefined()

  // ready 라더니 serve 가 https 없다고 해도 같다
  const tsB = fakeTailscale(READY)
  tsB.onResult = { kind: 'no-https', enableUrl: LINK }
  const b = make({ ts: tsB, dataDir: path.join(dir, 'b') })
  await b.c.set({ enabled: true })
  expect(b.c.state()).toMatchObject({ settings: { enabled: true }, tailscale: { kind: 'no-https', enableUrl: LINK }, url: null })
  expect(tsB.routes.size).toBe(0)

  // 켜진 채 다시 시작 — 사람이 없으니 링크를 받으러 열지 않는다(phoneCheck 가 받는다)
  const dC = path.join(dir, 'c')
  seed({ settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true } }, dC)
  const tsC = fakeTailscale({ kind: 'no-https', enableUrl: null })
  tsC.onResult = { kind: 'no-https', enableUrl: LINK }
  const cc = make({ ts: tsC, dataDir: dC })
  await cc.c.ready
  expect(tsC.serveOn).not.toHaveBeenCalled()
  expect(cc.c.state().tailscale).toEqual({ kind: 'no-https', enableUrl: null })
  expect(await cc.c.check()).toEqual({ kind: 'no-https', enableUrl: LINK })
  expect(tsC.serveOn).toHaveBeenCalledTimes(1)
})

test('serveOn 실패(시간 상한) — 적어 둔 그 짝만 정리하고 까닭을 보임', async () => {
  const ts = fakeTailscale()
  ts.others.add(8443)
  ts.onResult = new Error('tailscale 이 답하지 않아요')
  const { c, servers, power } = make({ ts })
  await c.set({ enabled: true })
  expect(ts.serveOff).toHaveBeenCalledTimes(1)
  expect(ts.serveOff).toHaveBeenCalledWith(443, 47615, DNS)
  expect(ts.routes.size).toBe(0)
  expect(ts.others.has(8443)).toBe(true)
  expect(c.state()).toMatchObject({ settings: { enabled: true }, url: null, problem: 'tailscale 이 답하지 않아요' })
  expect(saved().serve).toBeUndefined()
  expect(servers.last().closed).toBe(true)
  expect(power.start).not.toHaveBeenCalled()
})

test('서버를 못 열면 — 까닭을 보이고 serve 는 부르지 않음', async () => {
  const ts = fakeTailscale()
  const start = vi.fn(async () => {
    throw new Error('휴대폰 연결을 열 포트를 찾지 못했어요')
  })
  const { c } = make({ ts, startServer: start })
  await c.set({ enabled: true })
  expect(ts.serveOn).not.toHaveBeenCalled()
  expect(c.state()).toMatchObject({ settings: { enabled: true }, url: null, problem: '휴대폰 연결을 열 포트를 찾지 못했어요' })
})

test('끄기 — serve 끄고 서버 닫고 절전 풀림 · 짝 맺기·inbox 도 비움', async () => {
  const order: string[] = []
  const ts = fakeTailscale(READY, order)
  const servers = fakeServers({ order })
  const power = fakePower(order)
  const { c } = make({ ts, servers, power })
  await c.set({ enabled: true })
  await c.pairStart()
  putInbox('0123456789abcdef-사진.png')
  order.length = 0
  await c.set({ enabled: false })
  // 문(서버·절전)은 그 자리에서 닫고, 길은 줄을 서서 끈다
  expect(order).toEqual(['close', 'power off', 'off 443 47615 fake-pc.tail0000.ts.net'])
  expect(ts.routes.size).toBe(0)
  expect(saved().serve).toBeUndefined()
  expect(servers.last().closed).toBe(true)
  expect(power.on.size).toBe(0)
  expect(c.state()).toMatchObject({ settings: { enabled: false }, url: null, pairing: null, connected: 0, problem: null })
  expect(servers.last().opts.allowedHost()).toBeNull()
  expect(inboxFiles()).toEqual([])
})

test('시작 때 남은 길 정리 — phone.json 에 적어 둔 짝만(꺼져 있으면 status 도 안 부름)', async () => {
  const OLD = 'old-pc.tail0000.ts.net'
  seed({ serve: { httpsPort: 47615, localPort: 47620, dnsName: OLD } })
  const ts = fakeTailscale()
  ts.routes.set(47615, { localPort: 47620, dnsName: OLD })
  ts.others.add(443)
  const { c } = make({ ts })
  await c.ready
  expect(ts.calls).toEqual([`off 47615 47620 ${OLD}`])
  expect(ts.routes.size).toBe(0)
  expect(ts.others.has(443)).toBe(true)
  expect(saved().serve).toBeUndefined()

  // 기록이 없으면 tailscale 을 아예 부르지 않는다
  const b = make({ dataDir: path.join(dir, 'b') })
  await b.c.ready
  expect(b.ts.calls).toEqual([])

  // 끄지 못하면(설정을 못 읽음) 기록을 남긴다 — 다음 시작 때 다시
  const dC = path.join(dir, 'c')
  seed({ serve: { httpsPort: 443, localPort: 47615, dnsName: DNS } }, dC)
  const tsC = fakeTailscale()
  tsC.offError = new Error('serve 설정을 읽지 못했어요')
  const cc = make({ ts: tsC, dataDir: dC })
  await cc.c.ready
  expect(saved(dC).serve).toEqual({ httpsPort: 443, localPort: 47615, dnsName: DNS })
  expect(cc.c.state()).toMatchObject({ settings: { enabled: false }, problem: expect.stringMatching(/정리하지 못했어요/) })
  // 꺼진 채 check — Tailscale 을 켠 뒤 '확인' 이면 기다리지 않고 다시 꺼 본다
  tsC.offError = null
  tsC.routes.set(443, { localPort: 47615, dnsName: DNS })
  await cc.c.check()
  expect(saved(dC).serve).toBeUndefined()
  expect(tsC.routes.size).toBe(0)
  expect(cc.c.state().problem).toBeNull()
})

test('시작 때 켜져 있으면 — 적어 둔 길을 정리하고 다시 연다(지난 포트 먼저)', async () => {
  seed({ settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true }, serve: { httpsPort: 47615, localPort: 47615, dnsName: DNS }, httpsPort: 47615 })
  const ts = fakeTailscale()
  ts.routes.set(47615, { localPort: 47615, dnsName: DNS })
  const { c, power } = make({ ts })
  await c.ready
  expect(ts.calls).toEqual(['status', `off 47615 47615 ${DNS}`, 'free 47615', `on 47615 47615 ${DNS}`])
  expect(c.state().url).toBe(`https://${DNS}:47615/mobile.html`)
  expect(saved().serve).toEqual({ httpsPort: 47615, localPort: 47615, dnsName: DNS })
  expect(power.on.size).toBe(1)
})

test('켜져 있는데 Tailscale 이 아직이면(로그인 전·안 켜짐) 잠시 뒤 다시 해 봄 — 열리면 그만', async () => {
  seed({ settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true } })
  const ts = fakeTailscale({ kind: 'logged-out' })
  const { c } = make({ ts, retryMs: 20 })
  await c.ready
  expect(c.state().url).toBeNull()
  ts.state = READY
  await vi.waitFor(() => expect(c.state().url).toBe(`https://${DNS}/mobile.html`), { timeout: 3000 })
  const n = ts.status.mock.calls.length
  await new Promise((r) => setTimeout(r, 120))
  expect(ts.status.mock.calls.length).toBe(n)
})

test('no-https — 받은 켜기 링크는 다시 해 보기·check 뒤에도 남음 · 링크를 받으러 다시 열지 않음(로그아웃을 거치면 다시 받음)', async () => {
  const ts = fakeTailscale({ kind: 'no-https', enableUrl: null })
  ts.onResult = { kind: 'no-https', enableUrl: LINK }
  const { c, emitted } = make({ ts, retryMs: 20 })
  await c.set({ enabled: true })
  expect(c.state().tailscale).toEqual({ kind: 'no-https', enableUrl: LINK })
  const n = emitted.length
  await vi.waitFor(() => expect(ts.status.mock.calls.length).toBeGreaterThanOrEqual(4), { timeout: 3000 })
  expect(c.state().tailscale).toEqual({ kind: 'no-https', enableUrl: LINK })
  expect(emitted.slice(n)).toEqual([]) // 링크가 사라졌다 돌아오는 깜박임도 없다
  expect(await c.check()).toEqual({ kind: 'no-https', enableUrl: LINK })
  expect(ts.serveOn).toHaveBeenCalledTimes(1)
  // 로그아웃을 거치면(다른 기기일 수 있다) 링크를 잊고 check 때 다시 받는다
  ts.state = { kind: 'logged-out' }
  expect(await c.check()).toEqual({ kind: 'logged-out' })
  ts.state = { kind: 'no-https', enableUrl: null }
  expect(await c.check()).toEqual({ kind: 'no-https', enableUrl: LINK })
  expect(ts.serveOn).toHaveBeenCalledTimes(2)
})

test('다시 해 보기 — 까닭은 끝날 때 한 번 정함(null 로 깜박이지 않음 · 같으면 사건도 없음)', async () => {
  const ts = fakeTailscale()
  ts.others.add(443).add(47615)
  const { c, emitted } = make({ ts, retryMs: 20 })
  await c.ready
  await c.set({ enabled: true })
  expect(c.state().problem).toMatch(/443.*47615/)
  const n = emitted.length
  await vi.waitFor(() => expect(ts.status.mock.calls.length).toBeGreaterThanOrEqual(4), { timeout: 3000 })
  expect(emitted.slice(n)).toEqual([])
  expect(emitted.filter((s) => s.settings.enabled).map((s) => s.problem)).not.toContain(null)
})

test('끄기 — serve 를 못 끄면 까닭 · 꺼진 채로도 잠시 뒤 다시 꺼 봄 · 끄면 그만', async () => {
  const ts = fakeTailscale()
  const { c, servers, power, emitted } = make({ ts, retryMs: 20 })
  await c.set({ enabled: true })
  ts.offError = new Error('tailscale 이 답하지 않아요')
  await c.set({ enabled: false })
  expect(c.state()).toMatchObject({ settings: { enabled: false }, url: null, problem: expect.stringMatching(/정리하지 못했어요/) })
  expect(saved().serve).toEqual({ httpsPort: 443, localPort: 47615, dnsName: DNS })
  expect(servers.last().closed).toBe(true)
  expect(power.on.size).toBe(0)
  await vi.waitFor(() => expect(ts.serveOff.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 3000 })
  expect(ts.routes.size).toBe(1)
  ts.offError = null
  await vi.waitFor(() => expect(c.state().problem).toBeNull(), { timeout: 3000 })
  expect(ts.routes.size).toBe(0)
  expect(saved().serve).toBeUndefined()
  expect(ts.status).toHaveBeenCalledTimes(1) // 정리엔 status 가 필요 없다 · 꺼진 채라 다시 열지도 않는다
  expect(ts.serveOn).toHaveBeenCalledTimes(1)
  const k = ts.serveOff.mock.calls.length
  await new Promise((r) => setTimeout(r, 120))
  expect(ts.serveOff.mock.calls.length).toBe(k)
  expect(emitted.at(-1)).toEqual(c.state())
})

test('경로가 든 오류는 화면·로그에 옮기지 않음 · 포트 기억을 못 적어도 길은 열림 · 길 기록을 못 적으면 열지 않음', async () => {
  const NAME = '홍길동' // 한국어 Windows 사용자 이름 — 경로에 들면 예전엔 '한국어 글' 로 보고 그대로 옮겼다
  // 길 기록(serve)을 못 적음(phone.json.tmp 자리에 폴더) — serveOn 을 부르지 않고 까닭은 고정된 글
  const dA = path.join(dir, 'a', NAME)
  const tmpA = path.join(dA, 'phone.json.tmp')
  const a = make({ dataDir: dA })
  a.ts.httpsPortFree.mockImplementation(async () => {
    fs.mkdirSync(tmpA, { recursive: true })
    return true
  })
  await a.c.set({ enabled: true })
  expect(a.ts.serveOn).not.toHaveBeenCalled()
  expect(a.c.state()).toMatchObject({ settings: { enabled: true }, url: null, problem: '휴대폰 연결을 켜지 못했어요' })
  expect(JSON.stringify(a.emitted)).not.toContain(NAME)
  expect(a.servers.last().closed).toBe(true)
  expect(a.power.start).not.toHaveBeenCalled()
  fs.rmSync(tmpA, { recursive: true, force: true })

  // 서버가 옮긴 포트·마지막 https 포트를 못 적음 — 길은 그대로 연다(다음엔 지난 값부터일 뿐) · 로그엔 고정된 글만
  const dB = path.join(dir, 'b', NAME)
  const tmpB = path.join(dB, 'phone.json.tmp')
  const servers = fakeServers({ bump: 1 })
  const start0 = servers.start.getMockImplementation()!
  servers.start.mockImplementation(async (opts: PhoneServerOptions) => {
    const s = await start0(opts)
    fs.mkdirSync(tmpB, { recursive: true })
    return s
  })
  const log = vi.fn()
  const b = make({ dataDir: dB, servers, log })
  b.ts.httpsPortFree.mockImplementation(async () => {
    fs.rmSync(tmpB, { recursive: true, force: true })
    return true
  })
  const on0 = b.ts.serveOn.getMockImplementation()!
  b.ts.serveOn.mockImplementation(async (h: number, l: number, d?: string) => {
    const r = await on0(h, l, d)
    fs.mkdirSync(tmpB, { recursive: true })
    return r
  })
  await b.c.set({ enabled: true })
  expect(b.c.state()).toMatchObject({ url: `https://${DNS}/mobile.html`, problem: null })
  expect(b.power.on.size).toBe(1)
  expect(saved(dB).serve).toEqual({ httpsPort: 443, localPort: 47616, dnsName: DNS })
  expect(saved(dB).settings.port).toBe(47615)
  expect(saved(dB).httpsPort).toBeUndefined()
  expect(log).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(log.mock.calls)).not.toContain(NAME)
  fs.rmSync(tmpB, { recursive: true, force: true })

  // 서버가 던진 시스템 오류(code·syscall·path) — 한국어 경로가 들어도 고정된 글
  const err = Object.assign(new Error(`EACCES: permission denied, open 'C:\\Users\\${NAME}\\x'`), { code: 'EACCES', syscall: 'open', path: `C:\\Users\\${NAME}\\x` })
  const cc = make({ dataDir: path.join(dir, 'c'), startServer: vi.fn(async () => { throw err }) })
  await cc.c.set({ enabled: true })
  expect(cc.c.state().problem).toBe('휴대폰 연결을 켜지 못했어요')
})

/** serveOn 을 붙잡아 두는 가짜 — release() 하면 진짜처럼(길을 열고 'on') 끝난다 */
function holdServeOn(ts: ReturnType<typeof fakeTailscale>) {
  const on0 = ts.serveOn.getMockImplementation()!
  const held = { release: () => {} }
  ts.serveOn.mockImplementationOnce(async (h: number, l: number, d?: string) => {
    await new Promise<void>((r) => (held.release = r))
    return on0(h, l, d)
  })
  return held
}

test('끄기는 바로 — 켜는 중(serveOn 기다림)이어도 꺼짐을 바로 적고, 켜기는 멈추며 연 것을 거둠(절전 안 막음)', async () => {
  const ts = fakeTailscale()
  const held = holdServeOn(ts)
  const { c, servers, power, emitted } = make({ ts })
  const turningOn = c.set({ enabled: true })
  await vi.waitFor(() => expect(ts.serveOn).toHaveBeenCalledTimes(1))
  const turningOff = c.set({ enabled: false })
  expect(saved().settings.enabled).toBe(false) // 기다리지 않고 바로 적는다
  held.release()
  await turningOn
  await turningOff
  expect(power.start).not.toHaveBeenCalled()
  expect(ts.routes.size).toBe(0)
  expect(saved().serve).toBeUndefined()
  expect(servers.last().closed).toBe(true)
  expect(servers.last().opts.allowedHost()).toBeNull()
  expect(c.state()).toMatchObject({ settings: { enabled: false }, url: null, problem: null })
  expect(emitted.some((s) => s.url !== null)).toBe(false)
  // 끈 뒤 다시 켜면 연다
  await c.set({ enabled: true })
  expect(c.state().url).toBe(`https://${DNS}/mobile.html`)
})

test('끄기 — 문은 그 자리에서 닫는다(앞에 줄 선 일이 Tailscale 을 기다려도): Host 거절 · 서버 닫기(소켓 끊김) · 절전 풀림 · 짝 맺기 닫힘', async () => {
  const ts = fakeTailscale()
  const { c, servers, power } = make({ ts })
  await c.set({ enabled: true })
  await c.pairStart()
  const s = servers.last()
  let release = () => {}
  ts.status.mockImplementationOnce(() => new Promise<TailscaleState>((r) => (release = () => r(READY))))
  const checking = c.check() // 줄 앞 — status 를 기다린다
  await vi.waitFor(() => expect(ts.status).toHaveBeenCalledTimes(2))
  const off = c.set({ enabled: false })
  // 줄 선 끄기(serve 끄기)가 돌기 전인데도 — 새 요청은 거절, 열린 소켓은 닫힘
  expect(ts.serveOff).not.toHaveBeenCalled()
  expect(s.opts.allowedHost()).toBeNull()
  expect(s.close).toHaveBeenCalledTimes(1)
  expect(s.closed).toBe(true)
  expect(power.on.size).toBe(0)
  expect(c.state()).toMatchObject({ url: null, pairing: null, connected: 0 })
  release()
  await checking
  await off
  expect(ts.serveOff).toHaveBeenCalledWith(443, 47615, DNS)
  expect(saved().serve).toBeUndefined()
  expect(s.close).toHaveBeenCalledTimes(1)
  expect(ts.serveOn).toHaveBeenCalledTimes(1) // 끈 뒤 확인이 다시 열지 않았다
  expect(c.state()).toMatchObject({ settings: { enabled: false }, url: null, problem: null })
})

test('https 포트를 볼 serve 설정을 못 읽으면 — 포트가 모두 쓰인다는 글이 아니라 따로 된 까닭(serve 안 부름)', async () => {
  const ts = fakeTailscale()
  ts.httpsPortFree.mockRejectedValue(new Error('Tailscale 의 serve 설정을 읽지 못했어요'))
  const { c, servers, power } = make({ ts })
  await c.set({ enabled: true })
  expect(c.state()).toMatchObject({ settings: { enabled: true }, url: null, problem: 'Tailscale 상태를 읽지 못했어요 — 잠시 뒤 다시 확인해 주세요' })
  expect(ts.serveOn).not.toHaveBeenCalled()
  expect(servers.last().closed).toBe(true)
  expect(power.start).not.toHaveBeenCalled()
  expect(saved().serve).toBeUndefined()
})

const FUNNEL = '이 포트가 인터넷에 공개(Funnel)돼 있어요 — Tailscale 에서 Funnel 을 꺼 주세요'

test('Funnel(인터넷 공개)이 켜진 포트는 쓰지 않음 — 지난 포트가 공개면 다음 포트 · 모두 못 쓰는데 공개가 끼면 그 까닭', async () => {
  seed({ httpsPort: 443 })
  const ts = fakeTailscale()
  ts.funnels.add(443)
  const { c } = make({ ts })
  await c.set({ enabled: true })
  expect(ts.serveOn).toHaveBeenCalledWith(47615, 47615, DNS)
  expect(c.state()).toMatchObject({ url: `https://${DNS}:47615/mobile.html`, problem: null })
  // 공개 때문에 비켜 간 포트는 기억한다 — 공개가 풀리면 돌아간다
  expect(saved()).toMatchObject({ httpsPort: 47615, funnelPort: 443 })

  const dB = path.join(dir, 'b')
  const tsB = fakeTailscale()
  tsB.funnels.add(443)
  tsB.others.add(47615)
  const b = make({ ts: tsB, dataDir: dB })
  await b.c.set({ enabled: true })
  expect(tsB.serveOn).not.toHaveBeenCalled()
  expect(b.c.state()).toMatchObject({ settings: { enabled: true }, url: null, problem: FUNNEL })
  expect(saved(dB).serve).toBeUndefined()
})

test('연 뒤에 그 포트에 Funnel 을 켜면 — 확인 때 두레 길·서버를 닫고 까닭 · 잠시 뒤 공개 아닌 포트로 다시', async () => {
  const ts = fakeTailscale()
  const { c, servers, power } = make({ ts, retryMs: 30 })
  await c.set({ enabled: true })
  await c.pairStart()
  const first = servers.last()
  ts.funnels.add(443)
  await c.check()
  expect(ts.serveOff).toHaveBeenCalledWith(443, 47615, DNS)
  expect(ts.routes.has(443)).toBe(false)
  expect(saved().serve).toBeUndefined()
  expect(first.closed).toBe(true)
  expect(first.opts.allowedHost()).toBeNull()
  expect(power.on.size).toBe(0)
  expect(c.state()).toMatchObject({ settings: { enabled: true }, url: null, pairing: null, problem: FUNNEL })
  await vi.waitFor(() => expect(c.state().url).toBe(`https://${DNS}:47615/mobile.html`), { timeout: 3000 })
  expect(c.state().problem).toBeNull()
  expect(ts.routes.has(443)).toBe(false)
  // 공개가 아니면 확인은 길을 건드리지 않는다(443 은 아직 공개 — 비었나만 본다)
  const offs = ts.serveOff.mock.calls.length
  await c.check()
  expect(ts.serveOff.mock.calls.length).toBe(offs)
  expect(ts.calls.slice(-3)).toEqual(['status', 'funnel 47615', 'free 443'])
})

test('켜진 채 PC 이름을 바꾸면 — 확인 때 예전 이름의 길을 닫고 지금 이름으로 다시 연다 · 예전 주소의 짝 맺기는 닫힘', async () => {
  const NEW = 'renamed-pc.tail0000.ts.net'
  const ts = fakeTailscale()
  const { c, servers, emitted } = make({ ts })
  await c.set({ enabled: true })
  await c.pairStart()
  ts.state = { kind: 'ready', dnsName: NEW }
  expect(await c.check()).toEqual({ kind: 'ready', dnsName: NEW })
  expect(ts.serveOff).toHaveBeenCalledWith(443, 47615, DNS)
  expect(ts.serveOn).toHaveBeenLastCalledWith(443, 47615, NEW)
  expect(ts.routes.get(443)).toEqual({ localPort: 47615, dnsName: NEW })
  expect(saved().serve).toEqual({ httpsPort: 443, localPort: 47615, dnsName: NEW })
  expect(c.state()).toMatchObject({ tailscale: { kind: 'ready', dnsName: NEW }, url: `https://${NEW}/mobile.html`, pairing: null, problem: null })
  // 예전 서버는 닫고(붙어 있던 휴대폰 소켓이 끊김) 같은 포트로 다시 — Host 는 새 이름
  expect(servers.made).toHaveLength(2)
  expect(servers.made[0].closed).toBe(true)
  expect(servers.last().opts.port).toBe(47615)
  expect(servers.last().opts.allowedHost()).toBe(NEW)
  expect(emitted.at(-1)).toEqual(c.state())
  expect(emitted.some((s) => s.url === `https://${DNS}/mobile.html` && s.tailscale?.kind === 'ready' && s.tailscale.dnsName === NEW)).toBe(false)
  // 이름이 그대로면 길을 건드리지 않는다
  const offs = ts.serveOff.mock.calls.length
  await c.check()
  expect(ts.serveOff.mock.calls.length).toBe(offs)
  expect(servers.made).toHaveLength(2)
})

test('켜진 채 PC 이름을 바꾸면 — 다시 열기 전에 문부터: 예전 주소를 거두어 알리고 서버를 닫는다(붙어 있던 휴대폰은 다시 여는 동안 아무것도 못 함)', async () => {
  const NEW = 'renamed-pc.tail0000.ts.net'
  const ts = fakeTailscale()
  const power = fakePower()
  const { c, servers, emitted } = make({ ts, power })
  await c.set({ enabled: true })
  const first = servers.last()
  first.list = [{ deviceId: 'd1', visible: true }]
  expect(c.state().connected).toBe(1)
  // 새 이름으로 여는 serveOn 을 붙잡아 둔다 — 그 사이를 본다
  const real = ts.serveOn.getMockImplementation()!
  let release: (() => void) | null = null
  ts.serveOn.mockImplementationOnce(async (h, l, d) => {
    await new Promise<void>((r) => (release = r))
    return real(h, l, d)
  })
  ts.state = { kind: 'ready', dnsName: NEW }
  const checking = c.check()
  await vi.waitFor(() => expect(release).not.toBeNull())
  expect(first.closed).toBe(true) // 예전 서버가 닫혀 소켓이 끊겼다
  expect(first.opts.allowedHost()).toBeNull() // 새 요청도 거절
  expect(power.on.size).toBe(0)
  expect(c.state()).toMatchObject({ url: null, connected: 0, pairing: null, tailscale: { kind: 'ready', dnsName: NEW } })
  expect(emitted.at(-1)).toEqual(c.state()) // PC 화면도 예전 주소를 더 보이지 않는다
  release!()
  await checking
  expect(c.state()).toMatchObject({ url: `https://${NEW}/mobile.html`, problem: null })
  expect(emitted.at(-1)?.url).toBe(`https://${NEW}/mobile.html`)
  expect(servers.made).toHaveLength(2)
  expect(power.on.size).toBe(1)
})

const MOVED = '주소가 바뀌었어요 — 휴대폰을 다시 짝 맺어 주세요'
const DEVICE = { id: 'd1', name: '폰1', createdAt: Date.now(), lastSeen: null, tokenHash: HASH }

test('Funnel 때문에 포트를 옮겨 다시 열면 — 짝 맺은 휴대폰이 있으면 주소가 바뀌었다는 알림 · 봤다고 하면 지운다', async () => {
  seed({ devices: [DEVICE] })
  const ts = fakeTailscale()
  const { c, emitted } = make({ ts, retryMs: 30 })
  await c.set({ enabled: true })
  expect(c.state()).toMatchObject({ url: `https://${DNS}/mobile.html`, notice: null }) // 처음 연 주소는 바뀐 게 아니다
  ts.funnels.add(443)
  await c.check()
  expect(c.state()).toMatchObject({ url: null, problem: FUNNEL, notice: null })
  await vi.waitFor(() => expect(c.state().url).toBe(`https://${DNS}:47615/mobile.html`), { timeout: 3000 })
  expect(c.state()).toMatchObject({ problem: null, notice: MOVED })
  expect(emitted.at(-1)?.notice).toBe(MOVED)
  // 알림은 설정의 휴대폰 탭에서 보거나 짝을 다시 맺을 때까지 남는다 — 확인을 해도 그대로
  await c.check()
  expect(c.state().notice).toBe(MOVED)
  c.noticeSeen()
  expect(c.state().notice).toBeNull()
  expect(emitted.at(-1)?.notice).toBeNull()
  c.noticeSeen() // 없으면 아무 일 없음
  expect(c.state().notice).toBeNull()
})

test("켜진 채 PC 이름을 바꿨는데 예전 이름의 길을 다른 serve 설정 때문에 못 지우면('left') — 멈추지 않고 비어 있는 포트로 다시 열고 둘 다 알린다", async () => {
  const LEFT = '예전 PC 이름으로 연 두레 길은 Tailscale 의 다른 serve 설정이 있어 지우지 않고 남겨 뒀어요'
  const NEW = 'renamed-pc.tail0000.ts.net'
  seed({ devices: [DEVICE] })
  const ts = fakeTailscale()
  ts.leave = true
  const { c, emitted } = make({ ts, retryMs: 30 })
  await c.set({ enabled: true })
  ts.state = { kind: 'ready', dnsName: NEW }
  await c.check()
  // 예전 길(443)은 남았다 — 443 은 쓰이는 채라 47615 로
  await vi.waitFor(() => expect(c.state().url).toBe(`https://${NEW}:47615/mobile.html`), { timeout: 3000 })
  expect(c.state()).toMatchObject({ problem: null, notice: `${MOVED}. ${LEFT}` })
  expect(emitted.at(-1)?.notice).toBe(`${MOVED}. ${LEFT}`)
  expect(saved().serve).toEqual({ httpsPort: 47615, localPort: 47615, dnsName: NEW }) // 예전 길의 기록은 지웠다(더 할 수 있는 게 없다)
  // 다시 확인해도 그 길을 또 건드리지 않는다(같은 까닭으로 계속 다시 해 보지 않음)
  const offs = ts.serveOff.mock.calls.length
  await c.check()
  expect(ts.serveOff.mock.calls.length).toBe(offs)
})

test('두레가 꺼진 사이(또는 다시 켜기 전에) PC 이름이 바뀌었으면 — 켤 때 주소가 바뀌었다고 알린다(phone.json 의 dnsName) · 같은 이름이면 안 알림', async () => {
  seed({ devices: [DEVICE], httpsPort: 443, dnsName: 'old-pc.tail0000.ts.net' })
  const { c } = make({ ts: fakeTailscale() })
  await c.set({ enabled: true })
  expect(c.state()).toMatchObject({ url: `https://${DNS}/mobile.html`, notice: MOVED })
  expect(saved().dnsName).toBe(DNS) // 이제 휴대폰이 알 이름
  await c.dispose()
})

test('켤 때 이름이 그대로면(phone.json 의 dnsName 과 같음) 주소가 바뀌었다는 알림 없음', async () => {
  seed({ devices: [DEVICE], httpsPort: 443, dnsName: DNS })
  const { c } = make({ ts: fakeTailscale() })
  await c.set({ enabled: true })
  expect(c.state()).toMatchObject({ url: `https://${DNS}/mobile.html`, notice: null })
})

test("PC 이름을 바꾼 뒤 끄는데 예전 이름의 길을 못 지우면('left') — 멈추지 않고(까닭 없음) 남겨 뒀다는 알림만 · 기록은 지운다", async () => {
  const LEFT = '예전 PC 이름으로 연 두레 길은 Tailscale 의 다른 serve 설정이 있어 지우지 않고 남겨 뒀어요'
  const ts = fakeTailscale()
  ts.leave = true
  const { c } = make({ ts, retryMs: 30 })
  await c.set({ enabled: true })
  ts.state = { kind: 'ready', dnsName: 'renamed-pc.tail0000.ts.net' }
  await c.set({ enabled: false })
  expect(c.state()).toMatchObject({ url: null, problem: null, notice: LEFT })
  expect(saved().serve).toBeUndefined()
})

test('주소가 바뀌었다는 알림 — 짝을 다시 맺으면(pairStart)·끄면 지운다 · 짝 맺은 휴대폰이 없으면 띄우지 않는다', async () => {
  seed({ devices: [DEVICE] })
  const ts = fakeTailscale()
  const { c } = make({ ts, retryMs: 30 })
  await c.set({ enabled: true })
  ts.funnels.add(443)
  await c.check()
  await vi.waitFor(() => expect(c.state().notice).toBe(MOVED), { timeout: 3000 })
  await c.pairStart()
  expect(c.state().notice).toBeNull()

  // 끄면 지운다 — 주소가 없다
  ts.funnels.delete(443)
  await c.check() // 443 으로 돌아가며 다시 알림
  expect(c.state()).toMatchObject({ url: `https://${DNS}/mobile.html`, notice: MOVED })
  await c.set({ enabled: false })
  expect(c.state()).toMatchObject({ url: null, notice: null })

  // 기기가 없으면 알릴 휴대폰도 없다
  const dB = path.join(dir, 'b')
  const tsB = fakeTailscale()
  const b = make({ ts: tsB, dataDir: dB, retryMs: 30 })
  await b.c.set({ enabled: true })
  tsB.funnels.add(443)
  await b.c.check()
  await vi.waitFor(() => expect(b.c.state().url).toBe(`https://${DNS}:47615/mobile.html`), { timeout: 3000 })
  expect(b.c.state().notice).toBeNull()
})

test('Funnel 을 끄면 47615 에 머물지 않는다 — 다음 확인 때 443 이 비고 공개가 아니면 돌아간다(문부터 닫고) · 남이 쓰면 그대로', async () => {
  seed({ devices: [DEVICE] })
  const ts = fakeTailscale()
  const { c, servers } = make({ ts, retryMs: 30 })
  await c.set({ enabled: true })
  ts.funnels.add(443)
  await c.check()
  await vi.waitFor(() => expect(c.state().url).toBe(`https://${DNS}:47615/mobile.html`), { timeout: 3000 })
  expect(saved()).toMatchObject({ httpsPort: 47615, funnelPort: 443 }) // 휴대폰이 아는 포트 · Funnel 때문에 비켜 간 포트
  c.noticeSeen()

  // 아직 공개면 그대로 — 443 이 비었나만 본다
  await c.check()
  expect(ts.calls.slice(-3)).toEqual(['status', 'funnel 47615', 'free 443'])
  expect(c.state().url).toBe(`https://${DNS}:47615/mobile.html`)
  // 공개를 껐는데 남이 쓰면 그대로
  ts.funnels.delete(443)
  ts.others.add(443)
  await c.check()
  expect(c.state()).toMatchObject({ url: `https://${DNS}:47615/mobile.html`, notice: null })
  // 비면 돌아간다 — 두레 길(47615)을 끄고 443 으로, 예전 서버는 닫는다
  ts.others.delete(443)
  const before = servers.last()
  before.list = [{ deviceId: 'd1', visible: true }]
  await c.check()
  expect(ts.serveOff).toHaveBeenLastCalledWith(47615, 47615, DNS)
  expect(ts.serveOn).toHaveBeenLastCalledWith(443, 47615, DNS)
  expect(before.closed).toBe(true)
  expect(ts.routes.has(47615)).toBe(false)
  expect(c.state()).toMatchObject({ url: `https://${DNS}/mobile.html`, problem: null, notice: MOVED })
  expect(saved().httpsPort).toBe(443)
  expect(saved().funnelPort).toBeUndefined()
  // 돌아온 뒤엔 확인이 길을 건드리지 않는다
  const offs = ts.serveOff.mock.calls.length
  await c.check()
  expect(ts.serveOff.mock.calls.length).toBe(offs)
  expect(ts.calls.slice(-2)).toEqual(['status', 'funnel 443'])
})

test('Funnel 때문에 비켜 간 채 다시 켜면(다음 시작도) — 그 포트가 비고 공개가 아니면 먼저 · 주소가 바뀌면 알림, 그대로면 없음', async () => {
  // 아직 공개 — 지난 포트(47615) 그대로, 주소가 안 바뀌었으니 알림 없음, 비켜 간 포트는 계속 기억
  seed({ settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true }, devices: [DEVICE], httpsPort: 47615, funnelPort: 443 })
  const ts = fakeTailscale()
  ts.funnels.add(443)
  const a = make({ ts })
  await a.c.ready
  expect(ts.calls).toEqual(['status', 'free 443', 'funnel 443', 'free 47615', `on 47615 47615 ${DNS}`])
  expect(a.c.state()).toMatchObject({ url: `https://${DNS}:47615/mobile.html`, notice: null })
  expect(saved()).toMatchObject({ httpsPort: 47615, funnelPort: 443 })
  await a.c.set({ enabled: false })

  // 공개를 끈 뒤 다시 켜면 443 — 휴대폰이 아는 주소(47615)와 다르니 알림
  ts.funnels.delete(443)
  await a.c.set({ enabled: true })
  expect(ts.serveOn).toHaveBeenLastCalledWith(443, 47615, DNS)
  expect(a.c.state()).toMatchObject({ url: `https://${DNS}/mobile.html`, notice: MOVED })
  expect(saved().httpsPort).toBe(443)
  expect(saved().funnelPort).toBeUndefined()
})

test('PC 이름이 바뀐 줄 모른 채 끄면 — 그 길이 지금 이름 아래로 옮겨졌어도 같은 짝(https 포트·로컬 포트)을 끈다', async () => {
  const NEW = 'renamed-pc.tail0000.ts.net'
  const ts = fakeTailscale()
  const { c } = make({ ts })
  await c.set({ enabled: true })
  // Tailscale 이 두레 길을 새 이름 아래로 옮긴 꼴 — 두레는 아직 확인 전이라 모른다
  ts.routes.set(443, { localPort: 47615, dnsName: NEW })
  ts.state = { kind: 'ready', dnsName: NEW }
  await c.set({ enabled: false })
  expect(ts.calls.slice(-3)).toEqual([`off 443 47615 ${DNS}`, 'status', `off 443 47615 ${NEW}`])
  expect(ts.routes.size).toBe(0)
  expect(saved().serve).toBeUndefined()
  expect(c.state().problem).toBeNull()
})

test('dispose — 켜는 중(serveOn 기다림)이어도 길·서버를 거두고 절전은 막지 않음 · 켜짐은 그대로', async () => {
  const ts = fakeTailscale()
  const held = holdServeOn(ts)
  const { c, servers, power } = make({ ts })
  const turningOn = c.set({ enabled: true })
  await vi.waitFor(() => expect(ts.serveOn).toHaveBeenCalledTimes(1))
  const done = c.dispose()
  held.release()
  await turningOn
  await done
  expect(power.start).not.toHaveBeenCalled()
  expect(ts.routes.size).toBe(0)
  expect(saved().serve).toBeUndefined()
  expect(servers.last().closed).toBe(true)
  expect(saved().settings.enabled).toBe(true)
})

test('dispose — 다시 해 보기 타이머가 걸려 있어도 풀고, 그 뒤로 tailscale 을 부르지 않음', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  seed({ settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true } })
  const ts = fakeTailscale({ kind: 'logged-out' })
  const { c } = make({ ts, retryMs: 1000 })
  await c.ready
  expect(vi.getTimerCount()).toBe(1)
  await c.dispose()
  expect(vi.getTimerCount()).toBe(0)
  ts.state = READY
  vi.advanceTimersByTime(5000)
  await new Promise<void>((r) => setImmediate(r))
  expect(ts.status).toHaveBeenCalledTimes(1)
  expect(ts.serveOn).not.toHaveBeenCalled()
})

test('check — 꺼져 있으면 status 만(서버·serve 없음)', async () => {
  const ts = fakeTailscale({ kind: 'no-https', enableUrl: null })
  const { c, servers } = make({ ts })
  expect(await c.check()).toEqual({ kind: 'no-https', enableUrl: null })
  expect(ts.calls).toEqual(['status'])
  expect(servers.start).not.toHaveBeenCalled()
  expect(c.state().tailscale).toEqual({ kind: 'no-https', enableUrl: null })
})

test('자동 켜기 — loginItem.set(바뀔 때만 · 휴대폰 연결을 꺼도 그대로)', async () => {
  const { c, loginItem } = make()
  await c.ready
  expect(loginItem.set).not.toHaveBeenCalled()
  await c.set({ openAtLogin: true })
  expect(loginItem.set).toHaveBeenLastCalledWith(true)
  await c.set({ openAtLogin: true })
  await c.set({ enabled: true, openAtLogin: true }) // 처음 켤 때 켬으로 — 화면이 같이 보낸다
  await c.set({ enabled: false })
  expect(loginItem.set).toHaveBeenCalledTimes(1)
  expect(saved().settings.openAtLogin).toBe(true)
  await c.set({ openAtLogin: false })
  expect(loginItem.set).toHaveBeenLastCalledWith(false)
  expect(loginItem.set).toHaveBeenCalledTimes(2)
})

test('절전 막기 — 길이 열린 동안만 · keepAwake 를 끄면 풀리고 켜면 다시', async () => {
  const { c, power } = make()
  await c.set({ keepAwake: true })
  expect(power.start).not.toHaveBeenCalled()
  await c.set({ enabled: true })
  expect(power.on.size).toBe(1)
  await c.set({ keepAwake: false })
  expect(power.on.size).toBe(0)
  await c.set({ keepAwake: true })
  expect(power.on.size).toBe(1)
  expect(power.start).toHaveBeenCalledTimes(2)
})

test('set — 불리언인 아는 칸만(포트·모르는 칸은 버림)', async () => {
  const { c } = make()
  await c.set({ notify: { finished: true }, port: 1234, keepAwake: 'yes' } as never)
  expect(saved().settings).toEqual({ ...DEFAULT_PHONE_SETTINGS, notify: { asks: true, finished: true } })
})

test('dispose — serveOff · 서버 닫기 · 절전 풀기 · 켜짐은 그대로(다음 시작 때 다시) · inbox 비움', async () => {
  const { c, ts, servers, power } = make()
  await c.set({ enabled: true })
  putInbox('aaaa-x.txt')
  await c.dispose()
  await c.dispose()
  expect(ts.serveOff).toHaveBeenCalledTimes(1)
  expect(ts.serveOff).toHaveBeenCalledWith(443, 47615, DNS)
  expect(servers.last().closed).toBe(true)
  expect(power.on.size).toBe(0)
  expect(saved().settings.enabled).toBe(true)
  expect(saved().serve).toBeUndefined()
  expect(inboxFiles()).toEqual([])
  // 끈 뒤엔 아무것도 하지 않는다
  await c.set({ enabled: false })
  await c.check()
  expect(ts.serveOff).toHaveBeenCalledTimes(1)
  expect(ts.status).toHaveBeenCalledTimes(1)
})

test('inbox — 시작 때 비움(올리기만 하고 안 보낸 파일)', async () => {
  putInbox('1111-a.pdf')
  putInbox('2222-b.png')
  const { c } = make()
  await c.ready
  expect(inboxFiles()).toEqual([])
})

test('짝 맺기 — QR·숫자·주소 · 상태엔 숫자·만료만(코드 없음) · 틀림 상한·취소·씀이면 상태에서 사라짐', async () => {
  const { c, servers, emitted } = make()
  await expect(c.pairStart()).rejects.toThrow('휴대폰 연결이 아직 열리지 않았어요')
  await c.set({ enabled: true })
  const offer = await c.pairStart()
  expect(offer.qr).toMatch(/^data:image\/png;base64,/)
  const code = /#pair=([0-9a-f]{64})$/.exec(offer.url)?.[1] ?? ''
  expect(offer.url).toBe(`https://${DNS}/mobile.html#pair=${code}`)
  expect(offer.pin).toMatch(/^\d{6}$/)
  expect(c.state().pairing).toEqual({ pin: offer.pin, expiresAt: offer.expiresAt })
  expect(emitted.at(-1)?.pairing).toEqual({ pin: offer.pin, expiresAt: offer.expiresAt })
  expect(JSON.stringify(c.state())).not.toContain(code)
  expect(JSON.stringify(emitted)).not.toContain(code)

  // 틀림 상한(짝 하나당 10번)으로 닫히면 PC 화면도 안다
  const { redeem } = servers.last().opts.pairing
  const wrong = offer.pin === '000000' ? '111111' : '000000'
  for (let i = 0; i < 9; i++) redeem(wrong, '폰', `from-${i}`)
  expect(c.state().pairing).not.toBeNull()
  redeem(wrong, '폰', 'from-9')
  expect(c.state().pairing).toBeNull()
  expect(emitted.at(-1)?.pairing).toBeNull()

  await c.pairStart()
  c.pairCancel()
  expect(c.state().pairing).toBeNull()
  expect(emitted.at(-1)?.pairing).toBeNull()

  // 맞는 숫자 — 기기가 생기고 짝은 닫힘
  const o2 = await c.pairStart()
  expect(redeem(o2.pin, '내 폰', 'x')).toHaveProperty('token')
  expect(c.state().pairing).toBeNull()
  expect(c.state().devices.map((d) => d.name)).toEqual(['내 폰'])
  expect(emitted.at(-1)?.devices).toHaveLength(1)
})

test('짝 맺기 — 5분이 지나면 상태에서 사라지고 phone 사건', async () => {
  const { c, emitted } = make()
  await c.set({ enabled: true })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await c.pairStart()
  expect(c.state().pairing).not.toBeNull()
  vi.advanceTimersByTime(PAIR_TTL_MS)
  expect(c.state().pairing).toBeNull()
  expect(emitted.at(-1)?.pairing).toBeNull()
})

test('끊기 — unpair 와 kick 을 같은 틱에', async () => {
  const { c, servers } = make()
  await c.set({ enabled: true })
  const s = servers.last()
  const offer = await c.pairStart()
  const r = s.opts.pairing.redeem(offer.pin, '폰', 'x')
  if (!('token' in r)) throw new Error('짝을 못 맺음')
  c.unpair(r.device.id)
  expect(s.kick).toHaveBeenCalledWith(r.device.id) // 기다리지 않고 바로
  expect(saved().devices).toEqual([])
  expect(s.opts.pairing.verify(r.token)).toBeNull()
  expect(c.state().devices).toEqual([])
})

test('idleDeviceExpires — 켤 때 30일 넘게 안 쓴 기기는 목록에서 빠지고(알림 구독도) 쓴 기기는 남는다', async () => {
  const DAY = 24 * 60 * 60 * 1000
  seed({
    devices: [
      { id: 'old', name: '옛 폰', createdAt: Date.now() - 90 * DAY, lastSeen: Date.now() - 31 * DAY, tokenHash: HASH, subscription: SUB },
      { id: 'new', name: '새 폰', createdAt: Date.now() - 90 * DAY, lastSeen: Date.now() - 29 * DAY, tokenHash: 'b'.repeat(64) },
    ],
  })
  const { c } = make()
  await c.set({ enabled: true })
  expect(c.state().devices.map((d) => d.id)).toEqual(['new'])
  expect(saved().devices.map((d: { id: string }) => d.id)).toEqual(['new'])
})

test('connected — 소켓이 열린 기기 수 · 바뀔 때만 phone 사건', async () => {
  const { c, servers, emitted } = make()
  await c.set({ enabled: true })
  const s = servers.last()
  const n = emitted.length
  s.list = [{ deviceId: 'd1', visible: false }, { deviceId: 'd1', visible: true }, { deviceId: 'd2', visible: false }]
  s.opts.onClients?.()
  expect(c.state().connected).toBe(2)
  expect(emitted.length).toBe(n + 1)
  expect(emitted.at(-1)?.connected).toBe(2)
  s.opts.onClients?.()
  expect(emitted.length).toBe(n + 1)
  // 어느 기기가 접속 중인지(PC 설정의 기기 목록 점) — 겹치지 않게, 차례는 늘 같게
  s.list = [{ deviceId: 'd2', visible: false }, { deviceId: 'd1', visible: true }, { deviceId: 'd2', visible: true }]
  s.opts.onClients?.()
  expect(c.state().online).toEqual(['d1', 'd2'])
  expect(emitted.length).toBe(n + 1) // 같은 상태 — 다시 안 보냄
  s.list = []
  s.opts.onClients?.()
  expect(emitted.at(-1)?.connected).toBe(0)
  expect(emitted.at(-1)?.online).toEqual([])
})

test('서버에 잇는 것 — 휴대폰 디스패처(휴대폰 메서드 거절) · 엔진 사건만 · VAPID·구독은 push · allowLocal', async () => {
  const engine = Object.assign(new EventEmitter(), { agents: () => [], heldInput: () => 0 })
  const { c, servers, inner, push, emitted } = make({ engine, allowLocal: true, log: vi.fn() })
  await c.set({ enabled: true })
  const s = servers.last()
  expect(s.opts.allowLocal).toBe(true)
  expect(s.opts.inboxDir).toBe(inboxOf())
  expect(s.opts.staticDir).toBe(path.join(dir, 'static'))

  for (const m of ['phoneState', 'setPhone', 'phoneCheck', 'phonePairStart', 'phonePairCancel', 'phoneUnpair', 'phoneNoticeSeen', 'setPrefs', 'pickFolder']) {
    expect(await s.opts.dispatch(m, [{ enabled: false }]), m).toEqual({ ok: false, error: PHONE_DENIED })
  }
  expect(inner).not.toHaveBeenCalled()
  expect(await s.opts.dispatch('snapshot', [])).toEqual({ ok: true, value: 'snapshot' })
  expect(inner).toHaveBeenCalledWith('snapshot', [])

  const got: string[] = []
  const before = EVENT_NAMES.map((n) => engine.listenerCount(n))
  const off = s.opts.subscribe((name) => got.push(name))
  for (const name of EVENT_NAMES) engine.emit(name, {})
  await c.set({ keepAwake: false }) // 앱 사건 phone 은 휴대폰에 가지 않는다
  expect(emitted.at(-1)?.settings.keepAwake).toBe(false)
  expect(got).toEqual([...EVENT_NAMES])
  off()
  engine.emit('status', {})
  expect(got).toHaveLength(EVENT_NAMES.length)
  expect(EVENT_NAMES.map((n) => engine.listenerCount(n))).toEqual(before) // 다 풀림(알림 판단의 것만 남음)

  expect(s.opts.vapidKey()).toBe('PUBKEY')
  await s.opts.onSubscribe('d1', SUB)
  expect(push.subscribe).toHaveBeenCalledWith('d1', SUB)
})

test('알림 — PC 쓰는 중(idle active)이면 안 보냄 · 화면 보는 기기는 건너뜀', async () => {
  seed({
    devices: [
      { id: 'd1', name: '폰1', createdAt: Date.now(), lastSeen: null, tokenHash: HASH, subscription: SUB },
      { id: 'd2', name: '폰2', createdAt: Date.now(), lastSeen: null, tokenHash: 'b'.repeat(64), subscription: { ...SUB, endpoint: 'https://fcm.googleapis.com/fcm/send/def' } },
    ],
  })
  const engine = Object.assign(new EventEmitter(), { agents: () => [{ id: 'a1', name: '백엔드' }], heldInput: () => 0 })
  const { c, servers, push, idle } = make({ engine })
  await c.set({ enabled: true })
  const ask = (id: string) => engine.emit('request', { id, agentId: 'a1', toolName: 'Bash', input: { command: 'rm -rf x' }, kind: 'permission', createdAt: 1 })
  const sentTo = () => push.sendTo.mock.calls.map((x) => (x as unknown[])[0])

  ask('q1')
  await vi.waitFor(() => expect(sentTo()).toEqual(['d1', 'd2']))
  idle.now = 'active'
  ask('q2')
  idle.now = 'locked'
  servers.last().list = [{ deviceId: 'd1', visible: true }]
  ask('q3')
  await vi.waitFor(() => expect(sentTo()).toEqual(['d1', 'd2', 'd2']))
})

test('알림 — PC 쓰는 중이라 미룬 것은 잠그면(lock-screen) 보냄 · 화면 보던 휴대폰이 나가면(onVisible) 그 휴대폰에 · dispose 면 잠금 신호를 풂', async () => {
  seed({
    devices: [
      { id: 'd1', name: '폰1', createdAt: Date.now(), lastSeen: null, tokenHash: HASH, subscription: SUB },
      { id: 'd2', name: '폰2', createdAt: Date.now(), lastSeen: null, tokenHash: 'b'.repeat(64), subscription: { ...SUB, endpoint: 'https://fcm.googleapis.com/fcm/send/def' } },
    ],
  })
  const engine = Object.assign(new EventEmitter(), { agents: () => [{ id: 'a1', name: '백엔드' }], heldInput: () => 0 })
  const away = new Set<() => void>()
  const polls: (() => void)[] = []
  const { c, servers, push, idle } = make({
    engine,
    pcAway: (fn) => {
      away.add(fn)
      return () => away.delete(fn)
    },
    every: (_ms, fn) => {
      polls.push(fn)
      return () => polls.splice(polls.indexOf(fn), 1)
    },
  })
  await c.set({ enabled: true })
  expect(away.size).toBe(1)
  const sentTo = () => push.sendTo.mock.calls.map((x) => (x as unknown[])[0])

  idle.now = 'active' // PC 앞에서 승인 요청이 왔다
  engine.emit('request', { id: 'q1', agentId: 'a1', toolName: 'Bash', input: { command: 'rm -rf x' }, kind: 'permission', createdAt: 1 })
  await new Promise((r) => setTimeout(r, 0))
  expect(sentTo()).toEqual([])
  expect(polls).toHaveLength(1)

  servers.last().list = [{ deviceId: 'd1', visible: true }] // d1 은 두레 화면을 보는 중
  for (const f of [...away]) f() // 잠갔다 — 그 순간 idle 이 아직 active 로 읽혀도
  await vi.waitFor(() => expect(sentTo()).toEqual(['d2']))
  idle.now = 'locked' // 잠긴 뒤엔 getSystemIdleState 도 locked
  servers.last().list = [{ deviceId: 'd1', visible: false }]
  servers.last().opts.onVisible?.('d1', false) // d1 이 화면을 떠났다
  await vi.waitFor(() => expect(sentTo()).toEqual(['d2', 'd1']))
  expect(polls).toHaveLength(0)
  expect(JSON.stringify(push.sendTo.mock.calls)).not.toContain('rm -rf')

  await c.dispose()
  expect(away.size).toBe(0)
})

test('phoneStaticDir — 개발은 out/renderer · 설치본은 app.asar.unpacked 안', () => {
  const dev = path.join('C:\\work\\dure', 'out', 'main')
  expect(phoneStaticDir(dev, false)).toBe(path.join('C:\\work\\dure', 'out', 'renderer'))
  const packed = path.join('C:\\Users\\u\\AppData\\Local\\Programs\\Dure', 'resources', 'app.asar', 'out', 'main')
  expect(phoneStaticDir(packed, true)).toBe(path.join('C:\\Users\\u\\AppData\\Local\\Programs\\Dure', 'resources', 'app.asar.unpacked', 'out', 'renderer'))
})

/** 빈 포트 하나 — 진짜 서버 시험용 */
async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

test('진짜 서버 — 짝 맺기 → 기기·짝 닫힘이 상태에 · 끊기면 소켓이 바로 닫힘', async () => {
  const port = await freePort()
  seed({ settings: { ...DEFAULT_PHONE_SETTINGS, port } })
  const { c, emitted } = make({ startServer: startPhoneServer })
  await c.set({ enabled: true })
  expect(c.state().url).toBe(`https://${DNS}/mobile.html`)
  const offer = await c.pairStart()
  const headers = { host: DNS, origin: `https://${DNS}`, 'content-type': 'application/json' }
  const res = await new Promise<{ status: number; cookie: string; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/pair', headers }, (r) => {
      const chunks: Buffer[] = []
      r.on('data', (d: Buffer) => chunks.push(d))
      r.on('end', () => resolve({ status: r.statusCode ?? 0, cookie: String(r.headers['set-cookie']?.[0] ?? ''), body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ secret: offer.pin, name: '진짜 폰' }))
  })
  expect(res.status).toBe(200)
  expect(c.state().pairing).toBeNull()
  expect(c.state().devices.map((d) => d.name)).toEqual(['진짜 폰'])
  expect(emitted.at(-1)?.devices).toHaveLength(1)

  const token = new RegExp(`${PHONE_COOKIE}=([^;]+)`).exec(res.cookie)?.[1] ?? ''
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { Host: DNS, Origin: `https://${DNS}`, Cookie: `${PHONE_COOKIE}=${token}` } })
  cleanup.push(() => ws.terminate())
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  await vi.waitFor(() => expect(c.state().connected).toBe(1))
  c.unpair(res.body.device.id)
  expect(await closed).toBe(4401)
  expect(c.state().connected).toBe(0)
  expect(c.state().devices).toEqual([])
  await c.set({ enabled: false })
  await expect(
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/' }, resolve)
      req.on('error', reject)
      req.end()
    }),
  ).rejects.toThrow()
})

test('진짜 서버 — 끄면 serve 를 끄기 전에(Tailscale 이 늦어도) 열린 소켓이 닫힌다', async () => {
  const port = await freePort()
  seed({ settings: { ...DEFAULT_PHONE_SETTINGS, port } })
  const ts = fakeTailscale()
  const { c } = make({ ts, startServer: startPhoneServer })
  await c.set({ enabled: true })
  const offer = await c.pairStart()
  const headers = { host: DNS, origin: `https://${DNS}`, 'content-type': 'application/json' }
  const cookie = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/pair', headers }, (r) => {
      r.resume()
      r.on('end', () => resolve(String(r.headers['set-cookie']?.[0] ?? '').split(';')[0]))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ secret: offer.pin, name: '폰' }))
  })
  expect(cookie.startsWith(`${PHONE_COOKIE}=`)).toBe(true)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { Host: DNS, Origin: `https://${DNS}`, Cookie: cookie } })
  cleanup.push(() => ws.terminate())
  const closed = new Promise<void>((r) => ws.on('close', () => r()))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  // serve 끄기가 끝나지 않는다(Tailscale 이 답하지 않음) — 그래도 소켓은 바로 닫힌다
  let release = (_: boolean) => {}
  ts.serveOff.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)))
  const off = c.set({ enabled: false })
  await closed
  await vi.waitFor(() => expect(ts.serveOff).toHaveBeenCalledTimes(1)) // 길 끄기는 아직 기다리는 중
  release(true)
  await off
})

// ── 안드로이드 앱 ──────────────────────────────────────────────────────────
const putApk = (info: Record<string, unknown>, d = dir) => {
  const a = path.join(d, 'android')
  fs.mkdirSync(a, { recursive: true })
  fs.writeFileSync(path.join(a, 'dure.apk'), 'APK')
  fs.writeFileSync(path.join(a, 'dure.apk.json'), JSON.stringify(info))
}
const REAL = { versionCode: 3, versionName: '1.2.0', packageName: 'io.github.choiy4432.dure' }
const TEST = { ...REAL, packageName: 'io.github.choiy4432.dure.test' }

test('안드로이드 앱 — 진짜 apk 가 있으면 상태에 그 판, 서버에 apk 경로와 판 번호', async () => {
  putApk(REAL)
  const { c, servers } = make()
  await c.ready
  expect(c.state().androidApp).toEqual({ versionCode: 3, versionName: '1.2.0' })
  await c.set({ enabled: true })
  const a = servers.last().opts.android!()
  expect(a.apk).toEqual({ path: path.join(dir, 'android', 'dure.apk'), versionCode: 3, packageName: 'io.github.choiy4432.dure' })
  expect(a.statements).toHaveLength(1) // 진짜 앱만
})

test('안드로이드 앱 — apk 가 없으면 null (상태·서버 모두)', async () => {
  const { c, servers } = make()
  await c.ready
  expect(c.state().androidApp).toBeNull()
  await c.set({ enabled: true })
  const a = servers.last().opts.android!()
  expect(a.apk).toBeNull()
  // 앱 파일이 없어도 assetlinks.json 은 낸다(Review Focus 3) — 진짜 앱 하나
  expect(a.statements).toHaveLength(1)
})

test('안드로이드 앱 — 시험 패키지 apk 는 진짜 빌드에서 null · 시험 빌드(androidTest)에서만 받는다', async () => {
  putApk(TEST)
  const real = make()
  await real.c.ready
  expect(real.c.state().androidApp).toBeNull()
  await real.c.set({ enabled: true })
  expect(real.servers.last().opts.android!().apk).toBeNull()

  const t = make({ androidTest: true })
  await t.c.ready
  expect(t.c.state().androidApp).toEqual({ versionCode: 3, versionName: '1.2.0' })
  await t.c.set({ enabled: true })
  expect(t.servers.last().opts.android!().apk).toMatchObject({ versionCode: 3, packageName: 'io.github.choiy4432.dure.test' })
  expect(t.servers.last().opts.android!().statements).toHaveLength(2)
})

test('안드로이드 앱 — 모르는 패키지는 시험 빌드에서도 null', async () => {
  putApk({ ...REAL, packageName: 'com.example.other' })
  const { c } = make({ androidTest: true })
  await c.ready
  expect(c.state().androidApp).toBeNull()
})

test('하루 한 번 30일 넘게 안 쓴 기기를 정리 — 오래 켜 둬도 낡은 기기가 목록에 남지 않고, dispose 가 타이머를 푼다', async () => {
  const DAY = 24 * 60 * 60 * 1000
  const t0 = Date.parse('2026-11-10T00:00:00Z')
  let now = t0
  const dev = (id: string) => ({ id, name: id, createdAt: t0, lastSeen: t0, tokenHash: id.padEnd(64, 'a') })
  seed({ devices: [dev('a'), dev('b')] })
  const ticks: { ms: number; fn: () => void }[] = []
  const stopped = vi.fn()
  const { c } = make({ now: () => now, sweepEvery: (ms, fn) => (ticks.push({ ms, fn }), stopped) })
  await c.ready
  expect(ticks.map((t) => t.ms)).toEqual([DAY])
  now = t0 + PHONE_IDLE_MS - DAY // 아직 30일 전
  ticks[0].fn()
  expect(c.state().devices.map((d) => d.id)).toEqual(['a', 'b'])
  now = t0 + PHONE_IDLE_MS + DAY // 켜 둔 채 30일을 넘김
  ticks[0].fn()
  expect(c.state().devices).toEqual([])
  expect(saved().devices).toEqual([])
  await c.dispose()
  expect(stopped).toHaveBeenCalledTimes(1)
  const before = ticks.length
  ticks[0].fn() // dispose 뒤엔 아무것도 안 한다
  expect(ticks).toHaveLength(before)
})

test('routeRecheckOnResume — 켜짐 + 길 열림일 때 깨어남 신호가 길을 한 번 확인 · 꺼져 있으면 안 함 · dispose 가 듣기를 푼다', async () => {
  const resumes = new Set<() => void>()
  const unhook = vi.fn()
  const ts = fakeTailscale()
  const { c } = make({
    ts,
    pcResume: (fn) => {
      resumes.add(fn)
      return () => (unhook(), resumes.delete(fn))
    },
    routeEvery: () => () => {},
  })
  await c.ready
  const wake = () => {
    for (const f of [...resumes]) f()
  }
  // 꺼져 있다 — Tailscale 을 부르지 않는다
  const n0 = ts.status.mock.calls.length
  wake()
  await new Promise((r) => setTimeout(r, 20))
  expect(ts.status.mock.calls.length).toBe(n0)

  await c.set({ enabled: true })
  expect(c.state().url).not.toBeNull()
  const before = ts.status.mock.calls.length
  wake()
  await vi.waitFor(() => expect(ts.status.mock.calls.length).toBe(before + 1))

  // PC 이름이 바뀐 채 깨어났다 — 새 이름으로 다시 연다
  ts.state = { kind: 'ready', dnsName: 'renamed-pc.tail0000.ts.net' }
  wake()
  await vi.waitFor(() => expect(c.state().url).toBe('https://renamed-pc.tail0000.ts.net/mobile.html'))

  await c.set({ enabled: false })
  const off = ts.status.mock.calls.length
  wake()
  await new Promise((r) => setTimeout(r, 20))
  expect(ts.status.mock.calls.length).toBe(off)

  await c.dispose()
  expect(unhook).toHaveBeenCalledTimes(1)
  expect(resumes.size).toBe(0)
})

test('routeRecheckEvery10min — 켜짐 + 길 열림인 동안만 10분 타이머 · 끄면 멈춤 · dispose 가 정리', async () => {
  const MIN10 = 10 * 60 * 1000
  const timers: { ms: number; fn: () => void; stopped: boolean }[] = []
  const ts = fakeTailscale()
  const { c } = make({
    ts,
    routeEvery: (ms, fn) => {
      const t = { ms, fn, stopped: false }
      timers.push(t)
      return () => {
        t.stopped = true
      }
    },
  })
  await c.ready
  expect(timers).toHaveLength(0) // 꺼져 있다 — 타이머 없음

  await c.set({ enabled: true })
  expect(timers.map((t) => t.ms)).toEqual([MIN10])
  expect(timers[0].stopped).toBe(false)

  // 10분이 지나면 길을 한 번 확인 — 이름이 바뀌었으면 새 이름으로
  const before = ts.status.mock.calls.length
  timers[0].fn()
  await vi.waitFor(() => expect(ts.status.mock.calls.length).toBe(before + 1))
  ts.state = { kind: 'ready', dnsName: 'renamed-pc.tail0000.ts.net' }
  timers[0].fn()
  await vi.waitFor(() => expect(c.state().url).toBe('https://renamed-pc.tail0000.ts.net/mobile.html'))
  // 다시 열어도 타이머는 하나만 돈다
  expect(timers.filter((t) => !t.stopped)).toHaveLength(1)

  await c.set({ enabled: false })
  expect(timers.every((t) => t.stopped)).toBe(true)
  const off = ts.status.mock.calls.length
  timers[timers.length - 1].fn() // 멈춘 뒤 늦게 울려도 아무것도 안 한다
  await new Promise((r) => setTimeout(r, 20))
  expect(ts.status.mock.calls.length).toBe(off)

  await c.set({ enabled: true })
  expect(timers.filter((t) => !t.stopped)).toHaveLength(1)
  await c.dispose()
  expect(timers.every((t) => t.stopped)).toBe(true)
})
