// 휴대폰 화면 — 방 고르기 → 카드 판 → 대화(+ 할 일). 화면은 주소의 조각(#room= · #inbox= · #agent=)이 정한다:
// 들어갈 때마다 방문 기록에 한 칸을 쌓아 휴대폰의 뒤로 가기(안드로이드 손짓)가 한 단계 위로 가고, 알림을 누르면 진입점이 #agent= 로 바꾼다.
// 대화상자·설정 판이 뜨면 그 위에 '덮개 칸'(주소는 같다)을 하나씩 쌓는다 — 뒤로 가기는 맨 위에 뜬 것부터 닫고, 그다음에 화면을 떠난다.
// 🔴 setSelected 는 부르지 않는다 — 열린 대화 = 스토어의 고른 에이전트(휴대폰 화면 상태로만, 스토어가 휴대폰이면 PC 에 알리지 않는다)
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentId, RoomId } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { Presence } from '../lib/presence'
import { escapeTopDialogs, openDialogCount, watchDialogs } from '../lib/dialog'
import { AddAgentDialog } from '../shell/AddAgentDialog'
import { useConn } from './connection'
import { MobileTop, OFFLINE_HINT, OfflineBand, OfflineContext, type Offline } from './parts'
import { RoomList } from './RoomList'
import { InboxScreen, RoomBoard } from './RoomBoard'
import { AgentScreen } from './AgentScreen'
import type { WaitRow } from './rooms'
import './mobile.css'

export type Route =
  | { kind: 'rooms' }
  | { kind: 'room'; roomId: RoomId }
  | { kind: 'inbox'; roomId: RoomId }
  | { kind: 'agent'; agentId: AgentId }

/** 주소 조각 → 화면. #pair= 는 진입점이 이미 지웠다 */
export function parseRoute(hash: string): Route {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const agent = p.get('agent')
  if (agent) return { kind: 'agent', agentId: agent }
  const inbox = p.get('inbox')
  if (inbox) return { kind: 'inbox', roomId: inbox }
  const room = p.get('room')
  if (room) return { kind: 'room', roomId: room }
  return { kind: 'rooms' }
}

export function routeHash(r: Route): string {
  switch (r.kind) {
    case 'rooms':
      return ''
    case 'room':
      return `#room=${encodeURIComponent(r.roomId)}`
    case 'inbox':
      return `#inbox=${encodeURIComponent(r.roomId)}`
    case 'agent':
      return `#agent=${encodeURIComponent(r.agentId)}`
  }
}

const sameRoute = (a: Route, b: Route) => routeHash(a) === routeHash(b)

/**
 * 우리가 쌓은 방문 기록 칸의 state — prev = 아래 칸의 주소 조각, below = 아래 칸의 state(우리 것이 아니면 null).
 * 이 칸에서 ‹ 는 브라우저 뒤로 가기와 같고(기록이 겹치지 않게), 화면은 기다리지 않고 바로 아래 칸으로 바꾼다.
 * layer = 덮개 칸(열린 대화상자 하나 몫) — 주소는 아래 칸과 같다. 뒤로 가기로 이 칸을 떠나면 맨 위 대화상자를 닫는다
 */
interface Entry {
  dure: true
  prev: string
  below: Entry | null
  layer?: true
}
const isEntry = (s: unknown): s is Entry => !!s && typeof s === 'object' && (s as { dure?: unknown }).dure === true
const isLayer = (s: unknown): s is Entry => isEntry(s) && s.layer === true

/** 덮개 칸 아래의 첫 화면 칸 — 지난 덮개 칸 수와 함께 */
function underLayers(st: unknown): { st: unknown; n: number } {
  let n = 0
  while (isLayer(st)) {
    st = st.below
    n++
  }
  return { st, n }
}

/** 기록에 쓴다 — 쌓기(아래 칸을 기억)나 지금 칸 갈음 */
function write(next: Route, replace: boolean): void {
  const url = `${location.pathname}${location.search}${routeHash(next)}`
  if (replace) history.replaceState(history.state, '', url)
  else history.pushState({ dure: true, prev: location.hash, below: isEntry(history.state) ? history.state : null } satisfies Entry, '', url)
}

