import { useRef, useState } from 'react'
import { MessageCircleQuestionMark } from 'lucide-react'
import type { AgentId, PendingRequest } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { inboxView } from '../state/inbox'
import { roomTotal, todoCounts } from '../state/attention'
import { useNow } from '../lib/useNow'
import { PresenceList, useMotion } from '../lib/presence'
import { MOTION } from '../lib/motion'
import { createAgentPlan, requestTitle } from '../lib/toolSummary'
import { FRESH_WORD, PHASE_WORD, ago, elapsed } from '../lib/words'
import { Clamp } from '../lib/Clamp'
import { MessageCard, pinOpen } from './cards/MessageCard'
import { PermissionCard } from './cards/PermissionCard'
import { HeldChainCard } from './cards/HeldChainCard'
import { readQuestions } from './cards/QuestionCard'

const select = (id: AgentId) => getStore().selectAgent(id)

/** 질문 항목 — 보기를 여기서 고르게 하지 않고(길다) 첫 질문 한 줄만 보여 그 에이전트 패널로 보낸다 */
function QuestionItem({ request, name, now }: { request: PendingRequest; name: string; now: number }) {
  const root = useRef<HTMLElement>(null)
  useMotion(root, MOTION.line)
  const title = `${name}에게 질문이 있어요`
  const first = readQuestions(request.input)[0]?.question
  return (
    <section ref={root} className="pin ask" aria-label={title}>
      <div className="ask-h">
        <MessageCircleQuestionMark className="i qc-ic" aria-hidden="true" />
        <b className="ask-t">{title}</b>
        <span className="pin-t">{ago(request.createdAt, now)}</span>
      </div>
      {first && <p className="ib-line">{first}</p>}
      <div className="ab">
        <button type="button" className="btn pri sm" onClick={() => select(request.agentId)}>
          답하기
        </button>
      </div>
    </section>
  )
}

/** 새 에이전트 만들기 항목 — 만들 내용(첫 할 일 포함)은 패널의 카드에서 보고 정한다 */
function CreateItem({ request, name, now }: { request: PendingRequest; name: string; now: number }) {
  const root = useRef<HTMLElement>(null)
  useMotion(root, MOTION.line)
  const title = requestTitle(name, request.toolName, request.input, request.fromSubagent)
  const plan = createAgentPlan(request.input)
  const who = [plan.name, plan.role].filter(Boolean).join(' · ')
  return (
    <section ref={root} className="pin ask" aria-label={title}>
      <div className="ask-h">
        <b className="ask-t">{title}</b>
        <span className="pin-t">{ago(request.createdAt, now)}</span>
      </div>
      {who && <p className="ib-line">{who}</p>}
      <div className="ab">
        <button type="button" className="btn pri sm" onClick={() => select(request.agentId)}>
          패널에서 확인하기
        </button>
      </div>
    </section>
  )
}

/** 새 결과 항목 — 마지막 답 두 줄(줄임)과 대화 보기. 고르면 fresh 가 풀려 항목이 사라진다 */
function FreshItem({ agentId, name, text, at, now }: { agentId: AgentId; name: string; text: string; at: number; now: number }) {
  const root = useRef<HTMLElement>(null)
  useMotion(root, MOTION.line)
  const title = `${name} · ${FRESH_WORD}`
  return (
    <section ref={root} className="pin ib-fresh" aria-label={title}>
      <div className="ask-h">
        <i className="dot n" aria-hidden="true" />
        <b className="ask-t">{title}</b>
        <span className="pin-t">{ago(at, now)}</span>
      </div>
      {text && (
        <Clamp lines={2} className="ib-line">
          {text}
        </Clamp>
      )}
      <div className="ab">
        <button type="button" className="btn sec sm" onClick={() => select(agentId)}>
          대화 보기
        </button>
      </div>
    </section>
  )
}

