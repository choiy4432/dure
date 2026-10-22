/** 화면 읽기 프로그램에게만 들리는 알림 자리 — 새 승인·메시지를 보이지 않게 읽어 준다 */
export function Announcer({ text }: { text: string }) {
  return (
    <div className="sr-only" aria-live="polite">
      {text}
    </div>
  )
}
