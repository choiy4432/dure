// 터미널 벽 — 왼쪽 창 격자(창 하나 = 에이전트 한 명, 최대 6) · 오른쪽 옆 칸(관제실과 같은 대화 | 기록) · 아래 상태 줄([두레] · 방 단추 · 창 이름).
// 창에 흐르는 줄은 전부 진짜 사건에서(그 방을 처음 볼 때는 스토어에 이미 불러와 있는 기록에서). 지어낸 창·줄·숫자는 없다.
// 창 줄·기록·숫자는 방마다 따로(roomMemory) — 방을 옮기면 그 방 창으로 바뀌고, 돌아오면 남겨 둔 줄이 그대로 보인다.
// 방을 옮길 때 창 격자는 두 걸음: 옛 창이 위에서 아래로 지워지듯 꺼지고(0.35초) 새 방 창 격자가 켜진다(0.35초, 제목 줄 먼저).
// 움직임 줄이기면 새 창이 바로 0.2초 흐려졌다 나타난다. 클래스는 걸음이 바뀔 때만 바꾼다(줄마다 JS 없음 — power.css).
// 줄은 DOM 에 바로 붙인다(사건마다 React 상태를 바꾸지 않는다) — 글자는 textContent 로만.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { reducedMotion } from '../lib/motion'
import { getStore, useDure } from '../state/store'
import { LiveLog } from './control/LiveLog'
import { batched, type AgentState, type PowerAgent, type ScreenEvent } from './events'
import { PowerControls } from './PowerControls'
import { RoomSwitch } from './RoomSwitch'
import { useRoomMemory, type RoomMemory } from './roomMemory'
import { SidePanel } from './SidePanel'
import { createPaneLines, MAX_LINES, Pane, type PaneLines } from './terminal/Pane'
import { historyLines, linesOf, panesOf, pickPanes } from './terminal/lines'
import { usePowerFeed, useRoomChange, useSwapFade } from './usePowerFeed'

/** 처음 보는 방의 창에 기록을 못 깔았다 — 콘솔에 남기는 고정 문구 */
export const PREFILL_FAILED = '두레: 터미널 벽에 켤 때의 기록을 깔지 못했어요'

/** 창 격자 전환(ms) — 옛 창 꺼짐 · 새 창 켜짐 · 움직임 줄이기면 켜짐(흐려짐)만. power.css 의 .pw-t-off · .pw-t-on 과 같은 길이 */
export const WALL_MS = { off: 350, on: 350, calm: 200 } as const

/** 창 격자의 지금 걸음 — shown: 보이는 격자의 방(room.n) · phase: 꺼지는 중 | 켜지는 중 | 평소('') */
type Wall = { shown: number; phase: '' | 'off' | 'on' }
/** 보이는 격자가 그리는 것 — 옛 방 격자가 꺼지는 동안은 그 방의 마지막 모습 그대로 */
type Grid = { panes: PowerAgent[]; total: number; state: Record<string, AgentState>; pl: PaneLines }

const pad2 = (n: number) => String(n).padStart(2, '0')
const clock = () => {
  const d = new Date()
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 상태 줄 오른쪽 시계(HH:MM) — 창이 안 보이는 동안은 멈춘다 */
function Clock() {
  const [now, setNow] = useState(clock)
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setNow(clock())
    }, 1000)
    return () => clearInterval(id)
  }, [])
  return <b className="pw-t-now">{now}</b>
}

