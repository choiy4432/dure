// 대화 내보내기 — 지금 대화(마지막 '새 대화' 뒤)를 마크다운 글로. 대화창과 같은 줄(buildTranscript)에서 만든다 (순수)
import type { HistoryItem } from '../../engine/types'
import { buildTranscript, type ActionLine, type ChatLine, type ClaudePart } from '../state/transcript'

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const day = (d: Date) => `${d.getMonth() + 1}월 ${d.getDate()}일`
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 코드 조각 — 글에 백틱이 있으면 두 개로 감싸고 띄운다(마크다운 규칙) */
function code(s: string): string {
  return s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``
}

/** 코드 상자 — 글 안의 가장 긴 백틱 줄보다 길게 감싼다(명령 출력에 ``` 가 있어도 안 깨지게) */
function fence(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length))
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}\n${s}\n${f}`
}

/** 하는 일 한 줄 — 대화창 접힌 줄과 같은 말(동사 + 대상), 거절된 일은 표시 */
function actionLine(a: ActionLine): string {
  return `- ${a.verb}${a.target ? ` ${code(a.target)}` : ''}${a.denied ? ' — 거절됨' : ''}`
}

function claudeBody(parts: ClaudePart[]): string[] {
  return parts.map((p) => {
    if (p.type === 'text') return p.text
    if (p.type === 'acts') return p.actions.map(actionLine).join('\n')
    const what = p.description ? ` — ${p.description}` : ''
    const many = p.ids.length > 1 ? ` · ${p.ids.length}개` : ''
    return `- 서브에이전트에게 맡김${what}${many}`
  })
}

/** 한 줄의 덩어리들(빈 줄로 나눈다) — 머리가 있는 줄은 '### 누가 · 언제' 부터 */
function lineBlocks(line: ChatLine, when: string): string[] {
  switch (line.kind) {
    case 'me':
      return [`### 나 · ${when}`, ...(line.text ? [line.text] : []), ...(line.images.length ? [`[그림 ${line.images.length}장]`] : [])]
    case 'relay':
      return [`### ${line.from ? `${line.from}에게서 온 메시지` : '전달된 메시지'} · ${when}`, line.text]
    case 'claude':
      return [`### Claude · ${when}`, ...claudeBody(line.parts)]
    case 'notice':
      return [`> ${line.text}`]
    case 'local':
      return [fence(line.text)]
    case 'streaming':
      return []
  }
}

/**
 * 머리(이름 · 역할 · 내보낸 때) + 대화 줄 차례대로. 머리가 있는 줄의 시각은 날짜가 앞 줄과 다를 때만 날짜를 붙인다.
 * 보일 줄이 하나도 없으면 null — 내보낼 대화가 없다
 */
export function conversationMarkdown({ agent, items, now }: { agent: { name: string; role: string }; items: HistoryItem[]; now: number }): string | null {
  const { lines } = buildTranscript(items, undefined, Infinity)
  if (lines.length === 0) return null
  const out: string[] = [`# ${agent.name} — 대화`]
  const at = new Date(now)
  const meta = [...(agent.role ? [`- 역할: ${agent.role}`] : []), `- 내보낸 때: ${at.getFullYear()}년 ${day(at)} ${clock(at)}`]
  out.push(meta.join('\n'))
  let lastDay = ''
  for (const line of lines) {
    if (line.kind === 'streaming') continue
    const d = new Date(line.at)
    const when = dayKey(d) === lastDay ? clock(d) : `${day(d)} ${clock(d)}`
    if (line.kind !== 'notice' && line.kind !== 'local') lastDay = dayKey(d)
    out.push(...lineBlocks(line, when))
  }
  return `${out.join('\n\n')}\n`
}

/** 저장 창의 처음 이름 — '<이름>-대화-<YYYY-MM-DD>.md'(쓸 수 없는 글자는 main 이 바꾼다) */
export function exportFileName(name: string, now: number): string {
  return `${name}-대화-${dayKey(new Date(now))}.md`
}
