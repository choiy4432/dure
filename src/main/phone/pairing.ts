import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { PAIR_TTL_MS, type PhoneDevice } from '../../shared/phoneTypes'
import { cleanDeviceName, publicDevice, type PhoneStore, type StoredPhoneDevice } from './phoneStore'

// 짝 맺기 — PC 가 짝 코드(QR, 32바이트 hex)와 6자리 숫자를 하나씩 내고, 휴대폰이 그중 하나를 내면 기기 토큰(32바이트 base64url)을 준다.
// 짝 코드·숫자는 메모리에만(해시로), 토큰은 phone.json 에 sha256 해시로만. 🔴 코드·숫자·토큰은 로그·오류 글에 싣지 않는다

export { cleanDeviceName }

/** 같은 곳(from)에서 PAIR_FAIL_WINDOW_MS 안에 6자리 숫자를 이만큼 틀리면 PAIR_LOCK_MS 동안 그 곳의 숫자를 막는다(맞는 숫자도) */
export const PAIR_FAIL_MAX = 5
export const PAIR_FAIL_WINDOW_MS = 60_000
export const PAIR_LOCK_MS = 60_000
/**
 * 짝 하나(start 한 번)에 6자리 숫자를 이만큼 틀리면 from 이 무엇이든 그 짝을 닫는다 — 코드·숫자 둘 다 expired, PC 에서 다시 start.
 * from 을 바꿔 가며 내도 맞힐 확률은 짝 하나당 10/1,000,000 을 넘지 않는다
 */
export const PAIR_TOTAL_FAIL_MAX = 10
/** touch 는 기기마다 이만큼에 한 번만 phone.json 에 쓴다 */
export const TOUCH_MIN_MS = 60_000

export type PairStart = { code: string; pin: string; expiresAt: number }
export type RedeemResult = { token: string; device: PhoneDevice } | { error: 'expired' | 'wrong' | 'locked' }

export interface Pairing {
  /** 새 짝 코드·숫자 — 앞의 것은 무효, 틀림 셈·막힘도 지운다. expiresAt 은 벽시계(화면용) */
  start(): PairStart
  /** 지금 짝 코드·숫자를 무효로 */
  cancel(): void
  /** 지금 짝 코드·숫자가 살아 있나 — 썼음·취소·5분 지남·틀림 상한(PAIR_TOTAL_FAIL_MAX)이면 false(PC 화면이 숫자를 거두게) */
  open(): boolean
  /**
   * secret = 짝 코드나 6자리 숫자(빈칸은 무시). 맞으면 기기를 저장하고 토큰을 준다 — 코드·숫자 둘 다 그걸로 끝.
   * 셈·막힘은 6자리 숫자 꼴만 — QR 코드(256비트)는 맞혀 볼 수 없어 세지도 막지도 않는다.
   * 'locked' = 그 from 이 막힌 동안 낸 숫자 · 'expired' = 짝 코드가 없음(안 냄·썼음·취소·5분 지남·틀림 상한) · 'wrong' = 틀림.
   * from = 소켓의 원격 주소(tailscale serve 뒤라 사실상 하나) — 짝 하나당 상한(PAIR_TOTAL_FAIL_MAX)은 from 과 상관없다
   */
  redeem(secret: string, deviceName: string, from: string): RedeemResult
  /** 토큰이 짝 맺은 기기의 것이면 그 기기(화면용 칸만), 아니면 null — store 의 캐시를 보므로 디스크를 읽지 않는다 */
  verify(token: string): PhoneDevice | null
  /** 기기 지우기 — 그 토큰은 바로 verify 안 됨(열린 연결 닫기는 서버의 kick) */
  unpair(id: string): void
  /** 마지막 접속을 지금으로 — 그 기기를 TOUCH_MIN_MS 안에 이미 썼으면(짝 맺기 포함) 쓰지 않는다 */
  touch(id: string): void
}

const sha256 = (s: string): Buffer => crypto.createHash('sha256').update(s, 'utf8').digest()

/** 6자리 숫자 — 4바이트 수가 1,000,000 의 배수 범위 안일 때만 써서 치우침이 없다 */
const PIN_SPACE = 1_000_000
const PIN_LIMIT = Math.floor(0x1_0000_0000 / PIN_SPACE) * PIN_SPACE
const PIN_TRIES = 64
const PIN_RE = /^\d{6}$/
/** 이보다 긴 글은 토큰이 아니다(진짜는 43자) */
const TOKEN_TEXT_MAX = 256
/**
 * 틀림 표의 곳(from) 수 상한 — 짝 하나당 숫자 틀림이 PAIR_TOTAL_FAIL_MAX 번이면 닫고 start 가 표를 비우므로 지금 규칙으론 그 수를 넘지 않는다.
 * 규칙이 바뀌어도 표가 끝없이 자라지 않게 둔다(넘으면 가장 오래 손대지 않은 곳부터 뺀다)
 */
const FAIL_KEYS_MAX = 256

function drawPin(randomBytes: (n: number) => Buffer): string {
  for (let i = 0; i < PIN_TRIES; i++) {
    const n = randomBytes(4).readUInt32BE(0)
    if (n < PIN_LIMIT) return String(n % PIN_SPACE).padStart(6, '0')
  }
  throw new Error('짝 숫자를 만들지 못했어요')
}

