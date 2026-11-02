import {
  useCallback, useMemo, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type FormEvent, type KeyboardEvent,
} from 'react'
import { Check, ChevronDown, Ellipsis, Monitor, Moon, Pencil, Plus, Server, Trash2, TriangleAlert } from 'lucide-react'
import type { Room, RoomId, SshHostEntry } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { roomIssues, roomTotal, todoCounts } from '../state/attention'
import { errorMessage, josa, REMOTE, serverLine, SLEEP_ROOM, sshAddress } from '../lib/words'
import { moveMenuFocus, OPTION, useDismiss } from '../lib/popover'
import { MotionDiv, Presence } from '../lib/presence'
import { MOTION } from '../lib/motion'
import { ConfirmDialog } from './ConfirmDialog'
import { FormDialog } from './FormDialog'
import { RemoteCheckLine, ServerTag, useRemoteCheck } from './RemoteCheck'

/**
 * 방을 만들고 그 방으로 — 위 띠 목록의 '새 방'과 빈 화면의 '방 만들기'가 같이 쓴다(둘 다 새 방 대화상자).
 * 엔진은 방이 생겼다는 이벤트를 보내지 않으므로 새로 받는다. 방은 이미 생겼으니 새로 받지 못한 건 던지지 않는다.
 * 이 PC 방은 이름만 넘긴다(옛 꼴 그대로).
 */
async function createRoom(name: string, remote: { host: string } | null): Promise<void> {
  const room = remote ? await window.dure.addRoom(name, remote) : await window.dure.addRoom(name)
  const store = getStore()
  try {
    await store.refresh()
    store.selectRoom(room.id)
  } catch (e) {
    console.error('두레: 방을 만든 뒤 상태를 받지 못했어요', e)
  }
}

/**
 * ~/.ssh/config 의 서버 목록 — on 일 때(서버 방이 있을 때 · 새 방 창) 받는다. again 이 바뀌면 다시(목록을 열 때).
 * 못 받으면 빈 목록(서버 방 표시는 host 만). 받기 전엔 null
 */
function useSshHosts(on: boolean, again?: unknown): SshHostEntry[] | null {
  const [hosts, setHosts] = useState<SshHostEntry[] | null>(null)
  useEffect(() => {
    if (!on) return
    let stale = false
    Promise.resolve()
      .then(() => window.dure.sshHosts())
      .then(
        h => { if (!stale) setHosts(h) },
        e => {
          console.error('두레: 서버 목록을 읽지 못했어요', e)
          if (!stale) setHosts(old => old ?? [])
        },
      )
    return () => { stale = true }
  }, [on, again])
  return hosts
}

type Editing = { kind: 'rename'; id: RoomId } | null
interface Ask {
  id: RoomId
  name: string
  agents: number
}

