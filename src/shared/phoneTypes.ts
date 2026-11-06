// 휴대폰으로 쓰기의 모양 — main(phone/*)·PC 설정 화면·휴대폰 화면이 같이 쓴다. 토큰·해시·구독·VAPID 같은 비밀 칸은 여기 없다(main 의 phoneStore 만)

/** 휴대폰 서버가 127.0.0.1 에서 듣는 포트 기본값 — 쓰이고 있으면 다음 빈 포트를 phone.json 에 저장 */
export const PHONE_PORT_DEFAULT = 47615

/** 짝 코드(QR)·6자리 숫자가 살아 있는 시간 */
export const PAIR_TTL_MS = 5 * 60_000

/** 기기 이름 — 이 글자 수(그래핌 — 이어 붙인 이모지·결합 문자도 한 글자)까지, 비면 기본 이름 */
export const PHONE_NAME_MAX = 40
export const PHONE_NAME_DEFAULT = '휴대폰'

export type PhoneSettings = {
  /** 휴대폰으로 쓰기 */
  enabled: boolean
  /** 켜 둔 동안 PC 절전 막기 */
  keepAwake: boolean
  /** Windows 를 켜면 두레도 켜기 */
  openAtLogin: boolean
  /** 휴대폰 알림 — 승인·질문 / 일을 마쳤어요(PC 의 Windows 알림과 따로) */
  notify: { asks: boolean; finished: boolean }
  /** 휴대폰 서버가 127.0.0.1 에서 듣는 포트 */
  port: number
}

/** 칸이 없거나 꼴이 틀리면 이 값 */
export const DEFAULT_PHONE_SETTINGS: Readonly<PhoneSettings> = Object.freeze({
  enabled: false,
  keepAwake: true,
  openAtLogin: false,
  notify: Object.freeze({ asks: true, finished: false }),
  port: PHONE_PORT_DEFAULT,
})

/** 짝 맺은 기기 — 화면에 보여도 되는 칸만(토큰 해시·구독은 phoneStore 의 StoredPhoneDevice) */
export type PhoneDevice = {
  id: string
  name: string
  createdAt: number
  /** 마지막 접속 — 모르면 null */
  lastSeen: number | null
  /** 알림 구독이 있다 */
  push: boolean
}

/**
 * PC 의 Tailscale 상태(main 의 tailscale.ts 가 만든다) — 깔려 있나 → 로그인됐나 → tailnet 에 https(Serve) 가 켜져 있나 → 준비됨.
 * 이 기기의 DNS 이름만 담는다(로그인 이름·이메일 같은 사용자 칸은 꺼내지 않는다)
 */
export type TailscaleState =
  | { kind: 'missing' }
  | { kind: 'logged-out' }
  | { kind: 'no-https'; enableUrl: string | null }
  | { kind: 'ready'; dnsName: string }

/** PC 설정의 휴대폰 칸이 받는 것(앱 사건 'phone' · phoneState) — 🔴 PC 창에만 간다(휴대폰엔 안 감) */
export type PhoneState = {
  settings: PhoneSettings
  devices: PhoneDevice[]
  /** 지금 소켓이 하나라도 열린 기기의 id — 겹치지 않고 정렬(PC 설정의 기기 목록 점) */
  online: string[]
  /** 지금 소켓이 하나라도 열린 기기 수 */
  connected: number
  /** 마지막으로 본 Tailscale 상태 — null = 아직 안 봄(꺼져 있으면 시작 때 tailscale 을 부르지 않는다 · phoneCheck 로 본다) */
  tailscale: TailscaleState | null
  /** 휴대폰 주소 `https://<dnsName>[:포트]/mobile.html` — 길이 열려 있을 때만, 아니면 null */
  url: string | null
  /** 지금 살아 있는 짝 맺기 — PC 가 띄우는 6자리 숫자와 만료 시각(벽시계). 없음·썼음·취소·만료·틀림 상한이면 null. QR 의 짝 코드는 싣지 않는다 */
  pairing: { pin: string; expiresAt: number } | null
  /** 켜기가 Tailscale 상태 밖의 까닭으로 멈췄다(https 포트가 다 쓰임·serve 실패·서버 포트 없음) — 한국어 한 줄, 없으면 null */
  problem: string | null
  /**
   * 다시 연 휴대폰 주소가 앞서 연 주소와 다르다(PC 이름이 바뀜·Funnel 때문에 https 포트를 옮김·공개가 풀려 돌아감) — 짝 맺은 휴대폰이 있을 때만.
   * 한국어 한 줄, 없으면 null. 휴대폰 창이 보고 phoneNoticeSeen 하거나, 짝을 다시 맺거나(phonePairStart), 끄면 지워진다
   */
  notice: string | null
}

/** setPhone 이 받는 것 — 화면이 바꾸는 칸만(포트는 main 이 정한다). 꼴이 틀린 칸은 pickPhoneChange 가 버린다 */
export type PhoneSettingsChange = {
  enabled?: boolean
  keepAwake?: boolean
  openAtLogin?: boolean
  notify?: { asks?: boolean; finished?: boolean }
}

/** 받은 값에서 불리언인 아는 칸만 — 그 밖(글·모르는 칸·port·객체 아님)은 버린다 */
export function pickPhoneChange(v: unknown): PhoneSettingsChange {
  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
  if (!obj(v)) return {}
  const out: PhoneSettingsChange = {}
  for (const k of ['enabled', 'keepAwake', 'openAtLogin'] as const) if (typeof v[k] === 'boolean') out[k] = v[k] as boolean
  if (obj(v.notify)) {
    const n: { asks?: boolean; finished?: boolean } = {}
    if (typeof v.notify.asks === 'boolean') n.asks = v.notify.asks
    if (typeof v.notify.finished === 'boolean') n.finished = v.notify.finished
    if (Object.keys(n).length > 0) out.notify = n
  }
  return out
}

/** phonePairStart 의 답 — qr = 휴대폰 주소 + `#pair=<짝 코드>` 의 QR(PNG data URL), url = 그 주소, pin = 6자리 숫자, expiresAt = 만료(벽시계) */
export type PhonePairOffer = { qr: string; pin: string; url: string; expiresAt: number }
