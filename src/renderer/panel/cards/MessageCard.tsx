import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { ArrowRight, ChevronDown, Clock, Ellipsis, Pin, Trash2 } from 'lucide-react'
import type { RelayMessage } from '../../../engine/types'
import { Markdown } from '../../lib/Markdown'
import { Clamp } from '../../lib/Clamp'
import { ExpandBox } from '../../lib/ExpandBox'
import { moveMenuFocus, useDismiss } from '../../lib/popover'
import { MotionDiv, Presence, useMotion } from '../../lib/presence'
import { MOTION } from '../../lib/motion'
import { ago, josa, MESSAGE_WORD } from '../../lib/words'
import { ConfirmDialog } from '../../shell/ConfirmDialog'
import { useCall } from './useCall'

interface Props {
  /** 내 확인 필요(pending) 메시지 — 할 일 목록만 카드로 보인다. 끝나면 전달·전달됨은 메시지 탭에서 본다 */
  message: RelayMessage
  fromName: string
  toName: string
  /** 지금 시각 — 패널이 한 번 재서 모든 카드에 준다 */
  now: number
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 받은 메시지 카드(시안 .pin, 할 일 목록) — 머리 '보낸 → 받는 · 보낸 때 · 내 확인 필요', 본문 마크다운, [일 시키기] [나중에].
 * 펼침은 할 일 목록이 들고 있다('나중에'·머리 누르기로 접고, 정한 적 없으면 펼침).
 */
export function MessageCard({ message, fromName, toName, now, open, onOpenChange }: Props) {
  const { busy, error, call } = useCall()
  const root = useRef<HTMLElement>(null)
  useMotion(root, MOTION.line)
  const [asking, setAsking] = useState(false)
  const { id } = message
  const time = ago(message.createdAt, now)
  const label = `${fromName}${josa(fromName, '이/가')} 보낸 메시지`

  const dismiss = async () => {
    await window.dure.dismissMessage(id) // 실패하면 대화상자 안에 문구
    setAsking(false)
  }

  return (
    <section ref={root} className="pin msg" aria-label={label}>
      {/* 펼친 카드의 머리 위 4px — 접힌 카드(위아래 8px)와의 여백 차이도 본문과 함께 높이로 잇는다(base.css .pin.msg) */}
      <Presence show={open}>
        <ExpandBox outer="pin-gap" />
      </Presence>
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
        <span className="tag">
          <Clock className="i" size={14} strokeWidth={2} aria-hidden="true" />
          {MESSAGE_WORD.pending}
        </span>
        <MessageMenu onDismiss={() => setAsking(true)} />
      </div>
      {/* 본문 — 아래 여백 6px(.pin-open::after)까지 이 상자 안에 있다 */}
      <Presence show={open}>
        <ExpandBox outer="pin-open">
          <div className="pin-b">
            <Clamp className="clamp-md">
              <Markdown text={message.text} />
            </Clamp>
          </div>
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
          {error && (
            <p className="pin-err" role="alert">
              {error}
            </p>
          )}
        </ExpandBox>
      </Presence>
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
      <Presence show={open}>
        <MotionDiv motion={MOTION.pop} origin="top right" ref={menu} className="pop fix" style={at ?? undefined} role="menu" aria-label="메시지 메뉴" onKeyDown={onKey}>
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
        </MotionDiv>
      </Presence>
    </span>
  )
}
