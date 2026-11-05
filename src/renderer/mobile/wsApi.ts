// 휴대폰의 window.dure — PC 창의 preload(IPC)와 같은 꼴(DureApi)을 WebSocket 으로 만든다. 화면·스토어 코드는 그대로 쓴다.
// 휴대폰에서 되는 메서드(PHONE_ACCESS 'phone')만 PC 로 보내고, 나머지는 보내지 않고 바로 거절한다(서버도 같은 목록으로 다시 거른다).
import { APP_METHODS, METHODS, type DureApi } from '../../shared/ipcContract'
import { PHONE_DENIED, phoneAllows } from '../../shared/phoneAccess'
import { PHONE_CLOSE_UNPAIRED, PHONE_PATHS, type PhoneClientMessage, type PhoneServerMessage, type PhoneUploadResponse } from '../../shared/phoneWire'
import { ATTACH_MAX_BYTES, ATTACH_TOO_BIG } from '../../shared/attachments'
import { checkMe } from './phoneHttp'
import { markPhone } from '../lib/phone'

/** 연결이 끊긴 동안 부른 일 · 보내기 전에 끊긴 일 — 화면이 오류 줄로 보인다 */
export const PHONE_OFFLINE = '연결이 끊겼어요 — 다시 잇는 중이에요'
/** 보냈는데 답을 받기 전에 끊겼다 — PC 가 받았는지 모른다(그대로 또 보내면 두 번 갈 수 있다) */
export const PHONE_UNSURE = '보냈는지 확인하지 못했어요 — 기록을 확인해 주세요'
/** JSON 으로 바꿀 수 없는 인자(순환·BigInt 등) — 보내지 않는다(서버의 같은 경우 글과 같다) */
export const PHONE_BAD_ARGS = '요청 꼴이 올바르지 않아요'
/** PC 에서 이 휴대폰을 끊었다 — 진입점이 짝 맺기 화면으로 간다 */
export const PHONE_UNPAIRED = '짝이 끊겼어요 — 다시 짝을 맺어 주세요'
export const UPLOAD_FAILED = '파일을 올리지 못했어요'
/** 다시 잇기 간격(ms) — 이어지면 처음부터, 끝 값에서 머문다 */
export const RECONNECT_MS = [1000, 2000, 5000, 10_000] as const
/** 소켓 열기를 이만큼 기다린다 — 넘으면 못 연 것으로 치고 다시(망이 바뀐 직후엔 열기가 끝나지 않을 수 있다) */
export const OPEN_TIMEOUT_MS = 10_000
/** 화면이 보이는 동안 이 간격으로 살아 있나 묻는다({t:'ping'}) — 화면이 다시 보일 때는 바로 */
export const PING_EVERY_MS = 25_000
/**
 * 물은 뒤 이만큼 아무 글도 안 오면 끊긴 것으로 친다 — PC 가 잠들거나 망이 끊기면 닫힘 신호 없이 '연결됨' 인 채로 call 이 몇 시간 걸린다.
 * 큰 글(그림)을 보내는 중이라 보낼 몫(bufferedAmount)이 줄고 있으면 한 번 더 기다린다
 */
export const PONG_WAIT_MS = 7000

export type PhoneConnState = 'open' | 'reconnecting'
export type PhoneUpload = { path: string; name: string; bytes: number }

/** 휴대폰의 window.dure — DureApi + 올리기(휴대폰엔 PC 경로가 없다) */
export type PhoneApi = DureApi & {
  /** 휴대폰 파일을 PC 의 받은 폴더로 올린다 — 돌려받은 path 를 sendUser 의 file part 로. 100MB 넘으면 올리지 않고 거절 · signal 로 끊는다(칩을 뺌) */
  uploadFile(file: File, signal?: AbortSignal): Promise<PhoneUpload>
  /** 휴대폰 File 은 PC 경로가 없다 — 늘 '' (입력창은 '' 이면 uploadFile 로) */
  pathForFile(file: File): string
  /** 화면이 보이는가 — PC 가 보는 중인 기기엔 알림을 보내지 않는다. visibilitychange 는 스스로 따라간다 */
  setVisible(on: boolean): void
  /** 소켓을 닫고 다시 잇지 않는다 */
  close(): void
}

/** 브라우저 WebSocket 에서 쓰는 만큼 — 시험은 가짜를 넣는다 */
type WsLike = {
  readyState: number
  /** 아직 못 보낸 바이트 — 큰 글을 보내는 중인지(없는 구현은 0 으로) */
  bufferedAmount?: number
  send(data: string): void
  close(code?: number): void
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number }) => void) | null
  onerror: ((e: unknown) => void) | null
}
type WsCtor = new (url: string) => WsLike

