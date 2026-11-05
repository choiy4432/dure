import crypto from 'node:crypto'
import { PAIR_TTL_MS, type PhoneDevice } from '../../shared/phoneTypes'
import { cleanDeviceName, publicDevice, type PhoneStore, type StoredPhoneDevice } from './phoneStore'

// 짝 맺기 — PC 가 짝 코드(QR, 32바이트 hex)와 6자리 숫자를 하나씩 내고, 휴대폰이 그중 하나를 내면 기기 토큰(32바이트 base64url)을 준다.
// 짝 코드·숫자는 메모리에만(해시로), 토큰은 phone.json 에 sha256 해시로만. 🔴 코드·숫자·토큰은 로그·오류 글에 싣지 않는다

export { cleanDeviceName }

/** 같은 곳(from)에서 PAIR_FAIL_WINDOW_MS 안에 이만큼 틀리면 PAIR_LOCK_MS 동안 막는다(맞는 코드·숫자도) */
export const PAIR_FAIL_MAX = 5
export const PAIR_FAIL_WINDOW_MS = 60_000
export const PAIR_LOCK_MS = 60_000

export type PairStart = { code: string; pin: string; expiresAt: number }
export type RedeemResult = { token: string; device: PhoneDevice } | { error: 'expired' | 'wrong' | 'locked' }

export interface Pairing {
  /** 새 짝 코드·숫자 — 앞의 것은 무효 */
  start(): PairStart
  /** 지금 짝 코드·숫자를 무효로 */
  cancel(): void
  /**
   * secret = 짝 코드나 6자리 숫자(빈칸은 무시). 맞으면 기기를 저장하고 토큰을 준다 — 코드·숫자 둘 다 그걸로 끝.
   * 'locked' = 그 from 이 막힌 동안 · 'expired' = 짝 코드가 없음(안 냄·썼음·취소·5분 지남) · 'wrong' = 틀림(셈에 듦)
   */
  redeem(secret: string, deviceName: string, from: string): RedeemResult
  /** 토큰이 짝 맺은 기기의 것이면 그 기기(화면용 칸만), 아니면 null */
  verify(token: string): PhoneDevice | null
  /** 기기 지우기 — 그 토큰은 바로 verify 안 됨(열린 연결 닫기는 서버의 kick) */
  unpair(id: string): void
  /** 마지막 접속을 지금으로 */
  touch(id: string): void
}

const sha256 = (s: string): Buffer => crypto.createHash('sha256').update(s, 'utf8').digest()

/** 6자리 숫자 — 4바이트 수가 1,000,000 의 배수 범위 안일 때만 써서 치우침이 없다 */
const PIN_SPACE = 1_000_000
const PIN_LIMIT = Math.floor(0x1_0000_0000 / PIN_SPACE) * PIN_SPACE
const PIN_TRIES = 64
/** 이보다 긴 글은 토큰이 아니다(진짜는 43자) */
const TOKEN_TEXT_MAX = 256

function drawPin(randomBytes: (n: number) => Buffer): string {
  for (let i = 0; i < PIN_TRIES; i++) {
    const n = randomBytes(4).readUInt32BE(0)
    if (n < PIN_LIMIT) return String(n % PIN_SPACE).padStart(6, '0')
  }
  throw new Error('짝 숫자를 만들지 못했어요')
}

type Pending = { codeHash: Buffer; pinHash: Buffer; expiresAt: number }
type Fails = { at: number[]; lockedUntil: number }

export function createPairing(
  store: PhoneStore,
  o: { now?: () => number; randomBytes?: (n: number) => Buffer } = {},
): Pairing {
  const now = o.now ?? Date.now
  const randomBytes = o.randomBytes ?? crypto.randomBytes
  let pending: Pending | null = null
  const fails = new Map<string, Fails>()

  /** 막힘이 풀렸고 셀 틀림도 없는 곳은 지운다 — 표가 끝없이 자라지 않게 */
  const prune = (t: number) => {
    for (const [k, f] of fails) {
      if (f.lockedUntil <= t && f.at.every((x) => t - x >= PAIR_FAIL_WINDOW_MS)) fails.delete(k)
    }
  }
  const fail = (key: string, t: number) => {
    const f = fails.get(key) ?? { at: [], lockedUntil: 0 }
    f.at = f.at.filter((x) => t - x < PAIR_FAIL_WINDOW_MS)
    f.at.push(t)
    if (f.at.length >= PAIR_FAIL_MAX) {
      f.lockedUntil = t + PAIR_LOCK_MS
      f.at = []
    }
    fails.set(key, f)
  }
  /** 기기 줄 하나를 바꾸거나 빼서 쓴다 — 없는 id 면 쓰지 않는다 */
  const editDevices = (id: string, edit: (all: StoredPhoneDevice[]) => StoredPhoneDevice[]) => {
    const cur = store.read().devices
    if (!cur.some((d) => d.id === id)) return
    store.write({ devices: edit(cur) })
  }

  return {
    start() {
      const code = randomBytes(32).toString('hex')
      const pin = drawPin(randomBytes)
      const expiresAt = now() + PAIR_TTL_MS
      pending = { codeHash: sha256(code), pinHash: sha256(pin), expiresAt }
      return { code, pin, expiresAt }
    },

    cancel() {
      pending = null
    },

    redeem(secret, deviceName, from) {
      const t = now()
      const key = typeof from === 'string' ? from : ''
      prune(t)
      if ((fails.get(key)?.lockedUntil ?? 0) > t) return { error: 'locked' }
      if (!pending || t >= pending.expiresAt) {
        pending = null
        return { error: 'expired' }
      }
      const h = sha256(typeof secret === 'string' ? secret.replace(/\s/g, '') : '')
      // 둘 다 비교한다(어느 쪽이 맞았는지로 시간이 갈리지 않게) — 해시끼리라 길이도 같다
      const hitCode = crypto.timingSafeEqual(h, pending.codeHash)
      const hitPin = crypto.timingSafeEqual(h, pending.pinHash)
      if (!hitCode && !hitPin) {
        fail(key, t)
        return { error: 'wrong' }
      }
      const token = randomBytes(32).toString('base64url')
      const device: PhoneDevice = {
        id: randomBytes(16).toString('hex'), name: cleanDeviceName(deviceName), createdAt: t, lastSeen: t, push: false,
      }
      // 먼저 저장 — 쓰기가 실패하면(던짐) 짝 코드는 살아 있어 다시 낼 수 있다
      store.write({ devices: [...store.read().devices, { ...device, tokenHash: sha256(token).toString('hex') }] })
      pending = null
      fails.delete(key)
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
    },

    touch(id) {
      const t = now()
      editDevices(id, (all) => all.map((d) => (d.id === id ? { ...d, lastSeen: t } : d)))
    },
  }
}
