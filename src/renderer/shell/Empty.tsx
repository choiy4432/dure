import { Plus } from 'lucide-react'

export type EmptyKind = 'claude' | 'room' | 'agent'

const COPY: Record<EmptyKind, { title: string; text?: string; action?: string }> = {
  claude: { title: 'Claude Code 가 필요해요', text: '설치·로그인 안내는 곧 들어갑니다' },
  room: { title: '첫 방을 만들어 보세요', action: '방 만들기' },
  agent: { title: '첫 에이전트를 추가해 보세요', action: '추가' },
}

interface Props {
  kind: EmptyKind
  /** 버튼을 누르면 — 방 만들기·에이전트 추가 대화상자를 연다 */
  onAction?: () => void
}

/** 관계도 바탕 가운데에 놓이는 빈 화면 안내 */
export function Empty({ kind, onAction }: Props) {
  const c = COPY[kind]
  return (
    <div className="empty">
      <div className="empty-card">
        <p className="empty-t">{c.title}</p>
        {c.text && <p className="empty-d">{c.text}</p>}
        {c.action && (
          <button type="button" className="btn pri" onClick={onAction}>
            <Plus className="i" />
            {c.action}
          </button>
        )}
      </div>
    </div>
  )
}