export interface WsApiOptions {
  /** wss://<호스트>/api/ws — 올리기·짝 확인 주소도 이 호스트로 */
  url: string
  WebSocketImpl?: typeof WebSocket
  /**
   * 연결 상태 — 'open' 의 again: 처음 연결이 아니다(끊겼다 이어졌다 · 처음 시도가 실패했었다) → 진입점이 스냅샷·열린 대화를 다시 받는다.
   * 'reconnecting' 의 again: 열려 있다가 끊겼다(처음 시도부터 못 열었으면 false)
   */
  onConn?: (s: PhoneConnState, again: boolean) => void
  /** 짝이 끊겼다 — PC 에서 [끊기](4401) 또는 열지 못한 뒤 /api/me 가 401. 다시 잇지 않는다 */
  onUnpaired?: () => void
  fetchImpl?: typeof fetch
}

const OPEN = 1
/** WebSocket 답 하나의 꼴 — 아니면 버린다 */
function parseServer(data: unknown): PhoneServerMessage | null {
  if (typeof data !== 'string') return null
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  if (m.t === 'result' && typeof m.id === 'number' && typeof m.ok === 'boolean') return m as PhoneServerMessage
  if (m.t === 'event' && typeof m.name === 'string') return m as PhoneServerMessage
  if (m.t === 'pong') return m as PhoneServerMessage
  return null
}

/** JSON 은 Infinity 를 null 로 바꾼다 — '전부'(지난 대화 전부 보기 · 내보내기)는 가장 큰 안전한 정수로(엔진은 같게 다룬다) */
const encode = (m: PhoneClientMessage) => JSON.stringify(m, (_k, v: unknown) => (v === Infinity ? Number.MAX_SAFE_INTEGER : v))
const PING = encode({ t: 'ping' })

