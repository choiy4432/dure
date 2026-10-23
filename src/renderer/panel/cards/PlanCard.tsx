import { useEffect, useRef, useState } from 'react'
import type { AgentId, PendingRequest } from '../../../engine/types'
import { ago, josa } from '../../lib/words'
import { Markdown } from '../../lib/Markdown'
import { useCall } from './useCall'
import { useMotion } from '../../lib/presence'
import { MOTION } from '../../lib/motion'

interface Props {
  request: PendingRequest
  agent: { id: AgentId; name: string }
  now: number
  /** 내가 할 일 목록 안 — 지금은 패널과 같은 모양이다(자리만 구분해 둔다) */
  inInbox?: boolean
}

/** 요청 입력에서 계획 글 — 모양이 어긋나도 죽지 않게 빈 글로 */
export function readPlan(input: unknown): string {
  const p = (input as { plan?: unknown } | null)?.plan
  return typeof p === 'string' ? p : ''
}

/**
 * 계획 카드 — 계획 모드의 에이전트가 계획을 다 세웠다(ExitPlanMode, kind 'plan'). 계획 전체를 흰 판 안에 보여 주고
 * [이대로 진행](허용) · [고쳐 달라고 하기](고칠 점을 적어 거절 — Claude 가 고쳐서 새 계획을 보낸다) · [그만](멈추기, 계획 모드도 끝난다)
 */
export function PlanCard({ request, agent, now, inInbox }: Props) {
  const { busy, error, call } = useCall()
  const root = useRef<HTMLElement>(null)
  useMotion(root, MOTION.line)
  const [revising, setRevising] = useState(false)
  const [note, setNote] = useState('')
  const noteBox = useRef<HTMLTextAreaElement>(null)
  const reviseButton = useRef<HTMLButtonElement>(null)
  const wasRevising = useRef(false)
  // 누른 단추가 사라진다 — 열면 입력칸으로, [취소]로 닫으면 다시 '고쳐 달라고 하기'로(초점이 body 로 떨어지지 않게)
  useEffect(() => {
    if (revising) noteBox.current?.focus()
    else if (wasRevising.current) reviseButton.current?.focus()
    wasRevising.current = revising
  }, [revising])
  const title = `${agent.name}${josa(agent.name, '이/가')} 계획을 세웠어요 — 보고 정해 주세요`
  const message = note.trim()

  return (
    <section ref={root} className={`pin ask${inInbox ? ' in-inbox' : ''}`} aria-label={title}>
      <div className="ask-h">
        <b className="ask-t">{title}</b>
        <span className="pin-t">{ago(request.createdAt, now)}</span>
      </div>
      <div className="pl-box">
        <Markdown text={readPlan(request.input)} />
      </div>
      {revising && (
        <textarea
          ref={noteBox}
          className="pl-note"
          rows={3}
          aria-label="고칠 점"
          placeholder="어떻게 고치면 좋을지 적어 주세요"
          value={note}
          disabled={busy}
          onChange={e => setNote(e.target.value)}
        />
      )}
      <div className="ab">
        {revising ? (
          <>
            <button
              type="button"
              className="btn pri sm"
              aria-label="고칠 점 보내기"
              disabled={busy || message === ''}
              onClick={() => call(() => window.dure.answerRequest(request.id, { type: 'deny', message }), 'hold')}
            >
              보내기
            </button>
            <button type="button" className="btn sec sm" disabled={busy} onClick={() => setRevising(false)}>
              취소
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn pri sm"
              disabled={busy}
              onClick={() => call(() => window.dure.answerRequest(request.id, { type: 'allow' }), 'hold')}
            >
              이대로 진행
            </button>
            <button ref={reviseButton} type="button" className="btn sec sm" disabled={busy} onClick={() => setRevising(true)}>
              고쳐 달라고 하기
            </button>
          </>
        )}
        <button type="button" className="lk" disabled={busy} onClick={() => call(() => window.dure.interrupt(agent.id))}>
          그만
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