/**
 * 아무 에이전트도 안 골랐을 때의 오른쪽 패널 — 지금 방에서 사람이 처리할 것.
 * 위에서부터: ① 권한·질문·새 에이전트 만들기(막힌 일) → ② 확인할 받은 메시지·자동 멈춤 → ③ 새 결과 → 지금 하는 일 → 다른 방 안내.
 * 묶음 안은 오래된 것이 위(순수 시간순이면 막힌 승인이 오래된 새 결과 밑으로 밀린다).
 */
export function Inbox() {
  const v = useDure(s => ({
    roomId: s.roomId, agents: s.agents, requests: s.requests, messages: s.messages, fresh: s.fresh, limit: s.autoChainLimit,
    thinking: s.thinking, phase: s.phase, since: s.statusSince, last: s.lastText,
  }))
  const now = useNow()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (v.roomId === null) return <div className="inbox" />

  const view = inboxView(v, v.roomId)
  const nameOf = (id: AgentId) => v.agents.find(a => a.id === id)?.name ?? '지워진 에이전트'
  const count = roomTotal(todoCounts(v).rooms[v.roomId])
  const empty = view.asks.length === 0 && view.messages.length === 0 && !view.held && view.fresh.length === 0

  return (
    <div className="inbox">
      <div className="ib-h">
        <b>내가 할 일</b>
        <span>{count}</span>
      </div>
      {empty && (
        <div className="ib-empty">
          <p className="ib-empty-t">지금 할 일이 없어요</p>
          <p className="ib-empty-d">에이전트가 승인이나 확인을 부탁하면 여기에 모여요.</p>
        </div>
      )}
      <PresenceList key={v.roomId}>
        {view.asks.map(r => {
          const a = v.agents.find(x => x.id === r.agentId)
          if (!a) return null
          return r.kind === 'question' ? (
            <QuestionItem key={r.id} request={r} name={a.name} now={now} />
          ) : r.kind === 'create-agent' ? (
            <CreateItem key={r.id} request={r} name={a.name} now={now} />
          ) : (
            <PermissionCard key={r.id} request={r} agent={a} now={now} inInbox />
          )
        })}
        {view.messages.map(m => (
          <MessageCard
            key={m.id}
            message={m as typeof m & { state: 'pending' }}
            fromName={nameOf(m.from)}
            toName={nameOf(m.to)}
            now={now}
            open={pinOpen(m as typeof m & { state: 'pending' }, open, now)}
            onOpenChange={o => setOpen(c => ({ ...c, [m.id]: o }))}
          />
        ))}
        {view.held && <HeldChainCard key="held" roomId={v.roomId} limit={v.limit} />}
      </PresenceList>
      {view.fresh.length > 0 && (
        <>
          <h3 className="ib-sub">새 결과</h3>
          <PresenceList key={`f-${v.roomId}`}>
            {view.fresh.map(f => (
              <FreshItem key={f.agentId} agentId={f.agentId} name={nameOf(f.agentId)} text={v.last[f.agentId]?.text ?? ''} at={f.at} now={now} />
            ))}
          </PresenceList>
        </>
      )}
      {view.running.length > 0 && (
        <>
          <h3 className="ib-sub">지금 하는 일</h3>
          <ul className="ib-runs">
            {view.running.map(id => {
              const since = v.since[id]
              const word = v.thinking[id] ? '생각하는 중…' : v.phase[id] ? PHASE_WORD[v.phase[id]] : '작업 중…'
              return (
                <li key={id} className="ib-run">
                  <button type="button" onClick={() => select(id)}>
                    <i className="wk-dot" aria-hidden="true" />
                    <b className="trunc">{nameOf(id)}</b>
                    <span className="ib-word">{word}</span>
                    {since !== undefined && <span className="pin-t">{elapsed(since, now)}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {view.otherRooms > 0 && (
        <button type="button" className="ib-other" onClick={() => getStore().requestRoomMenu()}>
          다른 방에도 할 일 {view.otherRooms}개
        </button>
      )}
    </div>
  )
}
