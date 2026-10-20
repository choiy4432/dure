/** 대화 목록의 한 순간 — 어느 에이전트의 몇 번째 줄까지 있고, 기록을 다 받았는지, 흐르는 글이 있는지 */
export interface LineSnap {
  agentId: string
  ready: boolean
  /** 앞에 숨긴 줄을 포함한 전체 줄 수(hiddenBefore + lines.length) */
  total: number
  streaming: boolean
}

/**
 * 이번에 들어올 줄 — 절대 위치 [from, to) 와 흐르는 글 줄. 없으면 null.
 * 처음 그린 것 · 에이전트 바꾸기 · 기록 받는 중 · '이전 대화 더 보기'(total 은 그대로) 는 들어오지 않는다.
 * 흐르던 글이 기록 줄로 자리 잡는 순간의 새 줄도 들어오지 않는다(이미 화면에 있던 글이다).
 */
export function enteringLines(prev: LineSnap | null, next: LineSnap): { from: number; to: number; live: boolean } | null {
  if (!prev || prev.agentId !== next.agentId || !prev.ready || !next.ready) return null
  const settled = prev.streaming && !next.streaming
  const grew = next.total > prev.total && !settled
  const live = !prev.streaming && next.streaming
  if (!grew && !live) return null
  return grew ? { from: prev.total, to: next.total, live } : { from: prev.total, to: prev.total, live }
}
