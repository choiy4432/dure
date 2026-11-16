// 관제실 — 위 띠 · 카드 · 관계도 칸 · 기록 · 숫자 띠. 사건은 usePowerFeed 가 먹인다.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
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
  // 사건은 stats 에 바로 쌓고, 스냅샷은 그려질 때 한 번만 뜬다(같은 틱의 사건은 한 번에 그려진다)
  const [version, bump] = useReducer((v: number) => v + 1, 0)
  const snap = useMemo(() => stats.current!.snapshot(), [version]) // eslint-disable-line react-hooks/exhaustive-deps
  const tokens = useRef<number[]>([snap.tokens])
  const [tokensPerMin, setTokensPerMin] = useState(0)
  const mountedAt = useRef(Date.now())
  const [wallMs, setWallMs] = useState(() => Date.now())

  useEffect(
    () =>
      subscribe(ev => {
        stats.current!.apply(ev)
        bump()
      }),
    [subscribe],
  )

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return // 창이 안 보이는 동안은 그리기를 멈춘다
      const st = stats.current!
      st.second()
      const t = tokens.current
      t.push(st.snapshot().tokens)
      if (t.length > 60) t.shift()
      setTokensPerMin(t.length > 1 ? Math.round(((t[t.length - 1] - t[0]) / (t.length - 1)) * 60 / 1000) : 0)
      setWallMs(Date.now())
      bump()
    }, 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed = Math.max(0, Math.floor((wallMs - mountedAt.current) / 1000)) // 벽시계 기준 — 멈췄다 와도 어긋나지 않는다

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
          <span className="pw-now">{clockText(wallMs)}</span>
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
