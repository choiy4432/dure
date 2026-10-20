import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { EFFORT_LEVELS, type EffortLevel } from '../../engine/types'
import { errorMessage } from '../lib/words'
import { useDismiss } from '../lib/popover'
import { MotionDiv, Presence } from '../lib/presence'
import { MOTION } from '../lib/motion'
import type { Described } from './ModelPicker'

interface Props {
  agentId: string
  /** 내가 정한 값 */
  effort: EffortLevel | null
  /** Claude 가 지금 쓰는 값 */
  effortNow: EffortLevel | null
  /** agent.model — null 이면 기본(default) */
  model: string | null
  description: Described
  onLoad: () => void
  onRetry: () => void
  /** 못 바꿨을 때 엔진 문구 */
  onError?: (message: string) => void
}

/** 패널이 이 너비(px)보다 좁으면 칩은 막대만 */
const NARROW_PX = 400
/** 마지막 움직임 뒤 이만큼 가만히 있으면 Claude 에 보낸다 */
const SEND_DELAY_MS = 300
/** effort 를 못 정하는 모델 */
const NO_EFFORT = '이 모델은 effort 를 정할 수 없어요'
/** 아직 안 고름 */
const MINE = '내 설정'
/** 칩에 나오는 이름 중 가장 넓은 둘 — 이름 칸에 안 보이게 깔아 칸 너비를 고정한다(base.css .eff-v) */
const WIDEST = ['medium', MINE] as const