/** 옆 칸의 기록 탭 — 관제실과 같은 실시간 기록(분당 도구 수도 그 방의 진짜 사건으로 센다 — 방별 숫자와 같은 셈) */
function WallLog({ agents, subscribe, memory }: { agents: PowerAgent[]; subscribe: (fn: (ev: ScreenEvent) => void) => () => void; memory: RoomMemory }) {
  const live = useRef(memory)
  live.current = memory
  const [rate, setRate] = useState(() => memory.stats.snapshot().toolsPerMin)
  // 방을 옮기면 그 방의 분당 도구 수로 바로
  const [seen, setSeen] = useState(memory)
  if (seen !== memory) {
    setSeen(memory)
    setRate(memory.stats.snapshot().toolsPerMin)
  }
  useEffect(() => batched(subscribe, evs => { for (const ev of evs) memory.stats.apply(ev) }), [subscribe, memory])
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      live.current.stats.second()
      setRate(live.current.stats.snapshot().toolsPerMin)
    }, 1000)
    return () => clearInterval(id)
  }, [])
  return <LiveLog agents={agents} rate={rate} subscribe={subscribe} memory={memory} />
}

export function TerminalWall({ onExit, onSettings }: { onExit: () => void; onSettings?: () => void }) {
  const { view, subscribe } = usePowerFeed()
  // 전환 신호 — 방이 바뀐 그 그리기에서 안다. 창 줄 상자는 바로 새 방 것으로 짓고, 창 격자는 옛 창을 지운 뒤 켠다
  const room = useRoomChange(view.roomId)
  const memory = useRoomMemory(view.roomId)
  const root = useRef<HTMLDivElement>(null)
  useSwapFade(room.n, root, '.pw-side')
  // 움직임 줄이기 — 덮개 판의 data-calm(또는 OS 설정)을 붙을 때 한 번 읽는다
  const calm = useRef(reducedMotion())
  useLayoutEffect(() => {
    calm.current = !!root.current?.closest('[data-calm]') || reducedMotion()
  }, [])
  const selected = useDure(s => s.selectedAgentId)
  // 창을 누르면 관제실의 카드처럼 그 에이전트를 고르고 옆 칸을 대화로 — 입력창에 커서는 주지 않는다(Esc 길게가 되게, ControlRoom 과 같다)
  const [picks, setPicks] = useState(0)
  const pick = useCallback((id: string) => {
    getStore().selectAgent(id)
    setPicks(n => n + 1)
  }, [])
  // 6명을 넘으면 기다림 → 일하는 중 → 나머지로 뽑되, 자리는 방 순서 — 상태가 바뀔 때마다 읽던 창이 옮겨 다니지 않게
  const shown = useMemo(() => {
    const picked = new Set(pickPanes(view.agents, view.state))
    return view.agents.filter(a => picked.has(a))
  }, [view.agents, view.state])
  const names = useRef(new Map<string, string>())
  for (const a of view.agents) names.current.set(a.id, a.name)
  const nameOf = useCallback((id: string) => names.current.get(id) ?? '?', [])

  // 창 줄 상자 — 방마다 그 방의 터미널 줄(memory.term)을 쥔다. 방이 바뀌면(room.n) 새 방 것으로 새로 짓는다.
  // 그 방에 남겨 둔 줄이 없는 창만 그 순간 스토어에 불러와 있는 기록을 깐다(이 화면은 기록을 불러오지 않는다).
  // 그리는 중에 돈다 — 기록에 바꿀 수 없는 줄이 있으면 그 창만 비워 두고 넘어간다(앱이 통째로 넘어지지 않게).
  // 남기는 건 스토어의 듣기처럼 고정 문구와 오류 종류뿐(기록 글·오류 글에 대화·파일 이름이 들 수 있다)
  const lines = useRef<{ scene: number; pl: PaneLines } | undefined>(undefined)
  if (lines.current?.scene !== room.n) {
    const pl = createPaneLines(MAX_LINES, memory.term)
    const history = getStore().getState().history
    for (const a of view.agents) {
      const items = history[a.id]
      if (memory.term.has(a.id) || !items?.length) continue
      try {
        pl.seed(a.id, historyLines(a.id, items, nameOf))
      } catch (e) {
        // 빈 창(기다리는 중…) — 뒤에 오는 진짜 사건은 평소대로 붙는다
        console.error(PREFILL_FAILED, e instanceof Error ? e.name : typeof e)
      }
    }
    lines.current = { scene: room.n, pl }
  }
  const pl = lines.current.pl

  useEffect(
    () =>
      subscribe(ev => {
        for (const id of panesOf(ev)) if (names.current.has(id)) pl.push(id, linesOf(ev, nameOf, id))
      }),
    [subscribe, pl, nameOf],
  )
  useEffect(() => () => pl.stop(), [pl])

  // 창 격자 전환 — 방이 바뀐 그 그리기에서 걸음을 정한다. 꺼지는 중에 또 바뀌면 꺼짐은 이어 가고(끝나면 마지막 방이 켜진다),
  // 켜지는 중에 바뀌면 지금 보이는 격자부터 다시 끈다. 움직임 줄이기면 끄지 않고 새 격자를 바로 켠다(흐려짐만)
  const [wall, setWall] = useState<Wall>({ shown: room.n, phase: '' })
  const [seen, setSeen] = useState(room.n)
  if (seen !== room.n) {
    setSeen(room.n)
    if (calm.current) setWall({ shown: room.n, phase: 'on' })
    else if (wall.phase !== 'off') setWall({ shown: wall.shown, phase: 'off' })
  }
  const roomN = useRef(room.n)
  roomN.current = room.n
  useEffect(() => {
    if (!wall.phase) return
    const ms = wall.phase === 'off' ? WALL_MS.off : calm.current ? WALL_MS.calm : WALL_MS.on
    const id = setTimeout(() => setWall(w => (w.phase === 'off' ? { shown: roomN.current, phase: 'on' } : { ...w, phase: '' })), ms)
    return () => clearTimeout(id)
  }, [wall.phase, wall.shown])
  // 보이는 격자 — 지금 방 것이면 지금 값, 옛 방 격자가 꺼지는 동안은 그 방의 마지막 모습(창·상태·줄 상자) 그대로(두 방 창이 섞이지 않게)
  const grid = useRef<Grid>({ panes: shown, total: view.agents.length, state: view.state, pl })
  if (wall.shown === room.n) grid.current = { panes: shown, total: view.agents.length, state: view.state, pl }
  const g = grid.current

  const n = g.panes.length
  const cls = `pw-t-grid${n ? '' : ' pw-t-none'}${wall.phase ? ` pw-t-${wall.phase}` : ''}`
  return (
    <div ref={root} className="pw-t-wall" data-power-screen="terminal">
      <div className="pw-t-main">
        {/* 창 격자는 보이는 방이 바뀔 때마다(wall.shown) 새로 — 새 방의 창이 그 방 줄 상자에 붙는다 */}
        {n ? (
          <div key={wall.shown} className={cls} data-n={n}>
            {g.panes.map(a => (
              <Pane key={a.id} agent={a} state={g.state[a.id] ?? 'resting'} selected={selected === a.id} lines={g.pl} onPick={pick} />
            ))}
          </div>
        ) : (
          <div key={wall.shown} className={cls}>
            <p className="pw-t-empty">이 방엔 에이전트가 없어요</p>
          </div>
        )}
        <SidePanel log={<WallLog agents={view.agents} subscribe={subscribe} memory={memory} />} picks={picks} />
      </div>
      <div className="pw-t-bar">
        <span className="pw-t-ses">[두레]</span>
        <RoomSwitch up />
        {/* 창 이름은 보이는 격자의 창과 함께 바뀐다 */}
        <span className="pw-t-wins">
          {g.panes.map((a, i) => (
            <span key={a.id} className="pw-t-win" data-on={selected === a.id || undefined}>
              {`${i}:${a.name}${selected === a.id ? '*' : ''}`}
            </span>
          ))}
          {g.total > n && <span className="pw-t-win pw-t-more">외 {g.total - n}명</span>}
        </span>
        <span className="pw-t-rt">
          <PowerControls onSettings={onSettings} onExit={onExit} />
          <Clock />
        </span>
      </div>
    </div>
  )
}
