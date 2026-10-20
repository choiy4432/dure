import { memo, useId, useState, type ComponentType } from 'react'
import {
  ChevronDown, ChevronRight, File, Globe, Image as ImageIcon, MessageCircleQuestion, Pencil, Search, Send, ShieldCheck, SquareTerminal,
  Wrench, type LucideProps,
} from 'lucide-react'
import type { ActionLine, ChatLine } from '../state/transcript'
import type { ToolIcon } from '../lib/toolSummary'
import { Markdown } from '../lib/Markdown'
import { useFrameValue } from '../lib/useFrameValue'
import { Clamp } from '../lib/Clamp'
import { ExpandBox } from '../lib/ExpandBox'
import { Presence } from '../lib/presence'
import { localSummary } from '../lib/words'

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

function Action({ a }: { a: ActionLine }) {
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
          {a.output ? (
            <Clamp className="clamp-mono">
              <pre>{a.output}</pre>
            </Clamp>
          ) : <p className="act-none">보여 줄 내용이 없어요</p>}
          {a.truncated && <p className="act-cut">전체는 길어서 생략</p>}
        </ExpandBox>
      </Presence>
    </li>
  )
}

/** 접힌 전달 메시지의 한 줄 — 첫 글 줄, 마크다운 머리표·강조 기호는 걷는다 */
function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim() !== '') ?? ''
  return line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[`*]/g, '').trim()
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
  /** 전달된 메시지가 위 고정 카드에 펼쳐져 있다 — 한 줄(누구에게서 온 메시지 + 첫 줄)로 접는다 */
  folded?: boolean
  /** 줄 번호(앞에 숨긴 줄 포함) — 뿌리 요소의 data-line. 새 줄이 들어올 때 ChatList 가 집는다 */
  index?: number
}

/** 대화 한 줄 — 사람 말풍선 · 전달된 메시지 · Claude 블록(+ 하는 일) · 알림 · 명령 출력 · 흐르는 글 */
function ChatItemView({ line, folded = false, index }: Props) {
  switch (line.kind) {
    case 'me':
      return (
        <div className="me" data-line={index}>
          {line.images > 0 && (
            <span className="me-img">
              <ImageIcon className="i" aria-hidden="true" />
              이미지 {line.images}개
            </span>
          )}
          {line.text && <p>{line.text}</p>}
        </div>
      )
    case 'relay': {
      // '기획에게서 온 메시지' 한 마디 — 이름만 굵게, 이름과 조사 사이를 나누지 않는다(한 칸 안에)
      const who = (
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
      )
      if (folded) {
        return (
          <div className="ci-relay fold" data-line={index}>
            {who}
            <p className="fold-t trunc">{firstLine(line.text)}</p>
          </div>
        )
      }
      return (
        <div className="ci-relay" data-line={index}>
          {who}
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
          {line.text && <Markdown text={line.text} />}
          {line.actions.length > 0 && (
            <ul className="acts">
              {line.actions.map(a => (
                <Action key={a.id} a={a} />
              ))}
            </ul>
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
  a.denied === b.denied && a.output === b.output && a.pending === b.pending && a.truncated === b.truncated

/** 기록이 하나 늘 때마다 줄 객체는 새로 만들어진다 — 내용이 같으면 다시 그리지 않는다(마크다운을 다시 읽지 않게) */
function sameLine(prev: Props, next: Props): boolean {
  if (!!prev.folded !== !!next.folded || prev.index !== next.index) return false
  const a = prev.line
  const b = next.line
  if (a === b) return true
  if (a.kind !== b.kind || a.text !== b.text) return false
  switch (a.kind) {
    case 'me':
      return a.images === (b as typeof a).images && a.at === (b as typeof a).at
    case 'relay':
      return a.from === (b as typeof a).from && a.at === (b as typeof a).at && a.messageId === (b as typeof a).messageId
    case 'claude': {
      const x = (b as typeof a).actions
      return a.at === (b as typeof a).at && a.actions.length === x.length && a.actions.every((act, i) => sameAction(act, x[i]))
    }
    case 'notice':
    case 'local':
      return a.at === (b as typeof a).at
    case 'streaming':
      return true
  }
}

export const ChatItem = memo(ChatItemView, sameLine)
