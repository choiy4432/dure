import { memo, useId, useState, type ComponentType } from 'react'
import {
  ArrowRight, Bot, ChevronDown, ChevronRight, File, Globe, MessageCircleQuestion, Pencil, Search, Send, ShieldCheck,
  SquareTerminal, Wrench, type LucideProps,
} from 'lucide-react'
import type { AgentId } from '../../engine/types'
import type { ActionLine, ChatLine, ClaudePart } from '../state/transcript'
import type { ToolIcon } from '../lib/toolSummary'
import { getStore } from '../state/store'
import { Markdown } from '../lib/Markdown'
import { useFrameValue } from '../lib/useFrameValue'
import { Clamp } from '../lib/Clamp'
import { ExpandBox } from '../lib/ExpandBox'
import { Presence } from '../lib/presence'
import { localSummary } from '../lib/words'
import { DiffView } from './DiffView'
import { MeImages } from './MeImages'

const ICONS: Record<ToolIcon, ComponentType<LucideProps>> = {
  file: File,
  edit: Pencil,
  run: SquareTerminal,
  search: Search,
  web: Globe,
  handoff: Send,
  question: MessageCircleQuestion,
  other: Wrench,
}

/**
 * '허용된 일' 꼬리표 — 보통은 승인을 묻는 일(고치기·만들기·실행·웹)이 설정의 허용 규칙으로 묻지 않고 된 것.
 * 읽기·찾기처럼 원래 묻지 않는 일엔 붙이지 않는다(시안: 읽음 줄엔 꼬리표가 없다).
 */
const ASKS_FIRST = new Set(['수정', '만듦', '실행', '웹에서 찾아봄'])

/** 명령 출력 — 아는 출력(/compact)은 가운데 한국어 한 줄 + 접힌 '자세히'(영어 원문), 모르는 출력은 원문 상자 그대로 */
function LocalLine({ text, index }: { text: string; index?: number }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const summary = localSummary(text)
  if (!summary)
    return (
      <Clamp className="clamp-mono pad" dataLine={index}>
        <pre className="ci-local">{text}</pre>
      </Clamp>
    )
  return (
    <div className="ci-sys" data-line={index}>
      <p className="note">
        {summary}
        <button type="button" className="lk sys-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
          자세히
          <ChevronDown className="i" size={14} aria-hidden="true" />
        </button>
      </p>
      <Presence show={open}>
        <ExpandBox as="pre" className="ci-local" id={id}>
          {text}
        </ExpandBox>
      </Presence>
    </div>
  )
}

/** 하는 일 한 줄 — 누르면 출력이 펼쳐진다. 대화의 하는 일 상자와 서브에이전트 지도의 한 일 목록이 같이 쓴다 */
export function Action({ a }: { a: ActionLine }) {
  const [open, setOpen] = useState(false)
  const tagged = a.allowed && ASKS_FIRST.has(a.verb)
  const Icon = tagged ? ShieldCheck : ICONS[a.icon]
  const cls = a.denied ? 'no' : a.pending ? 'run' : undefined
  return (
    <li className={cls}>
      <button
        type="button"
        className="act"
        aria-expanded={open}
        disabled={a.pending}
        title={a.target ?? undefined}
        onClick={() => setOpen(o => !o)}
      >
        <ChevronRight className="i c" aria-hidden="true" />
        <Icon className="i" aria-hidden="true" />
        {tagged && <span className="k">허용된 일</span>}
        {a.target && <span className="f trunc">{a.target}</span>}
        <span className="act-v">{a.verb}</span>
      </button>
      <Presence show={open}>
        <ExpandBox as="div" className="act-out">
          {/* '수정'은 결과 글("… updated successfully.") 대신 바뀐 줄 — 거절이면 지금처럼 결과 글 */}
          {a.patch && !a.denied ? (
            <DiffView hunks={a.patch} cut={a.patchCut} />
          ) : (
            <>
              {a.output ? (
                <Clamp className="clamp-mono">
                  <pre>{a.output}</pre>
                </Clamp>
              ) : <p className="act-none">보여 줄 내용이 없어요</p>}
              {a.truncated && <p className="act-cut">전체는 길어서 생략</p>}
            </>
          )}
        </ExpandBox>
      </Presence>
    </li>
  )
}

