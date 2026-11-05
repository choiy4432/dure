import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { startPhoneServer, type PhoneServerOptions } from '../src/main/phone/phoneServer'
import { PHONE_CLOSE_UNPAIRED, PHONE_COOKIE, PHONE_WS_MESSAGE_MAX } from '../src/shared/phoneWire'
import { ATTACH_MAX_BYTES } from '../src/shared/attachments'
import type { PhoneDevice } from '../src/shared/phoneTypes'
import type { InvokeResult } from '../src/shared/ipcContract'

// 휴대폰 서버 — 진짜 http·ws 를 127.0.0.1 무작위 포트에, 가짜 디스패처·짝 맺기. 임시 폴더만

const HOST = 'pc.tail1234.ts.net:47615'
const ORIGIN = `https://${HOST}`
const GOOD_SECRET = '123456'

type Res = { status: number; headers: http.IncomingHttpHeaders; text: string }

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-phone-srv-'))
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }))
  return d
}

function fakePairing() {
  const tokens = new Map<string, PhoneDevice>()
  const calls = { redeem: [] as [string, string, string][], verify: 0, touch: [] as string[] }
  let n = 0
  return {
    calls,
    tokens,
    redeem(secret: string, name: string, from: string) {
      calls.redeem.push([secret, name, from])
      if (secret === 'locked') return { error: 'locked' as const }
      if (secret === 'old') return { error: 'expired' as const }
      if (secret !== GOOD_SECRET) return { error: 'wrong' as const }
      const device: PhoneDevice = { id: `dev${++n}`, name, createdAt: 1, lastSeen: 1, push: false }
      const token = crypto.randomBytes(32).toString('base64url')
      tokens.set(token, device)
      return { token, device }
    },
    verify(token: string) {
      calls.verify++
      return tokens.get(token) ?? null
    },
    touch(id: string) {
      calls.touch.push(id)
    },
    unpair(id: string) {
      for (const [t, d] of tokens) if (d.id === id) tokens.delete(t)
    },
    /** 짝 맺은 기기 하나를 바로 만든다 — 쿠키 값 */
    add(id = 'dev-a'): string {
      const token = crypto.randomBytes(32).toString('base64url')
      tokens.set(token, { id, name: '내 휴대폰', createdAt: 1, lastSeen: 1, push: false })
      return token
    },
  }
}

async function setup(over: Partial<PhoneServerOptions> = {}) {
  const root = tempDir()
  const staticDir = path.join(root, 'static')
  const inboxDir = path.join(root, 'inbox')
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'mobile.html'), '<!doctype html><title>두레</title>')
  fs.writeFileSync(path.join(staticDir, 'assets', 'app-abc.js'), 'console.log(1)')
  fs.writeFileSync(path.join(staticDir, 'assets', 'app-abc.css'), 'body{}')
  fs.writeFileSync(path.join(staticDir, 'assets', 'font.woff2'), Buffer.from([1, 2, 3]))
  fs.writeFileSync(path.join(staticDir, 'sw.js'), 'self.addEventListener("push", () => {})')
  fs.writeFileSync(path.join(staticDir, 'manifest.webmanifest'), '{"name":"두레"}')
  fs.writeFileSync(path.join(staticDir, 'notes.txt'), 'not served')
  fs.writeFileSync(path.join(staticDir, '.hidden.js'), 'hidden')
  fs.writeFileSync(path.join(root, 'secret.js'), 'SECRET')
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET')

  const pairing = fakePairing()
  const dispatched: [string, unknown[]][] = []
  let forward: ((name: string, payload: unknown) => void) | null = null
  let unsubscribed = 0
  const subscribed: [string, unknown][] = []
  const visible: [string, boolean][] = []
  let clientsChanged = 0
  const opts: PhoneServerOptions = {
    port: 0,
    allowedHost: () => HOST,
    pairing,
    dispatch: async (method, args): Promise<InvokeResult> => {
      dispatched.push([method, args])
      if (method === 'boom') return { ok: false, error: '안 돼요' }
      return { ok: true, value: { method, args } }
    },
    subscribe: (f) => {
      forward = f
      return () => {
        unsubscribed++
        forward = null
      }
    },
    staticDir,
    inboxDir,
    vapidKey: () => 'PUBLIC-KEY',
    onSubscribe: (id, sub) => {
      subscribed.push([id, sub])
    },
    onVisible: (id, on) => {
      visible.push([id, on])
    },
    onClients: () => {
      clientsChanged++
    },
    ...over,
  }
  const server = await startPhoneServer(opts)
  cleanup.push(() => server.close())
  return {
    server,
    root,
    staticDir,
    inboxDir,
    pairing,
    dispatched,
    subscribed,
    visible,
    get clientsChanged() { return clientsChanged },
    get unsubscribed() { return unsubscribed },
    emit: (name: string, payload: unknown) => forward?.(name, payload),
  }
}

function request(
  port: number,
  o: { method?: string; path: string; headers?: Record<string, string | undefined>; body?: string | Buffer },
): Promise<Res> {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries({ host: HOST, ...o.headers })) if (v !== undefined) headers[k] = v
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(o.body)
  })
}

