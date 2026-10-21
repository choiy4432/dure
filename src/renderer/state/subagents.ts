import type { HistoryItem } from '../../engine/types'
import { actionFor, isAgentTool, stripRelay, type ActionLine } from './transcript'

export type SubagentStatus = 'running' | 'done' | 'failed' | 'stopped' | 'lost'
export type SubagentStep = { type: 'text'; text: string } | { type: 'act'; action: ActionLine }

export interface SubagentNode {
  /** 부모의 Agent tool_use id */
  id: string
  taskId: string | null
  description: string
  status: SubagentStatus
  startedAt: number | null
  endedAt: number | null
  toolUses: number
  steps: SubagentStep[]
  last: ActionLine | null
  report: string | null
  /** 안쪽 서브에이전트인데 그 줄이 하나도 오지 않는다 — Claude 가 안쪽의 안쪽은 보내 주지 않는다 */
  hidden: boolean
  children: SubagentNode[]
}

/** 같은 차례에 맡긴 서브에이전트들 — 차례를 연 것이 사람 말인지 받은 메시지인지 스스로 이어 간 것인지와 함께 */
export interface SubagentTurn {
  key: string
  opener: { kind: 'human' | 'relay' | 'auto'; text: string; from: string }
  nodes: SubagentNode[]
}

type ToolResult = Extract<HistoryItem, { kind: 'tool-result' }>
type Start = Extract<HistoryItem, { kind: 'subagent-start' }>
type End = Extract<HistoryItem, { kind: 'subagent-end' }>
type Opener = SubagentTurn['opener']

interface Slot {
  node: SubagentNode
  start: Start | null
  end: End | null
  /** 이 Agent tool_use 를 낸 줄의 parent — 부모 자신이면 null */
  owner: string | null
  /** 이 일을 연 마지막 사람 말·받은 메시지·차례 끝 기록의 자리 */
  anchor: number
}

const STATUS: Record<End['status'], SubagentStatus> = { completed: 'done', failed: 'failed', stopped: 'stopped' }

function openerOf(item: HistoryItem | undefined): Opener {
  if (item?.kind !== 'user') return { kind: 'auto', text: '', from: '' }
  const text = item.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
  if (item.source === 'relay') {
    const r = stripRelay(text)
    return { kind: 'relay', text: r.body, from: r.from }
  }
  return { kind: 'human', text, from: '' }
}

/**
 * 서브에이전트 나무 — 차례별로, 안쪽은 children 으로.
 * 노드 = 부모가 낸 Agent·Task tool_use(+ 시작 기록). 글·하는 일은 그 노드 id 를 parent 로 단 줄에서만 온다.
 * 멈춘 뒤 늦게 도착한 parent 결과는 걸음의 결과로만 붙고 상태는 끝 기록이 정한다.
 */
export function buildSubagentTree(
  all: HistoryItem[],
  running: ReadonlySet<string>,
): { turns: SubagentTurn[]; total: number; running: number } {
  // 새 대화 경계 앞은 버린다
  let from = 0
  all.forEach((it, i) => {
    if (it.kind === 'boundary') from = i + 1
  })
  const items = all.slice(from)

  const results = new Map<string, ToolResult>()
  const starts = new Map<string, Start>()
  const ends = new Map<string, End>()
  for (const it of items) {
    if (it.kind === 'tool-result') results.set(it.toolUseId, it)
    else if (it.kind === 'subagent-start') starts.set(it.toolUseId, it)
    else if (it.kind === 'subagent-end') ends.set(it.toolUseId, it)
  }

  const slots = new Map<string, Slot>()
  const register = (id: string, input: unknown, owner: string | null, anchor: number) => {
    if (slots.has(id)) return
    const start = starts.get(id) ?? null
    const end = ends.get(id) ?? null
    const own = results.get(id)
    let status: SubagentStatus
    if (end) status = STATUS[end.status]
    else if (running.has(id)) status = 'running'
    else if (start) status = 'lost'
    // 시작 기록이 없는 옛 기록 — 부모가 받은 결과로(안내 글은 쓰지 않는다)
    else if (own) status = own.isError ? 'failed' : 'done'
    else status = 'lost'
    const inputDesc = input && typeof input === 'object' ? (input as Record<string, unknown>).description : null
    slots.set(id, {
      node: {
        id,
        taskId: start?.taskId ?? end?.taskId ?? null,
        description: start?.description || (typeof inputDesc === 'string' ? inputDesc : ''),
        status,
        startedAt: start?.t ?? null,
        endedAt: end?.t ?? null,
        toolUses: 0,
        steps: [],
        last: null,
        report: end?.summary ? end.summary : null,
        hidden: false,
        children: [],
      },
      start,
      end,
      owner,
      anchor,
    })
  }

  // 차례의 머리 = 이 일 앞의 마지막 사람 말·받은 메시지, 그 뒤로 차례 끝 기록이 있으면 스스로 이어 간 것
  let anchor = -1
  items.forEach((it, i) => {
    if (it.kind === 'user' || it.kind === 'result') anchor = i
    else if (it.kind === 'assistant') {
      for (const b of it.blocks) if (b.type === 'tool_use' && isAgentTool(b.name)) register(b.id, b.input, it.parent ?? null, anchor)
    } else if (it.kind === 'subagent-start') register(it.toolUseId, null, null, anchor)
  })

  // 걸음 — 그 노드를 parent 로 단 줄의 글과 (Agent 가 아닌) 하는 일
  for (const it of items) {
    if (it.kind !== 'assistant' || !it.parent) continue
    const slot = slots.get(it.parent)
    if (!slot) continue
    for (const b of it.blocks) {
      if (b.type === 'text') {
        if (b.text !== '') slot.node.steps.push({ type: 'text', text: b.text })
      } else if (!isAgentTool(b.name)) {
        const action = actionFor(b, results)
        slot.node.steps.push({ type: 'act', action })
        slot.node.last = action
      }
    }
  }

  const byTask = new Map<string, Slot>()
  for (const s of slots.values()) if (s.node.taskId) byTask.set(s.node.taskId, s)

  const topBy = new Map<number, SubagentTurn>()
  const turns: SubagentTurn[] = []
  for (const s of slots.values()) {
    const n = s.node
    const acts = n.steps.filter((x) => x.type === 'act').length
    n.toolUses = s.end?.toolUses ?? acts
    n.hidden = s.start?.parentTaskId != null && n.steps.length === 0
    const parent = (s.start?.parentTaskId ? byTask.get(s.start.parentTaskId) : undefined) ?? (s.owner ? slots.get(s.owner) : undefined)
    if (parent) {
      parent.node.children.push(n)
      continue
    }
    let turn = topBy.get(s.anchor)
    if (!turn) {
      turn = { key: n.id, opener: openerOf(items[s.anchor]), nodes: [] }
      topBy.set(s.anchor, turn)
      turns.push(turn)
    }
    turn.nodes.push(n)
  }

  let total = 0
  let live = 0
  for (const s of slots.values()) {
    total++
    if (s.node.status === 'running') live++
  }
  return { turns, total, running: live }
}
