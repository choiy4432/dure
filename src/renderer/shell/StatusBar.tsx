import { UsageMeters } from './UsageMeters'

/** 창 맨 아래 상태 띠 — 왼쪽에 플랜 사용량(펼침은 위로). 오른쪽은 비워 둔다 */
export function StatusBar() {
  return (
    <footer className="sbar">
      <UsageMeters />
    </footer>
  )
}
