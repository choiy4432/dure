// 터미널 창 줄 — 순수. 진짜 화면 사건 하나를 그 창의 줄로 바꾼다(지어낸 줄은 없다). 글자는 그리는 쪽이 textContent 로만 넣는다.
import type { HistoryItem } from '../../../engine/types'
import { tailPath, type AgentState, type PowerAgent, type ScreenEvent } from '../events'
import { historyEvents } from '../tap'

export type Color = 'ok' | 'er' | 'am' | 'bl' | 'dim' | 'add' | 'del'
/** 줄 조각 — c: 색, b: 굵게(도구 이름) */
export type Part = { t: string; c?: Color; b?: true }
export type Line = { parts: Part[] }

/** 창 수 상한(2열×3행) */
export const MAX_PANES = 6
/** 켤 때 기록에서 까는 줄 상한(창마다) */
export const PREFILL_MAX = 40

const line = (...parts: Part[]): Line => ({ parts })
const p = (t: string, c?: Color): Part => (c ? { t, c } : { t })
/** diff 줄은 결과 글(`  ⎿  ` 뒤) 아래로 들여 쓴다 */
const DIFF_INDENT = '     '

/** 사건이 붙는 창 — 넘김은 보낸 이와 받는 이 둘, 나머지는 그 에이전트 하나 */
export const panesOf = (ev: ScreenEvent): string[] =>
  ev.kind !== 'handoff' ? [ev.agentId] : ev.from === ev.to ? [ev.from] : [ev.from, ev.to]

/**
 * 진짜 사건 하나 → paneId 창의 줄(그 창의 사건이 아니면 없음). nameOf = id → 이름.
 * 도구 `● Tool(대상)` · 결과 `⎿ 첫 줄`(오류면 빨강, 바꾼 줄 수) + diff 줄 · 답 글 · 넘김(보낸 이: `● send_message(→ 이름)` + 글, 받는 이: `← 이름: 글`) · 차례 끝 `✓ 끝남`
 */
export function linesOf(ev: ScreenEvent, nameOf: (id: string) => string, paneId: string): Line[] {
  if (ev.kind === 'handoff') {
    if (ev.from === paneId)
      return [
        line(p('●', 'bl'), p(' '), { t: 'send_message', b: true }, p(`(→ ${nameOf(ev.to)})`, 'dim')),
        line(p(`  ⎿  "${ev.text}"`, 'dim')),
      ]
    if (ev.to === paneId) return [line(p(`← ${nameOf(ev.from)}: `, 'bl'), p(ev.text))]
    return []
  }
  if (ev.agentId !== paneId) return []
  switch (ev.kind) {
    case 'tool':
      return [line(p('●', 'ok'), p(' '), { t: ev.tool, b: true }, p('(', 'dim'), p(tailPath(ev.target)), p(')', 'dim'))]
    case 'result': {
      const changed = ev.added > 0 || ev.removed > 0
      if (!ev.text && !changed && !ev.diff.length) return []
      const head = line(p(`  ⎿  ${ev.text}`, ev.ok ? 'dim' : 'er'))
      if (changed) head.parts.push(p(ev.text ? ' (' : '(', 'dim'), p(`+${ev.added}`, 'ok'), p(' '), p(`−${ev.removed}`, 'er'), p(')', 'dim'))
      const diff = ev.diff.map(d => line(p(DIFF_INDENT), p(`${d.sign} ${d.text}`, d.sign === '+' ? 'add' : d.sign === '-' ? 'del' : 'dim')))
      return [head, ...diff]
    }
    case 'say':
      return [line(p(ev.text))]
    case 'done':
      return [line(p('✓ 끝남', 'ok'))]
  }
}

/** 보일 창 — 진짜 승인 기다림 → 진짜 일하는 중 → 나머지(무리 안에선 방 순서)로 MAX_PANES 명까지 */
export function pickPanes(agents: PowerAgent[], state: Record<string, AgentState>): PowerAgent[] {
  const rank = (a: PowerAgent) => (state[a.id] === 'awaiting' ? 0 : state[a.id] === 'working' ? 1 : 2)
  return [...agents].sort((x, y) => rank(x) - rank(y)).slice(0, MAX_PANES)
}

/** 스토어에 불러와 있는 기록 → 켤 때 깔 줄(듣기와 같은 변환 · 같은 줄 규칙). 뒤에서부터 max 줄을 채우면 멈춘다, 새 것이 끝 */
export function historyLines(agentId: string, items: readonly HistoryItem[], nameOf: (id: string) => string, max = PREFILL_MAX): Line[] {
  const chunks: Line[][] = []
  let n = 0
  for (let i = items.length - 1; i >= 0 && n < max; i--) {
    const ls = historyEvents(agentId, items[i], items[i].t).flatMap(ev => linesOf(ev, nameOf, agentId))
    chunks.push(ls)
    n += ls.length
  }
  return chunks.reverse().flat().slice(-max)
}