type SubagentsPart = Extract<ClaudePart, { type: 'subagents' }>

/** 요약 줄의 상태별 개수 — 점 색(.dot)과 읽는 말. 차례는 늘 도는 중 · 끝 · 실패(멈춤·끊김도 빨강 묶음) */
const COUNT_GROUPS = [
  { key: 'running', dot: 'g', word: '도는 중' },
  { key: 'done', dot: 's', word: '끝' },
  { key: 'bad', dot: 'r', word: '실패' },
] as const

/**
 * 서브에이전트 요약 한 줄(시안 2안) — 한 답 안에서 이어 맡긴 서브에이전트를 하는 일 상자 한 줄로.
 * Bot · '서브에이전트 N개에게 맡김'(하나면 설명 + '서브에이전트에게 맡김') · 상태별 개수(0 인 묶음은 뺀다) · 화살표.
 * 누르면 서브에이전트 탭으로 가 이 줄의 차례 묶음을 보인다(key = 첫 Agent 의 tool_use id).
 */
function SubagentsRow({ part, agentId }: { part: SubagentsPart; agentId?: AgentId }) {
  const one = part.ids.length === 1
  const counts = COUNT_GROUPS.filter(g => part.counts[g.key] > 0)
  return (
    <li>
      <button
        type="button"
        className="act sa-sum"
        disabled={!agentId}
        title={(one && part.description) || undefined}
        onClick={() => agentId && getStore().showSubagents(agentId, part.key)}
      >
        <Bot className="i" aria-hidden="true" />{' '}
        {one && part.description && (
          <>
            <span className="sa-sum-d trunc">{part.description}</span>{' '}
          </>
        )}
        <span className="act-v">{one ? '서브에이전트에게 맡김' : `서브에이전트 ${part.ids.length}개에게 맡김`}</span>{' '}
        <span className="sa-sum-n" role="img" aria-label={counts.map(g => `${g.word} ${part.counts[g.key]}`).join(', ')}>
          {counts.map(g => (
            <span key={g.key}>
              <i className={`dot ${g.dot}`} aria-hidden="true" />
              {part.counts[g.key]}
            </span>
          ))}
        </span>
        <ArrowRight className="i sa-sum-go" aria-hidden="true" />
      </button>
    </li>
  )
}

/** 흐르는 글 — 마크다운으로, 한 장에 한 번만 다시 읽는다 */
function LiveLine({ text }: { text: string }) {
  const shown = useFrameValue(text)
  return (
    <div className="ci-live" aria-busy="true" data-line="live">
      <div className="who">Claude</div>
      <Markdown text={shown} caret />
    </div>
  )
}

interface Props {
  line: ChatLine
  /** 줄 번호(앞에 숨긴 줄 포함) — 뿌리 요소의 data-line. 새 줄이 들어올 때 ChatList 가 집는다 */
  index?: number
  /** 이 대화의 에이전트 — 서브에이전트 요약 줄을 누르면 그 에이전트의 서브에이전트 탭으로 간다 */
  agentId?: AgentId
}

