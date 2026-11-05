import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startPhoneServer, type PhoneServerOptions } from '../src/main/phone/phoneServer'
import { PHONE_CLOSE_UNPAIRED, PHONE_COOKIE } from '../src/shared/phoneWire'
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

function connect(port: number, headers: Record<string, string | undefined>): Promise<Conn> {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries({ Host: HOST, Origin: ORIGIN, ...headers })) if (v !== undefined) h[k] = v
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: h })
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
const tick = () => new Promise((r) => setTimeout(r, 30))

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
    expect(pair).toBe(`${PHONE_COOKIE}=${token}`)
    expect(attrs).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']))
    expect(attrs.some((a) => /^Max-Age=\d+$/.test(a))).toBe(true)

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

    // 메시지 1MB 상한 — 넘으면 소켓이 닫힌다
    c.ws.send(JSON.stringify({ t: 'call', id: 12, method: 'x', args: ['y'.repeat(1024 * 1024)] }))
    const [code] = await c.closed
    expect(code).toBe(1009)
    expect(t.dispatched.map(([m]) => m)).toEqual(['snapshot', 'boom', 'listRooms'])
  })

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
    expect((await a1.closed)[0]).toBe(PHONE_CLOSE_UNPAIRED)
    expect((await a2.closed)[0]).toBe(PHONE_CLOSE_UNPAIRED)
    expect(t.server.clients()).toEqual([{ deviceId: 'dev-b', visible: false }])
    expect(t.visible.at(-1)).toEqual(['dev-a', false])

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

