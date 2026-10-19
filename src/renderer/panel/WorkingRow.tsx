import { useNow } from '../lib/useNow'
import { elapsed } from '../lib/words'

/**
 * 대화 맨 아래 '작업 중…' 줄 — Claude Code 의 작업 중 표시처럼, 에이전트가 일하는 동안만 대화 끝에 붙는다.
 * 초록 점(관계도의 작업 중과 같은 색) · 빛이 지나가는 '작업 중…' · 지난 시간(1초마다).
 * since 를 모르면(앱을 열 때 이미 일하던 중) 시간 없이. 움직임 줄이기면 점·글자가 움직이지 않는다(base.css).
 */
export function WorkingRow({ since }: { since?: number }) {
  const now = useNow(1000)
  return (
    <div className="ci-work" role="status">
      <span className="wk-dot" aria-hidden="true" />
      <span className="wk-t">작업 중…</span>
      {since !== undefined && (
        // 1초마다 바뀌는 수를 화면 읽기 프로그램이 매번 읽지 않게
        <span className="wk-time" aria-hidden="true">
          {elapsed(since, now)}
        </span>
      )}
    </div>
  )
}
