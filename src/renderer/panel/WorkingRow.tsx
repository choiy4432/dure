import { useRef } from 'react'
import { useNow } from '../lib/useNow'
import { elapsed, tokensText } from '../lib/words'
import { MOTION } from '../lib/motion'
import { useMotion } from '../lib/presence'

/**
 * 대화 맨 아래 '작업 중…' 줄 — Claude Code 의 작업 중 표시처럼, 에이전트가 일하는 동안만 대화 끝에 붙는다.
 * 초록 점(관계도의 작업 중과 같은 색) · 빛이 지나가는 '작업 중…' · 도는 서브에이전트 수(있을 때) · 지난 시간(1초마다).
 * Claude 가 생각하는 동안(thinking)은 '작업 중…' 자리에 '생각하는 중…', 지난 시간 뒤에 생각한 추정 토큰 수(알 때만) —
 * 내용은 오지 않지만 수가 오르니 멈추지 않았다는 게 보인다.
 * since 를 모르면(앱을 열 때 이미 일하던 중) 시간 없이. 움직임 줄이기면 점·글자가 움직이지 않는다(base.css).
 */
export function WorkingRow({ since, subagents = 0, thinking }: {
  since?: number
  subagents?: number
  thinking?: { tokens: number | null }
}) {
  const now = useNow(1000)
  const root = useRef<HTMLDivElement>(null)
  useMotion(root, MOTION.line)
  const tokens = thinking?.tokens ?? null
  return (
    <div ref={root} className="ci-work" role="status">
      <span className="wk-dot" aria-hidden="true" />
      <span className="wk-t">{thinking ? '생각하는 중…' : '작업 중…'}</span>
      {subagents > 0 && <span className="trunc">{`서브에이전트 ${subagents}개가 일하고 있어요`}</span>}
      {since !== undefined && (
        // 1초마다 바뀌는 수를 화면 읽기 프로그램이 매번 읽지 않게
        <span className="wk-time" aria-hidden="true">
          {elapsed(since, now)}
        </span>
      )}
      {tokens !== null && (
        // 생각하는 동안 몇 번씩 오르는 수 — 이것도 매번 읽지 않게
        <span className="wk-tok" aria-hidden="true">
          {`약 ${tokensText(tokens)} 토큰`}
        </span>
      )}
    </div>
  )
}
