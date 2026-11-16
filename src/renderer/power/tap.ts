// 엔진 사건 → 화면 사건 — 스토어가 버리기 전의 날 사건을 본다. 순수 함수.
import type { HistoryItem, RelayMessage } from '../../engine/types'
import { oneLine, type ScreenEvent } from './events'

const TARGET_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'description']

/** 도구 입력에서 대상 한 줄 — 문자열인 첫 칸만(`??` 순서 그대로) */
export function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const k of TARGET_KEYS) {
    const v = o[k]
    if (v !== undefined && v !== null) return typeof v === 'string' ? oneLine(v, 80) : ''
  }
  return ''
}

/** 기록 한 줄의 tool_use 블록들 — 서브에이전트 줄(parent)은 뺀다 */
export function toolEvents(agentId: string, item: HistoryItem, at: number): ScreenEvent[] {
  if (item.kind !== 'assistant' || item.parent) return []
  const out: ScreenEvent[] = []
  for (const b of item.blocks) {
    if (b.type === 'tool_use') out.push({ kind: 'tool', agentId, tool: b.name, target: toolTarget(b.input), real: true, at })
  }
  return out
}

export function handoffEvent(m: RelayMessage, at: number): ScreenEvent {
  return { kind: 'handoff', from: m.from, to: m.to, text: oneLine(m.text, 80), real: true, at }
}
