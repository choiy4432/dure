// 터미널 창 하나 — 제목줄·승인 기다림 줄은 React, 본문 줄은 DOM 에 직접 붙인다(사건마다 React 상태를 바꾸지 않는다).
// 글자는 모두 textContent 로만 넣는다.
import { useLayoutEffect, useRef, type MouseEvent } from 'react'
import type { AgentState, PowerAgent } from '../events'
import type { Line, Part } from './lines'

/** 창 하나가 쥐는 줄 수 — 넘치면 위에서부터 지운다 */
export const MAX_LINES = 60
/** 아직 줄이 없는 창의 안내 */
const EMPTY_TEXT = '기다리는 중…'

const span = (p: Part): HTMLSpanElement => {
  const s = document.createElement('span')
  s.textContent = p.t
  const cls = [p.c && `pw-t-${p.c}`, p.b && 'pw-t-b'].filter(Boolean).join(' ')
  if (cls) s.className = cls
  return s
}

/** 줄 하나를 DOM 으로 — 조각마다 span, 색은 class */
export function lineEl(l: Line): HTMLDivElement {
  const d = document.createElement('div')
  d.className = 'pw-t-ln'
  for (const p of l.parts) d.appendChild(span(p))
  return d
}

const emptyEl = (): HTMLDivElement => {
  const d = document.createElement('div')
  d.className = 'pw-t-ln pw-t-dim'
  d.dataset.empty = ''
  d.textContent = EMPTY_TEXT
  return d
}

/**
 * 창 본문 줄 — 에이전트마다 마지막 max 줄을 쥐고(창이 없는 에이전트도: 창에 올라오면 그대로 보인다),
 * 붙은 창 본문에는 한 프레임에 한 번 몰아 붙인다. 창이 안 보이는 동안엔 프레임이 돌지 않는다(먹이도 그동안 온 사건은 버린다)
 */
export function createPaneLines(max = MAX_LINES) {
  const kept = new Map<string, Line[]>()
  const bodies = new Map<string, HTMLElement>()
  const queued = new Map<string, Line[]>()
  let frame = 0
  const trim = (ls: Line[]) => {
    if (ls.length > max) ls.splice(0, ls.length - max)
  }
  const draw = () => {
    frame = 0
    for (const [id, ls] of queued) {
      const body = bodies.get(id)
      if (!body) continue
      if (body.firstElementChild instanceof HTMLElement && 'empty' in body.firstElementChild.dataset) body.firstElementChild.remove()
      const frag = document.createDocumentFragment()
      for (const l of ls) frag.appendChild(lineEl(l))
      body.appendChild(frag)
      while (body.childElementCount > max) body.firstElementChild!.remove()
    }
    queued.clear()
  }
  return {
    /** 켤 때 깔 줄 */
    seed(id: string, ls: Line[]) {
      const k = [...ls]
      trim(k)
      kept.set(id, k)
    },
    push(id: string, ls: Line[]) {
      if (!ls.length) return
      const k = kept.get(id) ?? []
      k.push(...ls)
      trim(k)
      kept.set(id, k)
      if (!bodies.has(id)) return
      const q = queued.get(id) ?? []
      q.push(...ls)
      trim(q)
      queued.set(id, q)
      frame ||= requestAnimationFrame(draw)
    },
    /** 창이 붙으면 쥔 줄을 그대로 그린다(없으면 안내 한 줄) */
    attach(id: string, body: HTMLElement) {
      bodies.set(id, body)
      queued.delete(id)
      const k = kept.get(id)
      body.replaceChildren(...(k?.length ? k.map(lineEl) : [emptyEl()]))
    },
    detach(id: string, body: HTMLElement) {
      if (bodies.get(id) !== body) return
      bodies.delete(id)
      queued.delete(id)
    },
    /** 걸린 프레임을 거둔다(쥔 줄은 남는다 — 다시 붙으면 그대로) */
    stop() {
      cancelAnimationFrame(frame)
      frame = 0
      queued.clear()
    },
  }
}
export type PaneLines = ReturnType<typeof createPaneLines>

/**
 * 창 — 누르면(본문 어디든, 제목 단추는 키보드로도) 그 에이전트를 고른다. 점 색은 진짜 상태,
 * 승인을 기다리는 동안엔 진짜 줄 아래에 `승인을 기다리는 중…` 을 붙여 둔다(줄을 갈아 끼우지 않는다)
 */
export function Pane({ agent, state, selected, lines, onPick }: {
  agent: PowerAgent
  state: AgentState
  selected: boolean
  lines: PaneLines
  onPick: (id: string) => void
}) {
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = body.current!
    lines.attach(agent.id, el)
    return () => lines.detach(agent.id, el)
  }, [lines, agent.id])
  // 제목 단추의 누르기도 이 창으로 올라와 한 번만 고른다. 창의 글을 끌어 고르던 누르기면(경로 복사 등) 고르지 않는다 —
  // 고르면 커서가 입력창으로 가서 고른 글이 풀린다
  const click = (e: MouseEvent<HTMLElement>) => {
    const s = window.getSelection()
    const fromTitle = e.target instanceof Element && !!e.target.closest('.pw-t-ptl')
    if (!fromTitle && s && !s.isCollapsed && body.current?.contains(s.anchorNode)) return
    onPick(agent.id)
  }
  return (
    <section className="pw-t-pane" data-agent={agent.id} data-st={state} data-sel={selected || undefined} onClick={click}>
      <button type="button" className="pw-t-ptl" aria-pressed={selected}>
        <i aria-hidden="true" />
        <span>{agent.role ? `${agent.name} — ${agent.role}` : agent.name}</span>
      </button>
      <div className="pw-t-pb" ref={body} />
      {state === 'awaiting' && <div className="pw-t-ln pw-t-am pw-t-wait">승인을 기다리는 중…</div>}
    </section>
  )
}
