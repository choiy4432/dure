import { useEffect, useMemo, useState } from 'react'
import { useDure } from '../../state/store'
import { batched, STATE_TEXT, tailPath, type AgentState, type PowerAgent, type ScreenEvent } from '../events'

const MAX_CARDS = 5
/** 맥락 고리 — 반지름 · 둘레 */
const RING_R = 7
const RING_C = 2 * Math.PI * RING_R

type Line = { tool: string; target: string }

const STATE_LOOK: Record<AgentState, string> = { working: 'ok', awaiting: 'warn', resting: 'rest' }

/**
 * 보일 카드 — 진짜 승인 기다림 → 진짜 일하는 중 → 나머지(무리 안에선 방 순서)로 다섯 장까지. 기다리는 에이전트가 '외 N명'에 묻히지 않게.
 * 고른 에이전트는 늘 안에 — 밀려나면 다섯째 자리를 내준다(순서는 같은 규칙).
 */
function pickCards(agents: PowerAgent[], state: Record<string, AgentState>, selected: string | null): PowerAgent[] {
  const rank = (a: PowerAgent) => (state[a.id] === 'awaiting' ? 0 : state[a.id] === 'working' ? 1 : 2)
  const ranked = [...agents].sort((x, y) => rank(x) - rank(y))
  const top = ranked.slice(0, MAX_CARDS)
  if (!selected || top.some(a => a.id === selected) || !ranked.some(a => a.id === selected)) return top
  const keep = new Set(top.slice(0, MAX_CARDS - 1))
  return ranked.filter(a => keep.has(a) || a.id === selected)
}

export function AgentCards({ agents, state, subscribe, selected, onPick }: {
  agents: PowerAgent[]
  state: Record<string, AgentState>
  subscribe: (fn: (ev: ScreenEvent) => void) => () => void
  /** 스토어가 고른 에이전트 — 카드에 고른 표시 */
  selected: string | null
  onPick: (id: string) => void
}) {
  // 상태가 바뀔 때마다 다시 고른다(진짜 상태만 있으니 순서가 뜻을 가진다). 지워진 에이전트는 agents 에 없다
  const shown = useMemo(() => pickCards(agents, state, selected), [agents, state, selected])
  // 에이전트마다 마지막 진짜 도구 줄 — 아직 없으면 '—'
  const [lines, setLines] = useState<Record<string, Line>>({})
  // 진짜 맥락 사용량(입력창 아래 고리와 같은 값) — 엔진이 아직 안 줬으면 없다
  const context = useDure(s => {
    const o: Record<string, number> = {}
    for (const a of s.agents) if (a.lastContext) o[a.id] = a.lastContext.percent
    return o
  })

  useEffect(
    () =>
      batched(subscribe, evs => {
        const next: Record<string, Line> = {}
        for (const ev of evs) if (ev.kind === 'tool') next[ev.agentId] = { tool: ev.tool, target: ev.target }
        if (Object.keys(next).length) setLines(prev => ({ ...prev, ...next }))
      }),
    [subscribe],
  )

  const busy = agents.filter(a => state[a.id] === 'working').length
  return (
    <section className="pw-agents" aria-label="에이전트">
      <div className="pw-label">
        <span>
          에이전트 {agents.length}
          {agents.length > shown.length && (
            <>
              {' '}
              <span className="pw-dotsep">·</span> <span className="pw-more">외 {agents.length - shown.length}명</span>
            </>
          )}
        </span>
        <span>
          작업 중 <b>{busy}</b>
        </span>
      </div>
      {shown.map(a => {
        const st = state[a.id] ?? 'resting'
        const line = lines[a.id]
        const pct = context[a.id]
        return (
          <button
            key={a.id}
            type="button"
            className="pw-card"
            data-agent={a.id}
            data-warn={st === 'awaiting' || undefined}
            data-st={STATE_LOOK[st]}
            aria-pressed={selected === a.id}
            style={{ ['--c' as string]: a.color }}
            onClick={() => onPick(a.id)}
          >
            <span className="pw-r1">
              <span className="pw-av" aria-hidden="true">{a.name.slice(0, 1)}</span>
              <b>{a.name}</b>
              <span className="pw-role">{a.role}</span>
              <span className="pw-st" data-st={STATE_LOOK[st]}>
                {STATE_TEXT[st]}
              </span>
            </span>
            <span className="pw-r2">
              <span className="pw-tool" title={line?.target || undefined}>
                <span className="pw-tn">{line?.tool ?? '—'}</span>
                <span className="pw-tg">{line ? tailPath(line.target) : ''}</span>
              </span>
              {pct !== undefined && (
                <span className="pw-ctx" title="대화 공간 사용">
                  <svg className="pw-ring" viewBox="0 0 18 18" aria-hidden="true">
                    <circle className="pw-rb" cx="9" cy="9" r={RING_R} />
                    <circle className="pw-rf" cx="9" cy="9" r={RING_R} strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - Math.min(100, Math.max(0, pct)) / 100)} />
                  </svg>
                  <span className="pw-pct">{pct}%</span>
                </span>
              )}
            </span>
          </button>
        )
      })}
    </section>
  )
}
