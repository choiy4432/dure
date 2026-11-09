import type { PhoneDevice } from './phoneTypes'

// 휴대폰 ↔ PC 휴대폰 서버(src/main/phone/phoneServer.ts) 사이의 꼴 — main 과 휴대폰 진입점(wsApi)이 같이 쓴다. node 를 쓰지 않는다

/**
 * 기기 토큰 쿠키 이름 — HttpOnly 라서 휴대폰 화면의 JS 는 토큰을 볼 수 없다(쿠키로만 받는다, 머리글 토큰 없음).
 * `__Host-` — 브라우저가 Secure · Path=/ · Domain 없음일 때만 받으므로, 같은 ts.net 의 다른 주소가 Domain 쿠키를 심어 덮어쓸 수 없다.
 * 끝은 휴대폰이 부르는 주소의 포트(https 443·47615 — e2e 의 http://127.0.0.1 은 그 포트): 쿠키는 포트를 가리지 않아서, 같은 PC 이름의
 * 다른 포트(두레 둘 — 설치본과 개발 실행)가 서로의 쿠키를 덮어쓰지 않게.
 * 🟡 같은 PC 이름의 다른 `tailscale serve` 앱(다른 포트)도 이 쿠키를 받는다(브라우저가 포트를 가리지 않음) — 받아들인다(설계 §4.2)
 */
export const PHONE_COOKIE_PREFIX = '__Host-dure_phone_'
export function phoneCookieName(port: number): string {
  return `${PHONE_COOKIE_PREFIX}${port}`
}

/** 서버 길 — ws 는 WebSocket(쿠키 필요), 나머지는 HTTP */
export const PHONE_PATHS = Object.freeze({
  ws: '/api/ws',
  /** POST { secret, name } → 쿠키 · PhonePairResponse */
  pair: '/api/pair',
  /** GET → 쿠키가 맞으면 PhoneMeResponse, 아니면 401 — WebSocket 은 401 을 화면에 알려 주지 않아서 짝 맺기 화면을 띄울지 이걸로 가린다 */
  me: '/api/me',
  /** POST ?name=<이름> 바이트 → PhoneUploadResponse(쿠키 필요) */
  upload: '/api/upload',
  /** GET → PhoneVapidResponse(쿠키 필요) */
  vapid: '/api/vapid',
  /** POST { subscription } → { ok:true }(쿠키 필요) */
  subscribe: '/api/subscribe',
})

/**
 * 휴대폰이 보내는 WebSocket 메시지 하나의 상한(바이트) — 넘으면 서버가 소켓을 닫는다(1009).
 * 보내는 칸이 그림을 base64 로 담아(5MB 그림 → 7MB 쯤) 넉넉히. 쿠키를 확인한 짝 맺은 기기만 소켓을 열 수 있다
 */
export const PHONE_WS_MESSAGE_MAX = 32 * 1024 * 1024
/** 짝이 끊겨(PC 에서 [끊기]) 서버가 닫은 소켓의 닫기 코드 — 다시 이어도 401 이니 짝 맺기 화면으로 */
export const PHONE_CLOSE_UNPAIRED = 4401

/**
 * 휴대폰 → PC. call 의 id 는 휴대폰이 고르는 정수(답의 id 로 돌아온다) · visible 은 화면이 보이는지(처음엔 안 보임으로 친다) ·
 * ping 은 연결이 살아 있나 묻기(서버는 바로 pong) — 브라우저는 WebSocket ping 틀을 보낼 수 없고, PC 가 잠들거나 망이 바뀌면
 * 닫힘 신호 없이 반쯤 열린 채로 남는다
 */
export type PhoneClientMessage =
  | { t: 'call'; id: number; method: string; args: unknown[] }
  | { t: 'visible'; on: boolean }
  | { t: 'ping' }

/** PC → 휴대폰. result 는 call 의 답(InvokeResult 꼴 그대로) · event 는 엔진 사건(앱 사건은 오지 않는다) · pong 은 ping 의 답 */
export type PhoneServerMessage =
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }
  | { t: 'event'; name: string; payload: unknown }
  | { t: 'pong' }

/** HTTP 길의 실패 답 — error 는 화면에 그대로 보일 한국어 */
export type PhoneApiError = { ok: false; error: string }
export type PhonePairResponse = { ok: true; device: PhoneDevice } | PhoneApiError
/**
 * PC 가 /dure.apk 로 내어 줄 안드로이드 앱 — 판(versionCode)은 앱 업데이트 띠, 패키지는 [두레 앱으로 열기] 링크가 쓴다
 * (시험 빌드는 시험 패키지). 내어 줄 앱이 없으면 null
 */
export type PhoneAndroidApp = { versionCode: number; packageName: string }
export type PhoneMeResponse = { ok: true; device: PhoneDevice; androidApp: PhoneAndroidApp | null } | PhoneApiError
/** path = PC 의 받은 파일(그대로 sendUser 의 file part path 로) · name = 다듬은 이름 · bytes = 받은 바이트 수 */
export type PhoneUploadResponse = { ok: true; path: string; name: string; bytes: number } | PhoneApiError
export type PhoneVapidResponse = { ok: true; publicKey: string } | PhoneApiError
