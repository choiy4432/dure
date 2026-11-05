// 휴대폰 화면들이 같이 쓰는 겉틀 — 머리(‹ · 제목 · 단추) · 끊김 띠 · 아래에서 올라오는 판 · ⋯ 메뉴
import { createContext, Fragment, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, Ellipsis, RefreshCw, X } from 'lucide-react'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { MotionDiv, Presence, useMotion } from '../lib/presence'
import { moveMenuFocus, useDismiss } from '../lib/popover'
import { clockText } from './rooms'

/** 끊김 — 다시 잇는 중이면 마지막으로 받은 때(받은 적이 없으면 null). 이어져 있으면 offline false */
export interface Offline {
  offline: boolean
  at: number | null
}
export const OfflineContext = createContext<Offline>({ offline: false, at: null })
export const useOffline = () => useContext(OfflineContext)

/** 끊김 안내 — PC 가 잠들었거나 휴대폰의 Tailscale 이 꺼졌을 수 있다 */
export const OFFLINE_HINT = 'PC 가 꺼졌거나 잠들었으면 이어지지 않아요. 휴대폰의 Tailscale 이 켜져 있는지도 봐 주세요.'

/** 위 띠 — 다시 잇는 중… <시각> 에 받은 내용이에요(화면에 보이는 것이 그때 것) */
export function OfflineBand() {
  const { offline, at } = useOffline()
  if (!offline) return null
  return (
    <div className="m-band" role="status">
      <RefreshCw className="i" aria-hidden="true" />
      <span>
        다시 잇는 중…{at !== null && ` ${clockText(at)} 에 받은 내용이에요`}
      </span>
    </div>
  )
}

/** 화면 머리 — ‹(있으면) · 가운데(제목 등) · 오른쪽 단추들. 높이 56, 누르는 곳 44 */
export function MobileTop({ onBack, children, actions }: { onBack?: () => void; children: ReactNode; actions?: ReactNode }) {
  return (
    <header className={`m-top${onBack ? ' back' : ''}`}>
      {onBack && (
        <button type="button" className="m-ib" aria-label="뒤로" onClick={onBack}>
          <ChevronLeft className="i" size={24} aria-hidden="true" />
        </button>
      )}
      <div className="m-top-main">{children}</div>
      {actions}
    </header>
  )
}

export interface MenuItem {
  label: string
  icon: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

/** ⋯ 메뉴 — 머리 오른쪽 44px 단추 + 아래로 펼치는 목록(PC 의 떠 있는 목록과 같은 모양, 항목은 44px) */
export function MoreMenu({ label, items, header, onOpen }: { label: string; items: MenuItem[]; header?: ReactNode; onOpen?: () => void }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, wrap, close)
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [open])
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      btn.current?.focus()
      return
    }
    if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    moveMenuFocus(e)
  }
  return (
    <span className="mp m-more" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="m-ib"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.()
          setOpen(o => !o)
        }}
      >
        <Ellipsis className="i" size={20} aria-hidden="true" />
      </button>
      <Presence show={open}>
        <MotionDiv motion={MOTION.pop} origin="top right" ref={menu} className="pop end m-pop" role="menu" aria-label={label} onKeyDown={onKey}>
          {header}
          {items.map((it, i) => (
            <Fragment key={it.label}>
              {/* 되돌릴 수 없는 일은 나눔 줄 아래로 — PC 메뉴·설정 판과 같게 */}
              {it.danger && i > 0 && <div className="pop-sep" role="separator" />}
              <button
                type="button"
                role="menuitem"
                className={`mi${it.danger ? ' dng-t' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false)
                  btn.current?.focus()
                  it.onSelect()
                }}
              >
                {it.icon}
                <span className="mi-tx">{it.label}</span>
              </button>
            </Fragment>
          ))}
        </MotionDiv>
      </Presence>
    </span>
  )
}

/**
 * 아래에서 올라오는 판(설정 판) — 막 · 손잡이 · 제목 줄(닫기). 열린 동안 포커스는 안에서만, Esc·막 누르기로 닫힌다(확인 대화상자가 위에 뜨면 그쪽이 먼저)
 */
export function Sheet({ open, title, head, onClose, children }: {
  open: boolean
  /** 읽는 이름(aria-label) */
  title: string
  /** 제목 줄 왼쪽(아바타·이름 등) */
  head: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  return <Presence show={open}>{createPortal(<SheetFrame title={title} head={head} onClose={onClose}>{children}</SheetFrame>, document.body)}</Presence>
}

function SheetFrame({ title, head, onClose, children }: { title: string; head: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const headId = useId()
  useMotion(backdrop, MOTION.backdrop)
  useMotion(ref, MOTION.dialog)
  useDialogFocus(ref, onClose, () => null)
  const onBackdrop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }
  return (
    <div ref={backdrop} className="m-sheet-bd" onPointerDown={onBackdrop}>
      <div ref={ref} className="m-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="m-sheet-hd" id={headId}>
          <div className="m-sheet-hd-main">{head}</div>
          <button type="button" className="m-ib" aria-label="닫기" onClick={onClose}>
            <X className="i" size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="m-sheet-body">{children}</div>
      </div>
    </div>
  )
}
