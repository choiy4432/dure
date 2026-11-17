// 관계도(궤도++) — 캔버스 2장(잔상 층 + 또렷한 층) 위에 에이전트 노드 카드(DOM 단추 — 누르면 그 에이전트를 고른다).
// 장면 상태는 world.ts, 그리기는 scene.ts · overlay.ts. 여기는 캔버스·카드·rAF 와 사건·상태 연결만 맡는다.
// 프레임마다 setState 하지 않는다 — 카드 자리·크기·불투명도는 style 을 바로 고치고(값이 바뀐 것만 — putCard), 카드 글은 사건이 올 때만 바뀐다.
// 방이 바뀌면(room.n) 장면을 새로 짓지 않고 전환(transition.ts)을 건다 — 옛 카드가 핵으로 빨려 들고 도약한 뒤, 장면이 새 방 노드로
// 바꿔 끼우는 그 순간에만 카드 목록을 바꾼다(React 상태 한 번). 두 방의 카드가 함께 그려지는 순간은 없다.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { reducedMotion } from '../../lib/motion'
import { batched, STATE_TEXT, type AgentState, type PowerAgent, type ScreenEvent } from '../events'
import type { RoomChange } from '../usePowerFeed'
import { createGlow, drawOverlay, sizeGlow } from './overlay'
import { FALLBACK_FONTS } from './palette'
import { drawScene } from './scene'
import { changeRoom, intake, stepWorld } from './step'
import { createWorld, resizeWorld, setNodes, setSatellites, setStates, toolLine, type NodePos, type SubLabel, type Who, type World } from './world'

/** 캔버스 해상도 상한(배) */
const MAX_RES = 2.5
/** 캔버스 한 장의 픽셀 상한 — 큰 칸 · 높은 배율(4K 150% 등)이면 해상도를 여기에 맞춰 낮춘다(칸의 CSS 크기 아래로는 안 내린다) */
export const MAX_PIXELS = 2_200_000
/** 이만큼부터는 궤도 카드를 작은 판으로(핵 카드는 그대로) — 카드가 겹쳐 쌓이지 않게 */
const CROWD_AT = 8

type Props = {
  /** 그리는 방이 바뀐 일(전환 신호 — useRoomChange) — 바뀌면 옛 방 노드를 빨아들이고 새 방 에이전트로 펼친다. 없으면 방이 바뀌지 않는 것 */
  room?: RoomChange
  /** 그리는 방 이름 — 방을 옮길 때 알림 `<이름> 방으로`(없으면 알림도 없다) */
  roomName?: string | null
  agents: PowerAgent[]
  state: Record<string, AgentState>
  /** 지금 도는 진짜 서브에이전트 — 없으면 위성도 없다 */
  subagents: SubLabel[]
  subscribe: (fn: (ev: ScreenEvent) => void) => () => void
  /** 스토어가 고른 에이전트 — 그 노드에 고른 표시 */
  selected?: string | null
  /** 노드를 눌렀다(전환 중엔 카드를 누를 수 없다) */
  onPick?: (id: string) => void
  /** 그릴 에이전트가 없어졌다(빈 방으로 옮겨 전환이 끝났다) — 관제실이 관계도 자리에 빈 방 글을 띄운다 */
  onEmpty?: () => void
}

const whoOf = (agents: PowerAgent[]): Who[] => agents.map(a => ({ id: a.id, name: a.name, color: a.color }))

/** 카드에 마지막으로 쓴 값(요소마다 — 새 요소는 새로) */
type CardLook = { transform: string; filter: string; zIndex: string; opacity: string; disabled: boolean | null }
const looks = new WeakMap<HTMLElement, CardLook>()
function lookOf(el: HTMLElement): CardLook {
  let l = looks.get(el)
  if (!l) looks.set(el, (l = { transform: '', filter: '', zIndex: '', opacity: '', disabled: null }))
  return l
}

/**
 * 카드 하나를 장면 자리에 — 끝까지 펼쳐졌으면 불투명도는 비운다(평소 그대로).
 * 값이 바뀐 것만 쓴다 — style 을 쓰면 값이 같아도 스타일을 다시 계산하고, filter 가 바뀌면 카드를 다시 그린다.
 * 밝기는 소수 둘째 자리로 묶는다(0.005 차이는 눈에 안 보이고, 궤도를 도는 카드의 filter 가 프레임마다 바뀌지 않는다)
 */
