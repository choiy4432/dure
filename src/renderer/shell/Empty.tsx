import { Plus, RotateCw } from 'lucide-react'

export type EmptyKind = 'claude' | 'room' | 'agent' | 'load'

const COPY: Record<EmptyKind, { title: string; text?: string; action?: string }> = {
  claude: { title: 'Claude Code 가 필요해요', text: '설치·로그인 안내는 곧 들어갑니다' },
  room: { title: '첫 방을 만들어 보세요', action: '방 만들기' },
  agent: { title: '첫 에이전트를 추가해 보세요', action: '추가' },
  load: { title: '두레를 불러오지 못했어요', action: '다시 시도' },
}

interface Props {
  kind: EmptyKind
  /** 버튼을 누르면 — 방 만들기·에이전트 추가 대화상자를 열거나 다시 불러온다 */
  onAction?: () => void
  /** 제목 아래 글을 바꿔 쓴다(불러오기 오류의 까닭) */
  text?: string
  /** 버튼을 막는다(다시 불러오는 중) */
  busy?: boolean
}

/** 관계도 바탕 가운데에 놓이는 빈 화면 안내 */
export function Empty({ kind, onAction, text, busy }: Props) {
  const c = COPY[kind]
  const body = text ?? c.text
  const Icon = kind === 'load' ? RotateCw : Plus
  return (
    <div className="empty">
      <div className="empty-card" role={kind === 'load' ? 'alert' : undefined}>
        <p className="empty-t">{c.title}</p>
        {body && <p className="empty-d">{body}</p>}
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
