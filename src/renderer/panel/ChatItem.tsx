import { memo, useState, type ComponentType } from 'react'
import {
  ChevronRight, File, Globe, Image as ImageIcon, MessageCircleQuestion, Pencil, Search, Send, ShieldCheck, SquareTerminal,
  Wrench, type LucideProps,
} from 'lucide-react'
import type { ActionLine, ChatLine } from '../state/transcript'
import type { ToolIcon } from '../lib/toolSummary'
import { Markdown } from '../lib/Markdown'

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
      {open && (
        <div className="act-out">
          {a.output ? <pre>{a.output}</pre> : <p className="act-none">보여 줄 내용이 없어요</p>}
          {a.truncated && <p className="act-cut">전체는 길어서 생략</p>}
        </div>
      )}
    </li>
  )
}

/** 대화 한 줄 — 사람 말풍선 · 전달된 메시지 · Claude 블록(+ 하는 일) · 알림 · 명령 출력 · 흐르는 글 */
function ChatItemView({ line }: { line: ChatLine }) {
  switch (line.kind) {
    case 'me':
      return (
        <div className="me">
          {line.images > 0 && (
            <span className="me-img">
              <ImageIcon className="i" aria-hidden="true" />
              이미지 {line.images}개
            </span>
          )}
          {line.text && <p>{line.text}</p>}
        </div>
      )
    case 'relay':
      return (
        <div className="ci-relay">
          <div className="who">
            {line.from ? (
              <>
                <span className="k">{line.from}</span>에게서 온 메시지
              </>
            ) : (
              '전달된 메시지'
            )}
          </div>
          <Markdown text={line.text} />
        </div>
      )
    case 'claude':
      return (
        <div className="ci-claude">
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
      return <p className="note">{line.text}</p>
    case 'local':
      return <pre className="ci-local">{line.text}</pre>
    case 'streaming':
      return (
        <div className="ci-live" aria-busy="true">
          <div className="who">Claude</div>
          <p className="live-t">
            {line.text}
            <span className="caret" aria-hidden="true" />
          </p>
        </div>
      )
  }
}

const sameAction = (a: ActionLine, b: ActionLine) =>
  a.id === b.id && a.verb === b.verb && a.target === b.target && a.icon === b.icon && a.allowed === b.allowed &&
  a.denied === b.denied && a.output === b.output && a.pending === b.pending && a.truncated === b.truncated

/** 기록이 하나 늘 때마다 줄 객체는 새로 만들어진다 — 내용이 같으면 다시 그리지 않는다(마크다운을 다시 읽지 않게) */
function sameLine(prev: { line: ChatLine }, next: { line: ChatLine }): boolean {
  const a = prev.line
  const b = next.line
  if (a === b) return true
  if (a.kind !== b.kind || a.text !== b.text) return false
  switch (a.kind) {
    case 'me':
      return a.images === (b as typeof a).images && a.at === (b as typeof a).at
    case 'relay':
      return a.from === (b as typeof a).from && a.at === (b as typeof a).at
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
