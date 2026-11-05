import crypto from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import path from 'node:path'
import { pipeline, type Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { safeName } from '../../engine/attachmentStore'
import { ATTACH_MAX_BYTES, ATTACH_TOO_BIG } from '../../shared/attachments'
import type { InvokeResult } from '../../shared/ipcContract'
import type { PhoneDevice } from '../../shared/phoneTypes'
import {
  PHONE_CLOSE_UNPAIRED, PHONE_COOKIE, PHONE_PATHS, PHONE_WS_MESSAGE_MAX, type PhoneServerMessage,
} from '../../shared/phoneWire'
import type { Dispatch } from '../dispatch'
import type { Pairing } from './pairing'
import { pickSubscription, type PhonePushSubscription } from './phoneStore'

// 휴대폰 서버 — 127.0.0.1 에만 HTTP + WebSocket. 바깥 길은 사용자의 `tailscale serve`(tailnet 안 https → 이 포트)가 낸다.
// 문은 셋: Host(그 ts.net 주소 — PC 의 다른 웹 페이지·DNS 재바인딩을 막는다) · Origin(상태를 바꾸는 요청·WebSocket) ·
// 기기 토큰 쿠키(dure_phone — HttpOnly·Secure·SameSite=Strict, 쿠키로만). 짝 맺기 화면이 떠야 하므로 정적 파일만 토큰 없이 준다.
// 🔴 토큰·짝 코드·숫자·쿠키는 로그·오류 글에 싣지 않는다(이 파일은 아무것도 로그에 쓰지 않는다) · 휴대폰에 가는 오류 글은 한국어, 경로·스택 없이

/** 포트가 쓰이고 있으면 +1 씩 이만큼 해 본다(처음 포트 포함) */
export const PHONE_PORT_TRIES = 20
/** POST /api/pair 몸 상한 */
export const PAIR_BODY_MAX = 1024
/** POST /api/subscribe 몸 상한 */
export const SUBSCRIBE_BODY_MAX = 8 * 1024
/** WebSocket ping 간격 — 다음 ping 때까지 pong 이 없으면 끊긴 것으로 보고 닫는다 */
export const WS_PING_MS = 30_000

/** 짧은 몸(JSON)을 받는 동안 이만큼 조용하면 끊는다 */
const BODY_IDLE_MS = 30_000
/** 올리기 — 휴대폰 데이터는 느릴 수 있어 넉넉히(조용한 시간만 잰다, 전체 시간은 재지 않는다) */
const UPLOAD_IDLE_MS = 60_000
/** 거절한 요청의 몸을 이만큼까지는 읽어 버린 뒤 답한다(답이 연결 끊김에 묻히지 않게) — 더 오면 답하고 끊는다 */
const DRAIN_MAX = 64 * 1024
/** 휴대폰이 못 받아 쌓인 보낼 글이 이보다 많으면 그 소켓을 끊는다 — 다시 이으면 스냅샷부터 다시 받는다 */
const SEND_BUFFER_MAX = 16 * 1024 * 1024
/** 끊기(kick) 뒤 닫기 인사가 안 끝나도 이만큼 뒤엔 끊는다 */
const KICK_GRACE_MS = 2_000
/** 쿠키 수명 — 브라우저 상한(400일). WebSocket 을 열 때마다 새로 붙여 늘린다 */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60
/** 머리글을 받는 시간 상한(Node 기본값) — 몸은 위의 조용한 시간으로 잰다(requestTimeout 0) */
const HEADERS_TIMEOUT_MS = 60_000

const E = {
  forbidden: '이 주소로는 열 수 없어요',
  unpaired: '짝을 맺어 주세요',
  busy: '잠시 뒤에 다시 해 주세요',
  notFound: '찾을 수 없어요',
  method: '할 수 없는 요청이에요',
  bad: '요청 꼴이 올바르지 않아요',
  tooBig: '요청이 너무 커요',
  pairExpired: '짝 코드가 지났어요 — PC 에서 [휴대폰 짝 맺기]를 다시 눌러 주세요',
  pairWrong: '짝 코드나 숫자가 맞지 않아요',
  pairLocked: '여러 번 틀려서 잠깐 막았어요 — 1분 뒤에 다시 해 주세요',
  pairFailed: '짝을 맺지 못했어요 — 다시 해 주세요',
  upload: '파일을 올리지 못했어요',
  subscription: '알림 구독 정보가 올바르지 않아요',
  push: '알림을 켜지 못했어요',
  call: '요청을 처리하지 못했어요',
  reply: '답을 보내지 못했어요',
  port: '휴대폰 연결을 열 포트를 찾지 못했어요',
} as const

/** 정적 파일 종류 — 이 밖의 확장자는 주지 않는다 */
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}
/** 정적 파일 경로의 마디 하나 — 빌드가 내는 이름 꼴만(점으로 시작·`..`·빈 마디·`\`·`:`·NUL 은 여기서 걸린다) */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

