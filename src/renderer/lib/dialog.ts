import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * 열린 대화상자의 키·포커스 — 확인 대화상자와 입력 대화상자가 같이 쓴다.
 * 키는 문서에서 받는다: 포커스가 대화상자 밖(body 등)에 떨어져 있어도 Esc 는 닫고 Tab 은 안에서만 돈다.
 * 열리면 first(상자)가 고른 곳으로 포커스(없으면 상자), 닫히면(언마운트) 연 자리로 돌려준다.
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

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const el = box.current
    if (el) (live.current.first(el) ?? el).focus()

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
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (opener?.isConnected) opener.focus()
    }
  }, [box])
}