export function createWsApi(o: WsApiOptions): PhoneApi {
  const Ws = (o.WebSocketImpl ?? WebSocket) as unknown as WsCtor
  const doFetch: typeof fetch = o.fetchImpl ?? ((...a) => fetch(...a))
  const wsUrl = new URL(o.url)
  /** https://<호스트> — 올리기·짝 확인 */
  const base = `${wsUrl.protocol === 'ws:' ? 'http:' : 'https:'}//${wsUrl.host}`

  let ws: WsLike | null = null
  let isOpen = false
  /** 한 번이라도 열렸었나 — 처음 시도 중의 call 은 열릴 때까지 기다리고, 그 뒤엔 끊긴 동안 바로 거절한다 */
  let everOpened = false
  /** 한 번이라도 끊기거나 못 열었나 — 다음 'open' 의 again */
  let everClosed = false
  let stopped = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  let seq = 0
  /** sent — 소켓에 넘겼다(끊기면 PC 가 받았는지 모른다) */
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; sent: boolean }>()
  /** 처음 열리기 전에 부른 call(이미 JSON 으로 바꾼 글) — 열리면 보낸다 */
  let queued: { id: number; text: string }[] = []
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  let visible = typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  /** 열기 기다림 · 다음 물음 · 물은 뒤 답 기다림 */
  let openTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setTimeout> | null = null
  let pongTimer: ReturnType<typeof setTimeout> | null = null
  /** 물을 때(또는 지난 확인 때)의 보낼 몫 — 줄고 있으면 큰 글을 보내는 중이다 */
  let bufferedAtCheck = 0

  /** 글 하나를 소켓에 — 넘겼으면 true(닫히는 중이면 false: close 사건이 진행 중 call 을 끝낸다) */
  const sendText = (text: string): boolean => {
    if (!ws) return false
    try {
      ws.send(text)
      return true
    } catch {
      return false
    }
  }

  /** 답을 기다리던 call 을 모두 끝낸다 — 이미 보낸 것은 unsure 글로(보냈는지 모른다), 못 보낸 것은 msg */
  const failAll = (msg: string, unsure = msg) => {
    const all = [...pending.values()]
    pending.clear()
    queued = []
    for (const p of all) p.reject(new Error(p.sent ? unsure : msg))
  }

  const clearTimers = () => {
    for (const t of [openTimer, pingTimer, pongTimer]) if (t) clearTimeout(t)
    openTimer = pingTimer = pongTimer = null
  }

  /** 살아 있나 묻는다 — 이미 묻는 중이면 그 답을 기다린다 */
  const ping = () => {
    if (!isOpen || pongTimer) return
    if (!sendText(PING)) return
    bufferedAtCheck = ws?.bufferedAmount ?? 0
    pongTimer = setTimeout(checkPong, PONG_WAIT_MS)
  }
  const checkPong = () => {
    pongTimer = null
    if (!isOpen) return
    // 큰 글을 보내는 중 — ping 이 그 뒤에 줄 서 있다. 보낼 몫이 줄고 있으면 망은 살아 있다
    const b = ws?.bufferedAmount ?? 0
    if (b > 0 && b < bufferedAtCheck) {
      bufferedAtCheck = b
      pongTimer = setTimeout(checkPong, PONG_WAIT_MS)
      return
    }
    lost()
  }
  /** 무엇이든 왔다 — 살아 있다 */
  const heard = () => {
    if (pongTimer) clearTimeout(pongTimer)
    pongTimer = null
  }
  /** 보이는 동안만 PING_EVERY_MS 마다 묻는다 */
  const beat = () => {
    if (pingTimer) clearTimeout(pingTimer)
    pingTimer = null
    if (!isOpen || !visible) return
    pingTimer = setTimeout(() => {
      pingTimer = null
      ping()
      beat()
    }, PING_EVERY_MS)
  }
  /** 답이 없다 — 반쯤 열린 소켓을 버리고 끊긴 것으로(그 소켓의 늦은 닫힘은 ws !== sock 이라 버려진다) */
  const lost = () => {
    const sock = ws
    ws = null
    try {
      sock?.close()
    } catch {
      // 이미 닫힘
    }
    onDown(true, 1006)
  }

  const connect = () => {
    retry = null
    if (stopped) return
    let sock: WsLike
    try {
      sock = new Ws(o.url)
    } catch {
      onDown(false, 1006)
      return
    }
    ws = sock
    // 열기가 끝나지 않는다(망이 바뀐 직후 등) — 버리고 못 연 것으로
    openTimer = setTimeout(() => {
      openTimer = null
      if (ws !== sock || isOpen) return
      ws = null
      try {
        sock.close()
      } catch {
        // 이미 닫힘
      }
      onDown(false, 1006)
    }, OPEN_TIMEOUT_MS)
    sock.onopen = () => {
      if (ws !== sock || stopped) return
      if (openTimer) clearTimeout(openTimer)
      openTimer = null
      isOpen = true
      attempt = 0
      const again = everClosed
      everOpened = true
      // 서버는 처음엔 안 보임으로 친다 — 지금 상태부터
      sendText(encode({ t: 'visible', on: visible }))
      const q = queued
      queued = []
      for (const m of q) {
        const p = pending.get(m.id)
        if (p && sendText(m.text)) p.sent = true
      }
      beat()
      o.onConn?.('open', again)
    }
    sock.onmessage = (e) => {
      if (ws !== sock) return
      heard()
      const m = parseServer(e.data)
      if (!m || m.t === 'pong') return
      if (m.t === 'result') {
        const p = pending.get(m.id)
        if (!p) return // 이미 실패로 끝낸 call 의 늦은 답
        pending.delete(m.id)
        if (m.ok) p.resolve(m.value)
        else p.reject(new Error(typeof m.error === 'string' ? m.error : PHONE_OFFLINE))
        return
      }
      for (const fn of [...(listeners.get(m.name) ?? [])]) {
        try {
          fn(m.payload)
        } catch (err) {
          console.error('두레: 사건을 처리하지 못했어요', err)
        }
      }
    }
    sock.onerror = () => {}
    sock.onclose = (e) => {
      if (ws !== sock) return
      onDown(isOpen, e.code)
    }
  }

  /** 소켓이 닫혔다(열려 있다가 끊김 · 못 엶 · 답이 없어 버림) */
  const onDown = (wasOpen: boolean, code: number) => {
    ws = null
    isOpen = false
    everClosed = true
    clearTimers()
    if (stopped) return
    if (code === PHONE_CLOSE_UNPAIRED) return unpaired()
    failAll(PHONE_OFFLINE, PHONE_UNSURE)
    o.onConn?.('reconnecting', wasOpen)
    if (wasOpen) return schedule()
    // 못 열었다 — 브라우저는 업그레이드의 401 을 알려 주지 않는다(1006). 짝이 끊겼는지 /api/me 로 본다
    void checkPaired().then((paired) => {
      if (stopped) return
      if (paired === false) unpaired()
      else schedule()
    })
  }

  const schedule = () => {
    if (stopped || retry) return
    const ms = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]
    attempt++
    retry = setTimeout(connect, ms)
  }

  /** true 짝 맺음 · false 끊김(401) · null 모름(끊김·서버 오류·8초 넘게 답 없음) */
  const checkPaired = async (): Promise<boolean | null> => {
    const r = await checkMe({ base, fetch: doFetch })
    return r === 'unpaired' ? false : r === 'paired' ? true : null
  }

  const unpaired = () => {
    stop(PHONE_UNPAIRED)
    o.onUnpaired?.()
  }

  const stop = (msg: string) => {
    stopped = true
    if (retry) clearTimeout(retry)
    retry = null
    clearTimers()
    const sock = ws
    ws = null
    isOpen = false
    try {
      sock?.close(1000)
    } catch {
      // 이미 닫힘
    }
    failAll(msg)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    if (typeof window !== 'undefined') window.removeEventListener('online', retryNow)
  }

  /**
   * 화면이 다시 보이거나 망이 돌아왔다(휴대폰은 숨은 동안 시계를 멈춘다) — 기다리던 다시 잇기는 바로,
   * 열려 있으면 바로 살아 있나 묻는다(그사이 PC 가 잠들었으면 소켓은 닫힘 없이 '열림' 이다)
   */
  const retryNow = () => {
    if (stopped) return
    if (isOpen) return ping()
    if (!retry) return
    clearTimeout(retry)
    connect()
  }

  const setVisible = (on: boolean) => {
    if (on === visible) return
    visible = on
    if (isOpen) sendText(encode({ t: 'visible', on }))
    // 숨으면 묻기를 멈춘다 — 멈췄던 시계가 돌아올 때 늦게 울린 기다림이 멀쩡한 연결을 끊지 않게(보이면 바로 다시 묻는다)
    if (!on) heard()
    beat()
  }
  const onVisibility = () => {
    const on = document.visibilityState !== 'hidden'
    setVisible(on)
    if (on) retryNow()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  if (typeof window !== 'undefined') window.addEventListener('online', retryNow)

  const call = (method: string, args: unknown[]): Promise<unknown> => {
    if (!phoneAllows(method)) return Promise.reject(new Error(PHONE_DENIED))
    if (stopped) return Promise.reject(new Error(PHONE_UNPAIRED))
    if (!isOpen && everOpened) return Promise.reject(new Error(PHONE_OFFLINE))
    // 끝의 undefined 는 뺀다 — JSON 은 null 로 바꾸고, 서버의 꼴 검사는 null 을 '없음'으로 보지 않는다
    const a = [...args]
    while (a.length > 0 && a[a.length - 1] === undefined) a.pop()
    const id = ++seq
    // 먼저 글로 바꾼다 — 못 바꾸면(순환·BigInt) 이 call 만 바로 거절(열린 뒤 보낼 때 조용히 사라져 영영 기다리지 않게)
    let text: string
    try {
      text = encode({ t: 'call', id, method, args: a })
    } catch {
      return Promise.reject(new Error(PHONE_BAD_ARGS))
    }
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, sent: false }
      pending.set(id, p)
      if (isOpen) p.sent = sendText(text)
      else queued.push({ id, text })
    })
  }

  // 휴대폰 표시(onPhone) — 화면 코드는 메서드 이름이 아니라 이 표시로 휴대폰인지 안다
  const api: Record<string, unknown> = markPhone({})
  for (const m of [...METHODS, ...APP_METHODS]) api[m] = (...args: unknown[]) => call(m, args)
  api.on = (name: string, fn: (p: unknown) => void) => {
    let set = listeners.get(name)
    if (!set) listeners.set(name, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }
  api.pathForFile = () => ''
  api.setVisible = setVisible
  api.close = () => stop(PHONE_OFFLINE)
  api.uploadFile = async (file: File, signal?: AbortSignal): Promise<PhoneUpload> => {
    // 서버도 100MB 에서 끊지만, 올리는 도중의 413 은 휴대폰에 망 오류로 보일 수 있다 — 미리 막는다
    if (file.size > ATTACH_MAX_BYTES) throw new Error(ATTACH_TOO_BIG)
    const u = `${base}${PHONE_PATHS.upload}?name=${encodeURIComponent(file.name)}`
    let r: Response
    try {
      r = await doFetch(u, { method: 'POST', body: file, credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, signal })
    } catch {
      throw new Error(UPLOAD_FAILED)
    }
    let body: PhoneUploadResponse | null = null
    try {
      body = (await r.json()) as PhoneUploadResponse
    } catch {
      body = null
    }
    if (!body || typeof body !== 'object') throw new Error(UPLOAD_FAILED)
    if (!body.ok) throw new Error(typeof body.error === 'string' && body.error ? body.error : UPLOAD_FAILED)
    if (!r.ok) throw new Error(UPLOAD_FAILED)
    return { path: body.path, name: body.name, bytes: body.bytes }
  }

  connect()
  return api as unknown as PhoneApi
}
