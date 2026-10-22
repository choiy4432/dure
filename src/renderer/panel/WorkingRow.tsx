import { useRef } from 'react'
import { useNow } from '../lib/useNow'
import { elapsed, PHASE_WORD, PREPARING_HINT, tokensText } from '../lib/words'
import { MOTION } from '../lib/motion'
import { useMotion } from '../lib/presence'
import type { Phase } from '../state/selectors'

/**
 * 대화 맨 아래 '작업 중…' 줄 — Claude Code 의 작업 중 표시처럼, 에이전트가 일하는 동안만 대화 끝에 붙는다.
 * 초록 점(관계도의 작업 중과 같은 색) · 빛이 지나가는 '작업 중…' · 도는 서브에이전트 수(있을 때) · 지난 시간(1초마다).
 * Claude 가 생각하는 동안(thinking)은 '작업 중…' 자리에 '생각하는 중…', 지난 시간 뒤에 생각한 추정 토큰 수(알 때만) —
 * 내용은 오지 않지만 수가 오르니 멈추지 않았다는 게 보인다. 생각 전 기다림은 단계(phase)로 — '준비하는 중…'(마우스를 올리면
 * 아직 보내기 전이라는 풀이) · 'Claude 답 받는 중…' · '대화를 정리하는 중…'.
 * since 를 모르면(앱을 열 때 이미 일하던 중) 시간 없이. 움직임 줄이기면 점·글자가 움직이지 않는다(base.css).
 */
export function WorkingRow({ since, subagents = 0, thinking, phase }: {
  since?: number
  subagents?: number
  thinking?: { tokens: number | null }
  phase?: Phase
}) {
  const now = useNow(1000)
  const root = useRef<HTMLDivElement>(null)
  useMotion(root, MOTION.line)
  const tokens = thinking?.tokens ?? null
  const label = thinking ? '생각하는 중…' : phase ? PHASE_WORD[phase] : '작업 중…'
  return (
    <div ref={root} className="ci-work" role="status">
      <span className="wk-dot" aria-hidden="true" />
      <span className="wk-t" title={!thinking && phase === 'preparing' ? PREPARING_HINT : undefined}>{label}</span>
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
