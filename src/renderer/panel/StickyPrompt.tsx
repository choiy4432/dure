import { useRef } from 'react'
import { useNow } from '../lib/useNow'
import { ago } from '../lib/words'
import { MOTION } from '../lib/motion'
import { useMotion } from '../lib/presence'
import { promptText, type PromptLine } from './turnStart'

/**
 * 대화 위 고정 — Claude Code 처럼, 지금 화면 맨 위에 걸친 차례를 연 말(내 말 · 다른 에이전트가 보낸 메시지)을 한 줄로.
 * 내 말풍선과 같은 회색 상자 + 보낸 시각. 둘레는 바탕색 막이 덮었다가 아래로 사라진다(밑으로 지나가는 글이 상자 글과 겹쳐 읽히지 않게).
 * 누르면 그 말로 간다(onJump). 막은 누름을 통과시키고 상자만 누를 수 있다. 나타나고 사라질 땐 막째 흐려진다(MOTION.backdrop).
 */
export function StickyPrompt({ line, onJump }: { line: PromptLine; onJump: () => void }) {
  const now = useNow()
  const root = useRef<HTMLDivElement>(null)
  useMotion(root, MOTION.backdrop)
  const text = promptText(line)
  const who = line.kind === 'relay' ? (line.from ? `${line.from}에게서 온 메시지` : '전달된 메시지') : '내 메시지'
  return (
    <div ref={root} className="stk">
      <button type="button" className="stk-c" aria-label={`${who}로 가기 — ${text}`} onClick={onJump}>
        {line.kind === 'relay' && (
          <span className="stk-who">{line.from ? <><b>{line.from}</b>에게서</> : '전달된 메시지'}</span>
        )}
        <span className="stk-t">{text}</span>
        <span className="stk-tm">{ago(line.at, now)}</span>
      </button>
    </div>
  )
}