/** 끊긴 동안 — 마지막으로 이어져 있던 때(받은 내용의 시각). 처음부터 못 받았으면 null */
function useOfflineState(): Offline {
  const conn = useConn()
  const failed = useDure(s => s.loadError !== null)
  const [lostAt, setLostAt] = useState<number | null>(() => (conn === 'reconnecting' && !failed ? Date.now() : null))
  useEffect(() => {
    if (conn === 'open') setLostAt(null)
    else if (conn === 'reconnecting' && !failed) setLostAt(t => t ?? Date.now())
  }, [conn, failed])
  return { offline: conn === 'reconnecting', at: failed ? null : lostAt }
}

const PENDING_TITLE: Record<Exclude<Route['kind'], 'rooms'>, string> = { agent: '대화', room: '방', inbox: '할 일' }

/** 처음 상태를 아직 못 받았다(PC 에 닿지 않음) — 알림으로 연 주소(#agent= 등)는 버리지 않고, 받으면 그 화면으로 */
function PendingScreen({ kind, onBack }: { kind: Exclude<Route['kind'], 'rooms'>; onBack: () => void }) {
  return (
    <main className="m-scr">
      <MobileTop onBack={onBack}>
        <div className="m-who">
          <h1 className="trunc">{PENDING_TITLE[kind]}</h1>
        </div>
      </MobileTop>
      <OfflineBand />
      <div className="m-body">
        <p className="m-empty-t">아직 받은 내용이 없어요</p>
        <p className="m-hint">{OFFLINE_HINT}</p>
      </div>
    </main>
  )
}

