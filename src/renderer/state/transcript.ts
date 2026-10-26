import type { AssistantBlock, DiffHunk, HistoryItem } from '../../engine/types'
import { DENY_TEXTS } from '../../shared/denyTexts'
import { closedLaunches, subagentStatus, userText } from './subagents'
import { toolSummary, type ToolIcon } from '../lib/toolSummary'

export interface ActionLine {
  id: string
  verb: string
  target: string | null
  icon: ToolIcon
  allowed: boolean
  denied: boolean
  output: string
  pending?: boolean
  /** 출력이 길어 앞 2000자만 남겼다 — 잘렸을 때만 true */
  truncated?: boolean
  /** '수정'의 바뀐 줄 — 거절·오류가 아니고 엔진이 남겼을 때만. 있으면 펼침이 결과 글 대신 이것을 보인다 */
  patch?: DiffHunk[]
  /** 바뀐 줄이 길어 앞 400줄만 남겼다 — 잘렸을 때만 */
  patchCut?: true
}

/** Claude 답 안의 한 조각 — 글, 또는 이어진 하는 일 한 상자. 일어난 차례대로 놓는다 */
export type ClaudePart =
  | { type: 'text'; text: string }
  | { type: 'acts'; actions: ActionLine[] }
  // 이어서 맡긴 서브에이전트 — 대화엔 요약 한 조각만(안쪽 일은 '서브에이전트' 탭). description 은 하나일 때만
  | { type: 'subagents'; key: string; ids: string[]; description: string | null; counts: { running: number; done: number; bad: number } }

export type ChatLine =
  /** images = 붙인 그림의 저장 이름 차례대로(저장하기 전에 보낸 그림은 null) */
  | { kind: 'me'; text: string; images: (string | null)[]; at: number }
  | { kind: 'relay'; from: string; text: string; at: number; messageId?: string }
  | { kind: 'claude'; text: string; actions: ActionLine[]; parts: ClaudePart[]; at: number }
  | { kind: 'notice'; text: string; at: number }
  | { kind: 'local'; text: string; at: number }
  | { kind: 'streaming'; text: string }

const OUTPUT_MAX = 2000
const RELAY_PREFIX = '[두레 메시지 — 보낸 쪽: '

// 첫 줄이 '[두레 메시지 — 보낸 쪽: 이름(역할)]'(늦게 갔으면 ' · 34분 전에 보냄]') 이어야 한다. 이름 = 첫 '(' 앞이라 역할 안 괄호는 상관없다.
// 읽지 못하면 이름 없이 통째로 — 전달된 글이 '내 말'로 둔갑하지 않게.
export function stripRelay(text: string): { from: string; body: string } {
  const nl = text.indexOf('\n')
  const first = nl === -1 ? text : text.slice(0, nl)
  if (first.startsWith(RELAY_PREFIX) && (first.endsWith(')]') || / · [^·\]]+ 전에 보냄\]$/.test(first))) {
    const inner = first.slice(RELAY_PREFIX.length, -1)
    const paren = inner.indexOf('(')
    if (paren !== -1) return { from: inner.slice(0, paren).trim(), body: nl === -1 ? '' : text.slice(nl + 1) }
  }
  return { from: '', body: text }
}

type ToolResult = Extract<HistoryItem, { kind: 'tool-result' }>
type ToolUse = Extract<AssistantBlock, { type: 'tool_use' }>

export const isAgentTool = (name: string) => name === 'Agent' || name === 'Task'

/** tool_use 한 줄 + 짝 결과 → 하는 일 한 줄. 대화와 서브에이전트 나무가 같이 쓴다 */
export function actionFor(b: ToolUse, results: Map<string, ToolResult>): ActionLine {
  const s = toolSummary(b.name, b.input)
  const r = results.get(b.id)
  if (!r) return { id: b.id, ...s, allowed: false, denied: false, output: '', pending: true }
  // 바뀐 줄은 '수정'의 성공한 결과에만 — 거절·오류면 지금처럼 결과 글
  const diff = s.verb === '수정' && !r.isError && r.patch && r.patch.length > 0 ? r.patch : null
  return {
    id: b.id,
    ...s,
    allowed: !r.viaApproval && !r.isError,
    denied: r.isError && DENY_TEXTS.includes(r.text),
    output: r.text.slice(0, OUTPUT_MAX),
    ...(r.text.length > OUTPUT_MAX ? { truncated: true } : {}),
    ...(diff ? { patch: diff, ...(r.patchCut ? { patchCut: true as const } : {}) } : {}),
  }
}

