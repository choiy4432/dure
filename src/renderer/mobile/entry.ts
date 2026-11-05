// 휴대폰 진입점(main.tsx)이 처음에 하는 일 — 주소의 짝 코드 · 알림을 누름(서비스 워커 글) · 이미 허락한 알림 다시 구독.
// main.tsx 는 맨 위에서 바로 돌아 시험하기 어려워 여기로 뗐다
import { subscribePush, type NotificationLike, type PushOutcome } from './phoneHttp'

/** 주소 조각 하나(`a=b`)의 이름 — URLSearchParams 와 같게 읽는다 */
const keyOf = (part: string) => [...new URLSearchParams(part).keys()][0] ?? ''

/**
 * QR 의 짝 코드(#pair=) — 읽고 그 조각만 주소에서 지운다(방문 기록·화면 공유에 남지 않게).
 * #agent= 같은 다른 조각·쿼리·history.state 는 그대로, 방문 기록 칸은 늘지 않는다(replaceState). 없으면 주소를 건드리지 않는다
 */
export function takePairCode(): string | null {
  const parts = location.hash.replace(/^#/, '').split('&').filter(Boolean)
  const pair = parts.find(p => keyOf(p) === 'pair')
  if (pair === undefined) return null
  const code = new URLSearchParams(pair).get('pair') ?? ''
  const rest = parts.filter(p => keyOf(p) !== 'pair')
  history.replaceState(history.state, '', location.pathname + location.search + (rest.length ? `#${rest.join('&')}` : ''))
  return code.trim() || null
}

/**
 * 알림을 누름 — 서비스 워커가 열린 창에 { type:'dure:open', url } 을 보낸다. 같은 곳(이 두레 주소)이면 그 조각(#agent=)으로만 옮긴다
 * (다시 읽지 않는다: 쓰던 글이 남게). 같은 조각이면 hashchange 가 안 생기니 직접 쏜다. 다른 곳·꼴이 틀린 글은 버린다(false)
 */
export function openFromWorker(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const m = data as { type?: unknown; url?: unknown }
  if (m.type !== 'dure:open' || typeof m.url !== 'string') return false
  let u: URL
  try {
    u = new URL(m.url, location.origin)
  } catch {
    return false
  }
  if (u.origin !== location.origin) return false
  if (location.hash === u.hash) window.dispatchEvent(new HashChangeEvent('hashchange'))
  else location.hash = u.hash
  return true
}

/**
 * 이미 알림을 허락했다 — 켤 때마다 조용히 다시 구독한다(묻지 않는다). PC 가 열쇠를 새로 만들었거나, 구독이 지나 PC 가 지웠거나(410),
 * 브라우저가 구독을 바꿨어도 알림이 이어진다. 허락 전·막힘·못 쓰는 브라우저면 아무것도 안 함(null)
 */
export async function resubscribeIfGranted(o: { notification?: NotificationLike | null; subscribe?: () => Promise<PushOutcome> } = {}): Promise<PushOutcome | null> {
  const n = o.notification === undefined ? (typeof Notification === 'undefined' ? null : Notification) : o.notification
  if (!n || n.permission !== 'granted') return null
  try {
    return await (o.subscribe ?? (() => subscribePush()))()
  } catch {
    return 'failed'
  }
}