/** 대화 한 줄 — 사람 말풍선 · 전달된 메시지 · Claude 블록(+ 하는 일 · 서브에이전트 요약) · 알림 · 명령 출력 · 흐르는 글 */
function ChatItemView({ line, index, agentId }: Props) {
  switch (line.kind) {
    case 'me':
      return (
        <div className="me" data-line={index}>
          {line.images.length > 0 && <MeImages agentId={agentId} files={line.images} />}
          {line.text && <p>{line.text}</p>}
        </div>
      )
    case 'relay': {
      // '기획에게서 온 메시지' 한 마디 — 이름만 굵게, 이름과 조사 사이를 나누지 않는다(한 칸 안에)
      return (
        <div className="ci-relay" data-line={index} data-msg={line.messageId}>
          <div className="who">
            <span className="who-p">
              {line.from ? (
                <>
                  <b>{line.from}</b>에게서 온 메시지
                </>
              ) : (
                '전달된 메시지'
              )}
            </span>
          </div>
          <Clamp className="clamp-md">
            <Markdown text={line.text} />
          </Clamp>
        </div>
      )
    }
    case 'claude':
      return (
        <div className="ci-claude" data-line={index}>
          <div className="who">Claude</div>
          {/* 글과 하는 일 상자를 일어난 차례대로 — 흐르는 동안 보던 차례가 차례가 끝나도 그대로 */}
          {line.parts.map((p, i) =>
            p.type === 'text' ? (
              <Markdown key={i} text={p.text} />
            ) : p.type === 'subagents' ? (
              <ul key={i} className="acts">
                <SubagentsRow part={p} agentId={agentId} />
              </ul>
            ) : (
              <ul key={i} className="acts">
                {p.actions.map(a => (
                  <Action key={a.id} a={a} />
                ))}
              </ul>
            ),
          )}
        </div>
      )
    case 'notice':
      return <p className="note" data-line={index}>{line.text}</p>
    case 'local':
      return <LocalLine text={line.text} index={index} />
    case 'streaming':
      return <LiveLine text={line.text} />
  }
}

const sameAction = (a: ActionLine, b: ActionLine) =>
  a.id === b.id && a.verb === b.verb && a.target === b.target && a.icon === b.icon && a.allowed === b.allowed &&
  a.denied === b.denied && a.output === b.output && a.pending === b.pending && a.truncated === b.truncated &&
  a.patch === b.patch && a.patchCut === b.patchCut // 바뀐 줄은 기록 항목의 그 배열 그대로 — 같은 결과면 같은 참조

/** 같은 종류의 조각 둘이 같은가 — 글은 내용, 하는 일은 개수, 서브에이전트 요약은 key·id·설명·개수 */
function samePart(p: ClaudePart, q: ClaudePart): boolean {
  if (p.type === 'text') return q.type === 'text' && p.text === q.text
  if (p.type === 'acts') return q.type === 'acts' && p.actions.length === q.actions.length
  return (
    q.type === 'subagents' && p.key === q.key && p.ids.length === q.ids.length && p.ids.every((id, i) => id === q.ids[i]) &&
    p.description === q.description &&
    p.counts.running === q.counts.running && p.counts.done === q.counts.done && p.counts.bad === q.counts.bad
  )
}

/** 기록이 하나 늘 때마다 줄 객체는 새로 만들어진다 — 내용이 같으면 다시 그리지 않는다(마크다운을 다시 읽지 않게) */
/** 그림 이름 목록 — 줄 객체가 새로 만들어져도 같은 이름 차례면 같다 */
const sameList = (x: (string | null)[], y: (string | null)[]) => x.length === y.length && x.every((v, i) => v === y[i])

function sameLine(prev: Props, next: Props): boolean {
  if (prev.index !== next.index || prev.agentId !== next.agentId) return false
  const a = prev.line
  const b = next.line
  if (a === b) return true
  if (a.kind !== b.kind || a.text !== b.text) return false
  switch (a.kind) {
    case 'me':
      return sameList(a.images, (b as typeof a).images) && a.at === (b as typeof a).at
    case 'relay':
      return a.from === (b as typeof a).from && a.at === (b as typeof a).at && a.messageId === (b as typeof a).messageId
    case 'claude': {
      const x = (b as typeof a).actions
      const y = (b as typeof a).parts
      // 조각의 차례·나뉨도 같아야 — 글과 하는 일이 같아도 놓인 차례가 다르면 다시 그린다
      const sameParts = a.parts.length === y.length && a.parts.every((p, i) => p.type === y[i].type && samePart(p, y[i]))
      return a.at === (b as typeof a).at && a.actions.length === x.length && a.actions.every((act, i) => sameAction(act, x[i])) && sameParts
    }
    case 'notice':
    case 'local':
      return a.at === (b as typeof a).at
    case 'streaming':
      return true
  }
}

export const ChatItem = memo(ChatItemView, sameLine)
