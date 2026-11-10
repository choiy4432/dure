import type { ChatLine } from '../state/transcript'

/**
 * 바닥에서 벗어난 순간(위로 올려 읽기 시작) — 그때의 줄 수(줄 번호로 — 앞에 붙은 줄은 세지 않는다), 그때 마지막 줄의 모양, 흐르던 글 길이.
 * 새 글 알약(시안 ② A)이 그 뒤로 온 글을 센다
 */
export interface Away {
  total: number
  tail: string | null
  live: number
}

/** 줄의 모양 — Claude 답은 조각·글·하는 일 수(같은 차례가 이어 자라면 바뀐다). 다른 줄은 자라지 않는다(null) */
export function lineShape(line: ChatLine | undefined): string | null {
  return line?.kind === 'claude' ? `${line.parts.length}:${line.text.length}:${line.actions.length}` : null
}

/**
 * 바닥에서 벗어난 뒤 온 글 수 — 새 줄 수
 * + 1: 벗어날 때 마지막이던 Claude 답이 이어 자랐거나(같은 차례), 새 줄 없이 흐르는 글이 늘었다
 * + 1: 새 줄 뒤에 새 답이 흐르는 중(다 흐르면 그 답이 새 줄이 된다 — 두 번 세지 않는다).
 * now.tail = 벗어날 때 마지막이던 줄의 지금 모양 · lastKind = 지금 마지막 줄 · live = 지금 흐르는 글 길이
 */
export function unreadSince(away: Away, now: { total: number; tail: string | null; lastKind: ChatLine['kind'] | null; live: number }): number {
  const fresh = Math.max(0, now.total - away.total)
  const grew = now.tail !== away.tail || (fresh === 0 && now.live > away.live)
  const coming = fresh > 0 && now.live > 0 && now.lastKind !== 'claude'
  return fresh + (grew ? 1 : 0) + (coming ? 1 : 0)
}

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
