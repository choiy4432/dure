import { Plus, RotateCw } from 'lucide-react'

export type EmptyKind = 'claude' | 'room' | 'agent' | 'load'

const COPY: Record<EmptyKind, { title: string; text?: string; action?: string }> = {
  claude: { title: 'Claude Code 가 필요해요', text: '설치·로그인 안내는 곧 들어갑니다' },
  room: { title: '첫 방을 만들어 보세요', action: '방 만들기' },
  agent: { title: '첫 에이전트를 추가해 보세요', action: '추가' },
  load: { title: '두레를 불러오지 못했어요', text: '잠시 뒤 다시 시도해 주세요. 계속 안 되면 두레를 껐다 켜 주세요.', action: '다시 시도' },
}

interface Props {
  kind: EmptyKind
  /** 버튼을 누르면 — 방 만들기·에이전트 추가 대화상자를 열거나 다시 불러온다 */
  onAction?: () => void
  /** 제목 아래 글을 바꿔 쓴다(한국어 엔진 문구가 온 불러오기 오류) */
  text?: string
  /** 본문 아래 작은 회색 mono 줄 — 한국어가 아닌 오류 원문 */
  detail?: string
  /** 버튼을 막는다(다시 불러오는 중) */
  busy?: boolean
}

/** 관계도 바탕 가운데에 놓이는 빈 화면 안내 */
export function Empty({ kind, onAction, text, detail, busy }: Props) {
  const c = COPY[kind]
  const body = text ?? c.text
  const Icon = kind === 'load' ? RotateCw : Plus
  return (
    <div className="empty">
      <div className="empty-card" role={kind === 'load' ? 'alert' : undefined}>
        <p className="empty-t">{c.title}</p>
        {body && <p className="empty-d">{body}</p>}
        {detail && <p className="empty-x">{detail}</p>}
        {c.action && (
          <button type="button" className="btn pri" onClick={onAction} disabled={busy}>
            <Icon className="i" />
            {c.action}
          </button>
        )}
      </div>
    </div>
  )
}
