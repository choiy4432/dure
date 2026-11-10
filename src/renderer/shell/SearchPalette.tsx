import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Monitor, Search, Server } from 'lucide-react'
import type { SearchHit } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { getStore, useDure } from '../state/store'
import { openDialogCount, useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { useMotion } from '../lib/presence'
import { useNow } from '../lib/useNow'
import { ago, dayText, initial, SEARCH as W } from '../lib/words'
import { charCount, nameRows, type Found, type NameRow } from './searchNames'

/** 타자 뒤 이만큼 기다렸다 대화를 찾는다 — 치는 동안 찾기를 거듭 부르지 않게 */
export const SEARCH_WAIT_MS = 150

/** Ctrl+K(맥 Cmd+K) — Shift·Alt 가 같이 눌렸으면 아니다. 한글 자판이어도 같은 자리(code)면 */
export function isSearchKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')
}

/** 글을 받지 않는 input 꼴 — 이런 칸에 초점이 있어도 Ctrl+K 는 연다 */
const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image'])

/** 글을 쓰는 중인 다른 칸(설정 숫자 칸 · 이름 고치기 등) — 입력창(Composer)은 빼고. 그 칸의 글쓰기를 빼앗지 않는다 */
function typingElsewhere(el: Element | null): boolean {
  if (!(el instanceof HTMLElement) || el.closest('.pnl-cmp')) return false
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) return !NOT_TEXT.has(el.type)
  return el.isContentEditable === true
}

/**
 * 어디서든 Ctrl+K · Cmd+K 로 찾기 창을 연다 — 다른 창(설정 · 확인 · 에이전트 추가 · 짝 맺기 · 그림 보기 · 투어 카드 등)이 떠 있거나
 * 다른 입력칸에 쓰는 중이면 무시한다(입력창에서는 연다). enabled 가 아니면 듣지 않는다
 */
export function useSearchShortcut(enabled: boolean, onOpen: () => void): void {
  const live = useRef(onOpen)
  useLayoutEffect(() => {
    live.current = onOpen
  })
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !isSearchKey(e)) return
      if (openDialogCount() > 0 || document.querySelector('[aria-modal="true"]') || getStore().getState().tour !== null) return
      if (typingElsewhere(document.activeElement)) return
      e.preventDefault()
      live.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

/** 대화 묶음 — busy: 지금 말로 찾는 중(앞 결과는 새 결과가 올 때까지 그대로) · ver: 결과가 바뀔 때마다 오른다(고른 줄 열쇠) */
interface Convs {
  hits: SearchHit[]
  more: boolean
  busy: boolean
  failed: boolean
  ver: number
}
const NO_CONVS: Convs = { hits: [], more: false, busy: false, failed: false, ver: 0 }

/** 고를 수 있는 한 줄 — 에이전트 · 방 · 대화 줄 */
type Option =
  | { key: string; kind: 'name'; row: NameRow }
  | { key: string; kind: 'hit'; hit: SearchHit; agent: AgentView }

/** 맞은 곳을 <mark> 로 — ranges 는 [시작, 끝)(겹치거나 밖이면 건너뛴다) */
function Marked({ text, ranges }: { text: string; ranges: readonly (readonly [number, number])[] }) {
  const out: ReactNode[] = []
  let at = 0
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a < at || b <= a || b > text.length) continue
    if (a > at) out.push(text.slice(at, a))
    out.push(<mark key={a}>{text.slice(a, b)}</mark>)
    at = b
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

const marks = (f: Found | null): [number, number][] => (f?.range ? [f.range] : [])