/** 패널 머리의 effort 칩(막대 5개 + 단계 이름) + 다섯 단계 슬라이더 */
export function EffortControl({ agentId, effort, effortNow, model, description, onLoad, onRetry, onError }: Props) {
  const [open, setOpen] = useState(false)
  const [narrow, setNarrow] = useState(false)
  // 움직인 값 — 화면은 바로 이 값, Claude 로는 300 ms 뒤 마지막 값 하나만
  const [pending, setPending] = useState<EffortLevel | null>(null)
  const wrap = useRef<HTMLSpanElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const slider = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  // 누른 순간에 잰 막대 자리 — 끄는 동안 다시 재지 않는다(무엇이 막대를 옮겨도 손 밑 단계가 흔들리지 않게)
  const dragRect = useRef<DOMRect | null>(null)
  const [grab, setGrab] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, wrap, close)

  const settled = effortNow ?? effort
  const shown = pending ?? settled

  // 보낼 값(마지막 움직임) — 안 보낸 채 사라질 때 이 값을 보낸다
  const last = useRef<EffortLevel | null>(null)
  const agentRef = useRef(agentId)
  agentRef.current = agentId

  // 실제 값(내가 정한 값·Claude 가 쓰는 값)이 바뀌면 화면은 그 값을 따른다 — 아직 안 보낸 움직임이 있으면 그대로
  useEffect(() => {
    if (timer.current === null) {
      last.current = null
      setPending(null)
    }
  }, [effort, effortNow])

  // 패널(.pnl) 너비 — 좁으면 이름을 숨긴다
  useLayoutEffect(() => {
    const host = wrap.current?.closest('.pnl') ?? wrap.current?.parentElement
    if (!host) return
    const measure = () => {
      const w = host.getBoundingClientRect().width
      setNarrow(w > 0 && w < NARROW_PX)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  // 사라질 때(다른 에이전트를 고르거나 패널이 닫힘) 아직 안 보낸 마지막 값은 보낸다
  useEffect(() => () => {
    if (timer.current === null || last.current === null) return
    clearTimeout(timer.current)
    timer.current = null
    void window.dure.setEffort(agentRef.current, last.current).catch(() => {})
  }, [])

  // 처음 열 때 한 번 describe — 열기만으로 Claude 를 켜지 않는다(이미 받았으면 안 부름)
  useEffect(() => {
    if (open && description.state === 'idle') onLoad()
  }, [open, description.state, onLoad])

  useEffect(() => {
    if (open && description.state === 'ready') slider.current?.focus()
  }, [open, description.state])

  const current = model ?? 'default'
  const models = description.state === 'ready' ? description.value.models : null
  const info = models?.find(m => m.value === current)
  // describe 를 받은 뒤에만 안다 — 목록에 있는데 effort 를 못 정하는 모델이면 막는다
  const unsupported = !!info && !info.supportsEffort
  const allowed = (level: EffortLevel) => !info?.effortLevels || info.effortLevels.includes(level)

  const name = shown ?? MINE
  const label = `effort ${name}`
  const filled = shown ? EFFORT_LEVELS.indexOf(shown) + 1 : 0
  const index = shown ? EFFORT_LEVELS.indexOf(shown) : 2

  const choose = (level: EffortLevel) => {
    if (!allowed(level) || level === shown) return
    setPending(level)
    last.current = level
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      window.dure.setEffort(agentId, level).then(
        () => {
          // 더 새 움직임이 없으면 화면은 실제 값으로
          if (last.current === level) {
            last.current = null
            setPending(null)
          }
        },
        e => {
          if (last.current === level) {
            last.current = null
            setPending(null)
          }
          onError?.(errorMessage(e))
        },
      )
    }, SEND_DELAY_MS)
  }

  /** from 에서 dir 쪽으로 쓸 수 있는 가장 가까운 눈금 — 없으면 null */
  const nearest = (from: number, dir: 1 | -1): EffortLevel | null => {
    for (let i = from + dir; i >= 0 && i < EFFORT_LEVELS.length; i += dir) {
      if (allowed(EFFORT_LEVELS[i])) return EFFORT_LEVELS[i]
    }
    return null
  }

  // Esc — 초점이 칩에 있어도 닫히게 감싸는 칸에 건다
  const onEsc = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'Escape' || !open) return
    e.preventDefault()
    e.stopPropagation()
    setOpen(false)
    chip.current?.focus()
  }

  /** 막대(누른 순간의 자리) 위 x 좌표 → 모델이 지원하는 가장 가까운 눈금(같은 거리면 낮은 쪽) */
  const levelAt = (clientX: number): EffortLevel | null => {
    const r = dragRect.current
    if (!r || !(r.width > 0)) return null
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    const i = Math.round(f * (EFFORT_LEVELS.length - 1))
    for (let d = 0; d < EFFORT_LEVELS.length; d++) {
      if (i - d >= 0 && allowed(EFFORT_LEVELS[i - d])) return EFFORT_LEVELS[i - d]
      if (i + d < EFFORT_LEVELS.length && allowed(EFFORT_LEVELS[i + d])) return EFFORT_LEVELS[i + d]
    }
    return null
  }

  const follow = (e: PointerEvent<HTMLDivElement>) => {
    const level = levelAt(e.clientX)
    if (level) choose(level)
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return
    dragging.current = true
    dragRect.current = e.currentTarget.getBoundingClientRect()
    setGrab(true)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 붙잡기를 못 해도 눌린 자리는 반영 */ }
    e.currentTarget.focus()
    follow(e)
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) follow(e)
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    dragRect.current = null
    setGrab(false)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 이미 풀림 */ }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return // 눈금·다시 받기 단추는 제 키(Enter·Space)대로
    let next: EffortLevel | null | undefined
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = nearest(index, 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = nearest(index, -1)
    else if (e.key === 'Home') next = nearest(-1, 1)
    else if (e.key === 'End') next = nearest(EFFORT_LEVELS.length, -1)
    else return
    e.preventDefault()
    if (next) choose(next)
  }

  return (
    <span className={`mp eff${narrow ? ' narrow' : ''}`} ref={wrap} onKeyDown={onEsc}>
      <button
        ref={chip}
        type="button"
        className={`chip eff-chip${unsupported ? ' dim' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen(o => !o)}
      >
        <span className="eff-bars" aria-hidden="true">
          {EFFORT_LEVELS.map((l, i) => (
            <i key={l} className={i < filled ? 'on' : undefined} />
          ))}
        </span>
        <span className="eff-v" data-w1={WIDEST[0]} data-w2={WIDEST[1]}>
          {name}
        </span>
      </button>
      <Presence show={open}>
        <MotionDiv motion={MOTION.pop} origin="top right" className="pop eff-pop" role="dialog" aria-label="생각하는 정도(effort)" onKeyDown={onKey}>
          <h3 className="eff-h">생각하는 정도(effort)</h3>
          <p className="eff-s">높을수록 꼼꼼하지만 느리고 사용량을 더 써요</p>
          {description.state === 'ready' ? (
            unsupported ? (
              <p className="eff-note">{NO_EFFORT}</p>
            ) : (
              <>
                <div
                  ref={slider}
                  className={`eff-track${grab ? ' grab' : ''}`}
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                  role="slider"
                  tabIndex={0}
                  aria-label="생각하는 정도"
                  aria-valuemin={0}
                  aria-valuemax={EFFORT_LEVELS.length - 1}
                  aria-valuenow={index}
                  aria-valuetext={EFFORT_LEVELS[index]}
                >
                  <span className="eff-fill" style={{ width: `${(index / (EFFORT_LEVELS.length - 1)) * 100}%` }} />
                  <span className="eff-knob" style={{ left: `${(index / (EFFORT_LEVELS.length - 1)) * 100}%` }} />
                </div>
                <div className="eff-ticks">
                  {EFFORT_LEVELS.map(l => (
                    <button
                      key={l}
                      type="button"
                      tabIndex={-1}
                      className={`eff-tick${l === EFFORT_LEVELS[index] ? ' on' : ''}`}
                      aria-disabled={allowed(l) ? undefined : true}
                      // 눌러도 초점은 슬라이더에 — 단추로 옮겨 가면 ←/→ 가 더는 움직이지 않는다
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => {
                        choose(l)
                        slider.current?.focus()
                      }}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </>
            )
          ) : description.state === 'error' ? (
            <p className="eff-note">
              모델 정보를 받지 못했어요
              <button type="button" className="lk" onClick={onRetry}>
                다시 받기
              </button>
            </p>
          ) : (
            <p className="eff-note">불러오는 중…</p>
          )}
        </MotionDiv>
      </Presence>
    </span>
  )
}
