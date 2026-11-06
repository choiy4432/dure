import fs from 'node:fs'
import path from 'node:path'
import { renameRetrying } from '../../engine/store'
import {
  DEFAULT_PHONE_SETTINGS, PHONE_NAME_DEFAULT, PHONE_NAME_MAX, type PhoneDevice, type PhoneSettings,
} from '../../shared/phoneTypes'

// <userData>/phone.json — 휴대폰 설정 · 짝 맺은 기기(토큰은 sha256 해시만) · 알림 구독 · VAPID 열쇠쌍.
// 🔴 이 파일의 칸(해시·구독·VAPID 비밀 열쇠)은 로그·오류 글·화면으로 내보내지 않는다. 화면에는 publicDevice 만

/** 웹 푸시 구독 — 꼴을 확인한 것만(pickSubscription). 브라우저 PushSubscription.toJSON() 의 꼴 */
export type PhonePushSubscription = {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

/** 파일에 든 기기 — 화면용 PhoneDevice 에 토큰 해시(sha256 hex)·알림 구독을 더한 것. push 는 구독이 있는지로 정해진다(파일엔 안 씀) */
export type StoredPhoneDevice = PhoneDevice & { tokenHash: string; subscription?: PhonePushSubscription }

export type VapidKeys = { publicKey: string; privateKey: string }

/**
 * 두레가 연 `tailscale serve` 길 — 켜기 전에 적어 두고(serveOn 앞), 끈 뒤에 지운다. 비정상 종료로 남은 길은 다음 시작 때 이 짝만 정리한다
 * (포트를 짐작해 지우지 않는다 — 사용자 길을 건드리지 않게). dnsName 이 없으면 https 켜기 링크를 받으려고 이름을 모른 채 열어 본 것
 */
export type PhoneServeRecord = { httpsPort: number; localPort: number; dnsName?: string }

/**
 * serve — 지금 열려 있을 수 있는 두레 길(PhoneServeRecord) ·
 * httpsPort — 휴대폰이 아는 https 포트(마지막으로 길을 연 포트). 끈 뒤에도 남겨 다음 켜기에서 먼저 쓴다 — 주소가 바뀌면 홈 화면 앱·알림 구독이 끊긴다 ·
 * funnelPort — Funnel(인터넷 공개) 때문에 비켜 간 https 포트. 비고 공개가 아니면 다음 켜기·확인 때 그리로 돌아간다(그 포트로 열거나, 남이 써서 비켜 갔으면 지움)
 */
export type PhoneFile = {
  settings: PhoneSettings
  devices: StoredPhoneDevice[]
  vapid?: VapidKeys
  serve?: PhoneServeRecord
  httpsPort?: number
  funnelPort?: number
}

/** 설정은 칸별로 합친다(notify 도 칸별로) — 꼴이 틀린 칸은 무시하고 지금 값 그대로 */
export type PhoneSettingsPatch = Partial<Omit<PhoneSettings, 'notify'>> & { notify?: Partial<PhoneSettings['notify']> }

/** devices·vapid·serve 는 주면 통째로 바뀐다(serve·funnelPort: null 은 지움) — 꼴이 틀리면 write 가 던진다 */
export type PhoneFilePatch = {
  settings?: PhoneSettingsPatch
  devices?: StoredPhoneDevice[]
  vapid?: VapidKeys
  serve?: PhoneServeRecord | null
  httpsPort?: number
  funnelPort?: number | null
}

export interface PhoneStore {
  /**
   * 지금 값(복사본). 처음 한 번만 파일을 읽고 그 뒤로는 이 프로세스의 캐시 — phone.json 을 쓰는 건 이 프로세스뿐이다.
   * 없으면 기본값. 깨졌으면(JSON 아님·객체 아님) 원본을 phone.json.broken-<시각> 으로 옮기고 기본값 — 옮기지 못하면 던진다.
   * 잠김·폴더 같은 읽기 오류도 던진다(기본값으로 덮어 써서 짝 맺은 기기를 잃지 않게). 던진 판은 캐시하지 않는다
   */
  read(): PhoneFile
  /** 합치고 쓰기(.tmp 에 쓰고 renameRetrying) — 쓰다가 꺼져도 반쪽 파일이 남지 않는다. 준 기기 줄·VAPID 가 꼴이 틀리면 던지고 아무것도 쓰지 않는다 */
  write(patch: PhoneFilePatch): void
}

const FILE = 'phone.json'
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/
const ID_MAX = 64
const ENDPOINT_MAX = 2048
const KEY_MAX = 512
/** Tailscale 이 준 이 기기의 DNS 이름 꼴(stateFromStatus 가 끝 '.' 을 떼고 소문자로 준다) */
const DNS_NAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
/** 브라우저가 준 endpoint 는 직렬화된 주소라 ASCII 의 보이는 글자뿐 — 빈칸·제어 문자·그 밖의 글자가 있으면 거른다 */
const ENDPOINT_CHARS = /^[\x21-\x7E]+$/
/** p256dh = P-256 공개 열쇠 65바이트(87자) · auth = 16바이트(22자) — base64url, 끝의 덧붙임(=)은 있어도 됨 */
const P256DH_RE = /^[A-Za-z0-9_-]{87}=?$/
const AUTH_RE = /^[A-Za-z0-9_-]{22}(?:==)?$/

/** 짝 없는 서로게이트 — u 깃발이면 짝 지은 것은 한 글자로 읽혀 홀로 남은 것만 걸린다 */
const NAME_LONE_SURROGATE = /\p{Cs}/gu
/**
 * 보이지 않는 서식 문자(\p{Cf} — 너비 없는 빈칸·단어 잇기·소프트 하이픈·BOM·글 방향 바꾸기 …)와 태그 문자(U+E0000–E007F) — 지운다.
 * 이름을 뒤집거나 다른 기기와 같아 보이게 할 수 있어서. ZWJ(U+200D)·변형 선택자(U+FE0E·FE0F)는 이어 붙인 이모지에 쓰여 남긴다
 */
const NAME_INVISIBLE = /(?![\u200D\uFE0E\uFE0F])[\p{Cf}\u{E0000}-\u{E007F}]/gu
/** 제어 문자·줄 나눔(U+2028·2029) — 빈칸으로 */
const NAME_CONTROL = /[\p{Cc}\u2028\u2029]/gu
/** 앞뒤의 빈칸·홀로 남은 ZWJ */
const NAME_EDGES = /^[\s\u200D]+|[\s\u200D]+$/g
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * 기기 이름 — 짝 없는 서로게이트·안 보이는 서식 문자·태그 문자는 지우고(ZWJ·변형 선택자는 남김) 제어 문자는 빈칸으로,
 * 빈칸 줄이기·앞뒤 자르기, PHONE_NAME_MAX 글자(그래핌 — 이어 붙인 이모지·결합 문자도 한 글자)까지, 비면 '휴대폰'
 */
export function cleanDeviceName(name: string): string {
  if (typeof name !== 'string') return PHONE_NAME_DEFAULT
  const flat = name
    .replace(NAME_LONE_SURROGATE, '')
    .replace(NAME_INVISIBLE, '')
    .replace(NAME_CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .replace(NAME_EDGES, '')
  const kept: string[] = []
  for (const { segment } of graphemes.segment(flat)) {
    if (kept.length >= PHONE_NAME_MAX) break
    kept.push(segment)
  }
  return kept.join('').replace(NAME_EDGES, '') || PHONE_NAME_DEFAULT
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const bool = (v: unknown, base: boolean) => (typeof v === 'boolean' ? v : base)
const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535
const shortText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** v 에서 꼴이 맞는 칸만 base 위에 — 그 밖은 base 그대로 */
function settingsFrom(v: unknown, base: PhoneSettings): PhoneSettings {
  const s = isObject(v) ? v : {}
  const n = isObject(s.notify) ? s.notify : {}
  return {
    enabled: bool(s.enabled, base.enabled),
    keepAwake: bool(s.keepAwake, base.keepAwake),
    openAtLogin: bool(s.openAtLogin, base.openAtLogin),
    notify: { asks: bool(n.asks, base.notify.asks), finished: bool(n.finished, base.notify.finished) },
    port: isPort(s.port) ? s.port : base.port,
  }
}

/** https 이고 호스트가 있는 주소 — ENDPOINT_MAX 자까지 */
function isHttpsEndpoint(v: unknown): v is string {
  if (!shortText(v, ENDPOINT_MAX) || !ENDPOINT_CHARS.test(v) || !v.startsWith('https://')) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && u.hostname.length > 0
  } catch {
    return false
  }
}

/** 웹 푸시 구독 꼴 확인 — https 주소 · base64url p256dh(65바이트)·auth(16바이트)일 때만, 아니면 null(휴대폰이 올린 것·파일의 것 모두) */
export function pickSubscription(v: unknown): PhonePushSubscription | null {
  if (!isObject(v) || !isObject(v.keys)) return null
  const { endpoint, expirationTime } = v
  const { p256dh, auth } = v.keys
  if (!isHttpsEndpoint(endpoint)) return null
  if (typeof p256dh !== 'string' || !P256DH_RE.test(p256dh) || typeof auth !== 'string' || !AUTH_RE.test(auth)) return null
  const out: PhonePushSubscription = { endpoint, keys: { p256dh, auth } }
  if (expirationTime === null || finite(expirationTime)) out.expirationTime = expirationTime
  return out
}

/**
 * 기기 줄 하나 — id·토큰 해시가 틀리면 버릴 줄(bad = 칸 이름). 아니면 꼴을 맞춘 기기와, 틀려서 기본값으로 채운 칸 이름들(loose).
 * push 는 구독이 있는지로(저장된 값은 안 본다). 🔴 bad·loose 는 칸 이름만 — 값은 오류 글에 싣지 않는다
 */
function deviceRow(x: unknown): { bad: string } | { device: StoredPhoneDevice; loose: string[] } {
  if (!isObject(x)) return { bad: '꼴' }
  const { id, tokenHash, name, createdAt, lastSeen, subscription } = x
  if (!shortText(id, ID_MAX)) return { bad: 'id' }
  if (typeof tokenHash !== 'string' || !TOKEN_HASH_RE.test(tokenHash)) return { bad: 'tokenHash' }
  const sub = subscription === undefined ? null : pickSubscription(subscription)
  const loose = [
    typeof name !== 'string' && 'name',
    !finite(createdAt) && 'createdAt',
    lastSeen !== null && !finite(lastSeen) && 'lastSeen',
    subscription !== undefined && !sub && 'subscription',
  ].filter((k): k is string => !!k)
  const device: StoredPhoneDevice = {
    id,
    name: cleanDeviceName(typeof name === 'string' ? name : ''),
    createdAt: finite(createdAt) ? createdAt : 0,
    lastSeen: finite(lastSeen) ? lastSeen : null,
    push: !!sub,
    tokenHash,
  }
  if (sub) device.subscription = sub
  return { device, loose }
}

/** 파일의 기기 줄들 — 버릴 줄·겹친 id(앞 것만)는 빼고, 그 밖의 틀린 칸은 기본값 */
function devicesFrom(v: unknown): StoredPhoneDevice[] {
  if (!Array.isArray(v)) return []
  const out: StoredPhoneDevice[] = []
  for (const x of v) {
    const r = deviceRow(x)
    if ('bad' in r || out.some((d) => d.id === r.device.id)) continue
    out.push(r.device)
  }
  return out
}

/** 쓸 기기 줄들 — 하나라도 꼴이 틀리거나 id 가 겹치면 던진다(몇 번째·어느 칸만, 값은 안 실음) */
function devicesToWrite(v: unknown): StoredPhoneDevice[] {
  if (!Array.isArray(v)) throw new Error('기기 목록 꼴이 틀렸어요')
  const out: StoredPhoneDevice[] = []
  for (const [i, x] of v.entries()) {
    const r = deviceRow(x)
    const wrong = (what: string) => new Error(`기기 줄 꼴이 틀렸어요(${i + 1}번째 · ${what})`)
    if ('bad' in r) throw wrong(r.bad)
    if (r.loose.length > 0) throw wrong(r.loose.join('·'))
    if (out.some((d) => d.id === r.device.id)) throw wrong('id 겹침')
    out.push(r.device)
  }
  return out
}

function vapidFrom(v: unknown): VapidKeys | undefined {
  if (!isObject(v)) return undefined
  const { publicKey, privateKey } = v
  return shortText(publicKey, KEY_MAX) && shortText(privateKey, KEY_MAX) ? { publicKey, privateKey } : undefined
}

function serveFrom(v: unknown): PhoneServeRecord | undefined {
  if (!isObject(v)) return undefined
  const { httpsPort, localPort, dnsName } = v
  if (!isPort(httpsPort) || !isPort(localPort)) return undefined
  if (dnsName === undefined) return { httpsPort, localPort }
  return typeof dnsName === 'string' && DNS_NAME_RE.test(dnsName) ? { httpsPort, localPort, dnsName } : undefined
}

function fileFrom(raw: Record<string, unknown>): PhoneFile {
  const out: PhoneFile = { settings: settingsFrom(raw.settings, DEFAULT_PHONE_SETTINGS), devices: devicesFrom(raw.devices) }
  const vapid = vapidFrom(raw.vapid)
  if (vapid) out.vapid = vapid
  const serve = serveFrom(raw.serve)
  if (serve) out.serve = serve
  if (isPort(raw.httpsPort)) out.httpsPort = raw.httpsPort
  if (isPort(raw.funnelPort)) out.funnelPort = raw.funnelPort
  return out
}

/** 파일에 쓰는 글 — push 는 구독에서 끌어내므로 빼고 쓴다 */
function fileText(f: PhoneFile): string {
  return JSON.stringify({ ...f, devices: f.devices.map(({ push: _derived, ...d }) => d) }, null, 2)
}

/** 화면·휴대폰으로 보내도 되는 칸만 — 토큰 해시·구독은 빠지고, push 는 구독이 있는지로 */
export function publicDevice(d: StoredPhoneDevice): PhoneDevice {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, push: !!d.subscription }
}

/** o.now — 깨진 파일 사본 이름의 시각(시험용, 기본 Date.now) */
export function openPhoneStore(dir: string, o: { now?: () => number } = {}): PhoneStore {
  const file = path.join(dir, FILE)
  const now = o.now ?? Date.now
  let cache: PhoneFile | null = null

  /** 깨진 파일을 옮겨 둘 이름 — 같은 이름이 있으면 수를 하나씩 올린다(앞의 깨진 사본을 덮지 않게) */
  const brokenName = (): string => {
    for (let n = now(); ; n++) {
      const p = `${file}.broken-${n}`
      if (!fs.existsSync(p)) return p
    }
  }

  const load = (): PhoneFile => {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return fileFrom({})
      throw e // 잠김·권한·폴더 — 기본값으로 덮어 쓰면 짝 맺은 기기를 잃는다
    }
    let raw: unknown
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      raw = undefined
    }
    if (isObject(raw)) return fileFrom(raw)
    // 깨짐 — 옮겨 두고 기본값. 옮기지 못하면 던진다(기본값으로 시작하면 다음 쓰기가 원본을 덮는다)
    renameRetrying(file, brokenName())
    return fileFrom({})
  }

  const current = (): PhoneFile => (cache ??= load())

  return {
    read: () => structuredClone(current()),

    write(patch) {
      const cur = current()
      const next: PhoneFile = {
        settings: settingsFrom(patch.settings, cur.settings),
        devices: patch.devices !== undefined ? devicesToWrite(patch.devices) : cur.devices,
      }
      const vapid = patch.vapid !== undefined ? vapidFrom(patch.vapid) : cur.vapid
      if (patch.vapid !== undefined && !vapid) throw new Error('VAPID 열쇠 꼴이 틀렸어요')
      if (vapid) next.vapid = vapid
      const serve = patch.serve === null ? undefined : patch.serve !== undefined ? serveFrom(patch.serve) : cur.serve
      if (patch.serve != null && !serve) throw new Error('serve 길 기록 꼴이 틀렸어요')
      if (serve) next.serve = serve
      if (patch.httpsPort !== undefined && !isPort(patch.httpsPort)) throw new Error('https 포트 꼴이 틀렸어요')
      const httpsPort = patch.httpsPort ?? cur.httpsPort
      if (httpsPort !== undefined) next.httpsPort = httpsPort
      if (patch.funnelPort != null && !isPort(patch.funnelPort)) throw new Error('https 포트 꼴이 틀렸어요')
      const funnelPort = patch.funnelPort === null ? undefined : (patch.funnelPort ?? cur.funnelPort)
      if (funnelPort !== undefined) next.funnelPort = funnelPort
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, fileText(next))
      renameRetrying(tmp, file)
      cache = next // 디스크에 바뀐 뒤에만
    },
  }
}