/** deadline 은 단조 시계 · pinFails = 이 짝에서 틀린 숫자 수(from 과 상관없이) */
type Pending = { codeHash: Buffer; pinHash: Buffer; deadline: number; pinFails: number }
/** at·lockedUntil 은 단조 시계 */
type Fails = { at: number[]; lockedUntil: number }

/**
 * o.now — 벽시계(expiresAt·createdAt·lastSeen), 기본 Date.now.
 * o.clock — 단조 시계(만료·막힘·touch 간격 — 벽시계를 바꿔도 안 흔들림), 기본 performance.now. 안 주고 now 만 주면 now 를 쓴다(시험이 시계 하나로 돌리게)
 */
export function createPairing(
  store: PhoneStore,
  o: { now?: () => number; clock?: () => number; randomBytes?: (n: number) => Buffer } = {},
): Pairing {
  const now = o.now ?? Date.now
  const clock = o.clock ?? o.now ?? (() => performance.now())
  const randomBytes = o.randomBytes ?? crypto.randomBytes
  let pending: Pending | null = null
  const fails = new Map<string, Fails>()
  /** 기기마다 마지막으로 lastSeen 을 쓴 때(단조 시계) */
  const touchedAt = new Map<string, number>()

  const fail = (key: string, t: number) => {
    const f = fails.get(key) ?? { at: [], lockedUntil: 0 }
    f.at = f.at.filter((x) => t - x < PAIR_FAIL_WINDOW_MS)
    f.at.push(t)
    if (f.at.length >= PAIR_FAIL_MAX) {
      f.lockedUntil = t + PAIR_LOCK_MS
      f.at = []
    }
    fails.delete(key) // 맨 뒤로 — 넘치면 오래 손대지 않은 곳부터 빠지게
    const oldest = fails.keys().next()
    if (!oldest.done && fails.size >= FAIL_KEYS_MAX) fails.delete(oldest.value)
    fails.set(key, f)
  }
  /** 기기 줄 하나를 바꾸거나 빼서 쓴다 — 없는 id 면 쓰지 않는다. 썼으면 true */
  const editDevices = (id: string, edit: (all: StoredPhoneDevice[]) => StoredPhoneDevice[]): boolean => {
    const cur = store.read().devices
    if (!cur.some((d) => d.id === id)) return false
    store.write({ devices: edit(cur) })
    return true
  }

  return {
    start() {
      const code = randomBytes(32).toString('hex')
      const pin = drawPin(randomBytes)
      pending = { codeHash: sha256(code), pinHash: sha256(pin), deadline: clock() + PAIR_TTL_MS, pinFails: 0 }
      fails.clear()
      return { code, pin, expiresAt: now() + PAIR_TTL_MS }
    },

    cancel() {
      pending = null
    },

    open() {
      return pending !== null && clock() < pending.deadline
    },

    redeem(secret, deviceName, from) {
      const t = clock()
      const key = typeof from === 'string' ? from : ''
      const s = typeof secret === 'string' ? secret.replace(/\s/g, '') : ''
      // 6자리 숫자만 세고 막는다 — QR 코드는 맞혀 볼 수 없고, 그 밖의 꼴은 어느 쪽과도 맞을 수 없다
      const isPin = PIN_RE.test(s)
      if (isPin && (fails.get(key)?.lockedUntil ?? 0) > t) return { error: 'locked' }
      if (!pending || t >= pending.deadline) {
        pending = null
        return { error: 'expired' }
      }
      const h = sha256(s)
      // 둘 다 비교한다(어느 쪽이 맞았는지로 시간이 갈리지 않게) — 해시끼리라 길이도 같다
      const hitCode = crypto.timingSafeEqual(h, pending.codeHash)
      const hitPin = crypto.timingSafeEqual(h, pending.pinHash)
      if (!hitCode && !hitPin) {
        if (isPin) {
          fail(key, t)
          if (++pending.pinFails >= PAIR_TOTAL_FAIL_MAX) pending = null // 짝을 닫는다 — 다시 start 해야 함
        }
        return { error: 'wrong' }
      }
      const at = now()
      const token = randomBytes(32).toString('base64url')
      const device: PhoneDevice = {
        id: randomBytes(16).toString('hex'), name: cleanDeviceName(deviceName), createdAt: at, lastSeen: at, push: false,
      }
      // 먼저 저장 — 쓰기가 실패하면(던짐) 짝 코드는 살아 있어 다시 낼 수 있다
      store.write({ devices: [...store.read().devices, { ...device, tokenHash: sha256(token).toString('hex') }] })
      pending = null
      touchedAt.set(device.id, t) // lastSeen 을 방금 썼다
      return { token, device }
    },

    verify(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_TEXT_MAX) return null
      const h = sha256(token)
      let found: StoredPhoneDevice | null = null
      for (const d of store.read().devices) {
        if (crypto.timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), h) && !found) found = d
      }
      return found ? publicDevice(found) : null
    },

    unpair(id) {
      editDevices(id, (all) => all.filter((d) => d.id !== id))
      touchedAt.delete(id)
    },

    touch(id) {
      const t = clock()
      const last = touchedAt.get(id)
      if (last !== undefined && t - last < TOUCH_MIN_MS) return
      const at = now()
      if (editDevices(id, (all) => all.map((d) => (d.id === id ? { ...d, lastSeen: at } : d)))) touchedAt.set(id, t)
    },
  }
}
