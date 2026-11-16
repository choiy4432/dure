import { useEffect, useRef, useState } from 'react'
import { batched, tailPath, type PowerAgent, type ScreenEvent } from '../events'

const MAX_ROWS = 26

type Row = { id: number; time: string; name: string; color: string; tp: string; tg: string }

const pad = (n: number) => String(n).padStart(2, '0')
export const clockText = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 실시간 기록 — 진짜 도구 사용과 넘김만(새 것이 맨 위, 26줄까지). 옆 칸(SidePanel)의 기록 탭 안에 놓인다 */
export function LiveLog({ agents, rate, subscribe }: { agents: PowerAgent[]; rate: number; subscribe: (fn: (ev: ScreenEvent) => void) => () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const seq = useRef(0)
  const byId = useRef(new Map<string, PowerAgent>())
  for (const a of agents) byId.current.set(a.id, a)

  useEffect(
    () =>
      batched(subscribe, evs => {
        const add: Row[] = []
        for (const ev of evs) {
          if (ev.kind === 'tool') {
            const who = byId.current.get(ev.agentId)
            add.unshift({ id: ++seq.current, time: clockText(ev.at), name: who?.name ?? ev.agentId, color: who?.color ?? '', tp: ev.tool, tg: tailPath(ev.target) })
          } else if (ev.kind === 'handoff') {
            const who = byId.current.get(ev.from)
            const to = byId.current.get(ev.to)?.name ?? ev.to
            add.unshift({ id: ++seq.current, time: clockText(ev.at), name: who?.name ?? ev.from, color: who?.color ?? '', tp: '넘김', tg: `→ ${to} · ${ev.text}` })
          }
        }
        if (add.length) setRows(prev => [...add, ...prev].slice(0, MAX_ROWS))
      }),
    [subscribe],
  )

  return (
    <div className="pw-log">
      <div className="pw-label">
        실시간 기록
        <span>
          분당 도구 <b>{rate}</b>회
        </span>
      </div>
      <div className="pw-logrows">
        {rows.length === 0 && <p className="pw-log-empty">켠 뒤 들어온 일이 아직 없어요</p>}
        {rows.map(r => (
          <div key={r.id} className="pw-lr" data-row>
            <time>{r.time}</time>
            <b style={{ color: r.color || undefined }}>{r.name}</b>
            <span className="pw-tp">{r.tp}</span>
            <span className="pw-tg">{r.tg}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
