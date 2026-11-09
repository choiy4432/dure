// 휴대폰 → PC 휴대폰 서버의 HTTP 길 — 짝 여부(/api/me) · 짝 맺기(/api/pair) · 알림 구독(/api/vapid → /api/subscribe).
// 기기 토큰은 HttpOnly 쿠키라 이 코드는 토큰을 보지 못한다(credentials: same-origin 으로 브라우저가 실어 보낸다)
import { PHONE_PATHS, type PhoneAndroidApp, type PhoneMeResponse, type PhonePairResponse, type PhoneVapidResponse } from '../../shared/phoneWire'
import type { PhoneDevice } from '../../shared/phoneTypes'

export const PAIR_OFFLINE = '두레에 닿지 못했어요 — PC 가 켜져 있는지 확인해 주세요'
export const PAIR_FAILED = '짝을 맺지 못했어요 — 다시 해 주세요'

/** 짝 여부 묻기를 이만큼 기다린다 — PC 가 잠들었거나 망이 바뀌면 답도 닫힘도 없이 몇 분씩 걸린다 */
export const HTTP_TIMEOUT_MS = 8000

type Http = { base?: string; fetch?: typeof fetch }
const baseOf = (o: Http) => o.base ?? location.origin
const fetchOf = (o: Http): typeof fetch => o.fetch ?? ((...a) => fetch(...a))

/** ms 안에 답이 없으면 요청을 끊고 실패로 — fetch 가 끊기 신호를 무시해도 기다리지 않는다 */
async function fetchWithin(o: Http, url: string, init: RequestInit, ms = HTTP_TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort()
      reject(new Error('timeout'))
    }, ms)
  })
  try {
    return await Promise.race([fetchOf(o)(url, { ...init, signal: ctl.signal }), late])
  } finally {
    clearTimeout(timer)
  }
}