function agentDescription(input: unknown): string | null {
  return toolSummary('Agent', input).target
}

export function buildTranscript(
  items: HistoryItem[],
  streaming: string | undefined,
  limit = 300,
  running: ReadonlySet<string> = new Set(),
): { lines: ChatLine[]; hiddenBefore: number } {
  const results = new Map<string, ToolResult>()
  const starts = new Map<string, Extract<HistoryItem, { kind: 'subagent-start' }>>()
  const ends = new Map<string, Extract<HistoryItem, { kind: 'subagent-end' }>>()
  for (const it of items) {
    if (it.kind === 'tool-result') results.set(it.toolUseId, it)
    else if (it.kind === 'subagent-start') starts.set(it.toolUseId, it)
    else if (it.kind === 'subagent-end') ends.set(it.toolUseId, it)
  }

  // 요약 숫자 — 나무와 같은 상태 규칙(subagentStatus · closedLaunches)에서 센다
  const closed = closedLaunches(items)
  const stateOf = (id: string): 'running' | 'done' | 'bad' => {
    const st = subagentStatus(ends.get(id), running.has(id), starts.has(id), results.get(id), closed.has(id))
    return st === 'running' ? 'running' : st === 'done' ? 'done' : 'bad'
  }

  const all: ChatLine[] = []
  let cur: Extract<ChatLine, { kind: 'claude' }> | null = null
  const texts: string[] = []
  const flush = () => {
    if (cur) {
      cur.text = texts.join('\n\n')
      if (cur.parts.length > 0) all.push(cur)
    }
    cur = null
    texts.length = 0
  }

  for (const it of items) {
    switch (it.kind) {
      case 'assistant': {
        if (it.parent) break
        if (!cur) cur = { kind: 'claude', text: '', actions: [], parts: [], at: it.t }
        const parts = cur.parts
        for (const b of it.blocks) {
          if (b.type === 'text') {
            if (b.text === '') continue
            texts.push(b.text)
            // 글은 바로 앞 조각이 글이면 이어 붙이고, 하는 일 상자 뒤면 새 조각 — 화면은 일어난 차례대로(흐르는 동안 보던 차례 그대로)
            const last = parts[parts.length - 1]
            if (last?.type === 'text') last.text += `\n\n${b.text}`
            else parts.push({ type: 'text', text: b.text })
          } else if (isAgentTool(b.name)) {
            const last = parts[parts.length - 1]
            if (last?.type === 'subagents') {
              last.ids.push(b.id)
              last.description = null
            } else {
              parts.push({ type: 'subagents', key: b.id, ids: [b.id], description: starts.get(b.id)?.description || agentDescription(b.input), counts: { running: 0, done: 0, bad: 0 } })
            }
            const part = parts[parts.length - 1] as Extract<ClaudePart, { type: 'subagents' }>
            part.counts[stateOf(b.id)]++
          } else {
            const action = actionFor(b, results)
            cur.actions.push(action)
            // 이어진 하는 일은 한 상자에
            const last = parts[parts.length - 1]
            if (last?.type === 'acts') last.actions.push(action)
            else parts.push({ type: 'acts', actions: [action] })
          }
        }
        break
      }
      case 'tool-result':
      case 'subagent-start':
      case 'subagent-end':
        break
      case 'user': {
        flush()
        const text = userText(it)
        const images = it.parts.flatMap((p) => (p.type === 'image' ? [p.file ?? null] : []))
        const relay = it.source === 'relay' ? stripRelay(text) : null
        if (relay) all.push({ kind: 'relay', from: relay.from, text: relay.body, at: it.t, ...(it.messageId ? { messageId: it.messageId } : {}) })
        else all.push({ kind: 'me', text, images, at: it.t })
        break
      }
      case 'notice':
        flush()
        all.push({ kind: 'notice', text: it.text, at: it.t })
        break
      case 'local-output':
        flush()
        all.push({ kind: 'local', text: it.text, at: it.t })
        break
      case 'result':
        flush()
        break
      case 'boundary':
        // 새 대화 — 앞 줄은 버린다(다시 켜면 엔진도 경계 뒤만 준다). 스토어가 이미 버리지만 어디서 오든 같은 화면이 되게
        cur = null
        texts.length = 0
        all.length = 0
        break
    }
  }
  flush()

  const hiddenBefore = Math.max(0, all.length - limit)
  const lines = hiddenBefore > 0 ? all.slice(hiddenBefore) : all
  if (streaming) lines.push({ kind: 'streaming', text: streaming })
  return { lines, hiddenBefore }
}
