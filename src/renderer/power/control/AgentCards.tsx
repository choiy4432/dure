import { useEffect, useState } from 'react'
import type { PowerAgent, ScreenEvent } from '../events'
import { TARGETS, TOOL_MIX } from '../fakeWorld'

const MAX_CARDS = 5
const RING_R = 8
const RING_C = 2 * Math.PI * RING_R

type Line = { tool: string; target: string }
/** real: 마지막 진짜 도구 줄(없으면 undefined) — 승인 기다리는 동안은 이것만 보인다 */
type CardState = Line & { done: number; total: number; ctx: number; n: number; real?: Line }

/** 켠 순간 카드가 비지 않게 채움 같은 첫 줄을 깐다 — 승인 기다리는 쪽은 지어내지 않는다 */
const seedLine = (i: number, wait: boolean): Line => {
  if (wait) return { tool: '—', target: '' }
  const tool = TOOL_MIX[(i * 3) % TOOL_MIX.length]
  return { tool, target: TARGETS[tool][(i * 5) % TARGETS[tool].length] }
}
const initial = (i: number, wait: boolean): CardState => ({ ...seedLine(i, wait), done: 3 + ((i * 5) % 7), total: 10 + ((i * 7) % 7), ctx: 20 + ((i * 13) % 50), n: 0 })

/** 할 일·문맥 수는 장식 — 그 에이전트의 도구 호출이 쌓일수록 천천히 오른다 */
function advance(c: CardState, tool: string, target: string, real: boolean): CardState {
  const n = c.n + 1
  let { done, total, ctx } = c
  if (n % 6 === 0) done++
  if (done > total) {
    done = 1
    total = 10 + (n % 7)
  }
  if (n % 4 === 0) ctx = ctx >= 95 ? 20 : ctx + 1
  return { tool, target, done, total, ctx, n, real: real ? { tool, target } : c.real }
}

/** 보일 카드 — 진짜 승인 기다림 → 진짜 일하는 중 → 나머지(무리 안에선 방 순서) 로 다섯 장까지. 기다리는 에이전트가 '외 N명'에 묻히지 않게 */
function pickCards(agents: PowerAgent[], awaiting: Set<string>, working: Set<string>): PowerAgent[] {
  const rank = (a: PowerAgent) => (awaiting.has(a.id) ? 0 : working.has(a.id) ? 1 : 2)
  return [...agents].sort((x, y) => rank(x) - rank(y)).slice(0, MAX_CARDS)
}

export function AgentCards({ agents, awaiting, working, subscribe }: {
  agents: PowerAgent[]
  awaiting: Set<string>
  working: Set<string>
  subscribe: (fn: (ev: ScreenEvent) => void) => () => void
}) {
  // 켠 순간에 한 번 고른다 — 켜져 있는 동안 상태가 바뀌어도 카드가 자리를 바꾸지 않는다
  const [shown] = useState(() => pickCards(agents, awaiting, working))
  const [cards, setCards] = useState<Record<string, CardState>>(() => Object.fromEntries(shown.map((a, i) => [a.id, initial(i, awaiting.has(a.id))])))

  // 한 틱의 사건은 한 번에 그려진다(React 가 같은 틱의 상태 갱신을 묶는다)
  useEffect(
    () =>
      subscribe(ev => {
        if (ev.kind !== 'tool') return
        setCards(prev => (prev[ev.agentId] ? { ...prev, [ev.agentId]: advance(prev[ev.agentId], ev.tool, ev.target, ev.real) } : prev))
      }),
    [subscribe],
  )

  const busy = agents.filter(a => !awaiting.has(a.id)).length
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
        const c = cards[a.id]
        const wait = awaiting.has(a.id)
        // 기다리는 동안엔 지어낸 줄을 숨기고 진짜 마지막 줄만(없으면 —) — 진짜 기다림과 헷갈리지 않게
        const line: Line = wait ? (c.real ?? { tool: '—', target: '' }) : c
        return (
          <div key={a.id} className="pw-card" data-agent={a.id} data-warn={wait || undefined} style={{ ['--c' as string]: a.color }}>
            <div className="pw-r1">
              <span className="pw-av">{a.name.slice(0, 1)}</span>
              <b>{a.name}</b>
              <span className="pw-role">{a.role}</span>
              <span className="pw-st" data-st={wait ? 'warn' : 'ok'}>
                {wait ? '승인 기다림' : '작업 중'}
              </span>
            </div>
            <div className="pw-tool">
              <span className="pw-tn">{line.tool}</span>
              <span className="pw-tg">{line.target}</span>
            </div>
            <div className="pw-r3">
              <div className="pw-bar">
                <i style={{ width: `${(c.done / c.total) * 100}%` }} />
              </div>
              <span>
                할 일 {c.done}/{c.total}
              </span>
              <svg className="pw-ring" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r={RING_R} className="pw-rb" />
                <circle cx="10" cy="10" r={RING_R} className="pw-rf" strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - c.ctx / 100)} />
              </svg>
              <span className="pw-pct">{c.ctx}%</span>
            </div>
          </div>
        )
      })}
    </section>
  )
}
