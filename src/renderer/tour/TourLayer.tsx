// 안내 투어 겹(시안 tour-look B) — 짚은 곳 밖은 살짝 흐린 옅은 막, 짚은 곳은 파란 테, 곁에 작은 카드(위 진행 막대 n/8).
// 처음 승인 칸이 뜰 때 한 번 '승인이 필요해요'도 같은 겹으로 띄운다(그동안 투어는 잠깐 멈춘다).
// 단계와 넘어가는 판정은 tourSteps — 여기선 진행(tourAdvance)을 부르고, 짚을 곳을 재고, 그리고, 초점·키를 맡는다.

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AgentId, PendingRequest, RoomId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { getStore, useDure, type UiState } from '../state/store'
import { effectiveSetup } from '../state/selectors'
import { FOCUSABLE } from '../lib/dialog'
import { useMedia } from '../lib/useMedia'
import { TOUR } from '../lib/words'
import { stepFor, tourAdvance, type TourStep } from './tourSteps'

type Dialog = 'room' | 'agent' | 'settings' | null

/** 짚은 요소 둘레 여백 */
const PAD = 6
/** 구멍은 창 가장자리에서 이만큼 안쪽까지만 — 가장자리에 붙은 요소도 테가 다 보이게 */
const HOLE_INSET = 2
/** 구멍과 카드 사이 */
const GAP = 12
/** 설정 창과 그 옆 카드 사이 */
const BESIDE_GAP = 16
/** 카드가 창 가장자리에서 떨어지는 거리 */
const EDGE = 12
/** ok 단계에서 짚을 요소가 이만큼 넘게 없으면 그 단계를 건너뛴다 */
const MISSING_MS = 1000
/** 짚은 곳이 이만큼(프레임) 그대로면 자리를 잡은 것 — 그때 화면 밖인지 본다(관계도 맞춤 움직임 도중엔 보지 않는다) */
const SETTLE_FRAMES = 5
/** 겹 모양이 이만큼(프레임, 약 1초) 그대로면 프레임마다 재지 않고 IDLE_MS 마다 잰다 — 투어를 띄워 둔 채 오래 있어도 일을 덜 한다 */
const IDLE_FRAMES = 60
const IDLE_MS = 200

type Rect = { left: number; top: number; right: number; bottom: number }
/** 겹의 모양 — 창 크기 · 구멍(없으면 화면 전체 막) · 카드 자리 */
type Geo = { vw: number; vh: number; hole: Rect | null; card: { left: number; top: number } }
/** 겹이 지금 그리는 것 — 단계 종류 · tip(승인 한 번) · beside(설정 안 — 막 없이 설정 창 옆 카드만) */
type Mode = TourStep['kind'] | 'tip' | 'beside'

/** 처음 승인 칸 — 지금 방의 승인(권한) 요청 중 고른 에이전트의 것, 없으면 가장 먼저 온 것 */
function tipRequest(requests: PendingRequest[], agents: AgentView[], roomId: RoomId | null, selected: AgentId | null): PendingRequest | null {
  const inRoom = new Set(agents.filter(a => a.roomId === roomId).map(a => a.id))
  const asks = requests.filter(r => r.kind === 'permission' && inRoom.has(r.agentId))
  if (asks.length === 0) return null
  return asks.find(r => r.agentId === selected) ?? asks.reduce((a, b) => (b.createdAt < a.createdAt ? b : a))
}

const rectOf = (el: Element): Rect => {
  const b = el.getBoundingClientRect()
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
}
const drawn = (el: Element) => {
  const b = el.getBoundingClientRect()
  return b.width > 0 || b.height > 0
}
const inside = (r: Rect, box: Rect) => r.left >= box.left && r.top >= box.top && r.right <= box.right && r.bottom <= box.bottom
const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom)
const sameGeo = (a: Geo | null, b: Geo) =>
  !!a && a.vw === b.vw && a.vh === b.vh && sameRect(a.hole, b.hole) && a.card.left === b.card.left && a.card.top === b.card.top
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
const box = (r: Rect): CSSProperties => ({ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top })

/** 요소들을 합친 사각형 — 그려진 것만 */
function unite(els: Element[]): Rect | null {
  let u: Rect | null = null
  for (const el of els) {
    if (!drawn(el)) continue
    const r = rectOf(el)
    u = u ? { left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) } : r
  }
  return u
}

/** 그 요소가 보이는 칸 — 관계도 안이면 관계도(React Flow 는 밖을 잘라 낸다), 아니면 창 */
function viewOf(el: Element): Rect {
  const flow = el.closest('.react-flow')
  return flow ? rectOf(flow) : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
}

