import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Bot } from 'lucide-react'
import type { SubagentNode, SubagentStatus, SubagentStep, SubagentTurn } from '../state/subagents'
import type { ActionLine } from '../state/transcript'
import { ongoing } from '../lib/toolSummary'
import { elapsed, firstLine, initial } from '../lib/words'
import { Markdown } from '../lib/Markdown'
import { Clamp } from '../lib/Clamp'
import { ExpandBox } from '../lib/ExpandBox'
import { Presence, playEnter } from '../lib/presence'
import { MOTION, reducedMotion } from '../lib/motion'
import { Action } from './ChatItem'

/** 바닥에서 이만큼 안이면 '맨 아래에 붙어 있다'(대화 목록과 같은 수) */
const STICK_PX = 24

const CHIP: Record<SubagentStatus, string> = { running: '도는 중', done: '끝', failed: '실패', stopped: '멈춤', lost: '끊김' }
/** 칩·노드 테두리 색 — 도는 중 초록 · 끝 회색 · 실패·멈춤·끊김 빨강 */
const TONE: Record<SubagentStatus, 'run' | 'done' | 'bad'> = { running: 'run', done: 'done', failed: 'bad', stopped: 'bad', lost: 'bad' }

/**
 * 노드 둘째 줄 — 도는 중: 마지막 하는 일(진행 중이면 진행형) + 도구 수 · 끝: 도구 수 + 걸린 시간 · 실패: 보고 첫 줄 · 멈춤 · 끊김.
 * Claude 가 쓰는 영어 진행 글은 쓰지 않는다 — 기록된 하는 일에서 만든다.
 */
function nodeLine(n: SubagentNode): string {
  const tools = `도구 ${n.toolUses}번`
  switch (n.status) {
    case 'running': {
      if (!n.last) return tools
      const doing = [n.last.target, n.last.pending ? ongoing(n.last.verb) : n.last.verb].filter(Boolean).join(' ')
      return `${doing} · ${tools}`
    }
    case 'done':
      return n.startedAt != null && n.endedAt != null ? `${tools} · ${elapsed(n.startedAt, n.endedAt)}` : tools
    case 'failed':
      return (n.report && firstLine(n.report)) || tools
    case 'stopped':
      return '멈췄어요'
    case 'lost':
      return '끝나기 전에 끊겼어요'
  }
}

/** 차례 머리 — 그 차례를 연 사람 말·받은 메시지의 첫 줄, 스스로 이어 간 차례는 그렇다고 */
function TurnHead({ id, opener }: { id: string; opener: SubagentTurn['opener'] }) {
  const line = opener.kind === 'auto' ? '' : firstLine(opener.text)
  const label =
    opener.kind === 'auto' ? '서브에이전트가 끝난 뒤 이어서'
      : opener.kind === 'relay' ? (opener.from ? `${opener.from}에게서 온 메시지` : '전달된 메시지')
        : '차례'
  return (
    <p id={id} className="sa-turn-h">
      <span className="trunc">
        <b>{label}</b>
        {line && ` · “${line}”`}
      </span>
      <span className="sa-turn-ln" aria-hidden="true" />
    </p>
  )
}

type Piece = { type: 'text'; text: string } | { type: 'acts'; actions: ActionLine[] }

/** 한 일 목록 — 이어진 하는 일은 한 상자, 그 사이 서브에이전트의 글은 작은 글로(대화와 같은 차례대로) */
function pieces(steps: SubagentStep[]): Piece[] {
  const out: Piece[] = []
  for (const s of steps) {
    const last = out[out.length - 1]
    if (s.type === 'text') out.push({ type: 'text', text: s.text })
    else if (last?.type === 'acts') last.actions.push(s.action)
    else out.push({ type: 'acts', actions: [s.action] })
  }
  return out
}

function NodeBody({ node }: { node: SubagentNode }) {
  const list = pieces(node.steps)
  return (
    <>
      {node.hidden ? (
        <p className="sa-none">이 서브에이전트가 한 일은 Claude 가 보내 주지 않아요</p>
      ) : list.length === 0 && !node.report ? (
        <p className="sa-none">보여 줄 내용이 없어요</p>
      ) : (
        list.map((p, i) =>
          p.type === 'text' ? (
            <Clamp key={i} className="clamp-md sa-say">
              <Markdown text={p.text} />
            </Clamp>
          ) : (
            <ul key={i} className="acts">
              {p.actions.map(a => (
                <Action key={a.id} a={a} />
              ))}
            </ul>
          ),
        )
      )}
      {node.report && (
        <div className="sa-rep">
          <p className="sa-rep-h">보고</p>
          <Markdown text={node.report} />
        </div>
      )}
    </>
  )
}