const json = (r: Res) => JSON.parse(r.text)
const cookie = (token: string) => `${PHONE_COOKIE}=${token}`
const post = (port: number, p: string, body: unknown, headers: Record<string, string | undefined> = {}) =>
  request(port, {
    method: 'POST',
    path: p,
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

type Conn = { ws: WebSocket; next(): Promise<any>; closed: Promise<[number, string]> }

function connect(port: number, headers: Record<string, string | undefined>, opts: WebSocket.ClientOptions = {}): Promise<Conn> {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries({ Host: HOST, Origin: ORIGIN, ...headers })) if (v !== undefined) h[k] = v
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { ...opts, headers: h })
    const queue: any[] = []
    const waiters: ((m: any) => void)[] = []
    ws.on('message', (d) => {
      const m = JSON.parse(String(d))
      const w = waiters.shift()
      if (w) w(m)
      else queue.push(m)
    })
    const closed = new Promise<[number, string]>((r) => ws.on('close', (code, reason) => r([code, String(reason)])))
    ws.on('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`status ${res.statusCode}`), { status: res.statusCode }))
      res.resume()
      ws.terminate()
    })
    ws.on('error', (e) => reject(e))
    ws.on('open', () => {
      cleanup.push(() => ws.terminate())
      resolve({
        ws,
        next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
        closed,
      })
    })
  })
}

const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tick = () => sleep(30)
/** ms 안에 안 끝나면 'timeout' */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'timeout' as const)])
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('기다려도 오지 않음')
    await sleep(10)
  }
}
const inbox = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])

