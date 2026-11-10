import { parse as legacyUrlParse } from 'node:url'
import webpush, { type RequestOptions } from 'web-push'
import { isIdleDevice, pickSubscription, type PhonePushSubscription, type PhoneStore, type StoredPhoneDevice, type VapidKeys } from './phoneStore'

// 웹 푸시(VAPID) — 휴대폰 알림을 PC 에서 바깥 알림 서버(구글·애플·모질라·마이크로소프트)로 보낸다.
// 🔴 VAPID 비밀 열쇠·구독 주소·구독 열쇠는 로그·오류 글에 싣지 않는다. 알림 글은 PhoneNotice 네 칸뿐(명령·대화 글 없음)

/** 휴대폰 서비스 워커가 받는 알림 — 이 네 칸만 보낸다. tag 는 알림마다 달라야 안드로이드가 다시 울린다(probe28) */
export type PhoneNotice = {
  title: '두레'
  /** '<에이전트 이름> · <짧은 말>' */
  body: string
  /** 'dure-<agentId>-<종류>-<번호>' — 알림마다 새 번호 */
  tag: string
  /** 누르면 열 곳 — '/#agent=<agentId>' */
  url: string
}

/** 알림 서버에 주는 것 — urgency: 'high' 는 바로 깨워 보내기(승인·질문), ttl: 휴대폰이 꺼져 있을 때 알림 서버가 들고 있는 초 */
export type PushDelivery = { urgency: 'high' | 'normal'; ttl: number }

/** 승인·질문·넘기기 기다림 — 바로, 한 시간까지 */
export const ASK_DELIVERY: Readonly<PushDelivery> = Object.freeze({ urgency: 'high', ttl: 3600 })
/** 일을 마쳤어요 — 보통, 10분까지(늦게 와 봐야 쓸모없다) */
export const FINISHED_DELIVERY: Readonly<PushDelivery> = Object.freeze({ urgency: 'normal', ttl: 600 })

/** VAPID 주제 — 알림 서버가 문제 때 연락할 곳. 공개 레포라 메일 주소 대신 레포 주소 */
export const VAPID_SUBJECT = 'https://github.com/choiy4432/dure'

/** 보내기 한 번 — 404·410(구독이 사라짐)이면 { gone: true }, 그 밖의 실패는 던진다(오류 글에 주소·열쇠 없이) */
export type PushSend = (sub: PhonePushSubscription, payload: string, vapid: VapidKeys, o: PushDelivery) => Promise<{ gone: boolean }>

export interface Push {
  /** VAPID 공개 열쇠 — 없으면 이때 한 번 만들어 phone.json 에 저장한다(있으면 절대 다시 만들지 않는다 — 바꾸면 모든 구독이 깨진다, probe28) */
  publicKey(): string
  /**
   * 휴대폰이 올린 구독을 그 기기에 저장한다. 꼴이 틀리거나 알려진 알림 서버 주소가 아니면 던진다.
   * 그 사이 끊긴 기기면 아무것도 안 한다. 같은 주소를 가진 다른 기기의 구독은 뺀다(한 브라우저가 다시 짝을 맺은 것 — 두 번 울리지 않게)
   */
  subscribe(deviceId: string, sub: unknown): void
  /** 그 기기로 알림 하나 — 구독이 없으면 안 보낸다. 404·410 이면 그 구독을 지운다. 던지지 않는다(실패는 로그에, 주소·열쇠 없이) */
  sendTo(deviceId: string, n: PhoneNotice, o?: PushDelivery): Promise<void>
}

/**
 * 알려진 웹 푸시 서버 — 이 이름이거나 그 아래 이름만(SSRF 막기: 짝 맺은 휴대폰이 PC 더러 아무 주소로나 POST 하게 하지 못하게).
 * 크롬·삼성 인터넷 = fcm.googleapis.com · 사파리 = web.push.apple.com · 파이어폭스 = updates.push.services.mozilla.com · 엣지 = *.notify.windows.com
 */
export const PUSH_HOSTS: readonly string[] = Object.freeze([
  'fcm.googleapis.com',
  'push.apple.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
])

/**
 * 주소에 쓸 수 있는 글자 — RFC 3986 의 글자에서 작은따옴표를 뺀 것.
 * 빈칸·제어 문자·따옴표·역슬래시·중괄호·백틱·<>^| ·ASCII 밖 글자는 안 된다(옛 url.parse 가 호스트를 거기서 끊는다)
 */
const ENDPOINT_SAFE = /^[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+$/
/** 호스트 — 소문자·숫자·하이픈 낱말을 점으로 이은 것(둘 이상). IP v6·끝 점·빈 낱말·%·대문자는 안 된다 */
const PUSH_HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/

/**
 * https · 기본 포트 · 사용자 칸 없음 · 호스트가 PUSH_HOSTS 의 하나이거나 그 아래.
 * 🔴 web-push 는 옛 url.parse 의 호스트로 접속한다(web-push-lib.js sendNotification) — WHATWG URL 로만 보면
 * 'https://127.0.0.1;.fcm.googleapis.com/x' 같은 주소가 통과하고 127.0.0.1 로 간다. 그래서 두 해석이 같은 호스트이고,
 * 쓴 글자 그대로 'https://<그 호스트>/' 로 시작할 때만 참(%-escape·대문자·역슬래시·사용자 칸·포트가 호스트 자리에 끼지 않게)
 */
export function isPushEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== 'string' || !ENDPOINT_SAFE.test(endpoint)) return false
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false
  const host = u.hostname
  if (!PUSH_HOST_RE.test(host) || !endpoint.startsWith(`https://${host}/`)) return false
  let legacy: ReturnType<typeof legacyUrlParse>
  try {
    legacy = legacyUrlParse(endpoint)
  } catch {
    return false
  }
  if (legacy.protocol !== 'https:' || legacy.hostname !== host || legacy.port !== null || legacy.auth !== null) return false
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/** 실패 까닭에서 쓸 수 있는 칸 — 알림 서버의 답 번호, Node 오류 이름(대문자 낱말)만. 오류 글은 주소를 담을 수 있어 쓰지 않는다 */
function safeFields(e: unknown): { statusCode?: number; code?: string } {
  const o = (e ?? {}) as { statusCode?: unknown; code?: unknown }
  const out: { statusCode?: number; code?: string } = {}
  if (typeof o.statusCode === 'number' && Number.isInteger(o.statusCode)) out.statusCode = o.statusCode
  if (typeof o.code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(o.code)) out.code = o.code
  return out
}

