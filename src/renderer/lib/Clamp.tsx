import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'

interface Props {
  /** 접혔을 때 보이는 줄 수 */
  lines?: number
  /** 상자 맞춤 클래스(줄 높이·안쪽 여백이 다른 본문용) */
  className?: string
  /** 뿌리 요소의 data-line — 대화 줄이 들어올 때 이 요소를 집는다 */
  dataLine?: number | string
  children: ReactNode
}

/**
 * 긴 내용은 `lines` 줄만 보이고 아래를 흐리게 — 누르면 펼친다.
 * 넘칠 때만 흐림·더 보기 버튼·손가락 커서가 생기고, 짧으면 그대로다. 넘침은 레이아웃에서 재서(scrollHeight) 폭이 바뀌면 다시 잰다.
 */
export function Clamp({ lines = 3, className, dataLine, children }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)

  const measure = useCallback(() => {
    const el = box.current
    if (el) setOver(el.scrollHeight > el.clientHeight)
  }, [])

  // 펼친 동안엔 잴 수 없다(높이가 내용 그대로) — 접힌 상태에서만 잰다
  useLayoutEffect(() => {
    if (open) return
    measure()
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, measure, children])

  const folded = over && !open
  const onBox = (e: MouseEvent) => {
    if (!folded) return
    if ((e.target as HTMLElement).closest('a, button')) return
    setOpen(true)
  }

  return (
    <div className="clamp" data-line={dataLine}>
      {/* 상자 눌러 펼치기는 마우스 덤 — 키보드는 아래 버튼이 맡는다 */}
      <div
        ref={box}
        id={id}
        className={`clamp-box${className ? ` ${className}` : ''}${open ? '' : ' lim'}${folded ? ' clamped' : ''}`}
        style={{ '--clamp-lines': lines } as CSSProperties}
        onClick={onBox}
      >
        {children}
      </div>
      {over && (
        <button type="button" className="lk clamp-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
          {open ? '접기' : '더 보기'}
        </button>
      )}
    </div>
  )
}
