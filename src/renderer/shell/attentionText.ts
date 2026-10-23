import type { PendingRequest } from '../../engine/types'
import { createAgentPlan, requestTarget, requestTitle } from '../lib/toolSummary'
import { josa } from '../lib/words'
import { readPlan } from '../panel/cards/PlanCard'
import { readQuestions } from '../panel/cards/QuestionCard'

// 순수 모듈 — 창 제목·알림·읽어 줄 글의 문구 정본. 훅(useAttention)은 이 글을 부르기만 한다

/** 창 제목 — 할 일이 있으면 앞에 (N), 방이 있으면 뒤에 방 이름 */
export function windowTitle(total: number, roomName: string | null): string {
  const base = roomName ? `두레 — ${roomName}` : '두레'
  return total > 0 ? `(${total}) ${base}` : base
}

/** 새 승인 요청의 Windows 알림 글 */
export function askNotice(request: PendingRequest, agent: { name: string; folder: string }): { title: string; body: string } {
  if (request.kind === 'question') {
    return { title: `${agent.name}에게 질문이 있어요`, body: (readQuestions(request.input)[0]?.question ?? '').split(/\r?\n/)[0] }
  }
  if (request.kind === 'plan') {
    const first = readPlan(request.input)
      .split(/\r?\n/)
      .map(l => l.replace(/^[#\s]+/, '').trim())
      .find(l => l !== '')
    return { title: `${agent.name}${josa(agent.name, '이/가')} 계획을 세웠어요`, body: first ?? '' }
  }
  const title = requestTitle(agent.name, request.toolName, request.input, request.fromSubagent === true)
  if (request.kind === 'create-agent') {
    const plan = createAgentPlan(request.input)
    return { title, body: `${plan.name}${plan.role ? ' · ' + plan.role : ''}` }
  }
  return { title, body: requestTarget(request.toolName, request.input, agent.folder) ?? '' }
}

/** 일이 끝났다는 알림 글 — 본문은 마지막 글의 첫 줄 */
export function finishedNotice(name: string, lastText: string | null): { title: string; body: string } {
  return { title: `${name}${josa(name, '이/가')} 일을 끝냈어요`, body: lastText ? (lastText.split(/\r?\n/)[0] ?? '') : '' }
}

/** 화면 읽기 프로그램이 읽어 줄 글 — 새 승인 요청 */
export function announceAsk(request: PendingRequest, name: string): string {
  if (request.kind === 'question') return `${name}에게 질문이 있어요`
  if (request.kind === 'plan') return `${name}${josa(name, '이/가')} 계획을 세웠어요`
  if (request.kind === 'create-agent') return `${name}${josa(name, '이/가')} 새 에이전트를 만들려 해요`
  return `${name}${josa(name, '이/가')} 승인을 기다려요`
}

export const announceMessage = (toName: string): string => `${toName}에게 메시지가 왔어요`

/** 작업표시줄 배지 글 — 0 은 배지 없음, 두 자리부터는 '9+' */
export function badgeText(count: number): string | null {
  if (count <= 0) return null
  return count > 9 ? '9+' : String(count)
}
