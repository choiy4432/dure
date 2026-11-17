// 파워 모드의 방 단추 — 관제실 위 띠의 `방 <이름>` · 터미널 벽 상태 줄의 [두레] 바로 뒤(한 부품, 생김새만 놓인 자리의 CSS 가 정한다).
// 방이 둘 이상이면 단추(▾) — 누르면 방 목록 메뉴: 방마다 `이름 · 에이전트 N`, 승인·질문을 기다리는 에이전트가 있으면 호박색 점과 `기다림 N`,
// 지금 방엔 체크. 고르면 앱의 방 고르기(selectRoom) 그대로 — 파워 모드는 앱의 방을 따른다(스토어). 방이 하나뿐이거나 없으면 눌리지 않는 글.
// 메뉴는 앱의 메뉴 부품(.pop · .mi · useDismiss · moveMenuFocus)과 같은 키보드 규칙 — 열면 지금 방 줄로 초점 · ↑↓ Home End · Esc 는 메뉴만 닫고
// 단추로 · Tab 이나 밖을 누르면 닫는다. 덮개 안, 화면(판) 밖에 그린다 — 덮개의 어두운 색을 쓰고, 위 띠의 잘림이나 관계도 노드 카드의 층이
// 메뉴를 덮지 못한다(판이 제 층을 가둔다 — power.css). 떠 있는 동안은 Esc 길게로 나가지 않는다(PowerLayer 가 떠 있는 메뉴를 본다)
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import type { RoomId } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { displayStatus } from '../state/selectors'
import { moveMenuFocus, useDismiss } from '../lib/popover'
import { MotionDiv, Presence } from '../lib/presence'
import { MOTION } from '../lib/motion'

/** 단추와 메뉴 사이 */
const GAP = 6

/** 열린 메뉴의 자리 — host: 그릴 덮개(없으면 단추 옆 그대로), style: 단추에 붙는 화면 좌표 */
type Place = { host: HTMLElement | null; style: CSSProperties }

/** up — 메뉴를 단추 위로 펼친다(터미널 벽의 아래 상태 줄) */
export function RoomSwitch({ up = false }: { up?: boolean }) {
  const v = useDure(s => ({ roomId: s.power.roomId, rooms: s.rooms, agents: s.agents, requests: s.requests }))
  // 기다림은 화면의 '승인 기다림'과 같은 셈 — 상태가 기다림이거나 승인·질문 요청이 걸려 있다(displayStatus)
  const rows = useMemo(
    () =>
      v.rooms.map(r => {
        const mine = v.agents.filter(a => a.roomId === r.id)
        return { id: r.id, name: r.name, agents: mine.length, waiting: mine.filter(a => displayStatus(a, v.requests) === 'awaiting').length }
      }),
    [v.rooms, v.agents, v.requests],
  )
  const name = v.rooms.find(r => r.id === v.roomId)?.name ?? '—'
  const many = v.rooms.length > 1
  const [shown, setShown] = useState(false)
  // 마지막으로 연 자리 — 닫힌 뒤에도 남겨 둔다(나가는 움직임이 같은 자리 · 같은 덮개에서 끝나게)
  const [place, setPlace] = useState<Place | null>(null)
  if (shown && !many) setShown(false) // 방이 하나로 줄면 단추와 함께 메뉴도 닫힌다
  const open = shown && many
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setShown(false), [])
  useDismiss(open, btn, close, menu)

  // 열리면 지금 방 줄로 초점 · 창 크기가 바뀌면 자리가 어긋나니 닫는다
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    window.addEventListener('resize', close)
    return () => window.removeEventListener('resize', close)
  }, [open, close])

  const closeToButton = () => {
    close()
    btn.current?.focus()
  }

  const toggle = () => {
    const b = btn.current
    if (open || !b) return close()
    const r = b.getBoundingClientRect()
    setPlace({
      host: b.closest<HTMLElement>('.pw'),
      style: up ? { top: 'auto', bottom: window.innerHeight - r.top + GAP, left: r.left } : { top: r.bottom + GAP, left: r.left },
    })
    setShown(true)
  }

  // 지금 방을 다시 고르면 그대로(고른 에이전트도) — 앱의 방 목록과 같다
  const pick = (id: RoomId) => {
    const store = getStore()
    if (id !== store.getState().roomId) store.selectRoom(id)
    closeToButton()
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeToButton()
      return
    }
    if (e.key === 'Tab') {
      close()
      return
    }
    moveMenuFocus(e)
  }

  // 키보드로 단추·메뉴 밖으로 나가면 닫는다(누르기는 useDismiss 가 본다)
  const onBlur = (e: FocusEvent) => {
    const to = e.relatedTarget as Node | null
    if (open && to && !btn.current?.contains(to) && !menu.current?.contains(to)) close()
  }

  // 방 이름은 사용자 글 — 글로만, 한 줄 · 넘치면 말줄임(CSS)
  const label = (
    <>
      방 <b className="pw-rs-n">{name}</b>
    </>
  )
  if (!many) return <span className="pw-rs">{label}</span>

  const list = (
    <Presence show={open}>
      <MotionDiv
        motion={up ? MOTION.popUp : MOTION.pop}
        origin={up ? 'bottom left' : 'top left'}
        ref={menu}
        className="pop fix pw-rs-pop"
        style={place?.style}
        role="menu"
        aria-label="방 옮기기"
        onKeyDown={onKey}
        onBlur={onBlur}
      >
        {rows.map(r => (
          <button key={r.id} type="button" role="menuitemradio" aria-checked={r.id === v.roomId} className="mi pw-rs-mi" onClick={() => pick(r.id)}>
            <span className="pw-rs-t">
              <span className="pw-rs-rn">{r.name}</span>
              <span className="pw-rs-c"> · 에이전트 {r.agents}</span>
            </span>
            {r.waiting > 0 && (
              <span className="rs-todo a">
                <span className="dot a" aria-hidden="true" />
                기다림 {r.waiting}
              </span>
            )}
            {r.id === v.roomId && <Check className="i mi-ck" aria-hidden="true" />}
          </button>
        ))}
      </MotionDiv>
    </Presence>
  )
  const Chevron = up ? ChevronUp : ChevronDown
  return (
    <>
      <button ref={btn} type="button" className="pw-rs" aria-haspopup="menu" aria-expanded={open} title="방 옮기기" onClick={toggle} onBlur={onBlur}>
        {label}
        <Chevron className="i" aria-hidden="true" />
      </button>
      {place?.host ? createPortal(list, place.host) : list}
    </>
  )
}
