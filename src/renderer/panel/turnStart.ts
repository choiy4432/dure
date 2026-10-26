// 대화 위 고정(StickyPrompt) — 이름이 StickyPrompt.tsx 와 대소문자만 다르면 윈도우에서 한쪽만 불린다. 지금 화면 맨 위에 걸친 차례를 연 줄(내 말 · 전달된 메시지) 고르기와 그 한 줄 글 (순수)
import type { ChatLine } from '../state/transcript'
import { firstLine } from '../lib/words'

/** 차례를 연 줄 하나의 자리 — 화면 좌표(getBoundingClientRect) */
export interface PromptBox {
  index: number
  top: number
  bottom: number
}

export type PromptLine = Extract<ChatLine, { kind: 'me' } | { kind: 'relay' }>

/** 고정 상자가 덮는 높이(px) — base.css .stk: 위 여백 20 + 상자 40(9 + 20 + 9 + 테두리 2) + 아래 막 56 */
export const STICKY_ZONE_PX = 116

/**
 * 보이는 칸 맨 위(viewTop)보다 위에서 시작한 마지막 줄의 번호 — 그 줄이 아직 조금이라도 보이면(bottom > viewTop) 없다.
 * 위로 지나간 차례 시작 줄이 없으면(대화 맨 위) 없다. 상자 자리(viewTop 부터 zone 안)에 다른 차례 시작 줄이 보여도 없다 —
 * 그 말이 이미 거기 보이니, 앞 차례의 상자가 그 말을 덮지 않게(누르고 간 바로 뒤가 그렇다). boxes 는 위에서 아래 차례.
 */
export function stickyPromptIndex(boxes: PromptBox[], viewTop: number, zone = 0): number | null {
  let last: PromptBox | null = null
  for (const b of boxes) {
    if (b.top >= viewTop) {
      if (b.top < viewTop + zone) return null
      break
    }
    last = b
  }
  return last && last.bottom <= viewTop ? last.index : null
}

/** 고정 상자의 한 줄 — 내 말은 줄바꿈·빈칸을 한 칸으로(글 없이 그림만이면 그림 수), 전달된 메시지는 마크다운 기호를 뗀 첫 줄 */
export function promptText(line: PromptLine): string {
  if (line.kind === 'relay') return firstLine(line.text)
  const text = line.text.replace(/\s+/g, ' ').trim()
  return text || `이미지 ${line.images.length}장`
}
