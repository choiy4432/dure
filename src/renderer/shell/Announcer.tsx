/** 화면 읽기 프로그램에게만 들리는 알림 자리 — 새 승인·메시지를 보이지 않게 읽어 준다 */
export function Announcer({ text, n }: { text: string; n: number }) {
  return (
    <div className="sr-only" aria-live="polite">
      {/* key 가 바뀌면 노드가 갈린다 — 같은 글도 다시 읽어 준다 */}
      <span key={n}>{text}</span>
    </div>
  )
}