/**
 * 찾기 · 옮기기(시안 ① A) — 가운데 뜨는 하나의 검색창. 위 띠 아래를 막으로 덮는다(위 띠는 그대로 보이고, 누르면 닫힌다).
 * 한 상자에 '에이전트 · 방'(이름·역할·폴더 — 빈 입력이면 최근 고른 에이전트)과 '대화에서 · N곳'(두 글자부터, 타자 뒤 150 ms —
 * 모든 방 · 에이전트의 지금·지난 대화, 지금 방 먼저 · 새로운 순 · 50곳까지). 앞 찾기의 늦은 답 · 끊긴 답은 버린다.
 * 키보드: 입력칸이 combobox(aria-activedescendant 로 고른 줄) · ↑↓ 고르기(끝에서 처음으로) · Enter 열기 · Esc · Ctrl+K 닫기.
 * 마우스: 줄에 올리면 고른 줄, 누르면 연다 · 바깥을 누르면 닫는다. 결과 수는 화면 읽기 프로그램에 polite 로.
 * 고르면 닫고 — 에이전트는 그 에이전트로(다른 방이면 방도) · 방은 그 방으로 · 대화 줄은 그 줄로(store.openHit). 닫히면 초점은 연 자리로
 */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const v = useDure(s => ({ agents: s.agents, rooms: s.rooms, roomId: s.roomId }))
  const now = useNow()
  const base = useId()
  const backdrop = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useMotion(backdrop, MOTION.backdrop)
  useMotion(box, MOTION.dialog)
  useDialogFocus(box, onClose, b => b.querySelector<HTMLElement>('input'))

  // 바깥을 누르면 닫는다 — 막 · 위 띠(위 띠의 찾기 칸은 스스로 닫는다)
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (box.current?.contains(t) || t?.closest?.('[data-search-trigger]')) return
      onClose()
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [onClose])

  const [query, setQuery] = useState('')
  const q = query.trim()
  const long = charCount(q) >= 2
  const [recent] = useState(() => getStore().recentAgents())
  const names = useMemo(() => nameRows(v.agents, v.rooms, v.roomId, q, recent), [v.agents, v.rooms, v.roomId, q, recent])

  // 대화 찾기 — 마지막으로 부른 것(ask)의 답만 받는다. 끊긴 답(cancelled)은 더 새 찾기가 돌고 있다는 뜻이라 그대로 기다린다
  const [convs, setConvs] = useState<Convs>(NO_CONVS)
  const ask = useRef(0)
  const asked = useRef<string | null>(null)
  const roomId = v.roomId
  useEffect(() => {
    if (!long) {
      ask.current++
      asked.current = null
      setConvs(c => (c.hits.length > 0 || c.busy || c.failed ? { ...NO_CONVS, ver: c.ver + 1 } : c))
      return
    }
    if (asked.current === q) return
    setConvs(c => (c.busy && !c.failed ? c : { ...c, busy: true, failed: false }))
    const timer = setTimeout(() => {
      const n = ++ask.current
      asked.current = q
      Promise.resolve()
        .then(() => window.dure.search(q, roomId !== null ? { roomId } : undefined))
        .then(
          r => {
            if (n !== ask.current || r.cancelled) return
            setConvs(c => ({ hits: r.hits, more: r.more, busy: false, failed: false, ver: c.ver + 1 }))
          },
          () => {
            if (n !== ask.current) return
            setConvs(c => ({ ...NO_CONVS, failed: true, ver: c.ver + 1 }))
          },
        )
    }, SEARCH_WAIT_MS)
    return () => clearTimeout(timer)
  }, [q, long, roomId])
  // 닫힌 뒤에 온 답은 버린다
  useEffect(() => () => { ask.current++ }, [])

  const byId = useMemo(() => new Map(v.agents.map(a => [a.id, a])), [v.agents])
  const roomName = useMemo(() => new Map(v.rooms.map(r => [r.id, r.name])), [v.rooms])
  // 그새 지운 에이전트의 줄은 뺀다
  const hits = useMemo(
    () => (long ? convs.hits.flatMap(h => (byId.has(h.agentId) ? [{ hit: h, agent: byId.get(h.agentId)! }] : [])) : []),
    [long, convs.hits, byId],
  )

  const options = useMemo<Option[]>(() => [
    ...names.rows.map((row): Option => ({ key: row.kind === 'agent' ? `a:${row.agent.id}` : `r:${row.room.id}`, kind: 'name', row })),
    ...hits.map((h, i): Option => ({ key: `h:${convs.ver}:${i}`, kind: 'hit', ...h })),
  ], [names.rows, hits, convs.ver])

  const [activeKey, setActiveKey] = useState<string | null>(null)
  const found = options.findIndex(o => o.key === activeKey)
  const active = options.length === 0 ? -1 : Math.max(0, found)
  const optionId = (i: number) => `${base}-o${i}`
  const listId = `${base}-list`
  const hintId = `${base}-hint`

  // 고른 줄이 상자 밖이면 보이게(↑↓)
  useLayoutEffect(() => {
    if (active < 0) return
    const el = document.getElementById(optionId(active))
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const choose = useCallback((o: Option) => {
    onClose()
    const store = getStore()
    if (o.kind === 'hit') void store.openHit(o.hit)
    else if (o.row.kind === 'agent') store.focusAgent(o.row.agent.id)
    else store.selectRoom(o.row.room.id)
  }, [onClose])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isSearchKey(e)) {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (options.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActiveKey(options[(active + step + options.length) % options.length].key)
      return
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (active >= 0) choose(options[active])
    }
  }

  // 결과 수 — 화면 읽기 프로그램용 한 줄
  const nameCount = names.rows.length
  const parts: string[] = []
  if (nameCount > 0) parts.push(q ? W.countNames(nameCount) : names.title === 'recent' ? W.countRecent(nameCount) : W.countNames(nameCount))
  if (long) {
    if (convs.busy) parts.push(W.searching)
    else if (convs.failed) parts.push(W.failed)
    else if (hits.length > 0) parts.push(W.countConvs(hits.length, convs.more))
  }
  const statusText = parts.length > 0 ? parts.join(' · ') : q && !(long && convs.busy) ? W.nothing : ''

  // 대화 묶음 아래 안내 줄 — 두 글자 전 · 처음 찾는 중 · 못 찾음 · 맞는 곳 없음 · 50곳 넘음
  let note: string | null = null
  if (q && !long) note = W.short
  else if (long && hits.length === 0) note = convs.busy ? W.searching : convs.failed ? W.failed : nameCount === 0 ? W.nothing : W.none
  else if (long && convs.more && !convs.busy) note = W.more

  const namesTitle = names.title === 'recent' ? W.recent : names.title === 'room' ? W.roomAgents : W.names
  const namesHead = `${base}-gn`
  const convHead = `${base}-gc`
  let index = 0
  const row = (o: Option, body: ReactNode) => {
    const i = index++
    return (
      <div
        key={o.key}
        id={optionId(i)}
        role="option"
        aria-selected={i === active}
        className="pal-it"
        // 누르는 동안 입력칸 초점을 지킨다 — 고른 줄은 aria-activedescendant 가 말한다
        onMouseDown={e => e.preventDefault()}
        onMouseMove={() => { if (i !== active) setActiveKey(o.key) }}
        onClick={() => choose(o)}
      >
        {body}
      </div>
    )
  }

  const nameBody = (r: NameRow) => {
    if (r.kind === 'room') {
      const Icon = r.room.remote ? Server : Monitor
      return (
        <>
          <span className="av pal-av" aria-hidden="true">
            <Icon className="i" size={15} />
          </span>
          <span className="pal-m">
            <span className="pal-l1"><Marked text={r.room.name} ranges={marks(r.name)} /></span>
            <span className="pal-l2">{W.roomAgentCount(r.agents)}</span>
          </span>
          <span className="pal-tm">{r.room.id === v.roomId ? W.currentRoom : W.room}</span>
        </>
      )
    }
    const a = r.agent
    // 폴더로만 맞았으면 둘째 줄에 폴더(맞은 곳 강조), 아니면 역할 · 방
    const byFolder = !r.name && !r.role && !!r.folder
    return (
      <>
        <span className="av pal-av" aria-hidden="true">{initial(a.name)}</span>
        <span className="pal-m">
          <span className="pal-l1"><Marked text={a.name} ranges={marks(r.name)} /></span>
          {byFolder ? (
            <span className="pal-l2 pal-path"><Marked text={a.folder} ranges={marks(r.folder)} /></span>
          ) : (
            <span className="pal-l2">
              {a.role && (
                <>
                  <Marked text={a.role} ranges={marks(r.role)} />
                  {' · '}
                </>
              )}
              {r.room?.name ?? ''}
            </span>
          )}
        </span>
        <span className="pal-tm">{W.agent}</span>
      </>
    )
  }

  const hitBody = (h: SearchHit, a: AgentView) => {
    const who = h.who === 'me' ? W.me : h.who === 'claude' ? W.claude : h.from ? W.from(h.from) : W.message
    const where = h.conversation.key === null ? W.current : W.past(h.conversation.startedAt !== null ? dayText(h.conversation.startedAt, now) : null)
    const meta = [a.name, who, where, ...(h.roomId !== v.roomId ? [roomName.get(h.roomId) ?? ''] : [])].filter(Boolean).join(' · ')
    return (
      <>
        <span className="av pal-av" aria-hidden="true">{initial(a.name)}</span>
        <span className="pal-m">
          <span className="pal-l1"><Marked text={h.snippet} ranges={h.ranges} /></span>
          <span className="pal-l2">{meta}</span>
        </span>
        <span className="pal-tm">{ago(h.t, now)}</span>
      </>
    )
  }

  const nameOptions = options.filter((o): o is Extract<Option, { kind: 'name' }> => o.kind === 'name')
  const hitOptions = options.filter((o): o is Extract<Option, { kind: 'hit' }> => o.kind === 'hit')

  return (
    <div ref={backdrop} className="pal-bd">
      <div ref={box} className="pal" role="dialog" aria-modal="true" aria-label={W.title} tabIndex={-1}>
        <div className="pal-in">
          <Search className="i" size={18} aria-hidden="true" />
          <input
            className="pal-q"
            type="text"
            role="combobox"
            aria-label={W.title}
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-describedby={hintId}
            placeholder={W.placeholder}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setActiveKey(null)
            }}
            onKeyDown={onKeyDown}
          />
          <kbd className="kbd" aria-hidden="true">Esc</kbd>
        </div>
        <div className="pal-res">
          <div id={listId} role="listbox" aria-label={W.results}>
            {nameOptions.length > 0 && (
              <div role="group" aria-labelledby={namesHead} className="pal-grp">
                <div id={namesHead} role="presentation" className="pal-gt">
                  <span>{namesTitle}</span>
                </div>
                {nameOptions.map(o => row(o, nameBody(o.row)))}
              </div>
            )}
            {hitOptions.length > 0 && (
              <div role="group" aria-labelledby={convHead} className="pal-grp" aria-busy={convs.busy || undefined}>
                <div id={convHead} role="presentation" className="pal-gt">
                  <span>{W.convs(hitOptions.length)}</span>
                  <span className="pal-gt-r">{convs.busy ? W.searching : W.withPast}</span>
                </div>
                {hitOptions.map(o => row(o, hitBody(o.hit, o.agent)))}
              </div>
            )}
          </div>
          {note && <p className="pal-note">{note}</p>}
        </div>
        <p className="pal-f" id={hintId}>
          {W.hints.map(([k, what]) => (
            // 빈칸 — 화면 읽기 프로그램이 줄을 이어 읽을 때 낱말이 붙지 않게(flex 라 화면엔 안 보인다)
            <span key={k}>
              <kbd className="kbd">{k}</kbd> {what}{' '}
            </span>
          ))}
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {statusText}
        </p>
      </div>
    </div>
  )
}
