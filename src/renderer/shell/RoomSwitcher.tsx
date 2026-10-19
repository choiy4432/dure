import {
  useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type FormEvent, type KeyboardEvent,
} from 'react'
import { Check, ChevronDown, Ellipsis, Pencil, Plus, Trash2 } from 'lucide-react'
import type { Room, RoomId } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { errorMessage, josa } from '../lib/words'
import { moveMenuFocus, useDismiss } from '../lib/popover'
import { ConfirmDialog } from './ConfirmDialog'
import { FormDialog } from './FormDialog'

/**
 * 방을 만들고 그 방으로 — 위 띠 목록의 '새 방'과 빈 화면의 '방 만들기'가 같이 쓴다.
 * 엔진은 방이 생겼다는 이벤트를 보내지 않으므로 새로 받는다. 방은 이미 생겼으니 새로 받지 못한 건 던지지 않는다.
 */
async function createRoom(name: string): Promise<void> {
  const room = await window.dure.addRoom(name)
  const store = getStore()
  try {
    await store.refresh()
    store.selectRoom(room.id)
  } catch (e) {
    console.error('두레: 방을 만든 뒤 상태를 받지 못했어요', e)
  }
}

type Editing = { kind: 'rename'; id: RoomId } | { kind: 'new' } | null
interface Ask {
  id: RoomId
  name: string
  agents: number
}

