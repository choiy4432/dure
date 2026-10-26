import { useState } from 'react'
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, Clock } from 'lucide-react'
import type { AgentId, RelayMessage } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { messagesOf } from '../state/selectors'
import { Markdown } from '../lib/Markdown'
import { Clamp } from '../lib/Clamp'
import { ExpandBox } from '../lib/ExpandBox'
import { Presence } from '../lib/presence'
import { useNow } from '../lib/useNow'
import { ago, firstLine, josa, MESSAGE_WORD } from '../lib/words'
import { useCall } from './cards/useCall'

/**
 * 메시지 탭(시안 A · 한 줄 목록) — 이 에이전트가 받은 메시지와 보낸 메시지를 새것부터 한 줄씩.
 * 줄 = 방향 아이콘 · '기획 → 웹'(상대 이름만 굵게) · 접혀 있으면 첫 줄 · 상태 꼬리표 · 시각. 줄을 누르면 그 자리에서 펼쳐 전문(마크다운).
 * 내 확인이 필요한 것은 처음부터 펼친 채 주황 테두리 + [일 시키기] [나중에](나중에 = 접기 — 고정 카드와 같다, 보낸 메시지도 여기서 시작시킬 수 있다).
 * 전달된 것은 '대화에서 보기' — 받은 것은 이 대화의 그 줄로, 보낸 것은 받은 에이전트의 대화로 간다. 버린 것은 흐리게.
 * 자동 멈춤은 꼬리표만 — 계속은 방에 한 장인 자동 상한 카드가 맡는다.
 */
export function MessageList({ agentId }: { agentId: AgentId }) {
  const v = useDure(s => ({ agents: s.agents, messages: s.messages }))
  const now = useNow()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const list = messagesOf(agentId, v.messages)
  const nameOf = (id: AgentId) => v.agents.find(a => a.id === id)?.name ?? null
  return (
    <section className="mlist" aria-label="메시지">
      <ul className="mrows">
        {list.map(m => (
          <MessageRow
            key={m.id}
            message={m}
            me={agentId}
            nameOf={nameOf}
            now={now}
            open={open[m.id] ?? m.state === 'pending'}
            onOpenChange={o => setOpen(prev => ({ ...prev, [m.id]: o }))}
          />
        ))}
      </ul>
    </section>
  )
}

function MessageRow({ message: m, me, nameOf, now, open, onOpenChange }: {
  message: RelayMessage
  me: AgentId
  nameOf: (id: AgentId) => string | null
  now: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { busy, error, call } = useCall()
  const out = m.from === me
  const from = nameOf(m.from) ?? '지워진 에이전트'
  const to = nameOf(m.to) ?? '지워진 에이전트'
  const other = out ? to : from
  const pending = m.state === 'pending'
  // 전달된 것은 전달된 때, 기다리는 것은 보낸 때(고정 카드와 같다)
  const time = ago(m.state === 'delivered' ? m.updatedAt : m.createdAt, now)
  const label = `${from}${josa(from, '이/가')} ${to}에게 보낸 메시지${open ? '' : ` — ${firstLine(m.text)}`}`
  // 보낸 메시지는 받은 에이전트의 대화로 — 받은 에이전트가 지워졌으면 갈 곳이 없다
  const seeIn = out ? (nameOf(m.to) ? m.to : null) : me
  const cls = `mrow${open ? ' open' : ''}${pending ? ' wait' : ''}${m.state === 'dismissed' ? ' gone' : ''}`
  return (
    <li className={cls}>
      <div className="mrow-h">
        <button type="button" className="mrow-tg" aria-expanded={open} aria-label={label} onClick={() => onOpenChange(!open)}>
          <span className={`mrow-d${out ? ' out' : ''}`} aria-hidden="true">
            {out ? <ArrowUpRight className="i" size={14} /> : <ArrowDownLeft className="i" size={14} />}
          </span>
          <span className="mrow-who">
            {out ? from : <b>{from}</b>}
            <ArrowRight className="i mrow-ar" size={12} aria-hidden="true" />
            {out ? <b>{to}</b> : to}
          </span>
          {!open && <span className="mrow-tx">{firstLine(m.text)}</span>}
        </button>
        <span className={`tag${m.state === 'delivered' ? ' ok' : ''}`}>
          {m.state === 'delivered' ? (
            <Check className="i" size={14} strokeWidth={2} aria-hidden="true" />
          ) : m.state !== 'dismissed' ? (
            <Clock className="i" size={14} strokeWidth={2} aria-hidden="true" />
          ) : null}
          {MESSAGE_WORD[m.state]}
        </span>
        <span className="mrow-tm">{time}</span>
      </div>
      <Presence show={open}>
        <ExpandBox outer="mrow-open">
          <div className="mrow-b">
            <Clamp className="clamp-md">
              <Markdown text={m.text} />
            </Clamp>
          </div>
          {pending ? (
            <div className="ab mrow-ab">
              <button type="button" className="btn pri sm" disabled={busy} onClick={() => call(() => window.dure.approveMessage(m.id))}>
                일 시키기
              </button>
              <button type="button" className="btn sec sm" onClick={() => onOpenChange(false)}>
                나중에
              </button>
            </div>
          ) : (
            m.state === 'delivered' &&
            seeIn && (
              <div className="mrow-ab">
                <button type="button" className="lk" onClick={() => getStore().showMessage(seeIn, m.id)}>
                  {out ? `${other} 대화에서 보기` : '대화에서 보기'}
                </button>
              </div>
            )
          )}
          {error && (
            <p className="pin-err" role="alert">
              {error}
            </p>
          )}
        </ExpandBox>
      </Presence>
    </li>
  )
}
