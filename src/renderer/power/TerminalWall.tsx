// 터미널 벽 — 이번 판은 자리표: 첫 에이전트의 진짜 사건만 창 하나에 흐른다(에이전트마다 창·대화 칸은 다음 판 Task 3).
// 지어낸 창·줄·숫자는 없다. 줄은 DOM 에 바로 붙인다(사건마다 React 상태를 바꾸지 않는다) — 글자는 textContent 로만.
import { useEffect, useRef, useState } from 'react'
import { Pane, appendLines } from './terminal/Pane'
import { eventLines, waitingLine } from './terminal/panes'
import { usePowerFeed } from './usePowerFeed'

const pad2 = (n: number) => String(n).padStart(2, '0')
const clock = () => {
  const d = new Date()
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function TerminalWall() {
  const { view, subscribe } = usePowerFeed()
  const rep = view.agents[0]
  const waiting = !!rep && view.state[rep.id] === 'awaiting'
  const body = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(clock)
  const names = useRef(new Map<string, string>())
  for (const a of view.agents) names.current.set(a.id, a.name)
  const live = useRef({ waiting })
  live.current.waiting = waiting

  // 대표 에이전트의 진짜 사건만 — 승인을 기다리는 동안엔 붙이지 않는다
  useEffect(() => {
    if (!rep) return
    return subscribe(ev => {
      const el = body.current
      if (!el || live.current.waiting) return
      const mine = ev.kind === 'handoff' ? ev.from === rep.id || ev.to === rep.id : ev.agentId === rep.id
      if (mine) appendLines(el, eventLines(ev, rep.id, id => names.current.get(id) ?? id))
    })
  }, [subscribe, rep])

  // 승인을 기다리는 동안엔 한 줄뿐 — 풀리면 비우고 다시 흐른다
  useEffect(() => {
    const el = body.current
    if (!el) return
    el.replaceChildren()
    if (waiting) appendLines(el, [waitingLine()])
  }, [waiting])

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setNow(clock())
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="pw-t-wall" data-power-screen="terminal">
      <div className="pw-t-grid pw-t-one">
        <Pane title={rep ? (rep.role ? `${rep.name} — ${rep.role}` : rep.name) : '이 방엔 에이전트가 없어요'} focus warn={waiting} bodyRef={body} />
      </div>
      <div className="pw-t-bar">
        <span className="pw-t-ses">[두레]</span>
        <span className="pw-t-wins">
          {view.agents.map((a, i) => (
            <span key={a.id} className="pw-t-win" data-on={i === 0 || undefined}>
              {`${i}:${a.name}`}
              {i === 0 ? '*' : ''}
            </span>
          ))}
        </span>
        <span className="pw-t-rt">
          <b>{now}</b>
        </span>
      </div>
    </div>
  )
}
