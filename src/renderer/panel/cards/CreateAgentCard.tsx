import { useRef } from 'react'
import { ArrowRight } from 'lucide-react'
import type { Decision, PendingRequest } from '../../../engine/types'
import { createAgentPlan, requestTitle } from '../../lib/toolSummary'
import { ago } from '../../lib/words'
import { Markdown } from '../../lib/Markdown'
import { Clamp } from '../../lib/Clamp'
import { useCall } from './useCall'
import { useMotion } from '../../lib/presence'
import { MOTION } from '../../lib/motion'

interface Props {
  request: PendingRequest
  agent: { name: string }
  now: number
}

/**
 * 새 에이전트 만들기 카드 — 에이전트가 두레 도구 create_agent 로 같은 방에 새 에이전트를 만들려 한다(kind 'create-agent').
 * 권한 카드의 앰버 판에 새 이름(굵게) · 역할 · 폴더 전체 경로(고정폭) · 첫 할 일(있으면 — 받은 메시지 카드처럼 접힌 본문).
 * [만들기]는 첫 할 일 메시지의 승인이기도 하다(엔진이 확인 없이 보낸다) — 그래서 본문을 다 보여 준다. 매번 묻는다('항상 허용' 없음)
 */
export function CreateAgentCard({ request, agent, now }: Props) {
  const { busy, error, call } = useCall()
  const root = useRef<HTMLElement>(null)
  useMotion(root, MOTION.line)
  const title = requestTitle(agent.name, request.toolName, request.input, request.fromSubagent)
  const plan = createAgentPlan(request.input)
  // 성공하면 엔진이 요청을 지워 카드가 사라진다 — 그동안 단추는 막아 둔다
  const answer = (d: Decision) => call(() => window.dure.answerRequest(request.id, d), 'hold')

  return (
    <section ref={root} className="pin ask" aria-label={title}>
      <div className="ask-h">
        <b className="ask-t">{title}</b>
        <span className="pin-t">{ago(request.createdAt, now)}</span>
      </div>
      <div className="ca-who">
        <b className="trunc" title={plan.name}>
          {plan.name}
        </b>
        {plan.role && (
          <span className="trunc" title={plan.role}>
            · {plan.role}
          </span>
        )}
      </div>
      <div className="ask-row">
        <code className="trunc" title={plan.folder}>
          {plan.folder}
        </code>
      </div>
      {plan.task !== null && (
        <div className="ca-task">
          {/* 첫 할 일 = 만든 쪽이 새 에이전트에게 보내는 첫 메시지 — 받은 메시지 카드의 머리처럼 '보낼 쪽 → 받을 쪽' */}
          <div className="ca-to">
            <b className="trunc" title={agent.name}>
              {agent.name}
            </b>
            <ArrowRight className="i" size={14} aria-hidden="true" />
            <b className="trunc" title={plan.name}>
              {plan.name}
            </b>
          </div>
          <Clamp className="clamp-md">
            <Markdown text={plan.task} />
          </Clamp>
        </div>
      )}
      <div className="ab">
        <button type="button" className="btn pri sm" disabled={busy} onClick={() => answer({ type: 'allow' })}>
          만들기
        </button>
        <button type="button" className="btn sec sm" disabled={busy} onClick={() => answer({ type: 'deny' })}>
          거절
        </button>
      </div>
      {error && (
        <p className="pin-err" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
