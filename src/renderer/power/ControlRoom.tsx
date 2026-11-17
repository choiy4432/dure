// 관제실(시안 A) — 위 띠 · 왼쪽 카드 · 가운데 관계도 · 오른쪽 옆 칸(고른 에이전트의 대화 | 실시간 기록) · 숫자 띠.
// 사건은 usePowerFeed 가 먹이는 진짜 사건뿐, 숫자·기록은 방마다 따로(roomMemory — 처음 그 방을 볼 때 0에서). 고르기는 앱과 같은 스토어 고르기(selectAgent).
// 방은 앱의 방을 따른다 — 위 띠의 방 단추(RoomSwitch)·찾기로 옮기면 그 방의 카드·관계도·숫자·기록으로 바로 바뀐다
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { BrandMark } from '../shell/BrandMark'
import { getStore, useDure } from '../state/store'
import { AgentCards } from './control/AgentCards'
import { clockText, LiveLog } from './control/LiveLog'
import { StatsStrip } from './control/StatsStrip'
import { OrbitMap } from './orbit/OrbitMap'
import { batched } from './events'
import { PowerControls } from './PowerControls'
import { RoomSwitch } from './RoomSwitch'
import { useRoomMemory } from './roomMemory'
import { SidePanel } from './SidePanel'
import { usePowerFeed, useRoomChange } from './usePowerFeed'

const upText = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

export function ControlRoom({ onExit, onSettings }: { onExit: () => void; onSettings?: () => void }) {
  const { view, subscribe } = usePowerFeed()
  const agents = view.agents
  // 전환 신호 — 방이 바뀐 그 그리기에서 안다. 관계도는 이것으로 장면을 새 방 에이전트로 다시 짓는다(전환 연출은 이 자리 — Task 2)
  const room = useRoomChange(view.roomId)
  // 지금 방의 숫자·기록 — 방을 옮기면 그 방 것, 돌아오면 떠날 때 값에서 이어진다
  const memory = useRoomMemory(view.roomId)
  const live = useRef(memory)
  live.current = memory
  const selected = useDure(s => s.selectedAgentId)
  // 카드·노드를 누르면 그 에이전트를 고르고 옆 칸을 대화로(picks — 같은 에이전트를 다시 눌러도). 입력창에 커서는 주지 않는다 —
  // 초점이 누른 단추에 남아야 Esc 길게로 나갈 수 있다(입력창의 Esc 는 일하는 에이전트를 멈춘다). 쓰려면 입력창을 누른다
  const [picks, setPicks] = useState(0)
  const pick = useCallback((id: string) => {
    getStore().selectAgent(id)
    setPicks(n => n + 1)
  }, [])
  // 사건은 모아서 그 방의 stats 에 쌓고, 스냅샷은 그려질 때 한 번만 뜬다(같은 때 온 사건은 한 번에 그려진다)
  const [version, bump] = useReducer((v: number) => v + 1, 0)
  const snap = useMemo(() => memory.stats.snapshot(), [memory, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const mountedAt = useRef(Date.now())
  const [wallMs, setWallMs] = useState(() => Date.now())

  // 방이 바뀌면 다시 듣는다 — 모아 두던 옛 방 사건이 새 방 숫자에 들지 않게
  useEffect(
    () =>
      batched(subscribe, evs => {
        for (const ev of evs) memory.stats.apply(ev)
        bump()
      }),
    [subscribe, memory],
  )

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return // 창이 안 보이는 동안은 그리기를 멈춘다
      live.current.stats.second() // 지금 방의 초당 막대만 — 보지 않는 방은 떠날 때 막대에서 이어진다
      setWallMs(Date.now())
      bump()
    }, 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed = Math.max(0, Math.floor((wallMs - mountedAt.current) / 1000)) // 벽시계 기준 — 멈췄다 와도 어긋나지 않는다

  const subagents = view.subagents.length
  // 기록 요소는 넣는 값이 바뀔 때만 새로 — 시계 틱마다 옆 칸에 새 요소를 넘기지 않는다
  const rate = snap.toolsPerMin
  const log = useMemo(() => <LiveLog agents={agents} rate={rate} subscribe={subscribe} memory={memory} />, [agents, rate, subscribe, memory])
  return (
    <div className="pw-inner" data-power-screen="control">
      <header className="pw-top">
        <div className="pw-brand">
          <span className="pw-mark"><BrandMark /></span>
          <b>두레</b>
          <span className="pw-sep" />
          <span className="pw-mode"><i className="pw-dot" />파워 모드 · 가동 중</span>
        </div>
        <div className="pw-room">
          <RoomSwitch />
          <span className="pw-room-rest"> · 에이전트 {agents.length} · 서브에이전트 <b>{subagents}</b></span>
        </div>
        <div className="pw-clock">
          가동 <b>{upText(elapsed)}</b>
          <PowerControls onSettings={onSettings} onExit={onExit} />
          <span className="pw-now">{clockText(wallMs)}</span>
        </div>
      </header>
      <div className="pw-main">
        <AgentCards agents={agents} state={view.state} subscribe={subscribe} selected={selected} onPick={pick} />
        <section data-power-map className="pw-map" aria-label="관계도">
          <div className="pw-label">
            관계도 · 실시간 넘김
            {agents.length > 0 && <span>노드를 누르면 그 에이전트와 대화</span>}
          </div>
          {agents.length ? (
            <OrbitMap room={room} agents={agents} state={view.state} subagents={view.subagents} subscribe={subscribe} selected={selected} onPick={pick} />
          ) : (
            <p className="pw-empty">이 방엔 에이전트가 없어요</p>
          )}
        </section>
        <SidePanel log={log} picks={picks} />
      </div>
      <StatsStrip s={snap} subagents={subagents} />
    </div>
  )
}
