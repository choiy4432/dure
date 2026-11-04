import { useRef } from 'react'
import type { AgentId, Hold } from '../../../engine/types'
import { ago, attachCount } from '../../lib/words'
import { useCall } from './useCall'
import { useMotion, MotionDiv, PresenceList } from '../../lib/presence'
import { MOTION } from '../../lib/motion'

interface Props {
  agent: { id: AgentId }
  hold: Hold
  /** 에이전트 이름 — 모르면 null */
  nameOf: (id: AgentId) => string | null
  now: number
}

/**
 * 붙잡기 카드 — 멈춘 에이전트가 붙잡고 있는 입력(내가 친 것 · 다른 에이전트가 보낸 것).
 * 줄마다 테두리 상자 한 줄(보낸 쪽 · 글 말줄임 · [빼기]) → [이어서 보내기](한 번에 보냄) · [모두 버리기]. 줄이 빠지면 MOTION.line 으로 나간다.
 */
export function HoldCard({ agent, hold, nameOf, now }: Props) {
  const { busy, error, call } = useCall()
  const root = useRef<HTMLElement>(null)
  useMotion(root, MOTION.line)
  const title = `멈췄어요 · 기다리는 입력 ${hold.items.length}개`

  return (
    <section ref={root} className="pin hd" aria-label={title}>
      <div className="ask-h">
        <b className="ask-t">{title}</b>
        <span className="pin-t">{ago(hold.since, now)}</span>
      </div>
      <div className="hd-list">
        <PresenceList>
          {hold.items.map(it => {
            const who = it.from ? nameOf(it.from) : null
            const from = it.source === 'human' ? '나' : `${who ?? '다른 에이전트'}에게서`
            return (
              <MotionDiv key={it.id} motion={MOTION.line} className="hd-row">
                <span className="hd-from">{from}</span>
                {/* 글 없는 입력은 그림·첨부 수 — 첨부만이면 '그림 0장'이 아니라 '첨부 2개' */}
                <span className="hd-text">{it.text !== '' ? it.text : attachCount(it.images, it.files ?? 0)}</span>
                <button
                  type="button"
                  className="lk"
                  disabled={busy}
                  onClick={() => call(() => window.dure.dropHoldItem(agent.id, it.id))}
                >
                  빼기
                </button>
              </MotionDiv>
            )
          })}
        </PresenceList>
      </div>
      <div className="ab">
        <button type="button" className="btn pri sm" disabled={busy} onClick={() => call(() => window.dure.resumeHold(agent.id), 'hold')}>
          이어서 보내기
        </button>
        <button type="button" className="btn sec sm" disabled={busy} onClick={() => call(() => window.dure.dropHold(agent.id), 'hold')}>
          모두 버리기
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
