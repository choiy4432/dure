import { useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Decision, PendingRequest } from '../../../engine/types'
import { requestTarget, requestTitle } from '../../lib/toolSummary'
import { ago } from '../../lib/words'
import { getStore } from '../../state/store'
import { useCall } from './useCall'
import { useMotion } from '../../lib/presence'
import { MOTION } from '../../lib/motion'

// 자세히 — 파일 전체를 쓰는 입력은 아주 길 수 있다. 앞부분만
const DETAIL_MAX = 4000

function inputText(input: unknown): string {
  let text: string
  try {
    text = JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    text = String(input)
  }
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}\n…` : text
}

interface Props {
  request: PendingRequest
  agent: { name: string; folder: string }
  now: number
  /** '내가 할 일' 목록 안의 카드 — '항상 허용'은 에이전트 패널에서만(여기선 그 대신 대화 보기) */
  inInbox?: boolean
}

/** 권한 카드 — 관계도 카드의 앰버 칸과 같은 제목(서브에이전트가 물은 것이면 그렇다고)·대상, 자세히(입력 접힘) · [허용] [거절] · 항상 허용 */
export function PermissionCard({ request, agent, now, inInbox = false }: Props) {
  const { busy, error, call } = useCall()
  const root = useRef<HTMLElement>(null)
  useMotion(root, MOTION.line)
  const [more, setMore] = useState(false)
  // 서브에이전트가 물은 것이면 '디자인의 서브에이전트가 …' — 관계도 카드의 승인 칸과 같은 제목
  const title = requestTitle(agent.name, request.toolName, request.input, request.fromSubagent)
  const target = requestTarget(request.toolName, request.input, agent.folder)
  // 성공하면 엔진이 요청을 지워 카드가 사라진다 — 그동안 버튼은 막아 둔다
  const answer = (d: Decision) => call(() => window.dure.answerRequest(request.id, d), 'hold')

  return (
    <section ref={root} className="pin ask" aria-label={title}>
      <div className="ask-h">
        <b className="ask-t">{title}</b>
        <span className="pin-t">{ago(request.createdAt, now)}</span>
      </div>
      <div className="ask-row">
        {target && (
          <code className="trunc" title={target}>
            {target}
          </code>
        )}
        <button type="button" className="lk ask-more" aria-expanded={more} onClick={() => setMore(m => !m)}>
          자세히
          <ChevronDown className="i" size={14} aria-hidden="true" />
        </button>
      </div>
      {more && <pre className="ask-json">{inputText(request.input)}</pre>}
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
            이 에이전트에선 항상 허용
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