const BASE_HEADERS: OutgoingHttpHeaders = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const CLOSE: OutgoingHttpHeaders = { connection: 'close' }

export interface PhoneClient {
  deviceId: string
  /** 휴대폰 화면이 보이는지(휴대폰이 { t:'visible' } 로 알린다 — 처음엔 안 보임) */
  visible: boolean
}

export interface PhoneServerOptions {
  /** 처음 해 볼 포트 — 쓰이고 있으면 +1 씩 PHONE_PORT_TRIES 번까지. 0 이면 아무 빈 포트(시험) */
  port: number
  /** 휴대폰이 부르는 주소의 Host — 'pc.tailnet.ts.net:47615'(443 이면 포트 없이). 요청마다 묻는다 · null 이면 모두 거절(준비 안 됨) */
  allowedHost: () => string | null
  /** 짝 맺기 — redeem 은 /api/pair 에서, verify 는 WebSocket 을 열 때·올리기·구독·vapid·me 에서만, touch 는 WebSocket 을 열 때만 */
  pairing: Pick<Pairing, 'redeem' | 'verify' | 'touch'>
  /** 휴대폰 디스패처(phoneDispatcher — 허용 목록·inbox 규칙이 거기 있다) */
  dispatch: Dispatch
  /** 휴대폰에 보낼 사건 — 엔진 사건만 넘긴다(앱 사건은 휴대폰에 가지 않는다). 서버를 열 때 한 번 부르고, 닫을 때 돌려준 함수로 푼다 */
  subscribe: (forward: (name: string, payload: unknown) => void) => () => void
  /** 휴대폰 묶음이 든 폴더(out/renderer) — 이 안의 파일만 준다 */
  staticDir: string
  /** 올린 파일을 둘 폴더 — 바로 안에 `<무작위>-<이름>` 으로(phoneDispatcher 는 바로 안 파일만 받는다) */
  inboxDir: string
  /** 웹 푸시 VAPID 공개 열쇠 */
  vapidKey: () => string
  /** 휴대폰이 올린 알림 구독 — 꼴을 확인한 것만(pickSubscription) */
  onSubscribe: (deviceId: string, sub: PhonePushSubscription) => void | Promise<void>
  /** 그 기기 화면이 보이게·안 보이게 됐다(기기 단위 — 그 기기 소켓 중 하나라도 보이면 보임) */
  onVisible?: (deviceId: string, visible: boolean) => void
  /** 열린 소켓이 늘거나 줄었다(clients() 가 바뀜) — close() 때는 부르지 않는다 */
  onClients?: () => void
  /** e2e 만 — Host `127.0.0.1:<포트>` · Origin `http://127.0.0.1:<포트>` 도 받는다 */
  allowLocal?: boolean
}

export interface PhoneServer {
  /** 실제로 연 포트 */
  port: number
  /** 소켓을 모두 끊고 닫는다 — 여러 번 불러도 된다 */
  close(): Promise<void>
  /** 그 기기의 열린 소켓을 모두 닫는다(PHONE_CLOSE_UNPAIRED) — 다시 못 들어오게 하는 것은 pairing.unpair 몫 */
  kick(deviceId: string): void
  /** 열린 소켓마다 하나 */
  clients(): PhoneClient[]
}

