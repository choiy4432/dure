// 관계도(궤도++) — 캔버스 2장(잔상 층 + 또렷한 층) 위에 에이전트 노드 카드(DOM 단추 — 누르면 그 에이전트를 고른다).
// 장면 상태는 world.ts, 그리기는 scene.ts · overlay.ts. 여기는 캔버스·카드·rAF 와 사건·상태 연결만 맡는다.
// 프레임마다 setState 하지 않는다 — 카드 자리는 style 을 바로 고치고, 카드 글은 사건이 올 때만 바뀐다.
import { useEffect, useRef, useState } from 'react'
import { reducedMotion } from '../../lib/motion'
import { batched, STATE_TEXT, type AgentState, type PowerAgent, type ScreenEvent } from '../events'
import { drawOverlay } from './overlay'
import { FALLBACK_FONTS } from './palette'
import { drawScene } from './scene'
import { intake, stepWorld } from './step'
import { createWorld, resizeWorld, setSatellites, setStates, toolLine, type SubLabel, type World } from './world'

/** 캔버스 해상도 상한(배) */
const MAX_RES = 2.5
/** 이만큼부터는 궤도 카드를 작은 판으로(핵 카드는 그대로) — 카드가 겹쳐 쌓이지 않게 */
const CROWD_AT = 8

type Props = {
  agents: PowerAgent[]
  state: Record<string, AgentState>
  /** 지금 도는 진짜 서브에이전트 — 없으면 위성도 없다 */
  subagents: SubLabel[]
  subscribe: (fn: (ev: ScreenEvent) => void) => () => void
  /** 스토어가 고른 에이전트 — 그 노드에 고른 표시 */
  selected?: string | null
  /** 노드를 눌렀다 */
  onPick?: (id: string) => void
}

export function OrbitMap({ agents, state, subagents, subscribe, selected = null, onPick }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const trailRef = useRef<HTMLCanvasElement>(null)
  const crispRef = useRef<HTMLCanvasElement>(null)
  const nodes = useRef(new Map<string, HTMLButtonElement>())
  const worldRef = useRef<World | null>(null)
  const subRef = useRef(subagents)
  subRef.current = subagents
  const stateRef = useRef(state)
  stateRef.current = state
  const [lines, setLines] = useState<Record<string, string>>({})

  // 카드 상태 줄 — 그 에이전트의 마지막 진짜 도구(모아서 한 번에 그린다)
  useEffect(
    () =>
      batched(subscribe, evs => {
        const next: Record<string, string> = {}
        for (const ev of evs) if (ev.kind === 'tool') next[ev.agentId] = toolLine(ev.tool, ev.target)
        if (Object.keys(next).length) setLines(prev => ({ ...prev, ...next }))
      }),
    [subscribe],
  )

  useEffect(() => {
    const w = worldRef.current
    if (w) setSatellites(w, subagents)
  }, [subagents])

  useEffect(() => {
    const w = worldRef.current
    if (w) setStates(w, state)
  }, [state])

  useEffect(() => {
    const box = boxRef.current
    const trail = trailRef.current
    const crisp = crispRef.current
    if (!box || !trail || !crisp) return
    const tx = trail.getContext('2d')
    const cx = crisp.getContext('2d')
    if (!tx || !cx) return // 캔버스를 못 얻으면 그리지 않는다(카드만 남는다)

    const calm = !!box.closest('[data-calm]') || reducedMotion()
    const css = getComputedStyle(box)
    const w = createWorld({
      agents: agents.map(a => ({ id: a.id, name: a.name, color: a.color })),
      W: box.offsetWidth,
      H: box.offsetHeight,
      calm,
      satellites: subRef.current,
      states: stateRef.current,
      fonts: { mono: css.getPropertyValue('--mono').trim() || FALLBACK_FONTS.mono, ui: css.getPropertyValue('--font').trim() || FALLBACK_FONTS.ui },
    })
    worldRef.current = w

    let res = 1
    // 칸의 배치 크기 × 화면 배율 — 판은 창 크기 그대로라(늘리고 줄이지 않는다) 배율은 devicePixelRatio 뿐
    const measure = () => {
      res = Math.min(MAX_RES, window.devicePixelRatio || 1)
      const W = box.offsetWidth
      const H = box.offsetHeight
      const bw = Math.round(W * res)
      const bh = Math.round(H * res)
      for (const c of [trail, crisp])
        if (c.width !== bw || c.height !== bh) {
          c.width = bw
          c.height = bh
        }
      resizeWorld(w, W, H)
    }
    const placeCards = () => {
      for (const [id, el] of nodes.current) {
        const p = w.pos.get(id)
        if (!p) continue
        el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) scale(${p.s})`
        el.style.filter = `brightness(${p.o})`
        el.style.zIndex = String(Math.round(p.z * 100) + 10)
      }
    }
    measure()
    placeCards()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    // 화면 배율이 바뀌면(다른 모니터로) 창 크기 사건이 온다
    window.addEventListener('resize', measure)
    const off = subscribe(ev => intake(w, ev))

    let raf = 0
    const frame = (now: number) => {
      raf = 0
      if (document.visibilityState !== 'visible') return // 숨으면 쉰다 — visibilitychange 가 다시 깨운다
      stepWorld(w, now)
      if (w.W && w.H) {
        drawScene(tx, w, res)
        drawOverlay(cx, w, trail, res)
        placeCards()
      }
      if (w.hits.length) {
        if (!calm)
          for (const id of w.hits) {
            const el = nodes.current.get(id)
            if (!el) continue
            el.classList.remove('pw-hit')
            void el.offsetWidth // 같은 움직임을 처음부터 다시
            el.classList.add('pw-hit')
          }
        w.hits.length = 0
      }
      raf = requestAnimationFrame(frame)
    }
    const wake = () => {
      if (document.visibilityState === 'visible' && !raf) raf = requestAnimationFrame(frame)
    }
    document.addEventListener('visibilitychange', wake)
    raf = requestAnimationFrame(frame)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('resize', measure)
      ro.disconnect()
      off()
      worldRef.current = null
    }
  }, [agents, subscribe])

  return (
    <div ref={boxRef} className="pw-mapbox">
      <canvas ref={trailRef} aria-hidden="true" />
      <canvas ref={crispRef} aria-hidden="true" />
      <div className="pw-mapov" data-crowd={agents.length >= CROWD_AT || undefined}>
        {agents.map((a, i) => {
          const st = state[a.id] ?? 'resting'
          const wait = st === 'awaiting'
          return (
            <button
              key={a.id}
              ref={el => {
                if (el) nodes.current.set(a.id, el)
                else nodes.current.delete(a.id)
              }}
              type="button"
              className="pw-mn"
              data-node={a.id}
              data-core={i === 0 || undefined}
              data-warn={wait || undefined}
              aria-pressed={selected === a.id}
              style={{ ['--c' as string]: a.color }}
              onClick={() => onPick?.(a.id)}
            >
              <span className="pw-av" aria-hidden="true">{a.name.slice(0, 1)}</span>
              <span className="pw-mn-tx">
                <b>{a.name}</b>
                {/* 마지막 진짜 도구, 아직 없으면 진짜 상태 — 기다리는 동안은 늘 '승인 기다림' */}
                <i>{wait ? STATE_TEXT.awaiting : (lines[a.id] ?? STATE_TEXT[st])}</i>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