/** 위 띠의 방 버튼 + 방 목록(지금 방 표시 · 새 방 · 방마다 이름 바꾸기·지우기) */
export function RoomSwitcher() {
  const v = useDure(s => ({ roomId: s.roomId, rooms: s.rooms }))
  const current = v.rooms.find(r => r.id === v.roomId)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Editing>(null)
  const [menu, setMenu] = useState<{ id: RoomId; at: CSSProperties } | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const roomMenu = useRef<HTMLDivElement>(null)
  // 입력칸을 접은 뒤 포커스를 돌려줄 줄(data-nav 값) — 다시 그린 뒤에야 그 줄이 생긴다
  const refocus = useRef<string | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    setEditing(null)
    setMenu(null)
  }, [])
  useDismiss(open, wrap, close)

  const navItems = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])

  // 열리면 지금 방 줄로 포커스
  useEffect(() => {
    if (!open) return
    const box = list.current
    ;(box?.querySelector<HTMLElement>('[aria-current="true"]') ?? box?.querySelector<HTMLElement>('[data-nav]'))?.focus()
  }, [open])

  useEffect(() => {
    const key = refocus.current
    if (key === null) return
    refocus.current = null
    navItems().find(el => el.dataset.nav === key)?.focus()
  })

  // 방 메뉴 — 열리면 첫 항목으로. 목록이 스크롤되거나 창 크기가 바뀌면 자리가 어긋나니 닫는다
  const menuId = menu?.id ?? null
  useEffect(() => {
    if (menuId === null) return
    roomMenu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const shut = () => setMenu(null)
    const onScroll = (e: Event) => {
      if (!roomMenu.current?.contains(e.target as Node)) shut()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', shut)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', shut)
    }
  }, [menuId])

  const closeToButton = () => {
    close()
    button.current?.focus()
  }

  const pick = (id: RoomId) => {
    const store = getStore()
    if (id !== store.getState().roomId) store.selectRoom(id) // 지금 방을 다시 고르면 그대로(고른 에이전트도)
    closeToButton()
  }

  const toggleMenu = (id: RoomId, el: HTMLElement) => {
    if (menu?.id === id) return setMenu(null)
    const r = el.getBoundingClientRect()
    setEditing(null)
    setMenu({ id, at: { top: r.top - 5, left: r.right + 6 } })
  }

  const moreButton = (id: RoomId) =>
    Array.from(list.current?.querySelectorAll<HTMLElement>('[data-more]') ?? []).find(el => el.dataset.more === id)

  const startRename = (id: RoomId) => {
    setMenu(null)
    setEditing({ kind: 'rename', id })
  }

  const rename = async (room: Room, name: string) => {
    if (name !== room.name) {
      await window.dure.renameRoom(room.id, name) // 실패하면 입력칸 아래에 문구
      await getStore().refresh()
    }
    refocus.current = room.id
    setEditing(null)
  }

  const create = async (name: string) => {
    await createRoom(name)
    closeToButton()
  }

  // 지우기 — 목록을 닫고 확인만 남긴다(확인이 닫히면 포커스는 방 버튼으로)
  const askRemove = (room: Room) => {
    const agents = getStore().getState().agents.filter(a => a.roomId === room.id).length
    closeToButton()
    setAsk({ id: room.id, name: room.name, agents })
  }

  const remove = async () => {
    if (!ask) return
    const store = getStore()
    const wasCurrent = store.getState().roomId === ask.id
    await window.dure.removeRoom(ask.id) // 실패하면 확인 대화상자에 문구
    setAsk(null)
    try {
      await store.refresh()
    } catch (e) {
      console.error('두레: 방을 지운 뒤 상태를 받지 못했어요', e)
      return
    }
    // 지금 방이었으면 스토어가 남은 첫 방(없으면 빈 화면)으로 옮겼다 — 고른 에이전트도 비운다
    if (wasCurrent) store.selectAgent(null)
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeToButton()
      return
    }
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const items = navItems()
    if (items.length === 0) return
    const i = items.indexOf(document.activeElement as HTMLElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (i + 1) % items.length
    else if (e.key === 'ArrowUp') next = i <= 0 ? items.length - 1 : i - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    if (next < 0) return
    e.preventDefault()
    items[next].focus()
  }

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // 목록까지 닫지 않는다
      const id = menu?.id
      setMenu(null)
      if (id) moreButton(id)?.focus()
      return
    }
    if (e.key === 'Tab') {
      setMenu(null)
      return
    }
    if (moveMenuFocus(e)) e.stopPropagation()
  }

  // 키보드로 목록 밖으로 나가면 닫는다(누르기는 useDismiss 가 본다)
  const onBlur = (e: FocusEvent<HTMLSpanElement>) => {
    const to = e.relatedTarget as Node | null
    if (open && to && !wrap.current?.contains(to)) close()
  }

  return (
    <>
      <span className="mp" ref={wrap} onBlur={onBlur}>
        <button
          ref={button}
          type="button"
          className="room"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="방 고르기"
          onClick={() => (open ? closeToButton() : setOpen(true))}
        >
          <span className="room-name">{current?.name}</span>
          <ChevronDown className="i" aria-hidden="true" />
        </button>
        {open && (
          <div ref={list} className="pop rs" role="dialog" aria-label="방" onKeyDown={onListKey}>
            <ul className="rs-list">
              {v.rooms.map(r => (
                <li key={r.id} className="rs-row">
                  {editing?.kind === 'rename' && editing.id === r.id ? (
                    <NameForm
                      label="방 이름"
                      initial={r.name}
                      submitLabel="저장"
                      onSubmit={name => rename(r, name)}
                      onCancel={() => {
                        refocus.current = r.id
                        setEditing(null)
                      }}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="mi rs-pick"
                        data-nav={r.id}
                        aria-current={r.id === v.roomId ? 'true' : undefined}
                        onClick={() => pick(r.id)}
                      >
                        <span className="rs-n">{r.name}</span>
                        {r.id === v.roomId && <Check className="i mi-ck" aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        className="ib xs rs-more"
                        data-more={r.id}
                        aria-label={`${r.name} 메뉴`}
                        title="메뉴"
                        aria-haspopup="menu"
                        aria-expanded={menu?.id === r.id}
                        onClick={e => toggleMenu(r.id, e.currentTarget)}
                      >
                        <Ellipsis className="i" aria-hidden="true" />
                      </button>
                      {menu?.id === r.id && (
                        <div
                          ref={roomMenu}
                          className="pop fix"
                          style={menu.at}
                          role="menu"
                          aria-label={`${r.name} 메뉴`}
                          onKeyDown={onMenuKey}
                        >
                          <button type="button" role="menuitem" className="mi" onClick={() => startRename(r.id)}>
                            <Pencil className="i" aria-hidden="true" />
                            이름 바꾸기
                          </button>
                          <div className="pop-sep" role="separator" />
                          <button type="button" role="menuitem" className="mi dng-t" onClick={() => askRemove(r)}>
                            <Trash2 className="i" aria-hidden="true" />
                            지우기
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
            <div className="pop-sep" role="separator" />
            {editing?.kind === 'new' ? (
              <NameForm
                label="새 방 이름"
                placeholder="새 방 이름"
                initial=""
                submitLabel="만들기"
                onSubmit={create}
                onCancel={() => {
                  refocus.current = 'new'
                  setEditing(null)
                }}
              />
            ) : (
              <button
                type="button"
                className="mi"
                data-nav="new"
                onClick={() => {
                  setMenu(null)
                  setEditing({ kind: 'new' })
                }}
              >
                <Plus className="i" aria-hidden="true" />새 방
              </button>
            )}
          </div>
        )}
      </span>
      <ConfirmDialog
        open={ask !== null}
        title={ask ? `방 ${ask.name}${josa(ask.name, '을/를')} 지울까요?` : ''}
        body={ask && ask.agents > 0 ? `안의 에이전트 ${ask.agents}개와 대화 기록도 지워져요.` : undefined}
        confirmLabel="지우기"
        danger
        onConfirm={remove}
        onCancel={() => setAsk(null)}
      />
    </>
  )
}

interface NameFormProps {
  label: string
  placeholder?: string
  initial: string
  submitLabel: string
  /** 다듬은(앞뒤 빈칸 뺀) 이름 — 실패하면 그 문구를 칸 아래에 */
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}

/** 목록 안 한 줄 이름 입력 — Enter·버튼으로 보내고 Esc 로 접는다 */
function NameForm({ label, placeholder, initial, submitLabel, onSubmit, onCancel }: NameFormProps) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const errorId = useId()

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (busy || !trimmed) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed) // 잘 되면 이 칸은 접힌다
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
      input.current?.focus()
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation() // 목록은 그대로
    if (!busy) onCancel()
  }

  return (
    <form className="rs-form" onSubmit={submit}>
      <div className="rs-fr">
        <input
          ref={input}
          className="inp"
          aria-label={label}
          placeholder={placeholder}
          value={name}
          onChange={e => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={onKey}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
        />
        <button type="submit" className="btn pri sm" disabled={busy || !name.trim()}>
          {submitLabel}
        </button>
      </div>
      {error && (
        <p className="fe" id={errorId}>
          {error}
        </p>
      )}
    </form>
  )
}

/** 방이 하나도 없을 때(빈 화면의 '방 만들기') — 이름만 적는 대화상자 */
export function NewRoomDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await createRoom(name.trim())
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <FormDialog
      title="새 방"
      submitLabel="만들기"
      canSubmit={name.trim() !== ''}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div className="fld">
        <label className="fld-l" htmlFor={id}>
          이름
        </label>
        <input
          id={id}
          className="inp"
          placeholder="예: 여름 캠페인"
          value={name}
          onChange={e => {
            setName(e.target.value)
            setError(null)
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-e` : undefined}
          autoComplete="off"
        />
        {error && (
          <p className="fe" id={`${id}-e`}>
            {error}
          </p>
        )}
      </div>
    </FormDialog>
  )
}
