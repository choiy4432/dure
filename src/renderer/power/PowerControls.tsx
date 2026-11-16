// 파워 모드 두 화면(관제실 위 띠 · 터미널 벽 상태 줄)이 같이 쓰는 단추 — [설정] · [나가기 Esc].
// 한 부품이라 두 화면의 단추·이름·순서가 어긋나지 않는다(생김새만 놓인 자리의 CSS 가 정한다)
import type { KeyboardEvent } from 'react'
import { swallowHeldKey } from './useHoldEscape'

/** [나가기] 풍선 도움말 — 설정의 파워 모드 안내(GeneralPane: '[나가기] 단추나 Esc 를 길게 눌러 나가요')와 같은 말 */
const EXIT_TITLE = 'Esc 를 길게 눌러도 나가요'

/** onSettings 가 없으면(설정을 열 수 없는 때 — 앱 위 띠의 톱니가 막히는 때와 같다) [설정] 도 없다 */
export function PowerControls({ onSettings, onExit }: { onSettings?: () => void; onExit: () => void }) {
  // 키로 누르면 그 키를 누른 순간 나가고, 떼기 전까지 오는 그 키의 자동 반복은 삼킨다 — 다시 붙은 앱 입력창이 그 Enter 로 쓰던 글을 보내지 않게.
  // 단추의 기본 누르기(Enter 는 누를 때 · Space 는 뗄 때 click)는 막는다: 한 번만 나가고, 다른 데서 누르고 있던 키의 반복으로는 나가지 않는다
  const exitKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (e.repeat) return
    swallowHeldKey(e.key)
    onExit()
  }
  return (
    <span className="pw-ctls">
      {onSettings && (
        <button type="button" className="pw-ctl" onClick={onSettings}>
          설정
        </button>
      )}
      <button type="button" className="pw-ctl" title={EXIT_TITLE} onClick={onExit} onKeyDown={exitKey}>
        나가기<kbd aria-hidden="true">Esc</kbd>
      </button>
    </span>
  )
}
