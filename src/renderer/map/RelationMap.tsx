import '@xyflow/react/dist/base.css'
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type RefObject,
} from 'react'
import {
  Background, BackgroundVariant, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow,
  type EdgeTypes, type NodeChange, type NodeTypes,
} from '@xyflow/react'
import { ArrowLeftRight, ArrowRight } from 'lucide-react'
import type { AgentId, RoomId } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { edges as edgeViews, pairMessages, type EdgeView } from '../state/selectors'
import { ago, MESSAGE_WORD } from '../lib/words'
import { useNow } from '../lib/useNow'
import { MotionDiv, Presence, useLeaving } from '../lib/presence'
import { MOTION, moveMs } from '../lib/motion'
import { AgentNode, type AgentFlowNode } from './AgentNode'
import { HandoffEdge, MARKER_TONES, markerId, type HandoffFlowEdge } from './HandoffEdge'
import { SummaryChips } from './SummaryChips'
import { OffscreenPill } from './OffscreenPill'
import { FIT_OPTIONS, ZoomControls } from './ZoomControls'
import { fitPolicy, type FitReason, type FitState } from './fitPolicy'
import { AUTO_FIT_MIN, arrange, columnsFor, isUnplaced, placeMissing, type Point } from './layout'

/** 처음 그릴 때와 자동 맞춤 — 모두 보기와 같되 너무 작아지지 않게 하한을 둔다 */
const AUTO_FIT = { ...FIT_OPTIONS, minZoom: AUTO_FIT_MIN }
/** 마지막 크기 변화 뒤 이만큼 가만하면 맞춘다(창·경계선 끌기 중에는 기다린다) */
const RESIZE_SETTLE_MS = 150

const nodeTypes: NodeTypes = { agent: AgentNode }
const edgeTypes: EdgeTypes = { handoff: HandoffEdge }

/** 같은 두 카드를 반대로 잇는 선이 비키는 거리 */
const PAIR_SHIFT = 12
/**
 * 누르는 동안 이만큼(px)까지 손이 흔들려도 클릭이고, 끌기는 이보다 더 움직여야 시작한다.
 * React Flow 기본은 클릭 0px·끌기 1px 이라, 1px 만 흔들려도 클릭이 버려져 카드를 두 번 눌러야 열렸다(그 흔들림으로 자리도 저장됐다).
 */
const CLICK_SLOP_PX = 5

const ARIA = {
  'node.a11yDescription.default': 'Enter 나 스페이스를 누르면 오른쪽 패널에 열려요. 끌어서 자리를 옮길 수 있어요.',
  'node.a11yDescription.keyboardDisabled': 'Enter 나 스페이스를 누르면 오른쪽 패널에 열려요.',
  'node.a11yDescription.ariaLiveMessage': () => '카드를 옮겼어요',
  'edge.a11yDescription.default': '',
  'handle.ariaLabel': '연결점',
}

/** 관계도 — 그 방의 에이전트 카드와 넘김 엣지. 방을 바꾸면 처음부터 다시 그린다(화면 맞춤 포함) */
export function RelationMap() {
  const roomId = useDure(s => s.roomId)
  if (!roomId) return null
  return (
    <ReactFlowProvider key={roomId}>
      <MapCanvas roomId={roomId} />
    </ReactFlowProvider>
  )
}

interface Seat {
  id: AgentId
  name: string
  role: string
  pos: Point
}
const seatsEqual = (a: Seat[], b: Seat[]) =>
  a.length === b.length &&
  a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.role === b[i].role && x.pos.x === b[i].pos.x && x.pos.y === b[i].pos.y)

const edgesEqual = (a: EdgeView[], b: EdgeView[]) =>
  a.length === b.length &&
  a.every((x, i) => x.id === b[i].id && x.state === b[i].state && x.at === b[i].at && x.count === b[i].count)

interface PairAt {
  a: AgentId
  b: AgentId
  x: number
  y: number
}

