import { useEffect, useState } from 'react'
import { batched, type AgentState, type PowerAgent, type ScreenEvent } from '../events'

const MAX_CARDS = 5

type Line = { tool: string; target: string }

const STATE_TEXT: Record<AgentState, string> = { working: '작업 중', awaiting: '승인 기다림', resting: '쉬는 중' }
const STATE_LOOK: Record<AgentState, string> = { working: 'ok', awaiting: 'warn', resting: 'rest' }

/** 보일 카드 — 진짜 승인 기다림 → 진짜 일하는 중 → 나머지(무리 안에선 방 순서) 로 다섯 장까지. 기다리는 에이전트가 '외 N명'에 묻히지 않게 */
function pickCards(agents: PowerAgent[], state: Record<string, AgentState>): PowerAgent[] {
  const rank = (a: PowerAgent) => (state[a.id] === 'awaiting' ? 0 : state[a.id] === 'working' ? 1 : 2)
  return [...agents].sort((x, y) => rank(x) - rank(y)).slice(0, MAX_CARDS)
}

export function AgentCards({ agents, state, subscribe }: {
  agents: PowerAgent[]
  state: Record<string, AgentState>
  subscribe: (fn: (ev: ScreenEvent) => void) => () => void
}) {
  // 켠 순간에 한 번 고른다 — 켜져 있는 동안 상태가 바뀌어도 카드가 자리를 바꾸지 않는다
  const [shown] = useState(() => pickCards(agents, state))
  // 에이전트마다 마지막 진짜 도구 줄 — 아직 없으면 '—'
  const [lines, setLines] = useState<Record<string, Line>>({})

  useEffect(
    () =>
      batched(subscribe, evs => {
        const next: Record<string, Line> = {}
        for (const ev of evs) if (ev.kind === 'tool') next[ev.agentId] = { tool: ev.tool, target: ev.target }
        if (Object.keys(next).length) setLines(prev => ({ ...prev, ...next }))
      }),
    [subscribe],
  )

  const live = shown.filter(a => agents.some(x => x.id === a.id)) // 켠 뒤 지워진 에이전트는 뺀다
  const busy = agents.filter(a => state[a.id] === 'working').length
  return (
    <section className="pw-agents" aria-label="에이전트">
      <div className="pw-label">
        <span>
          에이전트 {agents.length}
          {agents.length > live.length && (
            <>
              {' '}
              <span className="pw-dotsep">·</span> <span className="pw-more">외 {agents.length - live.length}명</span>
            </>
          )}
        </span>
        <span>
          작업 중 <b>{busy}</b>
        </span>
      </div>
      {live.map(a => {
        const st = state[a.id] ?? 'resting'
        const line = lines[a.id]
        return (
          <div key={a.id} className="pw-card" data-agent={a.id} data-warn={st === 'awaiting' || undefined} style={{ ['--c' as string]: a.color }}>
            <div className="pw-r1">
              <span className="pw-av">{a.name.slice(0, 1)}</span>
              <b>{a.name}</b>
              <span className="pw-role">{a.role}</span>
              <span className="pw-st" data-st={STATE_LOOK[st]}>
                {STATE_TEXT[st]}
              </span>
            </div>
            <div className="pw-tool">
              <span className="pw-tn">{line?.tool ?? '—'}</span>
              <span className="pw-tg">{line?.target ?? ''}</span>
            </div>
          </div>
        )
      })}
    </section>
  )
}