/** 실제로 초점이 갈 수 있는 것 — 숨김(hidden · display:none · visibility:hidden · aria-hidden)과 tabindex<0 은 뺀다 */
function focusable(el: HTMLElement): boolean {
  if (el.tabIndex < 0 || el.closest('[hidden],[aria-hidden="true"],[inert]')) return false
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n)
    if (cs.display === 'none' || (n === el && cs.visibility === 'hidden')) return false
  }
  return true
}

const byTour = (id: string) => Array.from(document.querySelectorAll(`[data-tour="${id}"]`)).filter(drawn)

/**
 * 짚을 요소 — 단계의 targets 를 모두. 승인 한 번은 그 에이전트 관계도 카드의 승인 칸, 그게 다 보이지 않으면 그 에이전트의 카드
 */
function targetsOf(mode: Mode, step: TourStep | null, tipAgent: AgentId | null): Element[] {
  if (mode === 'tip') {
    const ap = byTour('approval').filter(el => el.closest('[data-id]')?.getAttribute('data-id') === tipAgent)
    if (ap.length > 0 && inside(rectOf(ap[0]), viewOf(ap[0]))) return ap.slice(0, 1)
    // 묻는 에이전트 자신의 카드(고른 에이전트가 아니어도) — 관계도 노드 data-id
    return tipAgent
      ? Array.from(document.querySelectorAll('.react-flow__node[data-id]')).filter(el => el.getAttribute('data-id') === tipAgent && drawn(el)).slice(0, 1)
      : []
  }
  return step ? step.targets.flatMap(byTour) : []
}

/** 카드 자리 — 구멍 아래, 자리가 없으면 위, 그다음 옆. 구멍이 없으면 가운데 */
function placeCard(hole: Rect | null, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  if (!hole) return { left: Math.max(EDGE, (vw - w) / 2), top: Math.max(EDGE, (vh - h) / 2) }
  const x = clamp((hole.left + hole.right) / 2 - w / 2, EDGE, vw - w - EDGE)
  if (hole.bottom + GAP + h <= vh - EDGE) return { left: x, top: hole.bottom + GAP }
  if (hole.top - GAP - h >= EDGE) return { left: x, top: hole.top - GAP - h }
  const y = clamp((hole.top + hole.bottom) / 2 - h / 2, EDGE, vh - h - EDGE)
  if (hole.right + GAP + w <= vw - EDGE) return { left: hole.right + GAP, top: y }
  if (hole.left - GAP - w >= EDGE) return { left: hole.left - GAP - w, top: y }
  return { left: x, top: clamp(hole.bottom + GAP, EDGE, vh - h - EDGE) }
}

/** 설정 창 옆 — 오른쪽, 자리가 없으면 왼쪽(둘 다 없으면 창 오른쪽 끝에 붙인다). 위는 창 위와 나란히 */
function placeBeside(dlg: Rect | null, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  if (!dlg) return placeCard(null, w, h, vw, vh)
  const top = clamp(dlg.top, EDGE, vh - h - EDGE)
  if (dlg.right + BESIDE_GAP + w <= vw - EDGE) return { left: dlg.right + BESIDE_GAP, top }
  if (dlg.left - BESIDE_GAP - w >= EDGE) return { left: dlg.left - BESIDE_GAP - w, top }
  return { left: clamp(dlg.right + BESIDE_GAP, EDGE, vw - w - EDGE), top }
}

/** 구멍 둘레 네 칸(위·아래·왼쪽·오른쪽) — 구멍이 없으면 화면 전체 한 칸 */
function veilPieces(h: Rect | null, vw: number, vh: number): Rect[] {
  if (!h) return [{ left: 0, top: 0, right: vw, bottom: vh }]
  const top = clamp(h.top, 0, vh)
  const bottom = clamp(h.bottom, 0, vh)
  const left = clamp(h.left, 0, vw)
  const right = clamp(h.right, 0, vw)
  return [
    { left: 0, top: 0, right: vw, bottom: top },
    { left: 0, top: bottom, right: vw, bottom: vh },
    { left: 0, top, right: left, bottom },
    { left: right, top, right: vw, bottom },
  ]
}

/** 막·구멍 막이를 누르면 — 아무 데도 닿지 않고 초점도 카드에 남는다 */
const swallow = (e: MouseEvent) => e.preventDefault()