function MapCanvas({ roomId }: { roomId: RoomId }) {
  const seats = useDure(
    s => s.agents.filter(a => a.roomId === roomId).map(a => ({ id: a.id, name: a.name, role: a.role, pos: a.pos })),
    seatsEqual,
  )
  const views = useDure(s => edgeViews(roomId, s.agents, s.messages), edgesEqual)
  // 에이전트가 만든 새 에이전트 → 만든 쪽(agent-added) — 자리 없는 새 에이전트를 그 가까이 놓는다
  const placeNear = useDure(s => s.placeNear)
  const wrap = useRef<HTMLDivElement>(null)
  // 화면에서 정한 자리 — 엔진에 저장되어 스토어로 돌아오기 전까지 이 값을 쓴다
  const placed = useRef(new Map<AgentId, Point>()) // 처음 그릴 때 정해 준 자리({0,0} 이던 에이전트)
  const moved = useRef(new Map<AgentId, Point>()) // 끌어서 옮긴 자리
  const saving = useRef(new Set<AgentId>())

  // 자리 없는({0,0}) 에이전트는 겹치지 않는 칸을 정해 둔다(한 번만 — 저장은 아래 effect 에서).
  // 에이전트가 만든 새 에이전트는 만든 카드 가까운 빈 칸, 그 밖은 첫 빈 칸
  if (seats.some(a => isUnplaced(a.pos) && !placed.current.has(a.id))) {
    const known = seats.map(a => ({
      id: a.id,
      pos: moved.current.get(a.id) ?? placed.current.get(a.id) ?? a.pos,
      by: placeNear[a.id],
    }))
    for (const [id, p] of placeMissing(known)) placed.current.set(id, p)
  }
  const posOf = (a: Seat): Point =>
    moved.current.get(a.id) ?? (isUnplaced(a.pos) ? placed.current.get(a.id) : undefined) ?? a.pos

  const build = (prev: AgentFlowNode[]): AgentFlowNode[] => {
    const byId = new Map(prev.map(n => [n.id, n]))
    return seats.map(a => {
      const position = posOf(a)
      const ariaLabel = a.role ? `${a.name} · ${a.role}` : a.name
      const old = byId.get(a.id)
      if (old && old.ariaLabel === ariaLabel && (old.dragging || (old.position.x === position.x && old.position.y === position.y))) return old
      return { ...(old ?? { id: a.id, type: 'agent' as const, data: {} }), position, ariaLabel }
    })
  }
  const [nodes, setNodes] = useState<AgentFlowNode[]>(() => build([]))
  // build 는 seats 와 ref 만 읽는다 — 바뀐 카드가 없으면 배열도 그대로(다시 그리지 않게)
  useEffect(() => {
    setNodes(prev => {
      const next = build(prev)
      return next.length === prev.length && next.every((n, i) => n === prev[i]) ? prev : next
    })
  }, [seats])

  // 정해 준 자리를 엔진에 저장 — 끝나면 스냅샷을 다시 받아 스토어 자리가 따라오게
  useEffect(() => {
    const todo = seats.filter(a => isUnplaced(a.pos) && placed.current.has(a.id) && !saving.current.has(a.id))
    if (todo.length === 0) return
    for (const a of todo) saving.current.add(a.id)
    void Promise.allSettled(todo.map(a => window.dure.updateAgent(a.id, { pos: placed.current.get(a.id)! })))
      .then(() => getStore().refresh())
      .catch(() => {}) // 못 받으면 이번 실행에선 정해 둔 자리 그대로 보인다
      .finally(() => todo.forEach(a => saving.current.delete(a.id)))
  }, [seats])

  const onNodesChange = useCallback((changes: NodeChange<AgentFlowNode>[]) => {
    setNodes(nds => applyNodeChanges(changes, nds))
  }, [])

  const onNodeDragStop = useCallback((_e: unknown, node: AgentFlowNode) => {
    const p = { x: Math.round(node.position.x), y: Math.round(node.position.y) }
    if (isUnplaced(p)) p.x = 1 // {0,0} 은 '자리 없음' 뜻이라 피한다
    moved.current.set(node.id, p)
    void window.dure
      .updateAgent(node.id, { pos: p })
      .then(() => getStore().refresh())
      .catch(() => {})
      .finally(() => {
        if (moved.current.get(node.id) === p) moved.current.delete(node.id)
      })
  }, [])

  const flow = useReactFlow()
  // 자동 맞춤 상태 — 사건마다 fitPolicy 가 다음 상태와 맞출지를 정한다
  const fitState = useRef<FitState>({ userMoved: false })
  const fitOn = useCallback((reason: FitReason) => {
    const r = fitPolicy(fitState.current, reason)
    fitState.current = r.state
    if (r.fit) void flow.fitView({ ...AUTO_FIT, duration: moveMs(260) })
  }, [flow])

  // 카드 수가 바뀌면 다시 맞춘다(처음 그릴 때는 fitView prop 이 맞춘다)
  const count = seats.length
  const lastCount = useRef(count)
  useEffect(() => {
    if (lastCount.current === count) return
    lastCount.current = count
    fitOn('count')
  }, [count, fitOn])

  // 관계도 크기가 바뀌면(창·경계선 끌기) 잠잠해진 뒤 한 번 — 직접 옮긴 화면이면 건드리지 않는다
  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let last = `${el.clientWidth}x${el.clientHeight}`
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      const now = `${el.clientWidth}x${el.clientHeight}`
      if (now === last) return // 관찰을 시작할 때 오는 첫 알림 등 — 크기가 그대로면 무시
      last = now
      clearTimeout(timer)
      timer = setTimeout(() => fitOn('resize'), RESIZE_SETTLE_MS)
    })
    ro.observe(el)
    return () => { ro.disconnect(); clearTimeout(timer) }
  }, [fitOn])
  // 자리 정리 — 보이는 자리의 읽는 순서대로 격자에 다시 놓는다. 열 수는 지금 너비에 3열이 들어오는지로.
  // 저장은 끌기 저장과 같다: moved 에 먼저 두어 스토어가 따라오기 전에도 새 자리로 보이게
  const arrangeAll = useCallback(async () => {
    const cols = columnsFor(wrap.current?.clientWidth ?? 0)
    const out = arrange(seats.map(a => ({ id: a.id, pos: posOf(a) })), cols)
    const todo = seats.filter(a => {
      const p = out.get(a.id)!
      const now = posOf(a)
      return p.x !== now.x || p.y !== now.y
    })
    for (const a of todo) moved.current.set(a.id, out.get(a.id)!)
    setNodes(prev => build(prev))
    await Promise.allSettled(todo.map(a => window.dure.updateAgent(a.id, { pos: out.get(a.id)! })))
    try { await getStore().refresh() } catch { /* 못 받으면 이번 실행에선 놓은 자리 그대로 보인다 */ }
    for (const a of todo) if (moved.current.get(a.id) === out.get(a.id)) moved.current.delete(a.id)
    // 정리는 '보기 좋게 다시 놓아 달라' 는 요청이라 화면도 따라간다 — 직접 옮겼던 것은 잊고 자동 맞춤으로 돌아간다
    fitState.current = fitPolicy(fitState.current, 'count').state
    void flow.fitView({ ...AUTO_FIT, duration: moveMs(260) })
  }, [seats, flow]) // eslint-disable-line react-hooks/exhaustive-deps -- posOf·build 는 seats 와 ref 만 읽는다

  const [pair, setPair] = useState<PairAt | null>(null)
  const openPair = useCallback((a: AgentId, b: AgentId, e: MouseEvent) => {
    const r = wrap.current?.getBoundingClientRect()
    let x = e.clientX
    let y = e.clientY
    if (e.detail === 0) {
      // 키보드로 누른 라벨 — 누른 자리가 없으니 라벨 아래에
      const label = (e.currentTarget as Element).getBoundingClientRect()
      x = label.left + label.width / 2
      y = label.bottom
    }
    setPair({ a, b, x: x - (r?.left ?? 0), y: y - (r?.top ?? 0) })
  }, [])
  const closePair = useCallback(() => setPair(null), [])

  // Esc 로 고르기 풀기 — 메시지 창이 열려 있으면 그 창의 Esc 가 먼저(닫기만), 패널·입력창에 초점이 있으면 그쪽 Esc 라 건드리지 않는다
  const pairOpen = useRef(false)
  pairOpen.current = pair !== null
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || pairOpen.current) return
      const at = document.activeElement
      if (at !== document.body && at !== null && !wrap.current?.contains(at)) return
      getStore().selectAgent(null)
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [])

  const flowEdges = useMemo<HandoffFlowEdge[]>(() => {
    const ids = new Set(views.map(v => v.id))
    return views.map(v => ({
      id: v.id,
      source: v.from,
      target: v.to,
      type: 'handoff',
      data: {
        state: v.state,
        at: v.at,
        count: v.count,
        shift: ids.has(`${v.to}>${v.from}`) ? (v.from < v.to ? -PAIR_SHIFT : PAIR_SHIFT) : 0,
        onOpen: openPair,
      },
    }))
  }, [views, openPair])

  // 키보드로 카드를 고르기 — 카드(노드)에 포커스가 있을 때 Enter·스페이스
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const el = e.target as HTMLElement
    if (!el.classList?.contains('react-flow__node')) return
    const id = el.getAttribute('data-id')
    if (!id) return
    e.preventDefault()
    getStore().selectAgent(id)
  }

  return (
    <div className="rm" ref={wrap} onKeyDown={onKeyDown}>
      <svg className="mk-defs" aria-hidden="true" focusable="false">
        <defs>
          {MARKER_TONES.map(tone => (
            <marker
              key={tone}
              id={markerId(tone)}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="10"
              markerHeight="10"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M1.5 1.5 9 5 1.5 8.5z" className={`mk ${tone}`} />
            </marker>
          ))}
        </defs>
      </svg>
      <ReactFlow<AgentFlowNode, HandoffFlowEdge>
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_e, node) => getStore().selectAgent(node.id)}
        nodeClickDistance={CLICK_SLOP_PX}
        nodeDragThreshold={CLICK_SLOP_PX}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={(e, edge) => openPair(edge.source, edge.target, e)}
        onMoveStart={(e) => {
          closePair()
          // event 가 있을 때만 사용자가 움직인 것 — fitView 같은 코드 움직임은 null
          if (e) fitOn('user-move')
        }}
        onPaneClick={() => getStore().selectAgent(null)}
        fitView
        fitViewOptions={AUTO_FIT}
        minZoom={0.25}
        maxZoom={2}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        ariaLabelConfig={ARIA}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={3} color="var(--dot)" bgColor="var(--canvas)" />
      </ReactFlow>
      <SummaryChips roomId={roomId} />
      <OffscreenPill roomId={roomId} nodes={nodes} wrap={wrap} />
      <ZoomControls onArrange={() => void arrangeAll()} onFitAll={() => fitOn('fit-all')} />
      {/* 다른 떠 있는 목록처럼 — 닫으면(pair = null) 마지막 모습으로 남아 가라앉는다 */}
      <Presence show={pair !== null}>
        {pair && <PairPopover key={`${pair.a}>${pair.b}`} at={pair} bounds={wrap} onClose={closePair} />}
      </Presence>
    </div>
  )
}

