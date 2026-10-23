import { useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Decision, PendingRequest } from '../../../engine/types'
import { alwaysAllowLabel, requestTarget, requestTitle } from '../../lib/toolSummary'
import { commandLines, detailRows, requestWhy } from '../../lib/requestDetails'
import { ago } from '../../lib/words'
import { getStore } from '../../state/store'
import { useCall } from './useCall'
import { useMotion } from '../../lib/presence'
import { MOTION } from '../../lib/motion'

interface Props {
  request: PendingRequest
  agent: { name: string; folder: string }
  now: number
  /** '내가 할 일' 목록 안의 카드 — '항상 허용'은 에이전트 패널에서만(여기선 그 대신 대화 보기) */
  inInbox?: boolean
}

/** 권한 카드 — 관계도 카드의 앰버 칸과 같은 제목(서브에이전트가 물은 것이면 그렇다고) · 설명 · 명령 첫 줄/대상 · 자세히(칸별, 접힘) · [허용] [거절] · 범위를 밝힌 '앞으로 … 묻지 않기' */
export function PermissionCard({ request, agent, now, inInbox = false }: Props) {
  const { busy, error, call } = useCall()
  const root = useRef<HTMLElement>(null)
  useMotion(root, MOTION.line)
  const [more, setMore] = useState(false)
  // 서브에이전트가 물은 것이면 '디자인의 서브에이전트가 …' — 관계도 카드의 승인 칸과 같은 제목
  const title = requestTitle(agent.name, request.toolName, request.input, request.fromSubagent)
  const target = requestTarget(request.toolName, request.input, agent.folder)
  const why = requestWhy(request.input)
  // 명령이면 첫 줄만 코드 판에 — 나머지는 '+N줄'과 자세히로
  const cmd = commandLines(request.toolName, request.input)
  // 성공하면 엔진이 요청을 지워 카드가 사라진다 — 그동안 버튼은 막아 둔다
  const answer = (d: Decision) => call(() => window.dure.answerRequest(request.id, d), 'hold')

  return (
    <section ref={root} className="pin ask" aria-label={title}>
      <div className="ask-h">
        <b className="ask-t">{title}</b>
        <span className="pin-t">{ago(request.createdAt, now)}</span>
      </div>
      {why && (
        <p className="ask-why trunc" title={why}>
          {why}
        </p>
      )}
      <div className="ask-row">
        {cmd ? (
          <>
            <code className="ask-cmd trunc" title={cmd.first}>
              {cmd.first}
            </code>
            {cmd.more > 0 && <span className="ask-n">+{cmd.more}줄</span>}
          </>
        ) : (
          target && (
            <code className="trunc" title={target}>
              {target}
            </code>
          )
        )}
        <button type="button" className="lk ask-more" aria-expanded={more} onClick={() => setMore(m => !m)}>
          자세히
          <ChevronDown className="i" size={14} aria-hidden="true" />
        </button>
      </div>
      {more && (
        <dl className="ask-dl">
          {detailRows(request.toolName, request.input, agent.folder).map((r, i) => (
            <div key={i} className="ask-dr">
              <dt>{r.label}</dt>
              <dd className={r.mono ? 'mono' : undefined}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="ab">
        <button type="button" className="btn pri sm" disabled={busy} onClick={() => answer({ type: 'allow' })}>
          허용
        </button>
        <button type="button" className="btn sec sm" disabled={busy} onClick={() => answer({ type: 'deny' })}>
          거절
        </button>
        {inInbox ? (
          // 목록에서 눈에 안 띄게 영구 허용까지 하지 않게 — 대화를 보고 정하도록 그 에이전트 패널로 보낸다
          <button type="button" className="lk" onClick={() => getStore().selectAgent(request.agentId)}>
            대화 보기
          </button>
        ) : (
          <button type="button" className="lk" disabled={busy} onClick={() => answer({ type: 'allow-always' })}>
            {alwaysAllowLabel(agent.name, request.toolName)}
          </button>
        )}
      </div>
      {error && (
        <p className="pin-err" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