export function MobileApp() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  const offline = useOfflineState()
  const [adding, setAdding] = useState<RoomId | null>(null)
  const fork = useDure(s => s.forkDraft)
  const selected = useDure(s => s.selectedAgentId)
  const roomMenu = useDure(s => s.roomMenuRequest)
  // 처음 상태를 받았나 — 못 받은 채 띄웠으면(진입점) loadError 가 남아 있다. 받기 전엔 없는 방·에이전트라고 화면을 떠나지 않는다
  const loaded = useDure(s => s.loadError === null)
  // 지금 있는 방·에이전트 — 지워지면 화면을 떠난다
  const ids = useDure(s => `${s.rooms.map(r => r.id).join(',')}|${s.agents.map(a => `${a.id}@${a.roomId}`).join(',')}`)
  /** 열린 대화의 방 — 그 에이전트가 지워진 뒤 갈 곳 */
  const lastRoom = useRef<RoomId | null>(null)
  // 우리가 부른 뒤로 가기가 끝나기를 기다리는 중 — 닿을 주소 조각(expect) · 그동안의 '지금 칸 state'(virtual, undefined 면 history.state) ·
  // 그동안 들어온 이동(queued, 닿은 뒤 기록에 쓴다). 브라우저의 뒤로 가기는 비동기라 그사이 기록을 건드리면 엉뚱한 칸으로 간다
  const expect = useRef<string | null>(null)
  const virtual = useRef<Entry | null | undefined>(undefined)
  const queued = useRef<{ next: Route; replace: boolean } | null>(null)
  /** 지금 화면 칸 위에 쌓은 덮개 칸 수 — 열린 대화상자 수를 따라간다(sync) */
  const layers = useRef(0)

  const show = (next: Route) => setRoute(prev => (sameRoute(prev, next) ? prev : next))

  /** 뒤로 n 칸 — 닿을 칸의 주소 조각과 state 를 적어 두고 간다(닿을 때까지 들어온 이동은 queued 로) */
  const goBack = (n: number, hash: string, landing: Entry | null) => {
    expect.current = hash
    virtual.current = landing
    history.go(-n)
  }

  /** 덮개 칸을 모두 걷는다(대화상자는 그대로 — 화면이 바뀌기 전에). 기다리는 뒤로 가기가 없을 때만 */
  const dropLayers = () => {
    const { st, n } = underLayers(history.state)
    layers.current = 0
    if (n > 0) goBack(n, location.hash, isEntry(st) ? st : null)
  }

  /** 덮개 칸 수를 열린 대화상자 수에 맞춘다 — 뜨면 쌓고(누른 그 자리라 브라우저가 건너뛰지 않는 칸), 단추·Esc 로 닫히면 걷는다 */
  const sync = () => {
    if (expect.current !== null) return // 닿은 뒤 다시 맞춘다
    const want = openDialogCount()
    if (want > layers.current) {
      for (let i = layers.current; i < want; i++) {
        history.pushState({ dure: true, prev: location.hash, below: isEntry(history.state) ? history.state : null, layer: true } satisfies Entry, '', location.href)
      }
      layers.current = want
    } else if (want < layers.current) {
      let st: unknown = history.state
      let n = 0
      while (n < layers.current - want && isLayer(st)) {
        st = st.below
        n++
      }
      layers.current = want
      if (n > 0) goBack(n, location.hash, isEntry(st) ? st : null)
    }
  }
  const syncRef = useRef(sync)
  syncRef.current = sync

  // 대화상자가 뜨고 닫힐 때 — 한 번의 그림에서 닫고 여는 것(판 → 확인)은 합쳐서 본다
  useEffect(() => {
    let scheduled = false
    const off = watchDialogs(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        syncRef.current()
      })
    })
    // 다시 불러온 페이지가 덮개 칸 위에서 시작했다(그 대화상자는 이제 없다) — 걷는다
    if (expect.current === null && openDialogCount() === 0 && isLayer(history.state)) dropLayers()
    return off
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- dropLayers 는 ref 만 쓴다

  // 주소 → 화면: 휴대폰의 뒤로·앞으로 가기(popstate) · 알림 누름(hashchange — 진입점이 #agent= 로 바꾼다)
  useEffect(() => {
    const on = () => {
      const h = location.hash
      if (expect.current !== null) {
        if (h !== expect.current) return // 이어진 뒤로 가기의 중간 칸
        expect.current = null
        virtual.current = undefined
        // 쓸 이동이 있는데 덮개 칸이 남았다 — 먼저 걷고 닿은 뒤에 쓴다
        if (queued.current && layers.current > 0) return dropLayers()
        const q = queued.current
        queued.current = null
        if (q) write(q.next, q.replace)
        syncRef.current()
        return
      }
      // 사용자의 뒤로 가기가 덮개 칸을 지났다 — 지난 만큼 맨 위 대화상자부터 닫는다(주소가 같으면 화면은 그대로)
      if (layers.current > 0) {
        const { n } = underLayers(history.state)
        if (n < layers.current) {
          const k = layers.current - n
          layers.current = n
          escapeTopDialogs(k)
        }
      }
      show(parseRoute(h))
    }
    window.addEventListener('popstate', on)
    window.addEventListener('hashchange', on)
    return () => {
      window.removeEventListener('popstate', on)
      window.removeEventListener('hashchange', on)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- dropLayers 는 ref 만 쓴다

  const navigate = useCallback((next: Route, replace = false) => {
    show(next)
    // 대화상자가 떠 있는 채 화면이 바뀐다 — 덮개 칸을 먼저 걷는다(새 칸이 덮개 칸 위에 쌓이지 않게)
    if (expect.current === null && layers.current > 0) dropLayers()
    if (expect.current !== null) {
      // 뒤로 가기가 끝난 뒤에 쓴다 — 쌓기가 하나라도 있었으면 쌓는다
      queued.current = { next, replace: (queued.current?.replace ?? true) && replace }
      return
    }
    write(next, replace)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- dropLayers 는 ref 만 쓴다

  /** 위 화면 — 대화는 그 에이전트의 방 판, 할 일은 그 판, 판은 방 목록 */
  const parentOf = useCallback((r: Route): Route => {
    const st = getStore().getState()
    if (r.kind === 'agent') {
      const room = st.agents.find(a => a.id === r.agentId)?.roomId ?? lastRoom.current
      return room && st.rooms.some(x => x.id === room) ? { kind: 'room', roomId: room } : { kind: 'rooms' }
    }
    if (r.kind === 'inbox') return st.rooms.some(x => x.id === r.roomId) ? { kind: 'room', roomId: r.roomId } : { kind: 'rooms' }
    return { kind: 'rooms' }
  }, [])

  const routeNow = useRef(route)
  routeNow.current = route

  /**
   * ‹ — 우리가 쌓은 칸이면 화면을 바로 아래 칸으로 바꾸고 브라우저 뒤로 가기(기록이 겹치지 않게, 위의 덮개 칸도 한 번에).
   * 아니면(알림으로 바로 열림 · 처음 연 주소) 위 화면으로 갈음
   */
  const back = useCallback(() => {
    const { st, n } = underLayers(virtual.current === undefined ? history.state : virtual.current)
    if (isEntry(st)) {
      layers.current = 0
      virtual.current = st.below
      expect.current = st.prev
      show(parseRoute(st.prev))
      history.go(-(n + 1))
      return
    }
    navigate(parentOf(routeNow.current), true)
  }, [parentOf, navigate])

  // 바로 앞 화면이 대화였으면 그 에이전트 — 판이 다시 그려질 때 그 카드가 화면 안에 들게(RoomBoard → 관계도)
  const shown = useRef(route)
  const cameFrom = useRef<AgentId | null>(null)
  if (shown.current !== route) {
    cameFrom.current = shown.current.kind === 'agent' ? shown.current.agentId : null
    shown.current = route
  }

  // 화면 → 스토어: 대화면 그 에이전트를 고르고(방도 그 방으로), 판·할 일이면 그 방(고르기 없음), 방 목록이면 고르기 없음.
  // 없는 방·에이전트(지워짐 · 알림의 옛 에이전트)면 화면을 떠난다 — 처음 상태를 받은 뒤에만(받기 전엔 모두 없다)
  useEffect(() => {
    const store = getStore()
    const st = store.getState()
    if (route.kind === 'agent') {
      if (!loaded) return
      const a = st.agents.find(x => x.id === route.agentId)
      if (!a) {
        back()
        return
      }
      lastRoom.current = a.roomId
      if (st.selectedAgentId !== a.id || st.roomId !== a.roomId) store.focusAgent(a.id)
      return
    }
    if (route.kind === 'room' || route.kind === 'inbox') {
      if (!loaded) return
      if (!st.rooms.some(r => r.id === route.roomId)) {
        back()
        return
      }
      if (st.roomId !== route.roomId || st.selectedAgentId !== null) store.selectRoom(route.roomId)
      return
    }
    if (st.selectedAgentId !== null) store.selectAgent(null)
  }, [route, ids, back, loaded])

  // 스토어 → 화면: 같이 쓰는 화면(관계도 카드 · 할 일 · 화면 밖 알약 …)이 에이전트를 골랐다 — 그 대화로 들어간다.
  // 고르기가 바뀐 때만 본다(뒤로 가기로 화면이 먼저 바뀐 순간의 옛 고르기를 다시 열지 않게)
  const prevSelected = useRef(selected)
  useEffect(() => {
    const prev = prevSelected.current
    prevSelected.current = selected
    if (selected === null || selected === prev) return
    if (route.kind === 'agent' && route.agentId === selected) return
    navigate({ kind: 'agent', agentId: selected })
  }, [selected, route, navigate])

  // 할 일 화면의 '다른 방에도 할 일' — 방 목록으로
  const prevRoomMenu = useRef(roomMenu)
  useEffect(() => {
    if (roomMenu === prevRoomMenu.current) return
    prevRoomMenu.current = roomMenu
    navigate({ kind: 'rooms' })
  }, [roomMenu, navigate])

  const openAgent = (row: WaitRow) => {
    // 넘기는 메시지만 기다리면 대화의 메시지 탭(거기서 승인한다)
    if (row.messagesOnly) getStore().setPanelTab(row.agentId, 'messages')
    navigate({ kind: 'agent', agentId: row.agentId })
  }

  let screen
  if (route.kind !== 'rooms' && !loaded) screen = <PendingScreen kind={route.kind} onBack={back} />
  else {
    switch (route.kind) {
      case 'rooms':
        screen = <RoomList onOpenRoom={id => navigate({ kind: 'room', roomId: id })} onOpenAgent={openAgent} />
        break
      case 'room':
        screen = (
          <RoomBoard
            roomId={route.roomId}
            onBack={back}
            onInbox={() => navigate({ kind: 'inbox', roomId: route.roomId })}
            onAddAgent={() => setAdding(route.roomId)}
            // 지운 방은 스냅샷에서 빠진다 — 위의 '없는 방이면 떠난다'가 방 목록으로 데려간다
            onRemoved={() => {}}
            from={cameFrom.current}
          />
        )
        break
      case 'inbox':
        screen = <InboxScreen roomId={route.roomId} onBack={back} />
        break
      case 'agent':
        screen = selected === route.agentId ? <AgentScreen onBack={back} /> : null
        break
    }
  }

  return (
    <OfflineContext.Provider value={offline}>
      <div className={`m-app${offline.offline ? ' offline' : ''}`}>{screen}</div>
      <Presence show={adding !== null}>{adding !== null && <AddAgentDialog roomId={adding} onClose={() => setAdding(null)} />}</Presence>
      <Presence show={fork !== null}>{fork && <AddAgentDialog roomId={fork.roomId} fork={fork} onClose={() => getStore().closeFork()} />}</Presence>
    </OfflineContext.Provider>
  )
}