const POP_W = 320
const POP_MARGIN = 12

/**
 * 엣지를 누르면 뜨는 작은 창 — 두 에이전트 사이에 오간 메시지(양방향, 최신 먼저). 바깥 누르기·Esc 로 닫힌다.
 * 떠 있는 목록처럼 떠오르고 가라앉는다(MOTION.pop, 기준점 = 누른 자리 쪽 왼쪽 위 — 창은 left·top 으로 놓인다).
 */
export function PairPopover({ at, bounds, onClose }: { at: PairAt; bounds: RefObject<HTMLDivElement | null>; onClose: () => void }) {
  const list = useDure(s => pairMessages(at.a, at.b, s.messages))
  const names = useDure(s => Object.fromEntries(s.agents.filter(x => x.id === at.a || x.id === at.b).map(x => [x.id, x.name])) as Record<AgentId, string>,
    (p, q) => p[at.a] === q[at.a] && p[at.b] === q[at.b])
  const now = useNow()
  const ref = useRef<HTMLDivElement>(null)
  // 닫혀서 가라앉는 중 — 키·누르기를 더 듣지 않는다(Esc 가 초점을 라벨로 다시 끌어오거나, 새로 연 창을 닫지 않게)
  const leaving = useLeaving()
  const [pos, setPos] = useState({ left: at.x + POP_MARGIN, top: at.y + POP_MARGIN })
  const name = (id: AgentId) => names[id] ?? '지워진 에이전트'

  // 창이 관계도 밖으로 나가지 않게 — 그린 뒤 크기를 재서 안으로 들인다
  useLayoutEffect(() => {
    const box = bounds.current?.getBoundingClientRect()
    const el = ref.current
    if (!box || !el) return
    const w = el.offsetWidth || POP_W
    const h = el.offsetHeight
    let left = Math.max(POP_MARGIN, at.x + POP_MARGIN)
    let top = Math.max(POP_MARGIN, at.y + POP_MARGIN)
    if (left + w > box.width - POP_MARGIN) left = Math.max(POP_MARGIN, at.x - POP_MARGIN - w)
    if (top + h > box.height - POP_MARGIN) top = Math.max(POP_MARGIN, box.height - POP_MARGIN - h)
    setPos({ left, top })
  }, [at, bounds, list.length])

  useEffect(() => {
    if (leaving) return
    // 열리면 창으로 포커스, Esc 로 닫으면 연 자리(라벨)로 돌려준다
    const opener = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      onClose()
      opener?.focus?.()
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key)
    }
  }, [onClose, leaving])

  return (
    <MotionDiv
      motion={MOTION.pop}
      origin="top left"
      ref={ref}
      className="pm"
      role="dialog"
      aria-label={`${name(at.a)} · ${name(at.b)} 사이에 오간 메시지`}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="pm-hd">
        <b className="trunc">{name(at.a)}</b>
        <ArrowLeftRight className="i pm-ic" size={14} aria-hidden="true" />
        <b className="trunc">{name(at.b)}</b>
        <span className="pm-n">메시지 {list.length}개</span>
      </div>
      {list.length === 0 ? (
        <p className="pm-empty">오간 메시지가 없어요</p>
      ) : (
        <ul className="pm-list">
          {list.map(m => (
            <li key={m.id} className={m.state === 'dismissed' ? 'pm-row off' : 'pm-row'}>
              <div className="pm-h">
                <b className="trunc">{name(m.from)}</b>
                <ArrowRight className="i pm-ic" size={12} aria-hidden="true" />
                <b className="trunc">{name(m.to)}</b>
                <span className="pm-m">
                  · {MESSAGE_WORD[m.state]} · {ago(m.createdAt, now)}
                </span>
              </div>
              <p className="pm-t">{m.text}</p>
            </li>
          ))}
        </ul>
      )}
    </MotionDiv>
  )
}
