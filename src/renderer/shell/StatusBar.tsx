import { useDure } from '../state/store'
import { UsageMeters } from './UsageMeters'

/** 창 맨 아래 상태 띠 — 왼쪽에 플랜 사용량(펼침은 위로), 오른쪽에 켤 때 claude 최신으로 바꾸는 중일 때만 한 줄 */
export function StatusBar() {
  const updating = useDure(s => s.app.claudeUpdate === 'running')
  return (
    <footer className="sbar">
      <UsageMeters />
      {updating && <span className="sbar-note" role="status">claude 최신으로 바꾸는 중…</span>}
    </footer>
  )
}
