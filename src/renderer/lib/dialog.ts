import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useLeaving } from './presence'

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * 열린 대화상자의 키·포커스 — 확인 대화상자와 입력 대화상자가 같이 쓴다.
 * 키는 문서에서 받는다: 포커스가 대화상자 밖(body 등)에 떨어져 있어도 Esc 는 닫고 Tab 은 안에서만 돈다.
 * 열리면 first(상자)가 고른 곳으로 포커스(없으면 상자), 닫히는 순간 연 자리로 돌려준다 — Presence 가 나가는 중(useLeaving)이 되는 때,
 * 나가는 움직임이 없으면 언마운트 때. 키 듣기도 그 순간 풀린다(나가는 동안 Esc·Tab 은 듣지 않는다).
 * onEscape·first 는 늘 마지막으로 넘긴 것을 부른다.
 */
export function useDialogFocus(
  box: RefObject<HTMLElement | null>,
  onEscape: () => void,
  first: (box: HTMLElement) => HTMLElement | null | undefined,
) {
  const live = useRef({ onEscape, first })
  useLayoutEffect(() => {
    live.current = { onEscape, first }
  })

  const leaving = useLeaving()
  const opener = useRef<HTMLElement | null>(null)
  const returned = useRef(false)

  const giveBack = () => {
    if (returned.current) return
    returned.current = true
    if (opener.current?.isConnected) opener.current.focus()
  }

  // 열릴 때 — 연 자리를 적어 두고 안으로 포커스. 언마운트 때 아직 안 돌려줬으면(나가는 움직임이 없었다) 돌려준다
  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null
    returned.current = false
    const el = box.current
    if (el) (live.current.first(el) ?? el).focus()
    return giveBack
  }, [box])

  // 닫히는 순간 — 연 자리로 초점(나가는 요소는 inert 라 초점이 body 로 떨어지기 전에 먼저 옮긴다)
  useLayoutEffect(() => {
    if (leaving) giveBack()
    else returned.current = false
  }, [leaving])

  // 키 — 나가는 동안은 듣지 않는다
  useEffect(() => {
    if (leaving) return
    const onKey = (e: KeyboardEvent) => {
      const dlg = box.current
      if (!dlg) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        live.current.onEscape()
        return
      }
      if (e.key !== 'Tab') return
      const items = Array.from(dlg.querySelectorAll<HTMLElement>(FOCUSABLE))
      const at = document.activeElement
      const inside = dlg.contains(at)
      if (items.length === 0) {
        // 기다리는 동안(버튼이 막혀 있음) — 포커스는 대화상자에 머문다
        e.preventDefault()
        dlg.focus()
        return
      }
      const head = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (!inside || at === head || at === dlg)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (!inside || at === last)) {
        e.preventDefault()
        head.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [box, leaving])
}
