// 엔진 사건 → 화면 사건 — 스토어가 버리기 전의 날 사건을 본다. 순수 함수. 글은 모두 한 줄 글자로만(그리는 쪽도 글자로만 넣는다).
import type { DiffHunk, HistoryItem, RelayMessage } from '../../engine/types'
import { oneLine, type DiffLine, type ScreenEvent } from './events'

/** 화면 사건 글 한 줄의 상한 */
export const TEXT_MAX = 80
/** 결과 하나에 싣는 diff 줄 상한 */
export const DIFF_MAX = 12
/** 기록 한 줄에서 내는 답 글 줄 상한 */
export const SAY_MAX = 3

const TARGET_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'description']

/** 도구 입력에서 대상 한 줄 — 문자열인 첫 칸만(`??` 순서 그대로) */
export function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const k of TARGET_KEYS) {
    const v = o[k]
    if (v !== undefined && v !== null) return typeof v === 'string' ? oneLine(v, TEXT_MAX) : ''
  }
  return ''
}

/** 글의 첫 줄(빈 줄은 건너뛴다) — 없으면 '' */
const firstLine = (s: string): string => (s.split(/\r?\n/).find(l => l.trim()) ?? '').trim()

/** 글을 문단(빈 줄로 나뉜)마다 첫 줄로 */
const paragraphHeads = (s: string): string[] =>
  s.split(/\r?\n[ \t]*\r?\n/).map(firstLine).filter(Boolean)

/** patch → 더한·지운 줄 수(전체)와 앞 DIFF_MAX 줄 */
function diffOf(patch: DiffHunk[] | undefined): { added: number; removed: number; diff: DiffLine[] } {
  let added = 0
  let removed = 0
  const diff: DiffLine[] = []
  for (const h of patch ?? [])
    for (const l of h.lines) {
      const sign = l[0] === '+' || l[0] === '-' ? l[0] : ' '
      if (sign === '+') added++
      else if (sign === '-') removed++
      if (diff.length < DIFF_MAX) diff.push({ sign, text: oneLine(l.slice(1), TEXT_MAX) })
    }
  return { added, removed, diff }
}

/**
 * 기록 한 줄 → 화면 사건. 서브에이전트 줄(parent)은 뺀다 —
 * assistant: 글 블록은 문단 첫 줄(셋까지), tool_use 는 도구 · tool-result: 결과(오류·첫 줄·patch) · result: 차례 끝
 */
export function historyEvents(agentId: string, item: HistoryItem, at: number): ScreenEvent[] {
  if (item.kind === 'assistant') {
    if (item.parent) return []
    const out: ScreenEvent[] = []
    let says = 0
    for (const b of item.blocks) {
      if (b.type === 'tool_use') out.push({ kind: 'tool', agentId, tool: b.name, target: toolTarget(b.input), at })
      else
        for (const head of paragraphHeads(b.text)) {
          if (says >= SAY_MAX) break
          says++
          out.push({ kind: 'say', agentId, text: oneLine(head, TEXT_MAX), at })
        }
    }
    return out
  }
  if (item.kind === 'tool-result') {
    if (item.parent) return []
    return [{ kind: 'result', agentId, ok: !item.isError, text: oneLine(firstLine(item.text), TEXT_MAX), ...diffOf(item.patch), at }]
  }
  if (item.kind === 'result') return [{ kind: 'done', agentId, at }]
  return []
}

export function handoffEvent(m: RelayMessage, at: number): ScreenEvent {
  return { kind: 'handoff', from: m.from, to: m.to, text: oneLine(m.text, TEXT_MAX), at }
}
