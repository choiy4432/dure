import type { AgentId } from '../../engine/types'

// 방금 더한 에이전트의 표 — 관계도 카드가 '지금 생긴 것'만 나타나게 한다.
// 앱 시작·방 바꾸기로 다시 그려지는 카드는 표가 없어 움직이지 않는다.

/** 표가 유효한 시간(ms) — 더한 뒤 이 안에 그려진 카드만 새 카드다 */
const FRESH_MS = 5000
const fresh = new Map<AgentId, number>()

/** 에이전트를 막 더했다 */
export function markFresh(id: AgentId): void {
  fresh.set(id, Date.now())
}

function valid(id: AgentId): boolean {
  const at = fresh.get(id)
  if (at === undefined) return false
  if (Date.now() - at > FRESH_MS) {
    fresh.delete(id)
    return false
  }
  return true
}

/** 새 카드인가 — 지우지 않고 본다(StrictMode 가 처음 그릴 때를 두 번 불러도 같은 답) */
export function peekFresh(id: AgentId): boolean {
  return valid(id)
}

/** 한 번만 참 — 꺼내면 지운다 */
export function takeFresh(id: AgentId): boolean {
  const ok = valid(id)
  fresh.delete(id)
  return ok
}