/** 이 휴대폰이 짝을 맺었나 — paired(200) · unpaired(401) · unknown(끊김·서버 오류·8초 넘게 답 없음: 일단 이어 보고 다시 묻는다) */
export async function checkMe(o: Http = {}): Promise<'paired' | 'unpaired' | 'unknown'> {
  try {
    const r = await fetchWithin(o, `${baseOf(o)}${PHONE_PATHS.me}`, { credentials: 'same-origin', cache: 'no-store' })
    if (r.status === 401) return 'unpaired'
    return r.ok ? 'paired' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** androidApp 칸 — 꼴이 틀렸거나 없으면(옛 PC 두레) 앱 없음으로 */
const androidAppOf = (v: unknown): PhoneAndroidApp | null => {
  if (!v || typeof v !== 'object') return null
  const { versionCode, packageName } = v as Record<string, unknown>
  return Number.isInteger(versionCode) && typeof packageName === 'string' && packageName ? { versionCode: versionCode as number, packageName } : null
}

/**
 * 이 휴대폰(PC 가 기억하는 이름 등)과 PC 가 내어 줄 안드로이드 앱(판·패키지 — 없으면 null).
 * 짝을 안 맺었거나 끊겼거나 서버 오류면 null
 */
export async function meInfo(o: Http = {}): Promise<{ device: PhoneDevice; androidApp: PhoneAndroidApp | null } | null> {
  try {
    const r = await fetchWithin(o, `${baseOf(o)}${PHONE_PATHS.me}`, { credentials: 'same-origin', cache: 'no-store' })
    if (!r.ok) return null
    const body = (await r.json()) as PhoneMeResponse
    if (!body || !body.ok || !body.device || typeof body.device.name !== 'string') return null
    return { device: body.device, androidApp: androidAppOf(body.androidApp) }
  } catch {
    return null
  }
}

/** 이 휴대폰(PC 가 기억하는 이름 등) — 짝을 안 맺었거나 끊겼거나 서버 오류면 null */
export async function meDevice(o: Http = {}): Promise<PhoneDevice | null> {
  return (await meInfo(o))?.device ?? null
}

/** 짝 맺기 결과 — kind 로 화면 글을 고른다(틀림·지남은 화면의 말로, 막힘·그 밖은 서버 글 그대로) */
export type PairOutcome = { ok: true } | { ok: false; kind: 'wrong' | 'expired' | 'locked' | 'offline' | 'other'; error: string }

/** secret = QR 의 짝 코드 또는 6자리 숫자 — 맞으면 서버가 기기 토큰 쿠키를 심는다 */
export async function pairWith(secret: string, name: string, o: Http = {}): Promise<PairOutcome> {
  let r: Response
  try {
    r = await fetchOf(o)(`${baseOf(o)}${PHONE_PATHS.pair}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, name }),
    })
  } catch {
    return { ok: false, kind: 'offline', error: PAIR_OFFLINE }
  }
  let body: PhonePairResponse | null = null
  try {
    body = (await r.json()) as PhonePairResponse
  } catch {
    body = null
  }
  if (r.ok && body?.ok) return { ok: true }
  const error = body && !body.ok && typeof body.error === 'string' && body.error ? body.error : PAIR_FAILED
  const kind = r.status === 400 ? 'wrong' : r.status === 410 ? 'expired' : r.status === 429 ? 'locked' : 'other'
  return { ok: false, kind, error }
}

export type PushOutcome = 'on' | 'denied' | 'unsupported' | 'failed'

export type NotificationLike = { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> }
type PushDeps = Http & {
  /** 없으면(앱 안 브라우저·아이폰 사파리) unsupported */
  notification?: NotificationLike | null
  /** 서비스 워커 등록 — 활성 워커가 있어야 구독할 수 있다 */
  registration?: () => Promise<ServiceWorkerRegistration>
  /** 열쇠가 같아도 옛 구독을 지우고 새로 — 두레 앱 안에서 처음(크롬 탭·웹앱이 만든 구독 대신 앱이 받게, 설계 §5.6) */
  fresh?: boolean
}

/** VAPID 공개 열쇠(base64url) → 바이트 */
export function base64UrlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const sameBytes = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

/** 서비스 워커가 활성될 때까지 — 10초 넘으면 실패 */
async function swRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js')
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sw')), 10_000)),
  ])
}

const defaultNotification = (): NotificationLike | null =>
  typeof Notification !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined'
    ? Notification
    : null

/**
 * 알림 켜기 — 허락을 묻고(누른 그 자리에서 불러야 한다: 아이폰은 사용자 손짓이 있어야 묻는다) → 공개 열쇠 → 구독 → PC 에 올림.
 * 이미 구독이 있는데 열쇠가 다르면(PC 가 열쇠를 새로 만듦) 지우고 다시 — 안 지우면 subscribe 가 InvalidStateError(실측). fresh 면 열쇠가 같아도 지우고 다시
 */
export async function subscribePush(o: PushDeps = {}): Promise<PushOutcome> {
  const n = o.notification === undefined ? defaultNotification() : o.notification
  if (!n) return 'unsupported'
  let perm = n.permission
  if (perm === 'default') {
    try {
      perm = await n.requestPermission()
    } catch {
      return 'failed'
    }
  }
  if (perm !== 'granted') return 'denied'
  try {
    const doFetch = fetchOf(o)
    const base = baseOf(o)
    const reg = await (o.registration ?? swRegistration)()
    const vr = await doFetch(`${base}${PHONE_PATHS.vapid}`, { credentials: 'same-origin', cache: 'no-store' })
    const v = (await vr.json()) as PhoneVapidResponse
    if (!vr.ok || !v.ok) return 'failed'
    const key = base64UrlBytes(v.publicKey)
    let sub = await reg.pushManager.getSubscription()
    if (sub && (o.fresh || !sameBytes(sub.options?.applicationServerKey, key))) {
      await sub.unsubscribe()
      sub = null
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource })
    const sr = await doFetch(`${base}${PHONE_PATHS.subscribe}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    })
    return sr.ok ? 'on' : 'failed'
  } catch {
    return 'failed'
  }
}

/** 글을 클립보드로 — 안 되면(권한·옛 브라우저) 숨은 칸을 골라 복사. 둘 다 안 되면 false */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 아래로
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
