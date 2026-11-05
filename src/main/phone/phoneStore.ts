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

/** 파일에 든 기기 — 화면용 PhoneDevice 에 토큰 해시(sha256 hex)·알림 구독을 더한 것 */
export type StoredPhoneDevice = PhoneDevice & { tokenHash: string; subscription?: PhonePushSubscription }

export type VapidKeys = { publicKey: string; privateKey: string }

export type PhoneFile = { settings: PhoneSettings; devices: StoredPhoneDevice[]; vapid?: VapidKeys }

/** 설정은 칸별로 합친다(notify 도 칸별로) — 꼴이 틀린 칸은 무시하고 지금 값 그대로 */
export type PhoneSettingsPatch = Partial<Omit<PhoneSettings, 'notify'>> & { notify?: Partial<PhoneSettings['notify']> }

/** devices·vapid 는 주면 통째로 바뀐다 */
export type PhoneFilePatch = { settings?: PhoneSettingsPatch; devices?: StoredPhoneDevice[]; vapid?: VapidKeys }

export interface PhoneStore {
  /** 파일을 읽어 꼴을 맞춘 값 — 없으면 기본값, 깨졌으면(JSON 아님·객체 아님) 원본을 phone.json.bad 로 옮기고 기본값. 잠김 같은 읽기 오류는 던진다 */
  read(): PhoneFile
  /** 읽고-합치고-쓰기(.tmp 에 쓰고 renameRetrying) — 쓰다가 꺼져도 반쪽 파일이 남지 않는다 */
  write(patch: PhoneFilePatch): void
}

const FILE = 'phone.json'
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/
const ID_MAX = 64
const ENDPOINT_MAX = 2048
const KEY_MAX = 512

/** 기기 이름의 글 방향 바꾸기 문자 — 이름을 뒤집어 다른 기기처럼 보이게 할 수 있어 지운다 */
const NAME_BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
/** 기기 이름의 제어 문자·줄 나눔(U+2028·2029) — 빈칸으로 */
const NAME_CONTROL = /[\p{Cc}\u2028\u2029]/gu

/** 기기 이름 — 제어 문자는 빈칸으로(방향 바꾸기는 지움), 빈칸 줄이기·앞뒤 자르기, PHONE_NAME_MAX 글자(코드 포인트)까지, 비면 '휴대폰' */
export function cleanDeviceName(name: string): string {
  if (typeof name !== 'string') return PHONE_NAME_DEFAULT
  const flat = name.replace(NAME_BIDI, '').replace(NAME_CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const cut = Array.from(flat).slice(0, PHONE_NAME_MAX).join('').trim()
  return cut || PHONE_NAME_DEFAULT
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const bool = (v: unknown, base: boolean) => (typeof v === 'boolean' ? v : base)
const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535
const shortText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

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

/** 웹 푸시 구독 꼴 확인 — https endpoint · p256dh · auth 가 있을 때만, 아니면 null(휴대폰이 올린 것·파일의 것 모두) */
export function pickSubscription(v: unknown): PhonePushSubscription | null {
  if (!isObject(v) || !isObject(v.keys)) return null
  const { endpoint, expirationTime } = v
  const { p256dh, auth } = v.keys
  if (!shortText(endpoint, ENDPOINT_MAX) || !endpoint.startsWith('https://')) return null
  if (!shortText(p256dh, KEY_MAX) || !shortText(auth, KEY_MAX)) return null
  const out: PhonePushSubscription = { endpoint, keys: { p256dh, auth } }
  if (expirationTime === null || (typeof expirationTime === 'number' && Number.isFinite(expirationTime))) {
    out.expirationTime = expirationTime
  }
  return out
}

/** 기기 줄들 — id·토큰 해시가 맞지 않는 줄은 버리고(겹친 id 는 앞 것만), 그 밖의 칸은 틀리면 기본값 */
function devicesFrom(v: unknown): StoredPhoneDevice[] {
  if (!Array.isArray(v)) return []
  const out: StoredPhoneDevice[] = []
  for (const x of v) {
    if (!isObject(x)) continue
    const { id, tokenHash, name, createdAt, lastSeen, push } = x
    if (!shortText(id, ID_MAX) || typeof tokenHash !== 'string' || !TOKEN_HASH_RE.test(tokenHash)) continue
    if (out.some((d) => d.id === id)) continue
    const d: StoredPhoneDevice = {
      id,
      name: cleanDeviceName(typeof name === 'string' ? name : ''),
      createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
      lastSeen: typeof lastSeen === 'number' && Number.isFinite(lastSeen) ? lastSeen : null,
      push: push === true,
      tokenHash,
    }
    const sub = pickSubscription(x.subscription)
    if (sub) d.subscription = sub
    out.push(d)
  }
  return out
}

function vapidFrom(v: unknown): VapidKeys | undefined {
  if (!isObject(v)) return undefined
  const { publicKey, privateKey } = v
  return shortText(publicKey, KEY_MAX) && shortText(privateKey, KEY_MAX) ? { publicKey, privateKey } : undefined
}

function fileFrom(raw: Record<string, unknown>): PhoneFile {
  const out: PhoneFile = { settings: settingsFrom(raw.settings, DEFAULT_PHONE_SETTINGS), devices: devicesFrom(raw.devices) }
  const vapid = vapidFrom(raw.vapid)
  if (vapid) out.vapid = vapid
  return out
}

/** 화면·휴대폰으로 보내도 되는 칸만 — 토큰 해시·구독은 빠진다 */
export function publicDevice(d: StoredPhoneDevice): PhoneDevice {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, push: d.push }
}

export function openPhoneStore(dir: string): PhoneStore {
  const file = path.join(dir, FILE)

  const read = (): PhoneFile => {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return fileFrom({})
      throw e // 잠김·권한 — 기본값으로 덮어 쓰면 짝 맺은 기기를 잃는다
    }
    let raw: unknown
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      raw = undefined
    }
    if (isObject(raw)) return fileFrom(raw)
    try {
      renameRetrying(file, `${file}.bad`)
    } catch {
      // 옮기지 못해도 기본값으로 — 다음 쓰기가 새 파일로 덮는다
    }
    return fileFrom({})
  }

  const write = (patch: PhoneFilePatch): void => {
    const cur = read()
    const next: PhoneFile = {
      settings: settingsFrom(patch.settings, cur.settings),
      devices: patch.devices !== undefined ? devicesFrom(patch.devices) : cur.devices,
    }
    const vapid = patch.vapid !== undefined ? vapidFrom(patch.vapid) : cur.vapid
    if (vapid) next.vapid = vapid
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    renameRetrying(tmp, file)
  }

  return { read, write }
}
