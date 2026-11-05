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
import { DEFAULT_PHONE_SETTINGS, PAIR_TTL_MS, type PhoneState, type TailscaleState } from '../src/shared/phoneTypes'
import { PHONE_COOKIE } from '../src/shared/phoneWire'

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
    routes, others, calls,
    status: vi.fn(async (): Promise<TailscaleState> => {
      log('status')
      return t.state
    }),
    httpsPortFree: vi.fn(async (p: number) => {
      log(`free ${p}`)
      return !others.has(p) && !routes.has(p)
    }),
    serveOn: vi.fn(async (h: number, l: number, d?: string) => {
      log(`on ${h} ${l} ${d ?? '-'}`)
      const r = t.onResult
      if (r && !(r instanceof Error)) return r
      routes.set(h, { localPort: l, dnsName: d })
      if (r instanceof Error) throw r
      return { kind: 'on' as const }
    }),
    serveOff: vi.fn(async (h: number, l: number, d?: string) => {
      log(`off ${h} ${l} ${d ?? '-'}`)
      if (t.offError) throw t.offError
      const r = routes.get(h)
      if (!r || r.localPort !== l || (d !== undefined && r.dnsName !== d)) return false
      routes.delete(h)
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
  const push = { publicKey: vi.fn(() => 'PUBKEY'), subscribe: vi.fn(), sendTo: vi.fn(async () => {}) }
  const idle = { now: 'locked' as 'active' | 'idle' | 'locked' | 'unknown' }
  const dataDir = over.dataDir ?? dir
  const c = createPhoneController({
    engine: null,
    dispatch: inner,
    staticDir: path.join(dataDir, 'static'),
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
  expect(order).toEqual(['off 443 47615 fake-pc.tail0000.ts.net', 'close', 'power off'])
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
  s.list = []
  s.opts.onClients?.()
  expect(emitted.at(-1)?.connected).toBe(0)
})

test('서버에 잇는 것 — 휴대폰 디스패처(휴대폰 메서드 거절) · 엔진 사건만 · VAPID·구독은 push · allowLocal', async () => {
  const engine = Object.assign(new EventEmitter(), { agents: () => [], heldInput: () => 0 })
  const { c, servers, inner, push, emitted } = make({ engine, allowLocal: true, log: vi.fn() })
  await c.set({ enabled: true })
  const s = servers.last()
  expect(s.opts.allowLocal).toBe(true)
  expect(s.opts.inboxDir).toBe(inboxOf())
  expect(s.opts.staticDir).toBe(path.join(dir, 'static'))

  for (const m of ['phoneState', 'setPhone', 'phoneCheck', 'phonePairStart', 'phonePairCancel', 'phoneUnpair', 'setPrefs', 'pickFolder']) {
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
      { id: 'd1', name: '폰1', createdAt: 1, lastSeen: null, tokenHash: HASH, subscription: SUB },
      { id: 'd2', name: '폰2', createdAt: 1, lastSeen: null, tokenHash: 'b'.repeat(64), subscription: { ...SUB, endpoint: 'https://fcm.googleapis.com/fcm/send/def' } },
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