/** 위 띠의 방 버튼 + 방 목록(지금 방 표시 · 새 방 · 방마다 이름 바꾸기·지우기) */
export function RoomSwitcher() {
  const v = useDure(s => ({
    roomId: s.roomId, rooms: s.rooms, agents: s.agents, requests: s.requests, messages: s.messages, menuRequest: s.roomMenuRequest,
  }))
  // 방마다 처리할 일 — 목록 줄의 수와, 다른 방에 있다는 방 단추의 점이 같은 셈을 쓴다
  const todo = useMemo(() => todoCounts(v).rooms, [v.agents, v.requests, v.messages]) // eslint-disable-line react-hooks/exhaustive-deps
  // 방마다 서버 문제가 보이는 에이전트 — 목록 줄에 오류처럼
  const issues = useMemo(() => roomIssues(v), [v.agents, v.requests, v.rooms]) // eslint-disable-line react-hooks/exhaustive-deps
  const elsewhere = v.rooms.some(r => r.id !== v.roomId && roomTotal(todo[r.id]) > 0)
  const current = v.rooms.find(r => r.id === v.roomId)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Editing>(null)
  const [creating, setCreating] = useState(false)
  // 서버 방 표시(<host> · <user>@<hostName>) — 서버 방이 있을 때만, 목록을 열 때마다 다시 읽는다
  const hosts = useSshHosts(v.rooms.some(r => r.remote), open)
  const [menu, setMenu] = useState<{ id: RoomId; at: CSSProperties } | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  /** 열린 방 메뉴에서 지금 재울 수 있는 에이전트 수 — null 은 아직 묻는 중 */
  const [sleepable, setSleepable] = useState<number | null>(null)
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

  // '다른 방에도 할 일' 줄이 목록을 열어 달라고 하면 연다 — 처음 마운트 때의 값은 요청이 아니다
  const seenRequest = useRef(v.menuRequest)
  useEffect(() => {
    if (v.menuRequest === seenRequest.current) return
    seenRequest.current = v.menuRequest
    setOpen(true)
  }, [v.menuRequest])

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
    roomMenu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
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

  // 방 메뉴를 열 때마다 재울 수 있는 수를 묻는다 — 답이 오기 전엔 항목을 꺼 둔다
  useEffect(() => {
    if (menuId === null) return
    let stale = false
    setSleepable(null)
    Promise.resolve()
      .then(() => window.dure.sleepableIn(menuId))
      .then(n => { if (!stale) setSleepable(n) })
      .catch(() => { if (!stale) setSleepable(0) })
    return () => { stale = true }
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

  const sleepRoom = (id: RoomId) => {
    setMenu(null)
    moreButton(id)?.focus()
    window.dure
      .sleepRoom(id)
      .then(() => getStore().refresh())
      .catch(e => console.error('두레: 방의 에이전트를 재우지 못했어요', e))
  }

  const rename = async (room: Room, name: string) => {
    if (name !== room.name) {
      await window.dure.renameRoom(room.id, name) // 실패하면 입력칸 아래에 문구
      await getStore().refresh()
    }
    refocus.current = room.id
    setEditing(null)
  }

  // 새 방 — 목록을 닫고 대화상자(닫히면 포커스는 방 버튼으로)
  const startCreate = () => {
    closeToButton()
    setCreating(true)
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
          {current?.remote && (
            <>
              {' '}
              <ServerTag host={current.remote.host} title={serverLine(current.remote.host, hosts)} />
            </>
          )}
          {elsewhere && <span className="dot a room-dot" role="img" aria-label="다른 방에 할 일 있음" />}
          <ChevronDown className="i" aria-hidden="true" />
        </button>
        <Presence show={open}>
          <MotionDiv motion={MOTION.pop} origin="top left" ref={list} className="pop rs" role="dialog" aria-label="방" onKeyDown={onListKey}>
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
                        {r.remote ? (
                          // 서버 방 — 이름 아래 흐린 <host> · <user>@<hostName>
                          <span className="rs-tx">
                            <span className="rs-n">{r.name}</span>{' '}
                            <span className="rs-sub">
                              <Server className="i" aria-hidden="true" />
                              <span className="trunc">{serverLine(r.remote.host, hosts)}</span>
                            </span>
                          </span>
                        ) : (
                          <span className="rs-n">{r.name}</span>
                        )}
                        <RoomTodo t={todo[r.id]} issues={issues[r.id]} />
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
                      <Presence show={menu?.id === r.id}>
                        <MotionDiv
                          motion={MOTION.pop}
                          origin="top left"
                          ref={roomMenu}
                          className="pop fix"
                          style={menu?.at}
                          role="menu"
                          aria-label={`${r.name} 메뉴`}
                          onKeyDown={onMenuKey}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            className="mi"
                            disabled={!sleepable}
                            onClick={() => sleepRoom(r.id)}
                          >
                            <Moon className="i" aria-hidden="true" />
                            {SLEEP_ROOM}
                          </button>
                          <button type="button" role="menuitem" className="mi" onClick={() => startRename(r.id)}>
                            <Pencil className="i" aria-hidden="true" />
                            이름 바꾸기
                          </button>
                          <div className="pop-sep" role="separator" />
                          <button type="button" role="menuitem" className="mi dng-t" onClick={() => askRemove(r)}>
                            <Trash2 className="i" aria-hidden="true" />
                            지우기
                          </button>
                        </MotionDiv>
                      </Presence>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <div className="pop-sep" role="separator" />
            <button type="button" className="mi" data-nav="new" onClick={startCreate}>
              <Plus className="i" aria-hidden="true" />새 방
            </button>
          </MotionDiv>
        </Presence>
      </span>
      <Presence show={creating}>
        <NewRoomDialog onClose={() => setCreating(false)} />
      </Presence>
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

/**
 * 목록 줄 오른쪽의 할 일 수 — 승인·질문은 앰버, 메시지·묶음은 빨강, 0 인 쪽은 안 쓴다. 색만으로는 못 읽으니 숫자 앞에 보이지 않는 이름을 둔다.
 * 서버 문제(issues — '<이름>: <문제 한 줄>')는 오류처럼 경고 아이콘 + 수, 무엇인지는 title
 */
function RoomTodo({ t, issues }: { t: { asks: number; messages: number; held: number } | undefined; issues?: string[] }) {
  if (!t && !issues?.length) return null
  const unread = t ? t.messages + t.held : 0
  return (
    <>
      {issues && issues.length > 0 && (
        <span className="rs-todo e" title={issues.join('\n')}>
          <TriangleAlert className="i" aria-hidden="true" />
          <span className="sr-only">서버 문제 </span>
          {issues.length}
        </span>
      )}
      {t && t.asks > 0 && (
        <span className="rs-todo a">
          <span className="dot a" aria-hidden="true" />
          <span className="sr-only">내 승인 필요 </span>
          {t.asks}
        </span>
      )}
      {unread > 0 && (
        <span className="rs-todo r">
          <span className="dot r" aria-hidden="true" />
          <span className="sr-only">받은 메시지 </span>
          {unread}
        </span>
      )}
    </>
  )
}

interface NameFormProps {
  label: string
  initial: string
  submitLabel: string
  /** 다듬은(앞뒤 빈칸 뺀) 이름 — 실패하면 그 문구를 칸 아래에 */
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}

/** 목록 안 한 줄 이름 입력(이름 바꾸기) — Enter·버튼으로 보내고 Esc 로 접는다 */
function NameForm({ label, initial, submitLabel, onSubmit, onCancel }: NameFormProps) {
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

/** 직접 입력한 서버 — 입력을 이만큼 멈추면 확인한다 */
const TYPE_PAUSE_MS = 600

type Where = 'local' | 'server'

/**
 * 새 방(목록의 '새 방' · 빈 화면의 '방 만들기') — 이름 · 어디서 일하나요(이 PC | 서버(SSH)).
 * 서버면 서버 칸 = ~/.ssh/config 의 서버 목록 + 직접 입력. 고르는 즉시(직접 입력은 입력을 멈춘 뒤 · Enter) 접속을 확인하고,
 * 서버 방은 확인이 된 뒤에만 만든다. ssh 가 없으면 스위치의 서버 칸이 꺼지고 그 자리에 안내.
 */
export function NewRoomDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [where, setWhere] = useState<Where>('local')
  /** 이 PC 에 ssh 가 있나 — null 은 묻는 중(그동안 서버 칸은 꺼 둔다) */
  const [ssh, setSsh] = useState<boolean | null>(null)
  const hosts = useSshHosts(true)
  /** 목록에서 고른 서버 */
  const [listHost, setListHost] = useState<string | null>(null)
  /** '직접 입력…' 을 골랐다 */
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')
  const serverArea = useRef<HTMLDivElement>(null)
  const typedInput = useRef<HTMLInputElement>(null)
  // 다시 그린 뒤 옮길 포커스 — 서버 칸이 처음 보일 때 · 직접 입력칸이 생길 때
  const focusNext = useRef<'server' | 'typed' | null>(null)
  // 입력 멈춤 타이머 · Enter·고르기로 막 물은 글 — 그 확인이 바로 실패해도 타이머가 같은 글을 또 묻지 않게(글을 고치면 다시 잰다)
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const asked = useRef<string | null>(null)
  const { check, start, reset, settled } = useRemoteCheck(
    target => target,
    async target => {
      const r = await window.dure.checkRemote(target)
      return r.ok ? { ok: true, value: target, claudeVersion: r.claudeVersion } : r
    },
  )
  const id = useId()

  useEffect(() => {
    let stale = false
    Promise.resolve()
      .then(() => window.dure.sshAvailable())
      .then(
        ok => { if (!stale) setSsh(ok) },
        e => console.error('두레: ssh 가 있는지 묻지 못했어요', e), // 모르면 서버 칸은 꺼 둔 채 — 없다고 말하지는 않는다
      )
    return () => { stale = true }
  }, [])

  // 목록이 비면(~/.ssh/config 없음) 서버 칸은 바로 입력칸
  const noList = hosts !== null && hosts.length === 0
  const inputMode = typing || noList
  const target = inputMode ? typed.trim() : listHost ?? ''
  // 지금 칸과 맞는 확인만 보인다
  const shown = check.state !== 'idle' && check.target === target ? check : { state: 'idle' as const }
  const serverReady = shown.state === 'ok' && target !== ''
  const canSubmit = name.trim() !== '' && (where === 'local' || serverReady)

  useLayoutEffect(() => {
    const to = focusNext.current
    if (!to) return
    focusNext.current = null
    if (to === 'typed') typedInput.current?.focus()
    else serverArea.current?.querySelector<HTMLElement>('button, input')?.focus()
  })

  // 직접 입력 — 입력을 멈추면 잠시 뒤 확인(Enter·고르기로 이미 물었으면 또 묻지 않는다)
  useEffect(() => {
    if (where !== 'server' || !inputMode) return
    const host = typed.trim()
    if (!host || asked.current === host) return
    const t = setTimeout(() => {
      typeTimer.current = null
      if (!settled(host)) start(host)
    }, TYPE_PAUSE_MS)
    typeTimer.current = t
    return () => {
      clearTimeout(t)
      if (typeTimer.current === t) typeTimer.current = null
    }
  }, [where, inputMode, typed, settled, start])

  /** 지금 묻는다 — 걸려 있던 입력 멈춤 타이머는 지운다 */
  const askNow = (host: string) => {
    if (typeTimer.current) clearTimeout(typeTimer.current)
    typeTimer.current = null
    asked.current = host
    if (!settled(host)) start(host)
  }

  const toServer = () => {
    if (where === 'server' || ssh !== true) return
    setWhere('server')
    focusNext.current = 'server'
  }

  const pickHost = (host: string) => {
    setTyping(false)
    setListHost(host)
    askNow(host)
  }

  const pickTyped = () => {
    setTyping(true)
    focusNext.current = 'typed'
    const host = typed.trim()
    if (!host) reset()
    else askNow(host)
  }

  const onTyped = (text: string) => {
    setTyped(text)
    asked.current = null
    if (!settled(text.trim())) reset()
  }

  // Enter — 확인이 됐으면 그대로 만들기(대화상자 보내기), 아니면 기다리지 않고 바로 확인
  const onTypedKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    if (serverReady) return
    e.preventDefault()
    const host = typed.trim()
    if (host) askNow(host)
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await createRoom(name.trim(), where === 'server' ? { host: target } : null)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const checkId = `${id}-c`

  return (
    <FormDialog title="새 방" submitLabel="만들기" canSubmit={canSubmit} busy={busy} onSubmit={() => void submit()} onClose={onClose}>
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
      <div className="fld">
        <span className="fld-l" id={`${id}-w`}>
          {REMOTE.where}
        </span>
        <div className="seg where" role="radiogroup" aria-labelledby={`${id}-w`}>
          <button type="button" role="radio" aria-checked={where === 'local'} onClick={() => setWhere('local')}>
            <Monitor className="i" aria-hidden="true" />
            {REMOTE.local}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={where === 'server'}
            disabled={ssh !== true}
            aria-describedby={ssh === false ? `${id}-ns` : undefined}
            onClick={toServer}
          >
            <Server className="i" aria-hidden="true" />
            {REMOTE.server}
          </button>
        </div>
        {/* ssh 가 없으면 서버 칸 자리에 */}
        {ssh === false && (
          <p className="rchk bad" id={`${id}-ns`}>
            <TriangleAlert className="i" aria-hidden="true" />
            <span>{REMOTE.noSsh}</span>
          </p>
        )}
      </div>
      {where === 'server' && (
        <div className="fld" ref={serverArea}>
          <span className="fld-l" id={`${id}-s`}>
            {REMOTE.serverLabel}
          </span>
          {!noList && (
            <ServerPicker
              hosts={hosts ?? []}
              host={typing ? null : listHost}
              typing={typing}
              labelId={`${id}-s`}
              describedBy={shown.state !== 'idle' && !typing ? checkId : undefined}
              onHost={pickHost}
              onTyped={pickTyped}
            />
          )}
          {inputMode && (
            <input
              ref={typedInput}
              className="inp mono"
              aria-label={REMOTE.typedLabel}
              placeholder={REMOTE.typedExample}
              value={typed}
              onChange={e => onTyped(e.target.value)}
              onKeyDown={onTypedKey}
              aria-describedby={shown.state !== 'idle' ? checkId : undefined}
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <RemoteCheckLine id={checkId} check={shown} okText={REMOTE.connected} />
        </div>
      )}
    </FormDialog>
  )
}

interface ServerPickerProps {
  hosts: SshHostEntry[]
  /** 목록에서 고른 서버 — 없으면 null */
  host: string | null
  /** '직접 입력…' 을 골랐다 */
  typing: boolean
  /** 칸 라벨('서버') — 단추와 목록의 이름 */
  labelId: string
  /** 확인 줄 */
  describedBy?: string
  onHost: (host: string) => void
  /** '직접 입력…' — 입력칸으로 포커스는 부른 쪽이 */
  onTyped: () => void
}

/** 서버 목록 단추 + 목록 상자 — 줄마다 host + 흐린 user@hostName, 끝에 직접 입력…. ↑↓·Home·End 로 옮기고 Enter 로 고르고 Esc 는 목록만 닫는다 */
function ServerPicker({ hosts, host, typing, labelId, describedBy, onHost, onTyped }: ServerPickerProps) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const valueId = useId()
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, wrap, close)

  // 열리면 고른 줄(없으면 첫 줄)로
  useEffect(() => {
    if (!open) return
    const b = box.current
    ;(b?.querySelector<HTMLElement>('[aria-selected="true"]') ?? b?.querySelector<HTMLElement>(OPTION))?.focus()
  }, [open])

  const chosen = host === null ? undefined : hosts.find(h => h.host === host)
  const chosenAddr = chosen ? sshAddress(chosen) : null

  const pick = (h: string) => {
    setOpen(false)
    button.current?.focus()
    onHost(h)
  }

  const pickTyped = () => {
    setOpen(false)
    onTyped()
  }

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    setOpen(true)
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      button.current?.focus()
      return
    }
    if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    moveMenuFocus(e, OPTION)
  }

  return (
    <div className="mp srv-pick" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="inp srv-sel"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-describedby={describedBy}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onButtonKey}
      >
        <span id={valueId} className="srv-v">
          {typing ? (
            REMOTE.typed
          ) : host === null ? (
            <span className="srv-ph">{REMOTE.pick}</span>
          ) : (
            <>
              <Server className="i" aria-hidden="true" />
              <span className="srv-h">{host}</span>
              {chosenAddr && (
                <>
                  {' '}
                  <small>{chosenAddr}</small>
                </>
              )}
            </>
          )}
        </span>
        <ChevronDown className="i srv-cv" aria-hidden="true" />
      </button>
      <Presence show={open}>
        <MotionDiv
          motion={MOTION.pop}
          origin="top left"
          ref={box}
          className="pop srv-pop"
          role="listbox"
          aria-labelledby={labelId}
          data-own-esc=""
          onKeyDown={onListKey}
        >
          {hosts.map(h => {
            const addr = sshAddress(h)
            return (
              <button key={h.host} type="button" role="option" aria-selected={!typing && h.host === host} className="mi" onClick={() => pick(h.host)}>
                <Server className="i" aria-hidden="true" />
                <span className="srv-h">{h.host}</span>
                {addr && (
                  <>
                    {' '}
                    <small>{addr}</small>
                  </>
                )}
              </button>
            )
          })}
          {hosts.length > 0 && <div className="pop-sep" aria-hidden="true" />}
          <button type="button" role="option" aria-selected={typing} className="mi" onClick={pickTyped}>
            <span className="srv-h">{REMOTE.typed}</span>{' '}
            <small aria-hidden="true">{REMOTE.typedExample}</small>
          </button>
        </MotionDiv>
      </Presence>
    </div>
  )
}