/** 몸을 시험이 나눠 보내는 POST — res 는 답(연결이 끊기면 거절) */
function streaming(port: number, p: string, headers: Record<string, string>) {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { host: HOST, ...headers } })
  const res = new Promise<Res>((resolve, reject) => {
    req.on('response', (rs) => {
      const chunks: Buffer[] = []
      rs.on('data', (c: Buffer) => chunks.push(c))
      rs.on('end', () => resolve({ status: rs.statusCode ?? 0, headers: rs.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
  })
  req.flushHeaders()
  return { req, res }
}

const pushSub = () => ({
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  expirationTime: null,
  keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
})

describe('phoneServer', () => {
  it('토큰 없음·틀린 Host·틀린 Origin — 거절, 디스패처 안 부름', async () => {
    const t = await setup()
    const port = t.server.port
    const token = t.pairing.add()

    // 틀린 Host — 정적 파일·API 모두 403(127.0.0.1 로 바로 부르는 PC 의 웹 페이지 · DNS 재바인딩)
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'evil.example:47615', 'pc.tail1234.ts.net:1', 'pc.tail1234.ts.net']) {
      expect((await request(port, { path: '/', headers: { host } })).status).toBe(403)
      expect((await post(port, '/api/pair', { secret: GOOD_SECRET, name: 'x' }, { host })).status).toBe(403)
      expect((await request(port, { path: '/api/vapid', headers: { host, cookie: cookie(token) } })).status).toBe(403)
      expect(await statusOf(connect(port, { Host: host, Cookie: cookie(token) }))).toBe(403)
    }
    const r403 = await request(port, { path: '/', headers: { host: 'evil.example' } })
    expect(json(r403).ok).toBe(false)
    expect(json(r403).error).toMatch(/[가-힣]/)
    expect(r403.text).not.toMatch(/[A-Za-z]:\\|\/tmp|at .*\(/)

    // 상태를 바꾸는 요청·WebSocket — Origin 이 그 https 주소여야
    for (const origin of [undefined, 'https://evil.example', `http://${HOST}`, 'null', `https://${HOST}.evil.example`]) {
      expect((await post(port, '/api/pair', { secret: GOOD_SECRET, name: 'x' }, { origin })).status).toBe(403)
      expect((await post(port, '/api/subscribe', { subscription: {} }, { origin, cookie: cookie(token) })).status).toBe(403)
      expect((await request(port, { method: 'POST', path: '/api/upload?name=a.txt', headers: { origin, cookie: cookie(token) }, body: 'abc' })).status).toBe(403)
      expect(await statusOf(connect(port, { Origin: origin, Cookie: cookie(token) }))).toBe(403)
    }

    // 토큰 없음·틀림 — 401
    for (const c of [undefined, cookie('nope'), `${PHONE_COOKIE}=`, `other=${token}`]) {
      expect(await statusOf(connect(port, { Cookie: c }))).toBe(401)
      expect((await request(port, { method: 'POST', path: '/api/upload?name=a.txt', headers: { origin: ORIGIN, cookie: c }, body: 'abc' })).status).toBe(401)
      expect((await post(port, '/api/subscribe', { subscription: {} }, { cookie: c })).status).toBe(401)
      expect((await request(port, { path: '/api/vapid', headers: { cookie: c } })).status).toBe(401)
      expect((await request(port, { path: '/api/me', headers: { cookie: c } })).status).toBe(401)
    }
    // 머리글로 준 토큰은 받지 않는다(쿠키만)
    expect(await statusOf(connect(port, { Authorization: `Bearer ${token}` }))).toBe(401)

    // 준비 안 됨(allowedHost null) — 맞는 머리글이어도 모두 403
    const off = await setup({ allowedHost: () => null })
    const offToken = off.pairing.add()
    expect((await request(off.server.port, { path: '/' })).status).toBe(403)
    expect(await statusOf(connect(off.server.port, { Cookie: cookie(offToken) }))).toBe(403)

    await tick()
    expect(t.dispatched).toEqual([])
    expect(t.pairing.calls.redeem).toEqual([])
    expect(t.subscribed).toEqual([])
    expect(fs.existsSync(t.inboxDir) ? fs.readdirSync(t.inboxDir) : []).toEqual([])
    expect(off.dispatched).toEqual([])
  })

  it('allowLocal — 127.0.0.1 주소도 받는다(e2e 만), 아니면 거절', async () => {
    const t = await setup({ allowLocal: true })
    const port = t.server.port
    const local = `127.0.0.1:${port}`
    const token = t.pairing.add()
    expect((await request(port, { path: '/', headers: { host: local } })).status).toBe(200)
    const c = await connect(port, { Host: local, Origin: `http://${local}`, Cookie: cookie(token) })
    c.ws.send(JSON.stringify({ t: 'call', id: 1, method: 'snapshot', args: [] }))
    expect((await c.next()).ok).toBe(true)

    // http://127.0.0.1 에서 짝 맺기 → 받은 __Host- 쿠키(Secure 그대로 — 크로미움은 127.0.0.1 을 안전한 곳으로 친다)로 /api/me · WebSocket
    const r = await post(port, '/api/pair', { secret: GOOD_SECRET, name: 'e2e' }, { host: local, origin: `http://${local}` })
    expect(r.status).toBe(200)
    const pair = r.headers['set-cookie']![0].split(';')[0]
    expect(pair.startsWith('__Host-dure_phone=')).toBe(true)
    expect(r.headers['set-cookie']![0]).toContain('Secure')
    expect((await request(port, { path: '/api/me', headers: { host: local, cookie: pair } })).status).toBe(200)
    const c2 = await connect(port, { Host: local, Origin: `http://${local}`, Cookie: pair })
    c2.ws.send(JSON.stringify({ t: 'call', id: 2, method: 'snapshot', args: [] }))
    expect((await c2.next()).ok).toBe(true)
    // 로컬 Host 에 tailnet Origin 은 안 된다(짝이 맞아야)
    expect(await statusOf(connect(port, { Host: local, Origin: ORIGIN, Cookie: cookie(token) }))).toBe(403)
    expect(await statusOf(connect(port, { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, Cookie: cookie(token) }))).toBe(403)
  })

  it('짝 맺기 → 쿠키 → ws call 결과', async () => {
    const t = await setup()
    const port = t.server.port

    // 틀림·지남·막힘 — 쿠키 없음, 한국어 오류
    for (const secret of ['000000', 'old', 'locked']) {
      const r = await post(port, '/api/pair', { secret, name: '폰' })
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.headers['set-cookie']).toBeUndefined()
      expect(json(r).ok).toBe(false)
      expect(json(r).error).toMatch(/[가-힣]/)
      expect(r.text).not.toContain(secret)
    }
    // 꼴이 틀린 몸 · 1KB 넘음
    expect((await post(port, '/api/pair', 'not json')).status).toBe(400)
    expect((await post(port, '/api/pair', { secret: 1, name: 'x' })).status).toBe(400)
    expect((await post(port, '/api/pair', { secret: GOOD_SECRET, name: 'x'.repeat(2048) })).status).toBe(413)
    expect((await request(port, { path: '/api/pair' })).status).toBe(405)
    expect(t.pairing.calls.redeem.length).toBe(3)

    // 맞는 숫자 — from 은 소켓 주소(X-Forwarded-For 는 쓰지 않는다)
    const r = await post(port, '/api/pair', { secret: GOOD_SECRET, name: '내 폰' }, { 'x-forwarded-for': '100.64.0.9' })
    expect(r.status).toBe(200)
    const body = json(r)
    expect(body.ok).toBe(true)
    expect(body.device).toMatchObject({ id: 'dev1', name: '내 폰' })
    expect(body).not.toHaveProperty('token')
    expect(r.text).not.toMatch(/tokenHash/)
    expect(r.headers['cache-control']).toBe('no-store')
    const last = t.pairing.calls.redeem.at(-1)!
    expect(last.slice(0, 2)).toEqual([GOOD_SECRET, '내 폰'])
    expect(['127.0.0.1', '::ffff:127.0.0.1']).toContain(last[2])
    for (const [, , from] of t.pairing.calls.redeem) expect(from).not.toBe('100.64.0.9')

    const set = r.headers['set-cookie']
    expect(set).toHaveLength(1)
    const sc = set![0]
    const [pair, ...attrs] = sc.split(';').map((s) => s.trim())
    const token = [...t.pairing.tokens.keys()].find((k) => t.pairing.tokens.get(k)!.id === 'dev1')!
    // __Host- 쿠키 — 같은 ts.net 의 다른 주소가 Domain 쿠키로 덮어쓸 수 없다(Secure · Path=/ · Domain 없음이어야 브라우저가 받는다)
    expect(PHONE_COOKIE).toBe('__Host-dure_phone')
    expect(pair).toBe(`__Host-dure_phone=${token}`)
    expect(attrs).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']))
    expect(attrs.some((a) => /^Max-Age=\d+$/.test(a))).toBe(true)
    expect(attrs.some((a) => /^domain=/i.test(a))).toBe(false)
    // 옛 이름 쿠키는 받지 않는다
    expect((await request(port, { path: '/api/me', headers: { cookie: `dure_phone=${token}` } })).status).toBe(401)

    // 그 쿠키로 /api/me · WebSocket
    const me = await request(port, { path: '/api/me', headers: { cookie: pair } })
    expect(me.status).toBe(200)
    expect(json(me).device.id).toBe('dev1')

    const verifiesBefore = t.pairing.calls.verify
    const c = await connect(port, { Cookie: `theme=dark; ${pair}` })
    expect(t.pairing.calls.verify).toBe(verifiesBefore + 1)
    expect(t.pairing.calls.touch).toEqual(['dev1'])
    expect(t.server.clients()).toEqual([{ deviceId: 'dev1', visible: false }])

    c.ws.send(JSON.stringify({ t: 'call', id: 7, method: 'snapshot', args: [] }))
    expect(await c.next()).toEqual({ t: 'result', id: 7, ok: true, value: { method: 'snapshot', args: [] } })
    c.ws.send(JSON.stringify({ t: 'call', id: 8, method: 'boom', args: [1, 'a'] }))
    expect(await c.next()).toEqual({ t: 'result', id: 8, ok: false, error: '안 돼요' })
    // 꼴이 틀린 call — 디스패처에 안 감
    c.ws.send(JSON.stringify({ t: 'call', id: 9, method: 'snapshot', args: 'x' }))
    expect(await c.next()).toMatchObject({ t: 'result', id: 9, ok: false })
    c.ws.send(JSON.stringify({ t: 'call', id: 10, method: 42, args: [] }))
    expect(await c.next()).toMatchObject({ t: 'result', id: 10, ok: false })
    c.ws.send('not json')
    c.ws.send(JSON.stringify({ t: 'call', id: 'x', method: 'snapshot', args: [] }))
    c.ws.send(JSON.stringify({ t: 'call', id: 11, method: 'listRooms', args: [{ a: 1 }] }))
    expect(await c.next()).toEqual({ t: 'result', id: 11, ok: true, value: { method: 'listRooms', args: [{ a: 1 }] } })
    expect(t.dispatched.map(([m]) => m)).toEqual(['snapshot', 'boom', 'listRooms'])
    // 메시지마다 verify·touch 하지 않는다
    expect(t.pairing.calls.verify).toBe(verifiesBefore + 1)
    expect(t.pairing.calls.touch).toEqual(['dev1'])

    // 휴대폰 스크린숏(그림 칸 base64 — 보내는 칸은 5MB 까지 담는다) 6MB 메시지는 받는다
    const shot = 'y'.repeat(6 * 1024 * 1024)
    c.ws.send(JSON.stringify({ t: 'call', id: 12, method: 'sendUser', args: [{ image: shot }] }))
    const big = await Promise.race([c.next(), c.closed.then(([closedWith]) => ({ closedWith }))])
    expect(big).toMatchObject({ t: 'result', id: 12, ok: true })
    expect(big.value.args[0].image.length).toBe(shot.length)
    expect(t.dispatched.map(([m]) => m)).toEqual(['snapshot', 'boom', 'listRooms', 'sendUser'])

    // 메시지 32MB 상한 — 넘으면 소켓이 닫힌다
    expect(PHONE_WS_MESSAGE_MAX).toBe(32 * 1024 * 1024)
    c.ws.send(JSON.stringify({ t: 'call', id: 13, method: 'x', args: ['y'.repeat(PHONE_WS_MESSAGE_MAX)] }))
    const [code] = await c.closed
    expect(code).toBe(1009)
    expect(t.dispatched.map(([m]) => m)).toEqual(['snapshot', 'boom', 'listRooms', 'sendUser'])
  }, 30_000)

  it('사건이 ws 로 감', async () => {
    const t = await setup()
    const port = t.server.port
    const a = await connect(port, { Cookie: cookie(t.pairing.add('dev-a')) })
    const b = await connect(port, { Cookie: cookie(t.pairing.add('dev-b')) })
    expect(t.clientsChanged).toBe(2)

    t.emit('message', { id: 'm1', text: '안녕' })
    expect(await a.next()).toEqual({ t: 'event', name: 'message', payload: { id: 'm1', text: '안녕' } })
    expect(await b.next()).toEqual({ t: 'event', name: 'message', payload: { id: 'm1', text: '안녕' } })

    // 보이기 — 기기 단위로 알림(onVisible), clients() 에 보임
    a.ws.send(JSON.stringify({ t: 'visible', on: true }))
    a.ws.send(JSON.stringify({ t: 'visible', on: 'yes' }))
    a.ws.send(JSON.stringify({ t: 'call', id: 1, method: 'snapshot', args: [] }))
    await a.next()
    expect(t.visible).toEqual([['dev-a', true]])
    expect(t.server.clients()).toEqual(expect.arrayContaining([{ deviceId: 'dev-a', visible: true }, { deviceId: 'dev-b', visible: false }]))

    // 닫으면 보이지 않음으로 · 사건은 남은 쪽만
    a.ws.close()
    await a.closed
    await tick()
    expect(t.visible).toEqual([['dev-a', true], ['dev-a', false]])
    expect(t.server.clients()).toEqual([{ deviceId: 'dev-b', visible: false }])
    expect(t.clientsChanged).toBe(3)
    t.emit('request', { agentId: 'x' })
    expect(await b.next()).toEqual({ t: 'event', name: 'request', payload: { agentId: 'x' } })

    // 끄면 구독도 푼다
    await t.server.close()
    expect(t.unsubscribed).toBe(1)
  })

  it('끊기 — 열린 소켓 닫힘·토큰 거절', async () => {
    const t = await setup()
    const port = t.server.port
    const tokenA = t.pairing.add('dev-a')
    const a1 = await connect(port, { Cookie: cookie(tokenA) })
    const a2 = await connect(port, { Cookie: cookie(tokenA) })
    const b = await connect(port, { Cookie: cookie(t.pairing.add('dev-b')) })
    a1.ws.send(JSON.stringify({ t: 'visible', on: true }))
    await tick()

    t.pairing.unpair('dev-a')
    t.server.kick('dev-a')
    // 닫기 인사가 닿기 전에 휴대폰이 보낸 메시지 — 버린다(디스패처·onVisible 안 부름)
    a1.ws.send(JSON.stringify({ t: 'call', id: 1, method: 'snapshot', args: [] }))
    a2.ws.send(JSON.stringify({ t: 'visible', on: true }))
    a2.ws.send(JSON.stringify({ t: 'call', id: 2, method: 'snapshot', args: [] }))
    expect((await a1.closed)[0]).toBe(PHONE_CLOSE_UNPAIRED)
    expect((await a2.closed)[0]).toBe(PHONE_CLOSE_UNPAIRED)
    await tick()
    expect(t.dispatched).toEqual([])
    expect(t.server.clients()).toEqual([{ deviceId: 'dev-b', visible: false }])
    expect(t.visible).toEqual([['dev-a', true], ['dev-a', false]])

    // 같은 토큰으로 다시 — 401, 다른 기기는 그대로
    expect(await statusOf(connect(port, { Cookie: cookie(tokenA) }))).toBe(401)
    expect((await request(port, { path: '/api/me', headers: { cookie: cookie(tokenA) } })).status).toBe(401)
    t.emit('message', { n: 1 })
    expect(await b.next()).toEqual({ t: 'event', name: 'message', payload: { n: 1 } })
    expect(b.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('올리기 — inbox 에 바이트 그대로 · 100MB+1 413', async () => {
    const t = await setup()
    const port = t.server.port
    const token = t.pairing.add()
    const headers = { origin: ORIGIN, cookie: cookie(token), 'content-type': 'application/octet-stream' }

    const bytes = crypto.randomBytes(300 * 1024)
    const name = '../a:b?<x>.txt'
    const r = await request(port, { method: 'POST', path: `/api/upload?name=${encodeURIComponent(name)}`, headers, body: bytes })
    expect(r.status).toBe(200)
    const up = json(r)
    expect(up.ok).toBe(true)
    expect(up.bytes).toBe(bytes.length)
    expect(up.name).not.toMatch(/[/\\:*?"<>|]/)
    expect(path.dirname(up.path)).toBe(path.resolve(t.inboxDir))
    expect(path.basename(up.path)).toMatch(new RegExp(`^[0-9a-f]{16}-${up.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    expect(fs.readFileSync(up.path).equals(bytes)).toBe(true)

    // 이름이 없으면 file · 빈 파일도 된다
    const r0 = await request(port, { method: 'POST', path: '/api/upload', headers, body: '' })
    expect(json(r0)).toMatchObject({ ok: true, name: 'file', bytes: 0 })
    fs.rmSync(json(r0).path)

    // 선언한 길이가 넘으면 몸을 받지 않고 413
    const declared = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/upload?name=big.bin',
        headers: { ...headers, host: HOST, 'content-length': String(ATTACH_MAX_BYTES + 1) },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.flushHeaders()
    })
    expect(declared).toBe(413)

    // 길이를 모르게(chunked) 100MB+1 — 끊고 413, 반쯤 쓴 파일은 지운다
    const res = await new Promise<Res>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/upload?name=big.bin', headers: { ...headers, host: HOST },
      }, (rs) => {
        const chunks: Buffer[] = []
        rs.on('data', (c: Buffer) => chunks.push(c))
        rs.on('end', () => resolve({ status: rs.statusCode ?? 0, headers: rs.headers, text: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      const chunk = Buffer.alloc(1024 * 1024, 7)
      void (async () => {
        for (let i = 0; i < ATTACH_MAX_BYTES / chunk.length; i++) {
          if (!req.write(chunk)) await once(req, 'drain')
        }
        req.end(Buffer.from([1]))
      })()
    })
    expect(res.status).toBe(413)
    expect(json(res).error).toMatch(/100MB/)
    expect(fs.readdirSync(t.inboxDir)).toEqual([path.basename(up.path)])
  }, 60_000)

  it('올리기 — 쓰기가 실패하면(디스크 가득) 바로 500 · 반쯤 쓴 파일 지움', async () => {
    const t = await setup()
    const port = t.server.port
    const token = t.pairing.add()
    // 진짜 파일을 'wx' 로 연 뒤 쓸 때마다 ENOSPC
    const real = fs.createWriteStream
    const spy = vi.spyOn(fs, 'createWriteStream').mockImplementation(((file: fs.PathLike, opts?: any) => {
      const out = real(file, opts)
      const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      out._write = (_c, _e, cb) => cb(enospc())
      out._writev = (_c, cb) => cb(enospc())
      return out
    }) as typeof fs.createWriteStream)
    cleanup.push(() => spy.mockRestore())

    // 길이를 모르게(chunked) — 앞쪽을 보내 쓰기가 실패한 뒤에 나머지
    const { req, res } = streaming(port, '/api/upload?name=a.bin', { origin: ORIGIN, cookie: cookie(token) })
    req.write(Buffer.alloc(16 * 1024, 1))
    await until(() => spy.mock.calls.length === 1)
    await sleep(200)
    req.end(Buffer.alloc(16 * 1024, 2))
    const r = await within(res, 5_000)
    expect(r).not.toBe('timeout')
    expect((r as Res).status).toBe(500)
    expect(json(r as Res).error).toMatch(/[가-힣]/)
    expect(inbox(t.inboxDir)).toEqual([])

    // 그 뒤 올리기는 그대로 된다
    spy.mockRestore()
    const ok = await request(port, { method: 'POST', path: '/api/upload?name=b.txt', headers: { origin: ORIGIN, cookie: cookie(token) }, body: 'abc' })
    expect(ok.status).toBe(200)
  }, 15_000)

  it('올리기 — 받다가 끊기면 반쯤 쓴 파일 지움', async () => {
    const t = await setup()
    const token = t.pairing.add()
    const { req, res } = streaming(t.server.port, '/api/upload?name=a.bin', { origin: ORIGIN, cookie: cookie(token) })
    res.catch(() => {})
    req.write(Buffer.alloc(64 * 1024, 1))
    await until(() => inbox(t.inboxDir).length === 1 && fs.statSync(path.join(t.inboxDir, inbox(t.inboxDir)[0])).size > 0)
    req.destroy()
    await until(() => inbox(t.inboxDir).length === 0)
  })

  it('올리기·구독 — 몸을 받는 사이 짝이 끊기면 401 · 파일 안 남김 · onSubscribe 안 부름', async () => {
    const t = await setup()
    const port = t.server.port

    // 올리기 — 앞쪽을 받아 파일을 연 뒤 끊기
    const tokenA = t.pairing.add('dev-a')
    const up = streaming(port, '/api/upload?name=a.txt', { origin: ORIGIN, cookie: cookie(tokenA) })
    up.req.write('앞쪽 ')
    await until(() => inbox(t.inboxDir).length === 1)
    t.pairing.unpair('dev-a')
    up.req.end('뒤쪽')
    const r = await up.res
    expect(r.status).toBe(401)
    expect(json(r).error).toMatch(/[가-힣]/)
    expect(inbox(t.inboxDir)).toEqual([])

    // 다시 볼 때 저장 파일을 잠깐 못 읽음 — 503 · 파일 안 남김(짝이 끊긴 것으로 보지 않는다)
    const tokenB = t.pairing.add('dev-b')
    const up2 = streaming(port, '/api/upload?name=b.txt', { origin: ORIGIN, cookie: cookie(tokenB) })
    up2.req.write('앞쪽 ')
    await until(() => inbox(t.inboxDir).length === 1)
    const verify = t.pairing.verify
    t.pairing.verify = () => { throw new Error('EBUSY') }
    up2.req.end('뒤쪽')
    expect((await up2.res).status).toBe(503)
    t.pairing.verify = verify
    expect(inbox(t.inboxDir)).toEqual([])

    // 구독 — 머리글로 확인한 뒤 몸 사이에 끊기
    const tokenC = t.pairing.add('dev-c')
    const v0 = t.pairing.calls.verify
    const sub = streaming(port, '/api/subscribe', { origin: ORIGIN, cookie: cookie(tokenC), 'content-type': 'application/json' })
    const body = JSON.stringify({ subscription: pushSub() })
    sub.req.write(body.slice(0, 10))
    await until(() => t.pairing.calls.verify > v0)
    t.pairing.unpair('dev-c')
    sub.req.end(body.slice(10))
    expect((await sub.res).status).toBe(401)
    expect(t.subscribed).toEqual([])

    // 끊기지 않았으면 그대로
    const tokenD = t.pairing.add('dev-d')
    expect((await post(port, '/api/subscribe', { subscription: pushSub() }, { cookie: cookie(tokenD) })).status).toBe(200)
    expect(t.subscribed.map(([id]) => id)).toEqual(['dev-d'])
    const ok = await request(port, { method: 'POST', path: '/api/upload?name=d.txt', headers: { origin: ORIGIN, cookie: cookie(tokenD) }, body: 'abc' })
    expect(ok.status).toBe(200)
    expect(inbox(t.inboxDir)).toEqual([path.basename(json(ok).path)])
  })

  it('구독 — 쿠키 있을 때만 onSubscribe', async () => {
    const t = await setup()
    const port = t.server.port
    const token = t.pairing.add('dev-a')
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      expirationTime: null,
      keys: { p256dh: crypto.randomBytes(65).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    }
    expect((await post(port, '/api/subscribe', { subscription: sub })).status).toBe(401)
    expect((await post(port, '/api/subscribe', { subscription: sub }, { cookie: cookie('nope') })).status).toBe(401)
    expect(t.subscribed).toEqual([])

    // 꼴이 틀린 구독 · 8KB 넘음
    expect((await post(port, '/api/subscribe', { subscription: { ...sub, endpoint: 'http://x/y' } }, { cookie: cookie(token) })).status).toBe(400)
    expect((await post(port, '/api/subscribe', { nope: sub }, { cookie: cookie(token) })).status).toBe(400)
    expect((await post(port, '/api/subscribe', { subscription: sub, pad: 'x'.repeat(9 * 1024) }, { cookie: cookie(token) })).status).toBe(413)
    expect(t.subscribed).toEqual([])

    const ok = await post(port, '/api/subscribe', { subscription: sub }, { cookie: cookie(token) })
    expect(ok.status).toBe(200)
    expect(json(ok)).toEqual({ ok: true })
    expect(t.subscribed).toHaveLength(1)
    expect(t.subscribed[0][0]).toBe('dev-a')
    expect(t.subscribed[0][1]).toMatchObject({ endpoint: sub.endpoint, keys: sub.keys })

    // VAPID 공개 열쇠 — 쿠키 있을 때만
    expect((await request(port, { path: '/api/vapid' })).status).toBe(401)
    const v = await request(port, { path: '/api/vapid', headers: { cookie: cookie(token) } })
    expect(json(v)).toEqual({ ok: true, publicKey: 'PUBLIC-KEY' })
    expect(v.headers['cache-control']).toBe('no-store')
  })

  it('정적 파일 — staticDir 밖 경로 거절', async () => {
    const t = await setup()
    const port = t.server.port
    // 밖으로 가는 연결(junction) — 만들 수 있으면
    try {
      fs.symlinkSync(t.root, path.join(t.staticDir, 'assets', 'out'), 'junction')
    } catch {
      // 링크를 못 만드는 PC — 그 칸은 건너뛴다
    }

    const home = await request(port, { path: '/' })
    expect(home.status).toBe(200)
    expect(home.text).toContain('두레')
    expect(home.headers['content-type']).toMatch(/^text\/html/)
    expect(home.headers['cache-control']).toBe('no-store')
    expect(home.headers['x-content-type-options']).toBe('nosniff')
    expect(home.headers['referrer-policy']).toBe('no-referrer')
    const csp = String(home.headers['content-security-policy'])
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain(`connect-src 'self' wss://${HOST}`)
    expect(csp).toContain("img-src 'self' data: blob:")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-eval')

    const mobile = await request(port, { path: '/mobile.html?x=1' })
    expect(mobile.status).toBe(200)
    expect(mobile.text).toBe(home.text)

    const types: [string, RegExp][] = [
      ['/assets/app-abc.js', /^text\/javascript/],
      ['/assets/app-abc.css', /^text\/css/],
      ['/assets/font.woff2', /^font\/woff2/],
      ['/sw.js', /^text\/javascript/],
      ['/manifest.webmanifest', /^application\/manifest\+json/],
    ]
    for (const [p, type] of types) {
      const r = await request(port, { path: p })
      expect(r.status, p).toBe(200)
      expect(r.headers['content-type'], p).toMatch(type)
      expect(r.headers['x-content-type-options']).toBe('nosniff')
    }
    expect((await request(port, { path: '/sw.js' })).headers['cache-control']).toBe('no-store')
    expect((await request(port, { method: 'HEAD', path: '/sw.js' })).status).toBe(200)

    const outside = [
      '/../secret.js',
      '/..%2fsecret.js',
      '/%2e%2e/secret.js',
      '/assets/../../secret.js',
      '/assets/%2e%2e/%2e%2e/secret.js',
      '/assets%5c..%5c..%5csecret.js',
      '/assets/..%5c..%5csecret.js',
      '//secret.js',
      '/C:%5cWindows%5cwin.ini',
      '/assets/out/secret.js',
      '/notes.txt',
      '/.hidden.js',
      '/assets',
      '/assets/',
      '/missing.js',
      '/mobile.html%00.js',
      '/mobile.html::$DATA',
      '/%E0%A4%A',
    ]
    for (const p of outside) {
      const r = await request(port, { path: p })
      expect([400, 404], p).toContain(r.status)
      expect(r.text, p).not.toContain('SECRET')
      expect(r.text, p).not.toContain('not served')
      expect(r.text, p).not.toContain(t.root)
    }

    expect((await request(port, { method: 'POST', path: '/mobile.html', headers: { origin: ORIGIN }, body: 'x' })).status).toBe(405)
    expect((await request(port, { path: '/api/nope' })).status).toBe(404)
    await tick()
    expect(t.dispatched).toEqual([])
  })

  it('휴대폰이 못 받아 보낼 글이 16MB 넘게 쌓이면 그 소켓을 끊는다', async () => {
    const t = await setup()
    const port = t.server.port
    const slow = await connect(port, { Cookie: cookie(t.pairing.add('dev-a')) })
    // 휴대폰이 읽지 않음 — 커널 버퍼가 차면 ws 에 쌓인다
    const sock = (slow.ws as unknown as { _socket: net.Socket })._socket
    sock.pause()
    const pad = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 64; i++) t.emit('message', { i, pad })
    await until(() => t.server.clients().length === 0)
    sock.resume()
    expect((await slow.closed)[0]).toBe(1006)

    // 다시 이으면 다시 받는다
    const again = await connect(port, { Cookie: cookie(t.pairing.add('dev-b')) })
    t.emit('message', { n: 1 })
    expect(await again.next()).toEqual({ t: 'event', name: 'message', payload: { n: 1 } })
  }, 30_000)

  it('pong 이 없으면 끊는다 · 답하는 소켓은 그대로', async () => {
    const t = await setup({ limits: { pingMs: 300 } })
    const port = t.server.port
    const mute = await connect(port, { Cookie: cookie(t.pairing.add('dev-a')) }, { autoPong: false })
    const live = await connect(port, { Cookie: cookie(t.pairing.add('dev-b')) })
    expect(await within(mute.closed, 3_000)).not.toBe('timeout')
    await until(() => t.server.clients().length === 1)
    expect(live.ws.readyState).toBe(WebSocket.OPEN)
    expect(t.server.clients()).toEqual([{ deviceId: 'dev-b', visible: false }])
    live.ws.send(JSON.stringify({ t: 'call', id: 1, method: 'snapshot', args: [] }))
    expect((await live.next()).ok).toBe(true)
  })

  it('Host — 대소문자 무시 · 443 이면 포트 없이도 :443 으로도', async () => {
    // tailscale serve 가 443 이면 allowedHost 는 포트 없이 온다 — 휴대폰 Host 는 포트 없이(브라우저) 또는 :443
    const DNS = 'pc.tail1234.ts.net'
    const t = await setup({ allowedHost: () => DNS })
    const port = t.server.port
    const token = t.pairing.add()
    for (const host of [DNS, `${DNS}:443`, DNS.toUpperCase(), `Pc.Tail1234.TS.net:443`]) {
      expect((await request(port, { path: '/', headers: { host } })).status, host).toBe(200)
      expect((await request(port, { path: '/api/me', headers: { host, cookie: cookie(token) } })).status, host).toBe(200)
      const c = await connect(port, { Host: host, Origin: `https://PC.tail1234.ts.net`, Cookie: cookie(token) })
      c.ws.close()
    }
    const csp = String((await request(port, { path: '/', headers: { host: `${DNS}:443` } })).headers['content-security-policy'])
    expect(csp).toContain(`connect-src 'self' wss://${DNS};`)
    for (const host of [`${DNS}:47615`, `${DNS}:4430`, `${DNS}:44`, `${DNS}.evil.example`, `x${DNS}`]) {
      expect((await request(port, { path: '/', headers: { host } })).status, host).toBe(403)
    }
    // Origin 은 포트 없는 https 주소
    expect((await post(port, '/api/pair', { secret: GOOD_SECRET, name: 'x' }, { host: DNS, origin: `https://${DNS}` })).status).toBe(200)
    expect((await post(port, '/api/pair', { secret: GOOD_SECRET, name: 'x' }, { host: DNS, origin: `https://${DNS}:47615` })).status).toBe(403)

    // allowedHost 를 :443 · 대문자로 줘도 같다
    const t2 = await setup({ allowedHost: () => `PC.tail1234.ts.net:443` })
    expect((await request(t2.server.port, { path: '/', headers: { host: DNS } })).status).toBe(200)
    expect((await request(t2.server.port, { path: '/', headers: { host: `${DNS}:443` } })).status).toBe(200)
    // 443 이 아닌 포트 — 대소문자만 무시, 포트는 맞아야
    expect((await request(port, { path: '/', headers: { host: HOST } })).status).toBe(403)
    const t3 = await setup()
    expect((await request(t3.server.port, { path: '/', headers: { host: HOST.toUpperCase() } })).status).toBe(200)
    expect((await request(t3.server.port, { path: '/', headers: { host: DNS } })).status).toBe(403)
  })

  it('조용한 연결은 끊는다 — 머리글을 다 안 보냄 · 큰 파일을 청하고 안 받아 감', async () => {
    const t = await setup({ limits: { idleMs: 200 } })
    const port = t.server.port
    const raw = async () => {
      const s = net.connect(port, '127.0.0.1')
      s.on('error', () => {})
      const closed = new Promise<void>((r) => s.once('close', () => r()))
      cleanup.push(() => s.destroy())
      await Promise.race([new Promise((r) => s.once('connect', r)), closed])
      return { s, closed }
    }

    // 머리글 반쯤에서 멈춤
    const a = await raw()
    a.s.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n`)
    expect(await within(a.closed, 3_000)).not.toBe('timeout')

    // 큰 파일을 청하고 읽지 않음 — 보내기가 막힌 채 조용하면 끊는다(읽던 파일도 닫힌다)
    const size = 64 * 1024 * 1024
    fs.writeFileSync(path.join(t.staticDir, 'assets', 'big.png'), Buffer.alloc(size))
    const b = await raw()
    b.s.write(`GET /assets/big.png HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`)
    b.s.pause()
    await sleep(1_000)
    let got = 0
    b.s.on('data', (c: Buffer) => { got += c.length })
    b.s.resume()
    expect(await within(b.closed, 5_000)).not.toBe('timeout')
    expect(got).toBeLessThan(size)

    // 오가는 요청은 그대로
    expect((await request(port, { path: '/' })).status).toBe(200)
  }, 20_000)

  it('연결 수 상한 — 넘는 연결은 받자마자 닫는다', async () => {
    const t = await setup({ limits: { maxConnections: 2 } })
    const port = t.server.port
    const open = async () => {
      const s = net.connect(port, '127.0.0.1')
      s.on('error', () => {})
      const closed = new Promise<void>((r) => s.once('close', () => r()))
      cleanup.push(() => s.destroy())
      await Promise.race([new Promise((r) => s.once('connect', r)), closed])
      return { s, closed }
    }
    const ask = (s: net.Socket) => new Promise<string>((resolve) => {
      s.once('data', (c: Buffer) => resolve(String(c)))
      s.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`)
    })
    const a = await open()
    expect(await ask(a.s)).toMatch(/^HTTP\/1\.1 200/)
    const b = await open()
    expect(await ask(b.s)).toMatch(/^HTTP\/1\.1 200/)
    const c = await open()
    expect(await within(c.closed, 3_000)).not.toBe('timeout')
    expect(a.s.destroyed || b.s.destroyed).toBe(false)

    // 하나가 닫히면 다시 받는다(모두 센 수가 아니라 동시에 열린 수)
    a.s.destroy()
    await a.closed
    await sleep(300)
    const d = await open()
    expect(await ask(d.s)).toMatch(/^HTTP\/1\.1 200/)
  })

  it('포트가 쓰이면 다음 포트', async () => {
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    cleanup.push(() => new Promise<void>((r) => blocker.close(() => r())))
    const taken = (blocker.address() as net.AddressInfo).port

    const t = await setup({ port: taken })
    expect(t.server.port).toBeGreaterThan(taken)
    expect(t.server.port).toBeLessThan(taken + 20)
    expect((await request(t.server.port, { path: '/' })).status).toBe(200)

    // 127.0.0.1 에만 — 다른 주소(::1)로는 안 열린다
    const v6 = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '::1', port: t.server.port })
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
    })
    expect(v6).toBe(false)
  })
})

