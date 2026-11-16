import { useEffect, useRef, useState } from 'react'
import type { PowerAgent, ScreenEvent } from '../events'

const MAX_ROWS = 26

type Row = { id: number; time: string; name: string; color: string; tp: string; tg: string }

const pad = (n: number) => String(n).padStart(2, '0')
export const clockText = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function LiveLog({ agents, rate, subscribe }: { agents: PowerAgent[]; rate: number; subscribe: (fn: (ev: ScreenEvent) => void) => () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const seq = useRef(0)
  const byId = useRef(new Map<string, PowerAgent>())
  for (const a of agents) byId.current.set(a.id, a)

  useEffect(
    () =>
      subscribe(ev => {
        const who = byId.current.get(ev.kind === 'tool' ? ev.agentId : ev.from)
        const to = ev.kind === 'handoff' ? (byId.current.get(ev.to)?.name ?? ev.to) : ''
        const row: Row =
          ev.kind === 'tool'
            ? { id: ++seq.current, time: clockText(ev.at), name: who?.name ?? ev.agentId, color: who?.color ?? '', tp: ev.tool, tg: ev.target }
            : { id: ++seq.current, time: clockText(ev.at), name: who?.name ?? ev.from, color: who?.color ?? '', tp: '넘김', tg: `→ ${to} · ${ev.text}` }
        setRows(prev => [row, ...prev].slice(0, MAX_ROWS))
      }),
    [subscribe],
  )

  return (
    <section className="pw-log" aria-label="실시간 기록">
      <div className="pw-label">
        실시간 기록
        <span>
          분당 도구 <b>{rate}</b>회
        </span>
      </div>
      <div className="pw-logrows">
        {rows.map(r => (
          <div key={r.id} className="pw-lr" data-row>
            <time>{r.time}</time>
            <b style={{ color: r.color || undefined }}>{r.name}</b>
            <span className="pw-tp">{r.tp}</span>
            <span className="pw-tg">{r.tg}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