/** 설정 목록 한 줄 — '이름 — 설명' 이면 이름만 굵게(설명이 없으면 줄 전체가 이름들) */
function listItem(text: string) {
  const at = text.indexOf(' — ')
  return at < 0 ? <b>{text}</b> : <><b>{text.slice(0, at)}</b>{text.slice(at)}</>
}

export function TourLayer({ dialog, onCloseDialog }: { dialog: Dialog; onCloseDialog: () => void }) {
  const v = useDure(s => ({
    tour: s.tour,
    // tourAdvance 가 읽는 것 — 바뀌면 다시 판정한다
    rooms: s.rooms,
    agents: s.agents,
    roomId: s.roomId,
    selected: s.selectedAgentId,
    history: s.history,
    requests: s.requests,
    prefs: s.app.prefs,
    // 준비 화면·불러오기 실패 동안은 겹 전체를 숨긴다(투어는 스토어에 그대로)
    ready: s.loadError === null && effectiveSetup(s.app.setup, s.claudeMissing, s.app.setupLoadFailed).phase === 'ready',
    fork: s.forkDraft !== null,
  }))

  // 진행 — 상태나 열린 창이 바뀔 때마다 직접 해 보기가 끝났는지 · 짚던 것이 사라졌는지 본다. 고를 에이전트가 있으면 고른다
  useEffect(() => {
    const store = getStore()
    const s: UiState = store.getState()
    if (!s.tour) return
    const r = tourAdvance(s.tour, s, dialog)
    if (r.tour !== s.tour) store.setTour(r.tour)
    if (r.select) store.selectAgent(r.select)
  }, [v.tour, v.rooms, v.agents, v.roomId, v.selected, v.history, dialog])

  // 승인 한 번 — [확인했어요]를 누르면 저장을 기다리지 않고 바로 닫는다(저장이 실패해도 이번 실행엔 다시 안 뜬다)
  const [tipDone, setTipDone] = useState(false)
  const tip = v.prefs && !v.prefs.approvalTipSeen && !tipDone ? tipRequest(v.requests, v.agents, v.roomId, v.selected) : null
  // 설정 안 단계의 [확인했어요] — 그 단계의 카드만 닫는다(투어는 설정 창을 닫을 때 끝으로)
  const [hiddenTour, setHiddenTour] = useState<UiState['tour']>(null)
  const step = v.tour ? stepFor(v.tour.step, v.tour.replay) : null

  let mode: Mode | null = null
  if (v.ready && !v.fork) {
    if (tip && dialog === null) mode = 'tip'
    else if (step?.id === 'settings') mode = dialog === 'settings' && hiddenTour !== v.tour ? 'beside' : null
    else if (step && dialog === null) mode = step.kind
  }
  // 같은 카드인가 — 바뀌면 다시 재고 초점을 옮긴다
  const key = mode === null ? null : mode === 'tip' ? `tip:${tip!.agentId}` : `${step!.id}:${mode}`

  const layer = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const [geo, setGeo] = useState<Geo | null>(null)
  const geoNow = useRef<Geo | null>(null)
  const live = useRef({ mode, step, tipAgent: tip?.agentId ?? null, selected: v.selected })
  useLayoutEffect(() => {
    live.current = { mode, step, tipAgent: tip?.agentId ?? null, selected: v.selected }
  })

  // 재기 — 보이는 동안 프레임마다(창 크기·스크롤·관계도 움직임·대화상자 움직임을 따라간다 — 움직임은 ResizeObserver 로는 안 보인다).
  // 바뀌었을 때만 다시 그린다. 한동안 그대로면 띄엄띄엄(IDLE_MS) 재고, 창 크기·스크롤이 바뀌면 바로 프레임마다로 돌아온다.
  // 처음 한 번은 그리기 전에 바로 잰다(카드가 엉뚱한 자리에 한 번 보이지 않게)
  useLayoutEffect(() => {
    if (key === null) return
    let frame = 0
    let nap: ReturnType<typeof setTimeout> | null = null
    let missing: ReturnType<typeof setTimeout> | null = null
    let last: Rect | null = null
    let still = 0
    let idle = 0
    let checked = false
    const stop = () => {
      cancelAnimationFrame(frame)
      if (nap) clearTimeout(nap)
      nap = null
    }
    const wake = () => {
      idle = 0
      stop()
      frame = requestAnimationFrame(tick)
    }
    const tick = () => {
      const { mode, step, tipAgent, selected } = live.current
      if (mode === null) return
      const els = mode === 'intro' ? [] : targetsOf(mode, step, tipAgent)
      const target = unite(els)
      // ok 단계 — 짚을 것이 1초 넘게 없으면 건너뛴다. do 단계는 사용자가 할 일이라 기다린다
      if (mode === 'ok' && !target) missing ??= setTimeout(() => getStore().tourNext(), MISSING_MS)
      else if (missing) {
        clearTimeout(missing)
        missing = null
      }
      // 자리를 잡았는데 다 보이지 않으면 한 번 보이게 옮긴다 — 관계도 카드는 관계도를 옮기고(focusAgent), 그 밖은 스크롤
      still = target && sameRect(target, last) ? still + 1 : 0
      last = target
      if (target && !checked && still >= SETTLE_FRAMES) {
        checked = true
        const el = els.find(drawn)!
        if (!inside(target, viewOf(el))) {
          const who = mode === 'tip' ? tipAgent : selected
          if (el.closest('.react-flow') && who) getStore().focusAgent(who)
          else el.scrollIntoView?.({ block: 'nearest' })
        }
      }
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = card.current?.offsetWidth ?? 0
      const h = card.current?.offsetHeight ?? 0
      const next: Geo =
        mode === 'beside'
          ? { vw, vh, hole: null, card: placeBeside(target, w, h, vw, vh) }
          : (() => {
              const cut = target && {
                left: Math.max(HOLE_INSET, target.left - PAD),
                top: Math.max(HOLE_INSET, target.top - PAD),
                right: Math.min(vw - HOLE_INSET, target.right + PAD),
                bottom: Math.min(vh - HOLE_INSET, target.bottom + PAD),
              }
              // 창 밖에 있으면(보이게 옮기기 전) 구멍 없이 — 막 전체 + 가운데 카드
              const hole = cut && cut.right > cut.left && cut.bottom > cut.top ? cut : null
              return { vw, vh, hole, card: placeCard(hole, w, h, vw, vh) }
            })()
      if (sameGeo(geoNow.current, next)) idle++
      else {
        idle = 0
        geoNow.current = next
        setGeo(next)
      }
      if (idle >= IDLE_FRAMES) nap = setTimeout(tick, IDLE_MS)
      else frame = requestAnimationFrame(tick)
    }
    tick()
    window.addEventListener('resize', wake)
    window.addEventListener('scroll', wake, true)
    return () => {
      stop()
      window.removeEventListener('resize', wake)
      window.removeEventListener('scroll', wake, true)
      if (missing) clearTimeout(missing)
    }
  }, [key])

  // 승인 한 번 닫기 · 설정 안 카드 닫기(초점은 설정 창으로)
  const ackTip = () => {
    setTipDone(true)
    void getStore().setPrefs({ approvalTipSeen: true }).catch(() => {})
  }
  // 설정 안 카드의 [확인했어요] — 설정 창을 닫는다(저장 안 한 바뀜은 취소처럼 버린다). 창이 닫히면 tourAdvance 가 끝 단계로 넘긴다
  const closeSettings = () => {
    setHiddenTour(v.tour)
    onCloseDialog()
  }

  // 초점 — 카드가 바뀌면 주 단추(do 단계는 카드 자체)로. 겹이 사라질 때 초점이 갈 곳을 잃었으면 처음 겹을 띄울 때의 자리로
  const shown = useRef<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (key === null) {
      if (shown.current !== null && document.activeElement === document.body && opener.current?.isConnected) opener.current.focus()
      shown.current = null
      return
    }
    if (shown.current === key) return
    if (shown.current === null) {
      const at = document.activeElement
      opener.current = at instanceof HTMLElement && at !== document.body && !layer.current?.contains(at) ? at : null
    }
    shown.current = key
    const el = card.current
    ;(el?.querySelector<HTMLElement>('[data-primary]') ?? el)?.focus()
  }, [key])

  // 키 — 창(window)의 붙잡기 단계에서 먼저 받는다: 설정 창은 문서에서 Tab·Esc 를 붙잡으니 카드 안의 키는 그보다 먼저 가로챈다.
  // Esc 는 카드에 초점이 있을 때만(대화상자의 Esc 와 섞이지 않게). Tab 은 카드 안에서 돈다 — do 단계는 짚은 곳도 함께
  const onEscape = useRef(() => {})
  onEscape.current = mode === 'tip' ? ackTip : () => void getStore().endTour()
  useEffect(() => {
    if (mode === null) return
    const onKey = (e: KeyboardEvent) => {
      const el = card.current
      if (!el) return
      const at = document.activeElement
      const inCard = !!at && el.contains(at)
      if (e.key === 'Escape') {
        if (!inCard) return
        e.preventDefault()
        e.stopPropagation()
        onEscape.current()
        return
      }
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return
      if (mode === 'beside' && !inCard) return // 설정 창 안의 Tab 은 그 창이 돌린다
      const hole = mode === 'do' ? targetsOf(mode, live.current.step, null) : []
      const items = [
        ...el.querySelectorAll<HTMLElement>(FOCUSABLE),
        ...hole.flatMap(t => [...(t.matches(FOCUSABLE) ? [t as HTMLElement] : []), ...t.querySelectorAll<HTMLElement>(FOCUSABLE)]),
      ].filter(focusable)
      e.preventDefault()
      e.stopPropagation()
      if (items.length === 0) {
        el.focus()
        return
      }
      const i = items.indexOf(at as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i === items.length - 1 ? 0 : i + 1
      items[next].focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mode])

  const titleId = useId()
  const bodyId = useId()
  const still = useMedia('(prefers-reduced-motion: reduce)')
  // 창 단추 띠 물들이기 — 막이 보이는 동안만(Windows 가 단추를 웹 화면 위에 그려 막이 못 덮는다)
  const veilOn = mode !== null && mode !== 'beside'
  useEffect(() => {
    void window.dure?.setTourVeil?.(veilOn)?.catch?.(() => {})
  }, [veilOn])
  useEffect(() => () => void window.dure?.setTourVeil?.(false)?.catch?.(() => {}), [])

  if (mode === null) return null

  const content =
    mode === 'tip'
      ? { label: TOUR.approval.badge, title: TOUR.approval.title, body: TOUR.approval.body, list: undefined, n: null }
      : { label: step!.n === null ? null : TOUR.count(step!.n), title: step!.title, body: step!.body, list: step!.list, n: step!.n }
  // 아래 줄 왼쪽 — 환영은 '나중에 볼게요', 끝·승인 한 번은 없음, 나머지는 '투어 끝내기'
  const skip = mode === 'tip' || step?.id === 'done' ? null : step?.id === 'welcome' ? TOUR.later : TOUR.end
  const primary =
    mode === 'tip'
      ? { label: TOUR.ok, run: ackTip }
      : mode === 'intro'
        ? { label: TOUR.start, run: () => getStore().tourNext() }
        : mode === 'beside'
          ? { label: TOUR.ok, run: closeSettings }
          : mode === 'ok'
            ? { label: TOUR.ok, run: () => getStore().tourNext() }
            : null
  const hole = geo?.hole ?? null
  const veil = mode !== 'beside'

  return createPortal(
    <div className="tour" ref={layer}>
      {veil && geo && veilPieces(hole, geo.vw, geo.vh).map((r, i) => <div key={i} className="tour-veil" style={box(r)} onMouseDown={swallow} />)}
      {veil && hole && <div className="tour-spot" style={box(hole)} aria-hidden="true" />}
      {/* ok·환영·승인 한 번은 카드만 누를 수 있다 — 짚은 곳도 막는다. do 단계는 짚은 곳만 누를 수 있다 */}
      {veil && hole && mode !== 'do' && <div className="tour-block" style={box(hole)} onMouseDown={swallow} />}
      <div
        key={key}
        ref={card}
        className="tour-card"
        role="dialog"
        aria-modal={mode === 'do' || mode === 'beside' ? undefined : true}
        aria-labelledby={titleId}
        aria-describedby={content.body || content.list ? bodyId : undefined}
        tabIndex={-1}
        style={geo ? { left: geo.card.left, top: geo.card.top } : { visibility: 'hidden' }}
      >
        {content.n !== null && (
          <div className="tour-bar" aria-hidden="true">
            <i style={{ width: `${(content.n / TOUR.total) * 100}%` }} />
          </div>
        )}
        {content.label && <p className="tour-n">{content.label}</p>}
        <h2 id={titleId} className="tour-t">
          {content.title}
        </h2>
        {content.body && (
          <p id={bodyId} className="tour-b">
            {content.body}
          </p>
        )}
        {content.list && (
          <ul id={content.body ? undefined : bodyId} className="tour-list">
            {content.list.map(item => (
              <li key={item}>{listItem(item)}</li>
            ))}
          </ul>
        )}
        <div className="tour-r">
          {skip && (
            <button type="button" className="tour-skip" onClick={() => void getStore().endTour()}>
              {skip}
            </button>
          )}
          {primary ? (
            <button type="button" className="btn pri sm" data-primary onClick={primary.run}>
              {primary.label}
            </button>
          ) : (
            <span className="tour-wait">
              <i className={`tour-dot${still ? '' : ' blink'}`} aria-hidden="true" />
              {step!.wait}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
