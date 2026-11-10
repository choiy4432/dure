// 찾기(Ctrl+K)에서 고른 대화 줄로 가기 — 대화 목록(ChatList)과 지난 대화 읽기(PastPanel)가 같이 쓴다.
// 줄마다 뿌리 요소에 data-t(그 줄을 연 기록의 시각)가 있다(ChatItem)

import type { SearchWho } from '../../engine/types'
import type { ChatLine } from '../state/transcript'

/** 고른 줄을 두르는 시간(ms) — 지나면 표시를 걷는다 */
export const HIT_MS = 2000

/**
 * 찾기로 연 지난 대화 읽기가 그리는 줄 — 찾은 줄 앞 lead 줄부터 그 줄을 포함해 after 줄까지. 가장자리 단추가 more 줄씩 더 보인다.
 * 긴 대화(수천 줄)를 통째로 그리면 줄마다 마크다운을 읽느라 앱이 멈춘다 — 받는 것과 줄로 바꾸는 것은 싸다(수만 항목에 수십 ms)
 */
export const HIT_WIN = { lead: 40, after: 300, more: 200 } as const

const KIND: Record<SearchWho, ChatLine['kind']> = { me: 'me', claude: 'claude', message: 'relay' }

/**
 * 찾은 기록(t · who)이 보이는 대화 줄의 자리 — 같은 시각에서 시작한 줄이 있으면 그 가운데 첫 줄(같은 ms 의 줄은 붙어 있다).
 * 같은 시각 줄 가운데 who 와 꼴이 맞는 줄(나 = 내 말 · Claude = 답 · 받은 메시지 = 전달된 메시지)이 있으면 그 가운데 첫 줄.
 * 같은 시각 줄이 없으면 t 보다 앞에서 시작한 마지막 줄 — Claude 답 한 줄은 차례 안의 여러 기록을 묶어 첫 기록 시각만 갖는다.
 * 모든 줄보다 앞이면 -1
 */
export function hitLineIndex(lines: readonly ChatLine[], t: number, who: SearchWho): number {
  let same = -1
  let before = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.kind === 'streaming') continue
    if (line.at === t) {
      if (line.kind === KIND[who]) return i
      if (same < 0) same = i
    } else if (line.at < t) {
      before = i
    }
  }
  return same >= 0 ? same : before
}

// 지금 두른 줄은 하나 — 다른 줄로 가면 앞 표시는 바로 걷는다
let shown: { node: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null

function clearShown() {
  if (!shown) return
  clearTimeout(shown.timer)
  shown.node.classList.remove('hit')
  shown = null
}

/**
 * 그 줄로 — 줄이 대화 칸 가운데쯤 오게 스크롤하고(칸보다 길면 윗 여백 바로 아래에서 시작), HIT_MS 동안 노란 테(.hit)를 두르고
 * 초점을 옮긴다(tabIndex -1 — Tab 순서엔 없다). 움직임 줄이기면 테가 사라지는 움직임만 없다(CSS)
 */
export function revealHit(box: HTMLElement, node: HTMLElement): void {
  const pad = parseFloat(getComputedStyle(box).paddingTop) || 0
  const b = box.getBoundingClientRect()
  const r = node.getBoundingClientRect()
  const spare = box.clientHeight - r.height
  const offset = spare > 2 * pad ? spare / 2 : pad
  box.scrollTop += r.top - b.top - offset
  clearShown()
  node.classList.add('hit')
  const timer = setTimeout(() => {
    if (shown?.node === node) clearShown()
  }, HIT_MS)
  shown = { node, timer }
  node.tabIndex = -1
  node.focus({ preventScroll: true })
}
