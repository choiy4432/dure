import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { ArrowRight, Check, ChevronDown, Clock, Ellipsis, Pin, Trash2 } from 'lucide-react'
import type { RelayMessage } from '../../../engine/types'
import { Markdown } from '../../lib/Markdown'
import { moveMenuFocus, useDismiss } from '../../lib/popover'
import { ago, josa } from '../../lib/words'
import { ConfirmDialog } from '../../shell/ConfirmDialog'
import { useCall } from './useCall'

/** 패널에 카드로 보이는 메시지 상태 — 상한 대기(held)는 방 하나에 한 장인 자동 상한 카드가 맡는다 */
export type ShownState = 'pending' | 'queued' | 'delivered'

/** 상태 표 — 관계도 엣지 알약과 같은 낱말 */
const TAG: Record<ShownState, string> = { delivered: '전달됨', pending: '확인 대기', queued: '작업 끝 대기' }

interface Props {
  message: RelayMessage & { state: ShownState }
  fromName: string
  toName: string
  /** 지금 시각 — 패널이 한 번 재서 모든 카드에 준다 */
  now: number
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 받은 메시지 카드(시안 .pin) — 머리 '보낸 → 받는 · 시간 · 상태', 본문 마크다운, 확인 대기면 [일 시키기] [나중에] */
export function MessageCard({ message, fromName, toName, now, open, onOpenChange }: Props) {
  const { busy, error, call } = useCall()
  const [asking, setAsking] = useState(false)
  const { id, state } = message
  const pending = state === 'pending'
  // 전달된 것은 전달된 때, 기다리는 것은 보낸 때
  const time = ago(state === 'delivered' ? message.updatedAt : message.createdAt, now)
  const label = `${fromName}${josa(fromName, '이/가')} 보낸 메시지`

  const dismiss = async () => {
    await window.dure.dismissMessage(id) // 실패하면 대화상자 안에 문구
    setAsking(false)
  }

  return (
    <section className={`pin${open ? '' : ' fold'}`} aria-label={label}>
      <div className="pin-h">
        <button type="button" className="pin-tg" aria-expanded={open} onClick={() => onOpenChange(!open)}>
          <Pin className="i" aria-hidden="true" />
          <b className="trunc" title={fromName}>
            {fromName}
          </b>
          <ArrowRight className="i pin-ar" size={14} aria-hidden="true" />
          <b className="trunc" title={toName}>
            {toName}
          </b>
          <span className="pin-t">· {time}</span>
          {!open && <ChevronDown className="i pin-cv" aria-hidden="true" />}
        </button>
        <span className={`tag${state === 'delivered' ? ' ok' : ''}`}>
          {state === 'delivered' ? (
            <Check className="i" size={14} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Clock className="i" size={14} strokeWidth={2} aria-hidden="true" />
          )}
          {TAG[state]}
        </span>
        {state !== 'delivered' && <MessageMenu onDismiss={() => setAsking(true)} />}
      </div>
      {open && (
        <>
          <div className="pin-b">
            <Markdown text={message.text} />
          </div>
          {pending && (
            <div className="ab pin-ab">
              <button
                type="button"
                className="btn pri sm"
                disabled={busy}
                onClick={() => call(() => window.dure.approveMessage(id))}
              >
                일 시키기
              </button>
              <button type="button" className="btn sec sm" onClick={() => onOpenChange(false)}>
                나중에
              </button>
            </div>
          )}
          {error && (
            <p className="pin-err" role="alert">
              {error}
            </p>
          )}
        </>
      )}
      <ConfirmDialog
        open={asking}
        title="이 메시지를 버릴까요?"
        body={`${toName}에게 전달되지 않아요.`}
        confirmLabel="버리기"
        danger
        onConfirm={dismiss}
        onCancel={() => setAsking(false)}
      />
    </section>
  )
}

/** 카드 머리의 … — 지금은 '버리기' 하나. 고정 카드 자리가 스크롤되므로 목록은 화면 기준(fixed)으로 띄운다 */
function MessageMenu({ onDismiss }: { onDismiss: () => void }) {
  const [at, setAt] = useState<CSSProperties | null>(null)
  const open = at !== null
  const wrap = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setAt(null), [])
  useDismiss(open, wrap, close)

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    // 고정 카드 자리가 스크롤되거나 창 크기가 바뀌면 자리가 어긋난다 — 닫는다
    const onMove = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  const toggle = () => {
    if (open) return close()
    const r = btn.current?.getBoundingClientRect()
    setAt(r ? { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) } : {})
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      btn.current?.focus()
      return
    }
    if (e.key === 'Tab') {
      close()
      return
    }
    moveMenuFocus(e)
  }

  return (
    <span className="mp" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="ib xs"
        aria-label="메시지 메뉴"
        title="메뉴"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <Ellipsis className="i" aria-hidden="true" />
      </button>
      {open && (
        <div ref={menu} className="pop fix" style={at} role="menu" aria-label="메시지 메뉴" onKeyDown={onKey}>
          <button
            type="button"
            role="menuitem"
            className="mi dng-t"
            onClick={() => {
              close()
              btn.current?.focus()
              onDismiss()
            }}
          >
            <Trash2 className="i" aria-hidden="true" />
            버리기
          </button>
        </div>
      )}
    </span>
  )
}