type Gate = { host: string; origin: string; secure: boolean }
type Auth = { device: PhoneDevice; token: string } | 'none' | 'error'
type Client = { ws: WebSocket; deviceId: string; visible: boolean; alive: boolean }
type Body = { kind: 'ok'; body: Buffer } | { kind: 'big'; ended: boolean } | { kind: 'gone' }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const codeOf = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code ?? ''
/** Host 비교 — 대소문자 무시 · https 기본 포트(:443)는 없는 것과 같다 */
const normHost = (h: string) => h.trim().toLowerCase().replace(/:443$/, '')
const fail = (error: string) => ({ ok: false as const, error })
const pathOf = (url: string | undefined) => {
  const u = url ?? ''
  const i = u.search(/[?#]/)
  return i < 0 ? u : u.slice(0, i)
}
const queryOf = (url: string | undefined) => {
  const u = url ?? ''
  const i = u.indexOf('?')
  return new URLSearchParams(i < 0 ? '' : u.slice(i + 1).split('#')[0])
}
const within = (root: string, p: string) => {
  const r = path.relative(root, p)
  return r !== '' && !path.isAbsolute(r) && r.split(path.sep)[0] !== '..'
}
const cookieFor = (token: string) =>
  `${PHONE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`
/** 화면용 칸만 — pairing 이 무엇을 더 주든 휴대폰엔 이것만 */
const deviceView = (d: PhoneDevice): PhoneDevice => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, push: d.push })

function cookieToken(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === PHONE_COOKIE) return part.slice(i + 1).trim() || null
  }
  return null
}

function textOf(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: OutgoingHttpHeaders): void {
  if (res.headersSent || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extra,
  })
  res.end(text)
}

/**
 * 몸을 max 바이트까지 모은다. 넘으면 'big' — 남은 몸은 DRAIN_MAX 까지 읽어 버리며 끝을 기다린다(ended: 끝까지 읽음 → 답이 깨끗이 간다).
 * 선언한 길이가 너무 크면 읽지 않고 바로 'big'. 끊기거나 조용하면 'gone'
 */
function readBody(req: IncomingMessage, max: number, idleMs = BODY_IDLE_MS): Promise<Body> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max + DRAIN_MAX) return Promise.resolve({ kind: 'big', ended: false })
  if (req.readableEnded) return Promise.resolve({ kind: 'ok', body: Buffer.alloc(0) })
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let n = 0
    let over = Number.isFinite(declared) && declared > max
    let settled = false
    const done = (v: Body) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('close', onClose)
      if (v.kind !== 'ok' && !req.readableEnded) req.pause()
      resolve(v)
    }
    const timer = setTimeout(() => done(over ? { kind: 'big', ended: false } : { kind: 'gone' }), idleMs)
    const onData = (c: Buffer) => {
      timer.refresh()
      n += c.length
      if (!over && n > max) {
        over = true
        chunks.length = 0
      }
      if (over) {
        if (n > max + DRAIN_MAX) done({ kind: 'big', ended: false })
        return
      }
      chunks.push(c)
    }
    const onEnd = () => done(over ? { kind: 'big', ended: true } : { kind: 'ok', body: Buffer.concat(chunks) })
    const onClose = () => done(over ? { kind: 'big', ended: false } : { kind: 'gone' })
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('close', onClose)
  })
}

/** 거절 — 몸을 조금 읽어 버린 뒤 답한다. 다 못 읽었으면 답하고 연결을 닫는다 */
async function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string, extra?: OutgoingHttpHeaders): Promise<void> {
  const b = await readBody(req, 0)
  if (b.kind === 'gone') {
    req.destroy()
    return
  }
  sendJson(res, status, fail(error), b.kind === 'ok' || b.ended ? extra : { ...extra, ...CLOSE })
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return undefined
  }
}

/** 지우기 — 할 수 있는 만큼. 막 쓴 파일은 백신 등이 잠깐 잡아 EBUSY·EPERM 이 난다: 몇 번 다시 */
async function removeQuietly(p: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.unlink(p)
      return
    } catch (e) {
      const c = codeOf(e)
      if (i >= 3 || (c !== 'EBUSY' && c !== 'EPERM')) return
      await new Promise((r) => setTimeout(r, 50 * (i + 1)))
    }
  }
}

