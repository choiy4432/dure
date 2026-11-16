// 관제실 — 위 띠 · 카드 · 관계도 칸 · 기록 · 숫자 띠. 사건은 usePowerFeed 가 먹이는 진짜 사건뿐, 숫자는 켠 순간 0에서.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { BrandMark } from '../shell/BrandMark'
import { AgentCards } from './control/AgentCards'
import { clockText, LiveLog } from './control/LiveLog'
import { StatsStrip } from './control/StatsStrip'
import { OrbitMap } from './orbit/OrbitMap'
import { batched } from './events'
import { createStats } from './stats'
import { usePowerFeed } from './usePowerFeed'

const upText = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

export function ControlRoom() {
  const { view, subscribe } = usePowerFeed()
  const agents = view.agents
  const stats = useRef<ReturnType<typeof createStats> | undefined>(undefined)
  stats.current ??= createStats()
  // 사건은 모아서 stats 에 쌓고, 스냅샷은 그려질 때 한 번만 뜬다(같은 때 온 사건은 한 번에 그려진다)
  const [version, bump] = useReducer((v: number) => v + 1, 0)
  const snap = useMemo(() => stats.current!.snapshot(), [version]) // eslint-disable-line react-hooks/exhaustive-deps
  const mountedAt = useRef(Date.now())
  const [wallMs, setWallMs] = useState(() => Date.now())
  const flowRef = useRef<HTMLElement>(null)

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
          <span className="pw-now">{clockText(wallMs)}</span>
        </div>
      </header>
      <div className="pw-main">
        <AgentCards agents={agents} state={view.state} subscribe={subscribe} />
        <section data-power-map className="pw-map">
          <div className="pw-label">
            관계도 · 실시간 넘김
            <span>
              켠 뒤 <b>{snap.handoffs}</b>건 · 지금 오가는 데이터 <b ref={flowRef}>0</b>개
            </span>
          </div>
          {agents.length ? (
            <OrbitMap agents={agents} state={view.state} subagents={view.subagents} subscribe={subscribe} flowRef={flowRef} />
          ) : (
            <p className="pw-empty">이 방엔 에이전트가 없어요</p>
          )}
        </section>
        <LiveLog agents={agents} rate={snap.toolsPerMin} subscribe={subscribe} />
      </div>
      <StatsStrip s={snap} subagents={subagents} />
    </div>
  )
}