export function putCard(el: HTMLElement, p: NodePos): void {
  const l = lookOf(el)
  const transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) scale(${p.s})`
  if (transform !== l.transform) el.style.transform = l.transform = transform
  const filter = `brightness(${Math.round(p.o * 100) / 100})`
  if (filter !== l.filter) el.style.filter = l.filter = filter
  const zIndex = String(Math.round(p.z * 100) + 10)
  if (zIndex !== l.zIndex) el.style.zIndex = l.zIndex = zIndex
  const opacity = p.a >= 1 ? '' : String(p.a)
  if (opacity !== l.opacity) el.style.opacity = l.opacity = opacity
}

/** 카드를 누를 수 있게·없게 — 바뀔 때만 쓴다 */
export function setCardDisabled(el: HTMLButtonElement, v: boolean): void {
  const l = lookOf(el)
  if (l.disabled !== v) el.disabled = l.disabled = v
}

export function OrbitMap({ room, roomName = null, agents, state, subagents, subscribe, selected = null, onPick, onEmpty }: Props) {
  const scene = room?.n ?? 0
  // 빈 방에서 옮겨 와 처음 붙었다(방이 바뀐 뒤에 그려지기 시작했다) — 노드는 핵에서 펼쳐진다
  const [enter] = useState(() => scene > 0)
  const boxRef = useRef<HTMLDivElement>(null)
  const trailRef = useRef<HTMLCanvasElement>(null)
  const crispRef = useRef<HTMLCanvasElement>(null)
  const nodes = useRef(new Map<string, HTMLButtonElement>())
  const worldRef = useRef<World | null>(null)
  const subRef = useRef(subagents)
  subRef.current = subagents
  const stateRef = useRef(state)
  stateRef.current = state
  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const live = useRef({ agents, room, roomName, onEmpty })
  live.current = { agents, room, roomName, onEmpty }
  /** 장면 노드가 지어진 에이전트 목록(같은 방 안에서 목록이 바뀐 것을 안다) */
  const built = useRef<PowerAgent[]>(enter ? [] : agents)
  /** 전환 중 — 카드를 누를 수 없다 */
  const busy = useRef(false)
  /** 캔버스를 얻었다(전환을 그릴 수 있다) — 못 얻으면 전환 없이 바로 새 방 카드 */
  const anim = useRef(true)
  const [lines, setLines] = useState<Record<string, string>>({})

  // 화면의 카드 — 장면이 바꿔 끼운 방(shown). 방이 바뀐 뒤 바꿔 끼우기 전엔 옛 방 카드를 그 방의 마지막 모습(목록·상태)으로 남긴다
  const [shown, setShown] = useState(enter ? -1 : scene)
  const current = !anim.current || shown === scene
  const frozen = useRef({ agents: enter ? [] : agents, state })
  if (current) frozen.current = { agents, state }
  const cards = frozen.current

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

  // 장면 — 붙어 있는 동안 하나(방이 바뀌어도 새로 짓지 않는다 — 아래 효과가 전환을 건다)
  useEffect(() => {
    const box = boxRef.current
    const trail = trailRef.current
    const crisp = crispRef.current
    if (!box || !trail || !crisp) return
    const tx = trail.getContext('2d')
    const cx = crisp.getContext('2d')
    if (!tx || !cx) {
      // 캔버스를 못 얻으면 그리지 않는다(카드만 남는다) — 방이 바뀌면 전환 없이 바로 새 방 카드
      anim.current = false
      setShown(sceneRef.current)
      return
    }

    const calm = !!box.closest('[data-calm]') || reducedMotion()
    const css = getComputedStyle(box)
    const L = live.current
    const w = createWorld({
      agents: enter ? [] : whoOf(L.agents),
      W: box.offsetWidth,
      H: box.offsetHeight,
      calm,
      satellites: enter ? [] : subRef.current,
      states: stateRef.current,
      fonts: { mono: css.getPropertyValue('--mono').trim() || FALLBACK_FONTS.mono, ui: css.getPropertyValue('--font').trim() || FALLBACK_FONTS.ui },
      tag: enter ? -1 : sceneRef.current,
    })
    worldRef.current = w
    // 빈 방에서 옮겨 왔다 — 빨려 들 것 없이 핵에서 펼친다
    if (enter) {
      built.current = L.agents
      changeRoom(w, { agents: whoOf(L.agents), satellites: subRef.current, states: stateRef.current, tag: sceneRef.current, toRoom: L.room?.next ?? null, name: L.roomName })
    }

    // 번짐 판 — 한 번 만들고 판 크기가 바뀔 때만 다시 잰다(프레임마다 만들지 않는다)
    const glow = createGlow(trail)
    let res = 1
    /** 혜성 머리 빛(shadowBlur — setTransform 을 안 따른다) 배율 — 픽셀 상한으로 해상도를 낮춘 몫만큼 줄여 화면 크기를 그대로 */
    let sk = 1
    // 칸의 배치 크기 × 화면 배율 — 판은 창 크기 그대로라(늘리고 줄이지 않는다) 배율은 devicePixelRatio 뿐.
    // 한 장이 MAX_PIXELS 를 넘으면 해상도를 √(MAX_PIXELS / 칸 넓이) 로 낮춘다 — 1 아래(칸의 CSS 크기보다 작은 판)로는 안 내린다(글이 흐려진다)
    const measure = () => {
      const W = box.offsetWidth
      const H = box.offsetHeight
      const base = Math.min(MAX_RES, window.devicePixelRatio || 1)
      res = Math.min(base, Math.max(1, Math.sqrt(MAX_PIXELS / (W * H))))
      sk = res / base
      const bw = Math.round(W * res)
      const bh = Math.round(H * res)
      for (const c of [trail, crisp])
        if (c.width !== bw || c.height !== bh) {
          c.width = bw
          c.height = bh
        }
      if (glow) sizeGlow(glow, bw, bh, res)
      resizeWorld(w, W, H)
    }
    const placeCards = () => {
      for (const [id, el] of nodes.current) {
        const p = w.pos.get(id)
        if (p) putCard(el, p)
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
    let emptied = false
    let tag = w.tag
    const frame = (now: number) => {
      raf = 0
      if (document.visibilityState !== 'visible') return // 숨으면 쉰다 — visibilitychange 가 다시 깨운다
      stepWorld(w, now)
      if (w.W && w.H) {
        drawScene(tx, w, res)
        drawOverlay(cx, w, glow, res, sk)
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
      // 전환이 시작·끝날 때만 — 카드 누르기를 막고 푼다
      const b = w.tr.phase !== 'idle'
      if (b !== busy.current) {
        busy.current = b
        for (const el of nodes.current.values()) setCardDisabled(el, b)
      }
      // 장면이 새 방 노드로 바꿔 끼웠다 — 카드 목록도 그 방 것으로(전환마다 한 번)
      if (w.tag !== tag) {
        tag = w.tag
        setShown(tag)
      }
      // 빈 방으로 옮겨 전환이 끝났다 — 한 번만 알린다
      const empty = !b && w.who.size === 0
      if (empty && !emptied) live.current.onEmpty?.()
      emptied = empty
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
  }, [subscribe, enter])

  // 방이 바뀌었다 — 전환을 건다(바꿔 끼우기 전에 또 바뀌면 이어 간다). 같은 방 안에서 목록이 줄었으면(굳힌 뒤 지워진 에이전트) 바로 다시 짓는다
  useEffect(() => {
    const w = worldRef.current
    if (!w) {
      if (!anim.current && !agents.length) live.current.onEmpty?.()
      return
    }
    if (agents === built.current && scene === (w.next?.tag ?? w.tag)) return
    built.current = agents
    if (scene !== w.tag || w.next) {
      changeRoom(w, { agents: whoOf(agents), satellites: subRef.current, states: stateRef.current, tag: scene, toRoom: room?.next ?? null, name: roomName })
      // 다음 프레임을 기다리지 않는다 — 방이 바뀐 이 순간부터 옛 방 카드는 누를 수 없다(프레임 루프가 끝나면 푼다)
      if (w.tr.phase !== 'idle') {
        busy.current = true
        for (const el of nodes.current.values()) setCardDisabled(el, true)
      }
      return
    }
    setNodes(w, whoOf(agents))
    setSatellites(w, subRef.current)
    setStates(w, stateRef.current)
  }, [scene, agents]) // eslint-disable-line react-hooks/exhaustive-deps

  // 위성·상태 — 바꿔 끼우기 전이면 새 방 몫으로 쥐어 둔다(옛 방 노드에 새 방 것이 섞이지 않게)
  useEffect(() => {
    const w = worldRef.current
    if (!w) return
    if (w.next) w.next.satellites = subagents
    else if (sceneRef.current === w.tag) setSatellites(w, subagents)
  }, [subagents])

  useEffect(() => {
    const w = worldRef.current
    if (!w) return
    if (w.next) w.next.states = state
    else if (sceneRef.current === w.tag) setStates(w, state)
  }, [state])

  // 새로 붙은 카드(바꿔 끼운 새 방 카드)는 그려지기 전에 장면 자리로 — 핵에서 scale 0 으로 시작한다
  useLayoutEffect(() => {
    const w = worldRef.current
    if (!w) return
    for (const [id, el] of nodes.current) {
      const p = w.pos.get(id)
      if (p) putCard(el, p)
      setCardDisabled(el, busy.current)
    }
  }, [shown])

  return (
    <div ref={boxRef} className="pw-mapbox">
      <canvas ref={trailRef} aria-hidden="true" />
      <canvas ref={crispRef} aria-hidden="true" />
      <div className="pw-mapov" data-crowd={cards.agents.length >= CROWD_AT || undefined}>
        {cards.agents.map((a, i) => {
          const st = cards.state[a.id] ?? 'resting'
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