function reasonOf(e: unknown): string {
  const f = safeFields(e)
  return f.statusCode !== undefined ? String(f.statusCode) : (f.code ?? '까닭 모름')
}

/** 알림 서버가 이 시간 안에 답하지 않으면(소켓이 조용하면) 끊는다 */
const SEND_TIMEOUT_MS = 15_000

/** web-push 에 주는 칸 — 페이로드 암호화는 표준(RFC 8291) aes128gcm. 프록시·따로 붙일 헤더는 없다 */
export function webPushOptions(vapid: VapidKeys, o: PushDelivery): RequestOptions {
  return {
    vapidDetails: { subject: VAPID_SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: o.ttl,
    urgency: o.urgency,
    contentEncoding: 'aes128gcm',
    timeout: SEND_TIMEOUT_MS,
  }
}

/** 진짜 보내기 — web-push. 오류는 답 번호·오류 이름만 담아 다시 던진다(원래 오류엔 구독 주소가 들어 있다) */
export const webPushSend: PushSend = async (sub, payload, vapid, o) => {
  try {
    await webpush.sendNotification(sub, payload, webPushOptions(vapid, o))
    return { gone: false }
  } catch (e) {
    const f = safeFields(e)
    if (f.statusCode === 404 || f.statusCode === 410) return { gone: true }
    throw Object.assign(new Error(`알림 서버에 보내지 못했어요(${reasonOf(e)})`), f)
  }
}

/** 기기에서 구독을 뺀 줄 — push 는 store 가 구독에서 다시 끌어낸다 */
function withoutSubscription(d: StoredPhoneDevice): StoredPhoneDevice {
  const { subscription: _gone, ...rest } = d
  return { ...rest, push: false }
}

/** o.send — 시험은 가짜(네트워크 없음) · o.now — 벽시계(30일 안 쓴 기기 가리기) · o.log — 실패 로그(기본 console.error, 주소·열쇠는 싣지 않는다) */
export function createPush(
  store: PhoneStore,
  o: { send?: PushSend; now?: () => number; log?: (...args: unknown[]) => void } = {},
): Push {
  const send = o.send ?? webPushSend
  const log = o.log ?? console.error
  const now = o.now ?? Date.now

  /** 저장된 열쇠쌍 — 없을 때만 만들어 저장한다 */
  const keys = (): VapidKeys => {
    const saved = store.read().vapid
    if (saved) return saved
    const made = webpush.generateVAPIDKeys()
    const vapid: VapidKeys = { publicKey: made.publicKey, privateKey: made.privateKey }
    store.write({ vapid })
    return vapid
  }

  /** 410·404 — 그 기기의 구독이 아직 그 주소일 때만 지운다(보내는 사이 새로 구독했으면 새것은 남긴다) */
  const forget = (deviceId: string, endpoint: string) => {
    const f = store.read()
    if (!f.devices.some((d) => d.id === deviceId && d.subscription?.endpoint === endpoint)) return
    store.write({ devices: f.devices.map((d) => (d.id === deviceId ? withoutSubscription(d) : d)) })
  }

  return {
    publicKey: () => keys().publicKey,

    subscribe(deviceId, raw) {
      const sub = pickSubscription(raw)
      if (!sub) throw new Error('알림 구독 꼴이 틀렸어요')
      if (!isPushEndpoint(sub.endpoint)) throw new Error('알려진 알림 서버가 아니에요')
      const f = store.read()
      if (!f.devices.some((d) => d.id === deviceId)) return // 그 사이 끊긴 기기
      store.write({
        devices: f.devices.map((d) =>
          d.id === deviceId ? { ...d, subscription: sub, push: true }
          : d.subscription?.endpoint === sub.endpoint ? withoutSubscription(d)
          : d,
        ),
      })
    },

    async sendTo(deviceId, n, delivery = ASK_DELIVERY) {
      try {
        const dev = store.read().devices.find((d) => d.id === deviceId)
        // 30일 넘게 안 쓴 기기는 짝이 풀린 것 — 정리(expireIdle) 전이어도 보내지 않는다
        if (!dev || isIdleDevice(dev, now())) return
        const sub = dev.subscription
        if (!sub) return
        if (!isPushEndpoint(sub.endpoint)) {
          log('[두레] 휴대폰 알림 주소가 알려진 알림 서버가 아니라 보내지 않았어요')
          return
        }
        // 네 칸만 — 부르는 쪽이 칸을 더 얹어도 나가지 않는다
        const payload = JSON.stringify({ title: n.title, body: n.body, tag: n.tag, url: n.url })
        const r = await send(sub, payload, keys(), { urgency: delivery.urgency, ttl: delivery.ttl })
        if (r.gone) forget(deviceId, sub.endpoint)
      } catch (e) {
        log(`[두레] 휴대폰 알림을 보내지 못했어요(${reasonOf(e)})`)
      }
    },
  }
}
