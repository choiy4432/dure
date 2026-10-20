import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { animate, utils } from 'animejs'
import { clearSize, growFrom, readSize } from './expand'
import { MOTION_MS, reducedMotion } from './motion'

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
  // 펼친 모습(lim 없음) — 접을 때는 높이가 줄어든 뒤에야 풀린다. 움직임 줄이기면 open 과 늘 같다
  const [expanded, setExpanded] = useState(false)
  const [over, setOver] = useState(false)
  const from = useRef<number | null>(null) // 누르는 순간의 크기
  const moved = useRef(false)

  const measure = useCallback(() => {
    const el = box.current
    if (el) setOver(el.scrollHeight > el.clientHeight)
  }, [])

  // 펼친 동안엔 잴 수 없다(높이가 내용 그대로) — 접힌 상태에서만 잰다
  useLayoutEffect(() => {
    if (expanded) return
    measure()
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [expanded, measure, children])

  // 열고 닫을 때 높이로 이어진다 — 펼칠 땐 lim 을 바로 빼고 접힌 높이 → 전체 높이, 접을 땐 접힌 높이까지 줄인 뒤 lim·clamped 를 붙인다
  useLayoutEffect(() => {
    if (!moved.current) return
    moved.current = false
    const el = box.current
    const start = from.current
    if (!el || start === null || reducedMotion()) return
    if (open) {
      growFrom(el, start)
      return
    }
    el.classList.add('lim')
    const to = el.offsetHeight
    el.classList.remove('lim')
    utils.remove(el)
    el.style.overflow = 'hidden'
    animate(el, {
      height: { from: `${start}px`, to: `${to}px` },
      duration: MOTION_MS.expand,
      ease: 'outCubic',
      onComplete: () => {
        // 인라인 높이를 지우는 순간 상자가 높이 제한 없이 그려지지 않게 — 클래스를 먼저 붙인다(다음 렌더가 같은 값을 쓴다)
        el.classList.add('lim')
        if (over) el.classList.add('clamped')
        clearSize(el)
        setExpanded(false)
      },
    })
  }, [open, over])
  useEffect(() => {
    const el = box.current
    return () => {
      if (el) utils.remove(el)
    }
  }, [])

  const toggle = (next: boolean) => {
    const el = box.current
    from.current = el ? readSize(el) : null
    moved.current = true
    setOpen(next)
    if (next || reducedMotion()) setExpanded(next)
  }

  const folded = over && !expanded
  const onBox = (e: MouseEvent) => {
    if (!folded) return
    if ((e.target as HTMLElement).closest('a, button')) return
    toggle(true)
  }

  return (
    <div className="clamp" data-line={dataLine}>
      {/* 상자 눌러 펼치기는 마우스 덤 — 키보드는 아래 버튼이 맡는다 */}
      <div
        ref={box}
        id={id}
        className={`clamp-box${className ? ` ${className}` : ''}${expanded ? '' : ' lim'}${folded ? ' clamped' : ''}`}
        style={{ '--clamp-lines': lines } as CSSProperties}
        onClick={onBox}
      >
        {children}
      </div>
      {over && (
        <button type="button" className="lk clamp-more" aria-expanded={open} aria-controls={id} onClick={() => toggle(!open)}>
          {open ? '접기' : '더 보기'}
        </button>
      )}
    </div>
  )
}
