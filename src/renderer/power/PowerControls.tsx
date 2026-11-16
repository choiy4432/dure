// 파워 모드 두 화면(관제실 위 띠 · 터미널 벽 상태 줄)이 같이 쓰는 단추 — [설정] · [나가기 Esc].
// 한 부품이라 두 화면의 단추·이름·순서가 어긋나지 않는다(생김새만 놓인 자리의 CSS 가 정한다)

/** onSettings 가 없으면(설정을 열 수 없는 때 — 앱 위 띠의 톱니가 막히는 때와 같다) [설정] 도 없다 */
export function PowerControls({ onSettings, onExit }: { onSettings?: () => void; onExit: () => void }) {
  return (
    <span className="pw-ctls">
      {onSettings && (
        <button type="button" className="pw-ctl" onClick={onSettings}>
          설정
        </button>
      )}
      <button type="button" className="pw-ctl" title="Esc 를 길게 눌러도 나가요" onClick={onExit}>
        나가기<kbd aria-hidden="true">Esc</kbd>
      </button>
    </span>
  )
}
