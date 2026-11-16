// 터미널 창 하나 — 제목줄은 React, 본문은 DOM 에 직접 줄을 붙인다(수백 줄을 React 상태로 다시 그리지 않는다).
// 글자는 모두 textContent 로만 넣는다.
import type { ReactNode, Ref } from 'react'
import { highlight, lineNo, type Line, type Part } from './panes'

/** 창 하나가 쥐는 줄 수 — 넘치면 위에서부터 지운다 */
export const MAX_LINES = 60

export function Pane({ title, focus, warn, bodyRef, children, top }: {
  title: string
  focus: boolean
  warn?: boolean
  bodyRef?: Ref<HTMLDivElement>
  children?: ReactNode
  top?: boolean
}) {
  return (
    <div className="pw-t-pane" data-focus={focus || undefined}>
      <div className="pw-t-ptl">
        <i data-warn={warn || undefined} />
        <span>{title}</span>
      </div>
      {children ?? <div className={top ? 'pw-t-pb pw-t-top' : 'pw-t-pb'} ref={bodyRef} />}
    </div>
  )
}

const span = (p: Part): HTMLSpanElement => {
  const s = document.createElement('span')
  s.textContent = p.t
  const cls = [p.c && `pw-t-${p.c}`, p.b && 'pw-t-b'].filter(Boolean).join(' ')
  if (cls) s.className = cls
  return s
}

/** 줄 하나를 DOM 으로 — 부분마다 span, 색은 class */
export function lineEl(l: Line): HTMLDivElement {
  const d = document.createElement('div')
  d.className = l.hd ? 'pw-t-ln pw-t-hd' : 'pw-t-ln'
  if (l.key) d.dataset.key = l.key
  for (const p of l.parts) d.appendChild(span(p))
  return d
}

const findKey = (body: HTMLElement, key: string): HTMLElement | undefined => {
  for (let el = body.lastElementChild as HTMLElement | null; el; el = el.previousElementSibling as HTMLElement | null) if (el.dataset.key === key) return el
  return undefined
}

/** 줄들을 아래에 붙이고 MAX_LINES 를 넘는 앞쪽을 지운다. key 줄은 제자리를 바꾸고, end 줄은 그 key 의 줄을 지운다 */
export function appendLines(body: HTMLElement, lines: Line[], max = MAX_LINES): void {
  for (const l of lines) {
    const old = l.key ? findKey(body, l.key) : undefined
    if (l.end) {
      old?.remove()
      continue
    }
    const el = lineEl(l)
    if (old) old.replaceWith(el)
    else body.appendChild(el)
  }
  while (body.childElementCount > max) body.firstElementChild!.remove()
}

/** 본문 전체를 새 줄로 바꾼다(위 고정 블록·시스템 창) */
export function setLines(body: HTMLElement, lines: Line[]): void {
  body.replaceChildren(...lines.map(lineEl))
}

/** 치는 중인 줄 — 쳐진 만큼 + 블록 커서. 다 치면 낱말 색을 입힌다 */
export function typeInto(el: HTMLElement, n: number, text: string, finished: boolean): void {
  const parts: Part[] = finished ? highlight(text) : [{ t: text }]
  el.replaceChildren(span(lineNo(n)), ...parts.map(span))
  if (!finished) {
    const cur = document.createElement('span')
    cur.className = 'pw-t-cur'
    el.appendChild(cur)
  }
}