function listenOnce(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      server.off('listening', onListening)
      reject(e)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/** 쓰이고 있음(EADDRINUSE)·Windows 가 막아 둔 포트 범위(EACCES)면 다음 포트로 */
const NEXT_PORT = new Set(['EADDRINUSE', 'EACCES'])

async function listen(server: http.Server, first: number): Promise<number> {
  if (!Number.isInteger(first) || first < 0 || first > 65535) throw new Error(E.port)
  const tries = first === 0 ? 1 : PHONE_PORT_TRIES
  for (let i = 0; i < tries && first + i <= 65535; i++) {
    try {
      return await listenOnce(server, first + i)
    } catch (e) {
      if (!NEXT_PORT.has(codeOf(e))) break
    }
  }
  throw new Error(E.port)
}

export async function startPhoneServer(o: PhoneServerOptions): Promise<PhoneServer> {
  const clients = new Set<Client>()
  const sockets = new Set<Socket>()
  /** WebSocket 을 열 때 쿠키를 다시 붙이려고(수명 늘리기) — 머리글을 쓰는 순간까지만 둔다 */
  const upgradeTokens = new WeakMap<IncomingMessage, string>()
  let port = 0
  let closed = false
  let closing: Promise<void> | null = null
  let unsubscribe: (() => void) | null = null

  const safely = (f: () => void) => {
    try {
      f()
    } catch {
      // 부르는 쪽의 실패가 서버를 멈추지 않게
    }
  }

  function gateOf(req: IncomingMessage): Gate | null {
    const raw = req.headers.host
    if (typeof raw !== 'string' || raw === '') return null
    const host = normHost(raw)
    let allowed: string | null = null
    try {
      allowed = o.allowedHost()
    } catch {
      allowed = null
    }
    if (allowed && host === normHost(allowed)) return { host, origin: `https://${host}`, secure: true }
    const local = `127.0.0.1:${port}`
    if (o.allowLocal && host === local) return { host, origin: `http://${local}`, secure: false }
    return null
  }
  const originOk = (req: IncomingMessage, g: Gate) =>
    typeof req.headers.origin === 'string' && req.headers.origin.toLowerCase() === g.origin

  function authOf(req: IncomingMessage): Auth {
    const token = cookieToken(req.headers.cookie)
    if (!token) return 'none'
    try {
      const device = o.pairing.verify(token)
      return device ? { device, token } : 'none'
    } catch {
      return 'error' // 저장 파일을 잠깐 못 읽음 — 짝이 끊긴 것으로 보이지 않게
    }
  }

  function cspFor(g: Gate): string {
    const ws = `${g.secure ? 'wss' : 'ws'}://${g.host}`
    return [
      "default-src 'self'",
      `connect-src 'self' ${ws}`,
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
  }

  // ── HTTP ──

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = gateOf(req)
    if (!gate) return refuse(req, res, 403, E.forbidden)
    const p = pathOf(req.url)
    const method = req.method ?? ''

    if (p === PHONE_PATHS.pair || p === PHONE_PATHS.upload || p === PHONE_PATHS.subscribe) {
      if (method !== 'POST') return refuse(req, res, 405, E.method, { allow: 'POST' })
      if (!originOk(req, gate)) return refuse(req, res, 403, E.forbidden)
      if (p === PHONE_PATHS.pair) return pair(req, res)
      const a = authOf(req)
      if (a === 'error') return refuse(req, res, 503, E.busy)
      if (a === 'none') return refuse(req, res, 401, E.unpaired)
      return p === PHONE_PATHS.upload ? upload(req, res) : subscribe(req, res, a.device)
    }
    if (p === PHONE_PATHS.vapid || p === PHONE_PATHS.me) {
      if (method !== 'GET') return refuse(req, res, 405, E.method, { allow: 'GET' })
      const a = authOf(req)
      if (a === 'error') return refuse(req, res, 503, E.busy)
      if (a === 'none') return refuse(req, res, 401, E.unpaired)
      if (p === PHONE_PATHS.me) return sendJson(res, 200, { ok: true, device: deviceView(a.device) })
      let publicKey: string
      try {
        publicKey = o.vapidKey()
      } catch {
        return sendJson(res, 500, fail(E.push))
      }
      return sendJson(res, 200, { ok: true, publicKey })
    }
    if (p === PHONE_PATHS.ws) return refuse(req, res, 426, E.bad, { upgrade: 'websocket' })
    if (p.startsWith('/api/')) return refuse(req, res, 404, E.notFound)
    if (method !== 'GET' && method !== 'HEAD') return refuse(req, res, 405, E.method, { allow: 'GET, HEAD' })
    return serveStatic(req, res, gate, p)
  }

  async function pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = await readBody(req, PAIR_BODY_MAX)
    if (b.kind === 'gone') return void req.destroy()
    if (b.kind === 'big') return sendJson(res, 413, fail(E.tooBig), b.ended ? undefined : CLOSE)
    const v = parseJson(b.body)
    if (!isObj(v) || typeof v.secret !== 'string' || (v.name !== undefined && typeof v.name !== 'string')) {
      return sendJson(res, 400, fail(E.bad))
    }
    let r: ReturnType<Pairing['redeem']>
    try {
      // from = 소켓 주소 — serve 뒤라 늘 127.0.0.1(모든 기기가 한 셈을 같이 쓴다). X-Forwarded-For 는 아무나 꾸밀 수 있어 쓰지 않는다
      r = o.pairing.redeem(v.secret, typeof v.name === 'string' ? v.name : '', req.socket.remoteAddress ?? '')
    } catch {
      return sendJson(res, 500, fail(E.pairFailed))
    }
    if ('error' in r) {
      if (r.error === 'locked') return sendJson(res, 429, fail(E.pairLocked))
      if (r.error === 'expired') return sendJson(res, 410, fail(E.pairExpired))
      return sendJson(res, 400, fail(E.pairWrong))
    }
    sendJson(res, 200, { ok: true, device: deviceView(r.device) }, { 'set-cookie': [cookieFor(r.token)] })
  }

  async function subscribe(req: IncomingMessage, res: ServerResponse, device: PhoneDevice): Promise<void> {
    const b = await readBody(req, SUBSCRIBE_BODY_MAX)
    if (b.kind === 'gone') return void req.destroy()
    if (b.kind === 'big') return sendJson(res, 413, fail(E.tooBig), b.ended ? undefined : CLOSE)
    const v = parseJson(b.body)
    const sub = isObj(v) ? pickSubscription(v.subscription) : null
    if (!sub) return sendJson(res, 400, fail(E.subscription))
    try {
      await o.onSubscribe(device.id, sub)
    } catch {
      return sendJson(res, 500, fail(E.push))
    }
    sendJson(res, 200, { ok: true })
  }

  /**
   * 올리기 — 몸을 inboxDir/<무작위 16 hex>-<안전한 이름> 에 흘려 쓴다(메모리에 모으지 않는다). ATTACH_MAX_BYTES 를 넘으면 쓰기를 끊고
   * 반쯤 쓴 파일을 지운 뒤 413. 끊기면 파일을 지운다
   */
  async function upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const name = safeName(queryOf(req.url).get('name') ?? '')
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > ATTACH_MAX_BYTES) return sendJson(res, 413, fail(ATTACH_TOO_BIG), CLOSE)
    const dir = path.resolve(o.inboxDir)
    try {
      await fs.promises.mkdir(dir, { recursive: true })
    } catch {
      return refuse(req, res, 500, E.upload)
    }
    const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}-${name}`)
    const out = fs.createWriteStream(file, { flags: 'wx' })
    let outFailed = false
    /** 'wx' 가 EEXIST 로 실패했으면 그 이름의 파일은 우리 것이 아니다 — 지우지 않는다 */
    let notOurs = false
    const outClosed = new Promise<void>((r) => out.once('close', () => r()))
    out.on('error', (e) => {
      outFailed = true
      if (codeOf(e) === 'EEXIST') notOurs = true
    })
    const removeOurs = () => (notOurs ? Promise.resolve() : removeQuietly(file))

    type End = 'ok' | 'big' | 'big-open' | 'gone' | 'fail'
    let bytes = 0
    const end = await new Promise<End>((resolve) => {
      let over = false
      let drained = 0
      let settled = false
      const done = (v: End) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('close', onClose)
        out.off('error', onOutError)
        if (v !== 'ok' && v !== 'big' && !req.readableEnded) req.pause()
        resolve(v)
      }
      const timer = setTimeout(() => done(over ? 'big-open' : 'gone'), UPLOAD_IDLE_MS)
      const onData = (c: Buffer) => {
        timer.refresh()
        if (!over && bytes + c.length > ATTACH_MAX_BYTES) {
          over = true
          drained = bytes + c.length - ATTACH_MAX_BYTES
          out.destroy()
        } else if (over) {
          drained += c.length
        } else {
          bytes += c.length
          if (!out.write(c)) {
            req.pause()
            out.once('drain', () => req.resume())
          }
          return
        }
        if (drained > DRAIN_MAX) done('big-open')
      }
      const onEnd = () => done(over ? 'big' : 'ok')
      const onClose = () => done(over ? 'big-open' : 'gone')
      const onOutError = () => done('fail')
      req.on('data', onData)
      req.once('end', onEnd)
      req.once('close', onClose)
      out.once('error', onOutError)
    })

    if (end === 'ok') {
      out.end()
      await outClosed
      if (!outFailed) return sendJson(res, 200, { ok: true, path: file, name, bytes })
      await removeOurs()
      return sendJson(res, 500, fail(E.upload))
    }
    out.destroy()
    await outClosed
    await removeOurs()
    if (end === 'gone') return void req.destroy()
    if (end === 'fail') return refuse(req, res, 500, E.upload)
    sendJson(res, 413, fail(ATTACH_TOO_BIG), end === 'big' ? undefined : CLOSE)
  }

  /** staticDir 안의 파일 — 마디 꼴·확장자 허용 목록 · 글자로도 진짜 경로(realpath — 연결·junction 을 따라간 뒤)로도 안쪽만 */
  async function staticFile(p: string): Promise<{ file: string; size: number; type: string; cache: string } | 'bad' | null> {
    let rel: string
    try {
      rel = decodeURIComponent(p)
    } catch {
      return 'bad'
    }
    if (!rel.startsWith('/')) return 'bad'
    if (rel === '/') rel = '/mobile.html'
    const parts = rel.slice(1).split('/')
    if (!parts.every((s) => SEGMENT.test(s))) return null
    const ext = path.extname(parts[parts.length - 1]).toLowerCase()
    const type = Object.hasOwn(TYPES, ext) ? TYPES[ext] : undefined
    if (!type) return null
    const root = path.resolve(o.staticDir)
    const full = path.join(root, ...parts)
    if (!within(root, full)) return null
    try {
      const [realRoot, realFull] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(full)])
      if (!within(realRoot, realFull)) return null
      const st = await fs.promises.stat(realFull)
      if (!st.isFile()) return null
      const top = parts.length === 1 ? parts[0].toLowerCase() : ''
      const cache = ext === '.html' || top === 'sw.js'
        ? 'no-store'
        : parts[0] === 'assets' ? 'public, max-age=31536000, immutable' : 'no-cache'
      return { file: realFull, size: st.size, type, cache }
    } catch {
      return null
    }
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, gate: Gate, p: string): Promise<void> {
    const hit = await staticFile(p)
    if (hit === 'bad') return refuse(req, res, 400, E.bad)
    if (!hit) return refuse(req, res, 404, E.notFound)
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': hit.type,
      'content-length': hit.size,
      'cache-control': hit.cache,
      'content-security-policy': cspFor(gate),
    })
    if (req.method === 'HEAD') return void res.end()
    // pipeline — 휴대폰이 받다 끊어도 읽던 파일을 닫는다(pipe 는 원본을 열어 둔다)
    pipeline(fs.createReadStream(hit.file), res, () => {})
  }

  // ── WebSocket ──

  const wss = new WebSocketServer({ noServer: true, maxPayload: PHONE_WS_MESSAGE_MAX, perMessageDeflate: false, clientTracking: false })
  wss.on('headers', (headers, req) => {
    const token = upgradeTokens.get(req)
    upgradeTokens.delete(req)
    if (token) headers.push(`Set-Cookie: ${cookieFor(token)}`)
  })
  wss.on('error', () => {})

  /** 머리글로 거절하고 닫는다(WebSocket 을 열지 않는다) */
  function deny(socket: Duplex, status: number): void {
    socket.once('finish', () => socket.destroy())
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {})
    if (closed) return deny(socket, 503)
    const gate = gateOf(req)
    if (!gate) return deny(socket, 403)
    if (pathOf(req.url) !== PHONE_PATHS.ws) return deny(socket, 404)
    if (!originOk(req, gate)) return deny(socket, 403)
    const a = authOf(req)
    if (a === 'error') return deny(socket, 503)
    if (a === 'none') return deny(socket, 401)
    upgradeTokens.set(req, a.token)
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, a.device))
  }

  const deviceVisible = (id: string) => [...clients].some((c) => c.deviceId === id && c.visible)

  function accept(ws: WebSocket, device: PhoneDevice): void {
    if (closed) return void ws.terminate()
    const c: Client = { ws, deviceId: device.id, visible: false, alive: true }
    clients.add(c)
    ws.on('pong', () => {
      c.alive = true
    })
    ws.on('message', (data, isBinary) => onMessage(c, data, isBinary))
    ws.on('close', () => drop(c))
    ws.on('error', () => {})
    safely(() => o.pairing.touch(device.id))
    safely(() => o.onClients?.())
  }

  /** 목록에서 뺀다 — 그 기기의 마지막 보이던 소켓이면 onVisible(false) */
  function drop(c: Client): void {
    if (!clients.has(c)) return
    const before = deviceVisible(c.deviceId)
    clients.delete(c)
    if (before && !deviceVisible(c.deviceId)) safely(() => o.onVisible?.(c.deviceId, false))
    if (!closed) safely(() => o.onClients?.())
  }

  function setVisible(c: Client, on: boolean): void {
    const before = deviceVisible(c.deviceId)
    c.visible = on
    const after = deviceVisible(c.deviceId)
    if (before !== after) safely(() => o.onVisible?.(c.deviceId, after))
  }

  function sendText(c: Client, text: string): void {
    if (c.ws.readyState !== WebSocket.OPEN) return
    if (c.ws.bufferedAmount > SEND_BUFFER_MAX) return void c.ws.terminate()
    c.ws.send(text)
  }

  function reply(c: Client, m: Extract<PhoneServerMessage, { t: 'result' }>): void {
    let text: string
    try {
      text = JSON.stringify(m)
    } catch {
      text = JSON.stringify({ t: 'result', id: m.id, ok: false, error: E.reply })
    }
    sendText(c, text)
  }

  async function run(c: Client, id: number, method: string, args: unknown[]): Promise<void> {
    let r: InvokeResult
    try {
      r = await o.dispatch(method, args)
    } catch {
      r = { ok: false, error: E.call }
    }
    if (r.ok) reply(c, { t: 'result', id, ok: true, value: r.value })
    else reply(c, { t: 'result', id, ok: false, error: typeof r.error === 'string' ? r.error : E.call })
  }

  /** 받는 꼴: { t:'call', id, method, args } · { t:'visible', on }. 그 밖·글이 아닌 틀은 버린다. 토큰은 열 때 한 번만 봤다(메시지마다 안 봄) */
  function onMessage(c: Client, data: RawData, isBinary: boolean): void {
    if (!clients.has(c) || isBinary) return
    let m: unknown
    try {
      m = JSON.parse(textOf(data))
    } catch {
      return
    }
    if (!isObj(m)) return
    if (m.t === 'visible') {
      if (typeof m.on === 'boolean') setVisible(c, m.on)
      return
    }
    if (m.t !== 'call' || typeof m.id !== 'number' || !Number.isSafeInteger(m.id)) return
    if (typeof m.method !== 'string' || !Array.isArray(m.args)) return reply(c, { t: 'result', id: m.id, ok: false, error: E.bad })
    void run(c, m.id, m.method, m.args)
  }

  function forward(name: string, payload: unknown): void {
    if (closed || clients.size === 0) return
    let text: string
    try {
      text = JSON.stringify({ t: 'event', name, payload })
    } catch {
      return
    }
    for (const c of clients) sendText(c, text)
  }

  // ── 열기 ──

  const server = http.createServer({ requestTimeout: 0, headersTimeout: HEADERS_TIMEOUT_MS }, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, fail(E.call), CLOSE)
      else res.destroy()
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('upgrade', onUpgrade)

  port = await listen(server, o.port)

  const pinger = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate()
        continue
      }
      c.alive = false
      safely(() => c.ws.ping())
    }
  }, WS_PING_MS)
  pinger.unref()

  async function close(): Promise<void> {
    if (closing) return closing
    closed = true
    closing = (async () => {
      clearInterval(pinger)
      if (unsubscribe) safely(unsubscribe)
      unsubscribe = null
      for (const c of clients) c.ws.terminate()
      clients.clear()
      wss.close()
      await new Promise<void>((r) => {
        server.close(() => r())
        for (const s of sockets) s.destroy()
      })
    })()
    return closing
  }

  try {
    unsubscribe = o.subscribe(forward)
  } catch (e) {
    await close()
    throw e
  }

  return {
    port,
    close,
    kick(deviceId) {
      for (const c of [...clients]) {
        if (c.deviceId !== deviceId) continue
        drop(c)
        try {
          c.ws.close(PHONE_CLOSE_UNPAIRED, 'unpaired')
        } catch {
          c.ws.terminate()
        }
        setTimeout(() => c.ws.terminate(), KICK_GRACE_MS).unref()
      }
    },
    clients: () => [...clients].map((c) => ({ deviceId: c.deviceId, visible: c.visible })),
  }
}
