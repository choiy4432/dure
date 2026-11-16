// 터미널 벽 — 창 여섯이 동시에 흐르고 아래에 tmux 같은 상태 줄. 스케줄러는 하나(32ms 걸음), 안 보이면 멈춘다.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { mulberry32 } from './events'
import { Pane, appendLines, lineEl, setLines, typeInto } from './terminal/Pane'
import { CODE } from './terminal/data'
import { createPanes, savedLines, waitingLine } from './terminal/panes'
import { shownSubagents } from './subagents'
import { usePowerFeed } from './usePowerFeed'

const STEP_MS = 32
/** 한 걸음에 흘려 보내는 시간 상한 — 멈췄다 돌아와도 한꺼번에 몰아 그리지 않는다 */
const MAX_DT = 100
/** 진짜 사건이 없은 지 이만큼 지나야 첫 창에 채움이 나온다 */
const REAL_QUIET_MS = 4000
const FOCUS_MS = 4200
const FAKE_PATH = '~/work/order-service'
const SUB_ROWS_MAX = 4

const pad2 = (n: number) => String(n).padStart(2, '0')

type Task = { due: number; run: () => number }

export function TerminalWall({ seed, now }: { seed?: number; now?: () => number } = {}) {
  const { view, agents, subscribe } = usePowerFeed({ seed, now })
  const rep = agents[0]
  const winNames = agents.slice(0, 4).map(a => a.name)
  const subN = shownSubagents(view)
  const waiting = !!rep && view.awaiting.has(rep.id)
  const fakeRoom = agents.every(a => !a.real)

  const [focus, setFocus] = useState(0)
  const [file, setFile] = useState(CODE[0][0])
  const winCount = winNames.length + 2
  const windows = useMemo(
    () => [...winNames.map((n, i) => `${i}:${n}`), `${winNames.length}:서브`, `${winNames.length + 1}:시스템`],
    [winNames.join('\n')], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // 창 번호 → 판의 칸: 에이전트 창은 앞 네 칸, 그다음 서브, 시스템
  const paneOf = (w: number) => (w < winNames.length ? w : w === winNames.length ? 4 : 5)

  const root = useRef<HTMLDivElement>(null)
  const b = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)]
  const b5t = useRef<HTMLDivElement>(null)
  const b5s = useRef<HTMLDivElement>(null)
  const b6 = useRef<HTMLDivElement>(null)
  const tokEl = useRef<HTMLElement>(null)
  const loadEl = useRef<HTMLElement>(null)
  const nowEl = useRef<HTMLElement>(null)

  // 스케줄러가 읽는 최신 값
  const live = useRef({ waiting, subN, winCount, fileShown: CODE[0][0], quietSince: -Infinity, vt: 0 })
  live.current.waiting = waiting
  live.current.subN = subN
  live.current.winCount = winCount

  const panes = useMemo(
    () => {
      const byId = new Map(agents.map(a => [a.id, a.name]))
      return createPanes(seed ?? 1, { others: agents.slice(1).map(a => a.name), nameOf: id => byId.get(id) ?? id })
    },
    [agents, seed],
  )

  // 진짜 사건 — 대표 에이전트의 것만 첫 창에 바로 붙인다(지어낸 사건은 보지 않는다)
  useEffect(() => {
    if (!rep) return
    return subscribe(ev => {
      const el = b[0].current
      if (!el || !ev.real || live.current.waiting) return
      const mine = ev.kind === 'tool' ? ev.agentId === rep.id : ev.from === rep.id || ev.to === rep.id
      if (!mine) return
      live.current.quietSince = live.current.vt
      appendLines(el, panes.agent(ev, rep.id))
    })
  }, [subscribe, rep, panes]) // eslint-disable-line react-hooks/exhaustive-deps

  // 승인을 기다리는 동안엔 한 줄뿐 — 풀리면 비우고 다시 흐른다
  useEffect(() => {
    const el = b[0].current
    if (!el) return
    el.replaceChildren()
    if (waiting) appendLines(el, [waitingLine()])
  }, [waiting]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const rnd = mulberry32((seed ?? 1) + 99991)
    const R = (lo: number, hi: number) => lo + rnd() * (hi - lo)
    const body = (r: RefObject<HTMLDivElement | null>) => r.current!
    const calm = () => !!root.current?.closest('[data-calm]')
    /** 줄이 느는 속도 — 움직임 줄이기에선 절반 */
    const slow = (ms: number) => (calm() ? ms * 2 : ms)
    const barW = () => {
      const w = b6.current?.clientWidth ?? 0
      if (!w) return 10
      // 한 줄에 CPU 칸 두 개: 칸마다 번호·괄호·퍼센트로 12글자 + 막대, 글자 폭은 13px 모노 ≈ 7.8px
      const cols = Math.floor((w - 24) / 7.8)
      return Math.max(4, Math.min(10, Math.floor((cols - 6) / 2) - 12))
    }

    // 처음에 한 화면 채워 둔다
    for (let i = 0; i < 30; i++) {
      if (!live.current.waiting) appendLines(body(b[0]), panes.agent(null))
      appendLines(body(b[1]), panes.tests())
      appendLines(body(b[2]), panes.diff())
    }
    let cur: HTMLDivElement | null = null
    const typeStep = (): void => {
      const r = panes.typing()
      if (r.file !== live.current.fileShown) {
        live.current.fileShown = r.file
        setFile(r.file)
      }
      if (r.idle) return
      const el = body(b[3])
      if (!cur) {
        cur = lineEl({ parts: [] })
        el.appendChild(cur)
        while (el.childElementCount > 60) el.firstElementChild!.remove()
      }
      typeInto(cur, r.line, r.text, r.lineDone)
      if (r.lineDone) cur = null
      if (r.done) appendLines(el, savedLines(r.file))
    }
    for (let i = 0; i < 420; i++) typeStep()
    for (let i = 0; i < 6; i++) appendLines(body(b5s), panes.subsLog())
    let spin = 0
    const subsStep = (): void => {
      spin++
      setLines(body(b5t), panes.subs(Math.min(live.current.subN, SUB_ROWS_MAX), spin).lines)
    }
    const sysStep = (): void => setLines(body(b6), panes.system(barW()))
    subsStep()
    sysStep()

    let tok = 1.82e6
    const statusStep = (): void => {
      tok += R(600, 4200)
      if (tokEl.current) tokEl.current.textContent = (tok / 1e6).toFixed(2) + 'M'
      if (loadEl.current) loadEl.current.textContent = [R(3.6, 4.6), R(3.5, 4.2), R(3.3, 3.8)].map(v => v.toFixed(2)).join(' ')
      const d = new Date()
      if (nowEl.current) nowEl.current.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }
    statusStep()

    const L = live.current
    const tasks: Task[] = [
      { due: slow(R(220, 650)), run: () => {
        if (!L.waiting && L.vt - L.quietSince >= REAL_QUIET_MS) appendLines(body(b[0]), panes.agent(null))
        return slow(R(220, 650))
      } },
      { due: slow(R(140, 420)), run: () => (appendLines(body(b[1]), panes.tests()), slow(R(140, 420))) },
      { due: slow(R(160, 520)), run: () => (appendLines(body(b[2]), panes.diff()), slow(R(160, 520))) },
      { due: STEP_MS, run: () => (typeStep(), slow(STEP_MS)) },
      { due: 110, run: () => (subsStep(), 110) },
      { due: slow(R(350, 900)), run: () => (appendLines(body(b5s), panes.subsLog()), slow(R(350, 900))) },
      { due: 900, run: () => (sysStep(), 900) },
      { due: FOCUS_MS, run: () => (setFocus(f => (f + 1) % L.winCount), FOCUS_MS) },
      { due: 1000, run: () => (statusStep(), 1000) },
    ]
    let last = Date.now()
    const id = setInterval(() => {
      const t = Date.now()
      const dt = Math.min(MAX_DT, Math.max(0, t - last))
      last = t
      if (document.visibilityState !== 'visible') return // 안 보이는 동안은 멈춘다
      L.vt += dt
      for (const k of tasks) while (k.due <= L.vt) k.due = L.vt + Math.max(1, k.run())
    }, STEP_MS)
    return () => clearInterval(id)
  }, [panes, seed]) // eslint-disable-line react-hooks/exhaustive-deps

  const focusPane = paneOf(Math.min(focus, winCount - 1))
  const titles = [
    `${rep?.name ?? '대표'} — claude${fakeRoom ? ` · ${FAKE_PATH}` : ''}`,
    '테스트 — npx vitest --watch',
    '검토 — git diff main...HEAD',
    `구현 — ${file}`,
    `서브에이전트 ×${subN}`,
    '시스템',
  ]
  return (
    <div className="pw-t-wall" data-power-screen="terminal" ref={root}>
      <div className="pw-t-grid">
        <Pane title={titles[0]} focus={focusPane === 0} warn={waiting} bodyRef={b[0]} />
        <Pane title={titles[1]} focus={focusPane === 1} bodyRef={b[1]} />
        <Pane title={titles[2]} focus={focusPane === 2} bodyRef={b[2]} />
        <Pane title={titles[3]} focus={focusPane === 3} bodyRef={b[3]} />
        <Pane title={titles[4]} focus={focusPane === 4}>
          <div className="pw-t-pb pw-t-top">
            <div ref={b5t} />
            <div className="pw-t-sub" ref={b5s} />
          </div>
        </Pane>
        <Pane title={titles[5]} focus={focusPane === 5} bodyRef={b6} top />
      </div>
      <div className="pw-t-bar">
        <span className="pw-t-ses">[두레]</span>
        <span className="pw-t-wins">
          {windows.map((w, i) => {
            const on = i === Math.min(focus, winCount - 1)
            return (
              <span key={w} className="pw-t-win" data-on={on || undefined}>
                {w}
                {on ? '*' : ''}
              </span>
            )
          })}
        </span>
        <span className="pw-t-rt">
          토큰 <b ref={tokEl}>1.82M</b> · 부하 <b ref={loadEl}>4.12 3.87 3.55</b> · <b ref={nowEl}>--:--</b>
        </span>
      </div>
    </div>
  )
}

