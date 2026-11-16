// 관제실(시안 A) — 위 띠 · 왼쪽 카드 · 가운데 관계도 · 오른쪽 옆 칸(고른 에이전트의 대화 | 실시간 기록) · 숫자 띠.
// 사건은 usePowerFeed 가 먹이는 진짜 사건뿐, 숫자는 켠 순간 0에서. 고르기는 앱과 같은 스토어 고르기(selectAgent).
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { BrandMark } from '../shell/BrandMark'
import { getStore, useDure } from '../state/store'
import { AgentCards } from './control/AgentCards'
import { clockText, LiveLog } from './control/LiveLog'
import { StatsStrip } from './control/StatsStrip'
import { OrbitMap } from './orbit/OrbitMap'
import { batched } from './events'
import { PowerControls } from './PowerControls'
import { SidePanel } from './SidePanel'
import { createStats } from './stats'
import { usePowerFeed } from './usePowerFeed'

const upText = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

export function ControlRoom({ onExit, onSettings }: { onExit: () => void; onSettings?: () => void }) {
  const { view, subscribe } = usePowerFeed()
  const agents = view.agents
  const selected = useDure(s => s.selectedAgentId)
  // 카드·노드를 누르면 앱의 카드처럼 그 에이전트를 고르고 입력창에 커서 — 옆 칸이 대화로 바뀐다
  const pick = useCallback((id: string) => getStore().selectAgent(id, { focusInput: true }), [])
  const stats = useRef<ReturnType<typeof createStats> | undefined>(undefined)
  stats.current ??= createStats()
  // 사건은 모아서 stats 에 쌓고, 스냅샷은 그려질 때 한 번만 뜬다(같은 때 온 사건은 한 번에 그려진다)
  const [version, bump] = useReducer((v: number) => v + 1, 0)
  const snap = useMemo(() => stats.current!.snapshot(), [version]) // eslint-disable-line react-hooks/exhaustive-deps
  const mountedAt = useRef(Date.now())
  const [wallMs, setWallMs] = useState(() => Date.now())

  useEffect(
    () =>
      batched(subscribe, evs => {
        for (const ev of evs) stats.current!.apply(ev)
        bump()
      }),
    [subscribe],
  )

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return // 창이 안 보이는 동안은 그리기를 멈춘다
      stats.current!.second()
      setWallMs(Date.now())
      bump()
    }, 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed = Math.max(0, Math.floor((wallMs - mountedAt.current) / 1000)) // 벽시계 기준 — 멈췄다 와도 어긋나지 않는다

  const subagents = view.subagents.length
  // 기록 요소는 넣는 값이 바뀔 때만 새로 — 시계 틱마다 옆 칸에 새 요소를 넘기지 않는다
  const rate = snap.toolsPerMin
  const log = useMemo(() => <LiveLog agents={agents} rate={rate} subscribe={subscribe} />, [agents, rate, subscribe])
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
          방 <b>{view.roomName ?? '—'}</b> · 에이전트 {agents.length} · 서브에이전트 <b>{subagents}</b>
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
            <OrbitMap agents={agents} state={view.state} subagents={view.subagents} subscribe={subscribe} selected={selected} onPick={pick} />
          ) : (
            <p className="pw-empty">이 방엔 에이전트가 없어요</p>
          )}
        </section>
        <SidePanel log={log} />
      </div>
      <StatsStrip s={snap} subagents={subagents} />
    </div>
  )
}
