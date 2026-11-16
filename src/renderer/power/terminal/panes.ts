// 터미널 창 줄 만들기 — 순수. 진짜 화면 사건만 줄로 바꾼다(지어낸 줄은 없다). 글자는 그리는 쪽이 textContent 로만 넣는다.
import { oneLine, type ScreenEvent } from '../events'

export type Color = 'ok' | 'er' | 'am' | 'bl' | 'dim' | 'vi' | 'cy' | 'add' | 'del' | 'gn'
export type Part = { t: string; c?: Color; b?: boolean }
/** key: 같은 key 의 줄은 새로 붙지 않고 그 자리를 바꾼다 · end: 그 key 의 줄을 지운다 · hd: 표 머리 바탕 */
export type Line = { parts: Part[]; key?: string; end?: boolean; hd?: boolean }

const line = (...parts: Part[]): Line => ({ parts })
const p = (t: string, c?: Color, b?: boolean): Part => ({ t, c, b })

const KW = /^(import|from|export|function|const|let|return|if|for|of|continue|async|await|type|as|new|throw)$/
const TOKEN = /('[^']*')|\b([A-Za-z_]+)\b|\b(\d+)\b/g

/** 한 줄 코드를 낱말 색으로 나눈다 — 주석은 통째로 dim, 문자열 초록, 예약어 보라, 숫자 노랑 */
export function highlight(text: string): Part[] {
  if (/^\s*\/\//.test(text)) return [p(text, 'dim')]
  const out: Part[] = []
  let at = 0
  for (const m of text.matchAll(TOKEN)) {
    const [all, str, word, num] = m
    const color: Color | undefined = str ? 'gn' : word && KW.test(word) ? 'vi' : num ? 'am' : undefined
    if (!color) continue
    if (m.index! > at) out.push(p(text.slice(at, m.index)))
    out.push(p(all, color))
    at = m.index! + all.length
  }
  if (at < text.length) out.push(p(text.slice(at)))
  return out
}

/**
 * 진짜 사건 하나 → 그 에이전트 창의 줄. self = 창 주인(넘김의 화살표 방향) · nameOf = id → 이름.
 * 도구 `● Tool(대상)` · 결과 `⎿ 첫 줄`(오류면 빨강) · 넘김 `send_message(→ 이름)` · 차례 끝 `✓ 끝남` — 답 글·diff 는 다음 판(Task 3)
 */
export function eventLines(ev: ScreenEvent, self: string, nameOf: (id: string) => string): Line[] {
  switch (ev.kind) {
    case 'tool':
      return [line(p('●', 'ok'), p(' '), p(ev.tool, undefined, true), p('(', 'dim'), p(ev.target), p(')', 'dim'))]
    case 'result':
      return ev.text ? [line(p(`  ⎿  ${ev.text}`, ev.ok ? 'dim' : 'er'))] : []
    case 'handoff': {
      const out = ev.from === self
      return [
        line(p('●', 'bl'), p(' '), p('send_message', undefined, true), p(`(${out ? '→' : '←'} ${nameOf(out ? ev.to : ev.from)})`, 'dim')),
        line(p(`  ⎿  "${oneLine(ev.text, 140)}"`, 'dim')),
      ]
    }
    case 'done':
      return [line(p('✓ 끝남', 'ok'))]
    default:
      return []
  }
}

export const waitingLine = (): Line => line(p('승인을 기다리는 중…', 'am'))