/** 노드 하나 — 누르면 그 자리에서 한 일과 보고가 펼쳐진다(여러 노드를 함께). 띄운 서브에이전트는 그 아래 한 칸 들여 */
function NodeView({ node }: { node: SubagentNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const tone = TONE[node.status]
  return (
    <li>
      <div className={`sa-node ${tone}${open ? ' open' : ''}`}>
        <button type="button" className="sa-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
          <span className="sa-t">
            <Bot className="i" aria-hidden="true" />
            <span className="sa-n trunc">{node.description || '서브에이전트'}</span>{' '}
            <span className={`sa-st ${tone}`}>
              {node.status === 'running' && <span className="wk-dot" aria-hidden="true" />}
              {CHIP[node.status]}
            </span>
          </span>{' '}
          <span className="sa-m trunc">{nodeLine(node)}</span>
        </button>
        <Presence show={open}>
          <ExpandBox as="div" className="sa-body" id={id}>
            <NodeBody node={node} />
          </ExpandBox>
        </Presence>
      </div>
      {node.children.length > 0 && (
        <ul className="sa-kids">
          {node.children.map(c => (
            <NodeView key={c.id} node={c} />
          ))}
        </ul>
      )}
    </li>
  )
}

function holds(nodes: SubagentNode[], id: string): boolean {
  return nodes.some(n => n.id === id || holds(n.children, id))
}

/**
 * 서브에이전트 탭 — 차례마다 묶은 나무 지도(시안 2안). 오래된 차례가 위, 열면 맨 아래(최신 차례)로.
 * 차례가 늘면 맨 아래에 붙어 있을 때만 따라 내려간다.
 * focus(대화의 요약 줄을 눌렀다)가 새로 오면 그 노드가 든 차례 묶음으로 스크롤하고 그 묶음이 다시 들어온다(새 줄과 같은 움직임).
 * 한 번 간 focus 는 seen 에 적어 — 대화로 갔다가 탭만 다시 열면 맨 아래로 간다.
 */
export function SubagentMap({ name, turns, focus, seen }: {
  name: string
  turns: SubagentTurn[]
  focus: { key: string; n: number } | null
  seen: RefObject<number>
}) {
  const box = useRef<HTMLDivElement>(null)
  const groups = useRef(new Map<string, HTMLDivElement>())
  const stick = useRef(true)
  const base = useId()

  const onScroll = () => {
    const el = box.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
  }

  // 새 focus — 그 노드가 든 차례로(열 때든 열린 채든). 맨 아래에 붙지 않게 해 아래 효과가 끌어 내리지 않는다.
  // 키보드 초점도 그 묶음으로 — 누른 요약 줄은 대화 목록과 함께 사라져 초점이 body 로 떨어진다(묶음 이름 = 차례 머리로 읽힌다).
  // turns 는 그 순간의 것을 읽을 뿐 — 차례가 늘 때 다시 돌지 않는다
  useLayoutEffect(() => {
    if (!focus || focus.n <= seen.current) return
    seen.current = focus.n
    const turn = turns.find(t => holds(t.nodes, focus.key))
    const group = turn ? groups.current.get(turn.key) : undefined
    if (!group) return
    stick.current = false
    group.scrollIntoView?.({ block: 'start' })
    group.focus({ preventScroll: true })
    if (!reducedMotion()) playEnter(group, MOTION.line.enter)
  }, [focus?.n])

  // 열 때(처음엔 붙어 있다) · 차례가 늘 때 — 맨 아래에 붙어 있으면 맨 아래로
  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [turns])

  return (
    <div className="conv-wrap">
      <div ref={box} className="sa-map" onScroll={onScroll}>
        {turns.map((turn, i) => (
          <div
            key={turn.key}
            ref={el => {
              if (el) groups.current.set(turn.key, el)
              else groups.current.delete(turn.key)
            }}
            className="sa-turn"
            role="group"
            aria-labelledby={`${base}-${i}`}
            // 요약 줄에서 올 때 초점을 받는 자리 — Tab 순서에는 넣지 않는다
            tabIndex={-1}
          >
            <TurnHead id={`${base}-${i}`} opener={turn.opener} />
            <div className="sa-root">
              <span className="av b" aria-hidden="true">
                {initial(name)}
              </span>
              <span className="sa-root-n trunc">{name}</span>
            </div>
            <ul className="sa-kids">
              {turn.nodes.map(n => (
                <NodeView key={n.id} node={n} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
