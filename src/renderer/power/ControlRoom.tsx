// 관제실 — 위 띠 · 카드 · 관계도 칸 · 기록 · 숫자 띠. 사건은 usePowerFeed 가 먹인다.
import { useEffect, useRef, useState } from 'react'
import { BrandMark } from '../shell/BrandMark'
import { AgentCards } from './control/AgentCards'
import { clockText, LiveLog } from './control/LiveLog'
import { StatsStrip } from './control/StatsStrip'
import { createStats } from './stats'
import { usePowerFeed } from './usePowerFeed'

const UP_START = 3 * 3600 + 42 * 60 + 17
/** 가짜 방일 때 서브에이전트 숫자(시안 값) */
const FAKE_SUBAGENTS = 4

const upText = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

export function ControlRoom({ seed, now }: { seed?: number; now?: () => number } = {}) {
  const { view, agents, subscribe } = usePowerFeed({ seed, now })
  const stats = useRef<ReturnType<typeof createStats> | undefined>(undefined)
  stats.current ??= createStats(seed ?? Date.now())
  const [snap, setSnap] = useState(() => stats.current!.snapshot())
  const tokens = useRef<number[]>([stats.current.snapshot().tokens])
  const [tokensPerMin, setTokensPerMin] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [wall, setWall] = useState(() => clockText(Date.now()))

  useEffect(
    () =>
      subscribe(ev => {
        stats.current!.apply(ev)
        setSnap(stats.current!.snapshot()) // 같은 틱의 사건은 한 번에 그려진다
      }),
    [subscribe],
  )

  useEffect(() => {
    const id = setInterval(() => {
      const st = stats.current!
      st.second()
      const next = st.snapshot()
      setSnap(next)
      const t = tokens.current
      t.push(next.tokens)
      if (t.length > 60) t.shift()
      setTokensPerMin(t.length > 1 ? Math.round(((t[t.length - 1] - t[0]) / (t.length - 1)) * 60 / 1000) : 0)
      setElapsed(e => e + 1)
      setWall(clockText(Date.now()))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const subagents = agents.every(a => !a.real) ? FAKE_SUBAGENTS : view.subagents
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
          방 <b>{view.roomName}</b> · 에이전트 {agents.length} · 서브에이전트 <b>{subagents}</b>
        </div>
        <div className="pw-clock">
          가동 <b>{upText(UP_START + elapsed)}</b>
          <span className="pw-now">{wall}</span>
        </div>
      </header>
      <div className="pw-main">
        <AgentCards agents={agents} awaiting={view.awaiting} subscribe={subscribe} />
        <section data-power-map className="pw-map">
          <div className="pw-label">
            관계도 · 실시간 넘김
            <span>
              지난 1시간 <b>{snap.handoffs}</b>건
            </span>
          </div>
          <div className="pw-mapbox" />
        </section>
        <LiveLog agents={agents} rate={snap.toolsPerMin} subscribe={subscribe} />
      </div>
      <StatsStrip s={snap} subagents={subagents} tokensPerMin={tokensPerMin} />
    </div>
  )
}
