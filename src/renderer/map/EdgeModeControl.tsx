import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronUp, Spline } from 'lucide-react'
import { getStore, useDure } from '../state/store'
import type { EdgeMode } from '../state/selectors'
import { moveMenuFocus, useDismiss } from '../lib/popover'
import { MotionDiv, Presence } from '../lib/presence'
import { MOTION } from '../lib/motion'

const MODES: { key: EdgeMode; name: string; hint: string }[] = [
  { key: 'recent', name: '최근', hint: '할 일이 있는 선과 24시간 안에 오간 선' },
  { key: 'all', name: '전부', hint: '오래된 선도 옅게 다 그려요' },
  { key: 'off', name: '끔', hint: '선 없이 — 받은 메시지는 카드가 알려 줘요' },
]

/**
 * 관계도 왼쪽 아래 '선' 단추 — 선 보기(최근 · 전부 · 끔)를 위로 펼친 목록에서 고른다. 고른 값은 이 PC 에 기억한다(store.setEdgeMode).
 * 확대 조절과 같은 떠 있는 상자 모양. 목록은 화살표·Home·End 로 오가고 Esc 면 닫고 단추로 초점을 돌린다.
 */
export function EdgeModeControl() {
  const mode = useDure(s => s.edgeMode)
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, wrap, close)

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [open])

  const pick = (m: EdgeMode) => {
    getStore().setEdgeMode(m)
    setOpen(false)
    btn.current?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
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

  const now = MODES.find(m => m.key === mode) ?? MODES[0]
  return (
    <div className="emc" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="emc-b"
        aria-label={`선 보기: ${now.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="선 보기"
        onClick={() => setOpen(o => !o)}
      >
        <Spline className="i" aria-hidden="true" />
        <span className="emc-t">
          선 <b>{now.name}</b>
        </span>
        <ChevronUp className="i emc-cv" aria-hidden="true" />
      </button>
      <Presence show={open}>
        <MotionDiv motion={MOTION.popUp} origin="bottom left" ref={menu} className="pop up emc-pop" role="menu" aria-label="선 보기" onKeyDown={onKey}>
          {MODES.map(m => (
            <button key={m.key} type="button" role="menuitemradio" aria-checked={m.key === mode} className="mi" onClick={() => pick(m.key)}>
              <span className="mi-tx">
                <span className="mi-t">{m.name}</span>
                <span className="mi-d">{m.hint}</span>
              </span>
              {m.key === mode && <Check className="i mi-ck" aria-hidden="true" />}
            </button>
          ))}
        </MotionDiv>
      </Presence>
    </div>
  )
}
