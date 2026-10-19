import { useEffect, type KeyboardEvent, type RefObject } from 'react'

/** 떠 있는 목록 — 열려 있는 동안 wrap(여는 버튼 + 목록) 바깥을 누르면 닫는다 */
export function useDismiss(open: boolean, wrap: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [open, wrap, onClose])
}

const ITEM = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)'

/** 메뉴 안 ↑↓ · Home · End 로 항목 사이를 옮긴다 — 처리했으면 true */
export function moveMenuFocus(e: KeyboardEvent<HTMLElement>): boolean {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(ITEM))
  if (items.length === 0) return false
  const i = items.indexOf(document.activeElement as HTMLElement)
  let next = -1
  if (e.key === 'ArrowDown') next = (i + 1) % items.length
  else if (e.key === 'ArrowUp') next = i <= 0 ? items.length - 1 : i - 1
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = items.length - 1
  if (next < 0) return false
  e.preventDefault()
  items[next].focus()
  return true
}
