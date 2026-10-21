import { memo, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { ShieldAlert } from 'lucide-react'
import type { AgentId, Decision, PendingRequest } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { getStore, useDure } from '../state/store'
import { displayStatus, unreadFor, type DisplayStatus } from '../state/selectors'
import { requestTarget, requestTitle } from '../lib/toolSummary'
import { ago, initial, josa, lasting, nodeModelLabel, STATUS_WORD } from '../lib/words'
import { useNow } from '../lib/useNow'
import { MOTION, popOnce, useRise } from '../lib/motion'
import { useMotion } from '../lib/presence'
import { peekFresh, takeFresh } from './freshNodes'

export type AgentFlowNode = Node<Record<string, never>, 'agent'>

/** 이보다 긴 역할은 최소 6em 을 지킨다(.nr .floor) — 짧은 역할은 제 폭 그대로 */
const ROLE_FLOOR_CHARS = 6
const ACTIVITY_MAX = 40
const ERROR_MAX = 30

const STATUS: Record<DisplayStatus, { dot: string; tone: string }> = {
  working: { dot: 'g', tone: 'w' },
  awaiting: { dot: 'a', tone: 'p' },
  idle: { dot: 's', tone: '' },
  stopped: { dot: 's', tone: '' },
  error: { dot: 'r', tone: 'e' },
}

const STATUS_LINE: Record<DisplayStatus, string> = {
  working: '일하는 중…',
  awaiting: '승인을 기다리는 중',
  idle: '기다리는 중',
  stopped: '기다리는 중',
  error: '오류로 멈췄어요',
}

/** 앞 max 자 — 마크다운 기호와 줄바꿈은 걷어 한 줄로, 넘치면 '…' */
function clip(text: string, max: number): string {
  const flat = text.replace(/[`*]/g, '').replace(/^\s*#+\s*/, '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? chars.slice(0, max).join('') + '…' : flat
}

function useCardView(agentId: AgentId) {
  return useDure(s => {
    const agent = s.agents.find(a => a.id === agentId)
    if (!agent) return null
    let request: PendingRequest | null = null
    for (const r of s.requests) if (r.agentId === agentId && (!request || r.createdAt < request.createdAt)) request = r
    let firstUnreadFrom: AgentId | null = null
    let firstUnreadAt = Infinity
    let lastMessageAt = 0
    for (const m of s.messages) {
      if (m.from === agentId || m.to === agentId) lastMessageAt = Math.max(lastMessageAt, m.updatedAt)
      if (m.to === agentId && (m.state === 'pending' || m.state === 'held') && m.createdAt < firstUnreadAt) {
        firstUnreadAt = m.createdAt
        firstUnreadFrom = m.from
      }
    }
    return {
      agent,
      request,
      status: displayStatus(agent, s.requests),
      unread: unreadFor(agentId, s.messages),
      sender: firstUnreadFrom ? (s.agents.find(a => a.id === firstUnreadFrom)?.name ?? '') : '',
      selected: s.selectedAgentId === agentId,
      streaming: s.streaming[agentId] ?? '',
      last: s.lastText[agentId] ?? null,
      lastMessageAt,
      since: s.statusSince[agentId] ?? null,
    }
  })
}

type CardView = NonNullable<ReturnType<typeof useCardView>>

function activityLine(v: CardView): string {
  if (v.status === 'working' && v.streaming.trim()) return clip(v.streaming, ACTIVITY_MAX)
  // 흐르는 글이 없고 서브에이전트가 돈다 — 부모 차례가 끝나 서브에이전트만 돌 때도 이 줄
  const subagents = v.agent.subagentsRunning.length
  if (subagents > 0) return `서브에이전트 ${subagents}개가 일하는 중`
  if (v.status === 'working') return STATUS_LINE.working
  if (v.unread > 0 && v.sender && v.status !== 'error') return `${v.sender}${josa(v.sender, '이/가')} 보낸 메시지 확인 전`
  if (v.last) return clip(v.last.text, ACTIVITY_MAX)
  return STATUS_LINE[v.status]
}

/** 바닥 오른쪽 시각 — 작업 중 'N분째' · 승인 기다림 'N분 전' · 그 밖은 마지막 답·메시지 시각 */
function timeText(v: CardView, now: number): string {
  // 언제부터인지 모르면(켤 때 이미 작업 중이던 에이전트) 쓰지 않는다 — '방금 시작' 은 거짓말이 된다
  if (v.status === 'working') return v.since !== null ? lasting(v.since, now) : ''
  if (v.status === 'awaiting') {
    const at = v.request?.createdAt ?? v.since
    return at !== null ? ago(at, now) : ''
  }
  const lastAt = Math.max(v.last?.at ?? 0, v.lastMessageAt)
  return lastAt > 0 ? ago(lastAt, now) : ''
}

const stop = (e: MouseEvent) => e.stopPropagation()

function Approval({ agent, request }: { agent: AgentView; request: PendingRequest }) {
  const [busy, setBusy] = useState(false)
  const answer = (d: Decision) => {
    setBusy(true)
    // 성공하면 엔진이 요청을 지워 이 칸이 사라진다 — 실패(이미 끝난 요청 등)면 다시 누를 수 있게
    window.dure.answerRequest(request.id, d).catch(() => setBusy(false))
  }
  const target = requestTarget(request.toolName, request.input, agent.folder)
  return (
    <div className="ap nodrag" onClick={stop}>
      <b className="ap-t">{requestTitle(agent.name, request.toolName, request.input, request.fromSubagent)}</b>
      {target && (
        <code className="trunc" title={target}>
          {target}
        </code>
      )}
      <div className="ab">
        <button type="button" className="btn pri sm" disabled={busy} onClick={() => answer({ type: 'allow' })}>
          허용
        </button>
        <button type="button" className="btn sec sm" disabled={busy} onClick={() => answer({ type: 'deny' })}>
          거절
        </button>
        <button type="button" className="lk" disabled={busy} onClick={() => answer({ type: 'allow-always' })}>
          이 에이전트에선 항상 허용
        </button>
      </div>
    </div>
  )
}

/** 관계도 카드 몸통(시안 .nd) — 스토어에서 그 에이전트의 상태를 읽어 그린다 */
export function AgentCard({ agentId }: { agentId: AgentId }) {
  const v = useCardView(agentId)
  const now = useNow()
  // 넘김 서명 — 받은 메시지가 늘 때(도착하는 순간) 배지가 한 번 튄다. 처음 그릴 때·줄어들 때·움직임 줄이기는 튀지 않는다
  const rise = useRise(v?.unread ?? 0)
  // 방금 더한 에이전트의 카드만 나타난다 — 앱 시작·방 바꾸기로 다시 그려진 카드는 표가 없어 그대로 있다
  const [appear] = useState(() => peekFresh(agentId))
  useEffect(() => void takeFresh(agentId), [agentId])
  const card = useRef<HTMLDivElement | null>(null)
  useMotion(card, MOTION.node, { appear })
  const badge = useRef<HTMLElement | null>(null)
  const setBadge = useCallback((el: HTMLElement | null) => {
    badge.current = el
  }, [])
  useEffect(() => (rise ? popOnce(badge.current) : undefined), [rise])
  if (!v) return null

  const { agent, request, unread, selected, status } = v
  // 역할 옆 '모델 · effort' — effort 는 Claude Code 가 쓰는 단계 이름 그대로
  const level = agent.effortNow ?? agent.effort
  const meta = [nodeModelLabel(agent.model, agent.modelNow), level].filter(Boolean).join(' · ')
  const roleLine = agent.role ? `${agent.role} · ${meta}` : meta
  const st = STATUS[status]
  const time = timeText(v, now)
  const errorText = status === 'error' && agent.errorText ? agent.errorText : null

  return (
    // 권한 요청 칸이 있으면 시안처럼 넓게(304px) — [허용][거절]·링크가 한 줄에 들어가 카드가 격자 한 칸(layout.ts CELL, 높이 217) 안에 머문다
    <div
      ref={card}
      className={`nd${selected ? ' sel' : ''}${agent.bypass ? ' byp' : ''}${request ? ' pend' : ''}${request?.kind === 'permission' ? ' wide' : ''}`}
      data-status={status}
    >
      <div className="nh">
        <span className={`av${selected ? ' b' : ''}`} aria-hidden="true">
          {initial(agent.name)}
        </span>
        <div className="nt">
          <span className="nn">
            <b className="trunc" title={agent.name}>
              {agent.name}
            </b>
            {agent.bypass && !agent.bypassNoticeClosed && (
              <span className="bp" role="img" aria-label="묻지 않고 실행해요" title="묻지 않고 실행해요">
                <ShieldAlert className="i" size={14} aria-hidden="true" />
              </span>
            )}
          </span>
          <span className="nr" title={roleLine}>
            {agent.role && (
              // 구분 점은 역할 쪽에 붙인다 — 줄이 나뉘어도 둘째 줄이 "·" 로 시작하지 않는다
              <span className={`nr-role${agent.role.length > ROLE_FLOOR_CHARS ? ' floor' : ''}`}>
                <span className="trunc">{agent.role}</span>
                <span className="nr-sep keep"> · </span>
              </span>
            )}
            <span className="nr-meta keep">{meta}</span>
          </span>
        </div>
        {/* 묻지 않음(테두리 주황과 같은 상태 — Claude 가 알려 준 실제 모드)이면 자동 켬/끔 대신 */}
        {agent.bypass ? (
          <span className="au byp">묻지 않음</span>
        ) : (
          <span className={`au${agent.auto ? ' on' : ''}`}>{agent.auto ? '자동 켬' : '자동 끔'}</span>
        )}
      </div>

      {request?.kind === 'question' ? (
        <div className="ap nodrag" onClick={stop}>
          <button type="button" className="lk" onClick={() => getStore().selectAgent(agent.id)}>
            질문이 있어요 · 패널에서 답하기
          </button>
        </div>
      ) : request ? (
        <Approval key={request.id} agent={agent} request={request} />
      ) : (
        <div className="na trunc">{activityLine(v)}</div>
      )}

      <div className="nf">
        <span className={`st${st.tone ? ` ${st.tone}` : ''}`}>
          <i className={`dot ${st.dot}`} aria-hidden="true" />
          <span className="st-l">{STATUS_WORD[status]}</span>
          {errorText && (
            <span className="nf-err trunc" title={errorText}>
              {clip(errorText, ERROR_MAX)}
            </span>
          )}
        </span>
        {unread > 0 ? (
          <span className="um">
            받은 메시지<b ref={setBadge}>{unread}</b>
          </span>
        ) : (
          time && <span className="nf-t">{time}</span>
        )}
      </div>
    </div>
  )
}

/** React Flow 노드 — 보이지 않는 연결점 둘(엣지는 HandoffEdge 가 카드 테두리에서 직접 잇는다) + 카드 */
export const AgentNode = memo(function AgentNode({ id }: NodeProps<AgentFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="nd-port" />
      <AgentCard agentId={id} />
      <Handle type="source" position={Position.Right} isConnectable={false} className="nd-port" />
    </>
  )
})
