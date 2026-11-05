import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useLeaving } from './presence'

/** Tab 으로 갈 수 있는 것 — 대화상자와 안내 투어 카드가 그 안에서 초점을 돌릴 때 */
export const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** 지금 열린 대화상자 — 연 차례대로. 겹쳐 열리면(설정 → 휴대폰 → 짝 맺기·확인) 키는 맨 위 것만 받는다 */
const openDialogs: object[] = []

/**
 * 열린 대화상자의 키·포커스 — 확인 대화상자와 입력 대화상자가 같이 쓴다.
 * 키는 문서에서 받는다: 포커스가 대화상자 밖(body 등)에 떨어져 있어도 Esc 는 닫고 Tab 은 안에서만 돈다.
 * 대화상자 위에 또 대화상자가 열리면 아래 것은 키를 듣지 않는다 — Esc 는 맨 위 것만 닫고, Tab 도 맨 위 것 안에서만 돈다.
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

  // 닫히는 순간 — 연 자리로 초점(나가는 요소는 inert 라 초점이 body 로 떨어지기 전에 먼저 옮긴다).
  // 열린 동안은 열린 대화상자 차례에 든다 — 나가기 시작하거나 언마운트되면 빠져, 아래 대화상자가 다시 키를 받는다
  const me = useRef({})
  useLayoutEffect(() => {
    if (leaving) {
      giveBack()
      return
    }
    returned.current = false
    const token = me.current
    openDialogs.push(token)
    return () => {
      const i = openDialogs.lastIndexOf(token)
      if (i >= 0) openDialogs.splice(i, 1)
    }
  }, [leaving])

  // 키 — 나가는 동안은 듣지 않는다 · 위에 다른 대화상자가 떠 있어도 듣지 않는다
  useEffect(() => {
    if (leaving) return
    const onKey = (e: KeyboardEvent) => {
      const dlg = box.current
      if (!dlg) return
      if (openDialogs[openDialogs.length - 1] !== me.current) return
      if (e.key === 'Escape') {
        // 안에 떠 있는 목록(서버 고르기)은 Esc 를 스스로 받는다 — 목록만 닫히고 대화상자는 그대로
        if ((e.target as Element | null)?.closest?.('[data-own-esc]') && dlg.contains(e.target as Node)) return
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
