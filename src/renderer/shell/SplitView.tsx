import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

export const SPLIT_KEY = 'dure.split'
/** 관계도 : 패널 = 62 : 38 */
export const SPLIT_DEFAULT = 0.62
const MIN_RATIO = 0.5
const MAX_RATIO = 0.8
const MAP_MIN = 400 // px — base.css .sv-map 과 같은 수
const PANEL_MIN = 360 // px — base.css .sv-panel 과 같은 수
const LINE = 1 // 경계선 두께
const STEP = 0.02

/** 너비 width 에서 관계도 몫이 가질 수 있는 범위 — 0.5~0.8 이면서 관계도 ≥ 400px · 패널 ≥ 360px */
function ratioRange(width: number): [number, number] {
  if (width <= 0) return [MIN_RATIO, MAX_RATIO]
  return [Math.max(MIN_RATIO, MAP_MIN / width), Math.min(MAX_RATIO, (width - LINE - PANEL_MIN) / width)]
}

/** 둘 다 지킬 수 없을 만큼 좁으면(창 최소 너비보다 좁을 때) 패널 쪽을 지킨다 */
export function clampRatio(ratio: number, width: number): number {
  const [lo, hi] = ratioRange(width)
  return Math.min(Math.max(ratio, lo), hi)
}

const round = (r: number) => Math.round(r * 10000) / 10000

function readSplit(): number {
  try {
    const raw = localStorage.getItem(SPLIT_KEY)
    const v = raw === null ? NaN : Number(raw)
    return Number.isFinite(v) ? clampRatio(v, 0) : SPLIT_DEFAULT
  } catch {
    return SPLIT_DEFAULT
  }
}

function writeSplit(r: number) {
  try {
    localStorage.setItem(SPLIT_KEY, String(r))
  } catch {
    // 저장을 못 해도 이번 실행에선 그대로 쓴다
  }
}

interface Props {
  left: ReactNode
  right: ReactNode
  /** 주면 그 값을 쓴다(없으면 저장된 값으로 스스로 관리) */
  ratio?: number
  onRatio?: (ratio: number) => void
}

export function SplitView({ left, right, ratio, onRatio }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const [own, setOwn] = useState(readSplit)
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef(false)
  const latest = useRef(own)

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const measure = () => setWidth(el.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const shown = clampRatio(ratio ?? own, width)
  const [lo, hi] = ratioRange(width)

  const change = (next: number) => {
    const w = root.current?.getBoundingClientRect().width ?? width
    const r = clampRatio(round(next), w)
    latest.current = r
    setOwn(r)
    onRatio?.(r)
    return r
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = true
    latest.current = shown
    setDragging(true)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !root.current) return
    const rect = root.current.getBoundingClientRect()
    if (rect.width > 0) change((e.clientX - rect.left) / rect.width)
  }

  const endDrag = () => {
    if (!drag.current) return
    drag.current = false
    setDragging(false)
    writeSplit(latest.current)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowLeft' ? -STEP : e.key === 'ArrowRight' ? STEP : 0
    if (!d) return
    e.preventDefault()
    writeSplit(change(shown + d))
  }

  return (
    <div className="sv" ref={root}>
      <div className="sv-pane sv-map" style={{ flexBasis: `${shown * 100}%` }}>
        {left}
      </div>
      <div
        className={dragging ? 'split drag' : 'split'}
        role="separator"
        aria-orientation="vertical"
        aria-label="관계도와 패널 너비"
        aria-valuenow={Math.round(shown * 100)}
        aria-valuemin={Math.round(lo * 100)}
        aria-valuemax={Math.round(hi * 100)}
        title="끌어서 너비 조절"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
      />
      <div className="sv-pane sv-panel">{right}</div>
    </div>
  )
}
