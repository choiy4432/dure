import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { AgentId, HistoryItem } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { buildTranscript, type ChatLine } from '../state/transcript'
import { displayStatus } from '../state/selectors'
import { ChatItem } from './ChatItem'
import { WorkingRow } from './WorkingRow'
import { enteringLines, lineShape, unreadSince, type Away, type LineSnap } from './newLines'
import { Presence, playEnter, useMotion } from '../lib/presence'
import { MOTION, reducedMotion } from '../lib/motion'
import { CHAT_PANEL as W } from '../lib/words'
import { onPhone } from '../lib/phone'
import { ViewShown } from './PanelTabs'
import { StickyPrompt } from './StickyPrompt'
import { STICKY_ZONE_PX, stickyPromptIndex, type PromptBox, type PromptLine } from './turnStart'
import { hitLineIndex, revealHit } from './hitJump'

/** 처음에 그리는 줄 수 · '더 보기' 한 번에 늘리는 수 */
const PAGE = 300
/** 바닥에서 이만큼 안이면 '맨 아래에 붙어 있다' */
const STICK_PX = 24
/** 찾기에서 고른 줄이 앞에 숨긴 줄이면 — 그 줄 위로 이만큼 더 그린다 */
const HIT_CONTEXT = 4
const NONE: HistoryItem[] = []
const NO_IDS: string[] = []

/** [이전 대화 더 보기]를 누른 순간 — 칸 맨 위에 걸친 줄(번호 · 칸 위에서의 자리), 그때의 첫 기록, 단추에 초점이 있었나 */
interface Anchor {
  row: { line: string; top: number } | null
  first: HistoryItem | undefined
  focused: boolean
}

/** 칸 맨 위에 걸친 줄 — 그 번호와 칸 위에서의 자리. 앞에 줄이 붙어도 이 줄을 그 자리에 둔다(흐르는 글 줄은 번호가 없다) */
function topRow(box: HTMLElement): Anchor['row'] {
  const b = box.getBoundingClientRect().top
  for (const n of box.querySelectorAll<HTMLElement>(':scope > [data-line]:not([data-line="live"])')) {
    const r = n.getBoundingClientRect()
    if (r.bottom > b) return { line: n.dataset.line!, top: r.top - b }
  }
  return null
}

/**
 * 대화 목록(시안 .conv) — 고른 에이전트의 기록을 buildTranscript 로 줄로 바꿔 그린다.
 * 최근 300줄만 그리고 위에 '이전 대화 N개 더 보기'. 받은 기록을 다 그렸는데 그 앞 기록이 있으면(hasOlder) [이전 대화 더 보기] —
 * 앞 500 항목을 불러와(store.loadOlder) 다 그리고, 보던 줄은 그 자리에 둔다. 맨 앞까지 오면 단추가 없다.
 * 줄 번호(key · data-line)는 처음 받은 첫 기록이 든 줄이 0 — 앞에 기록이 붙어도 이미 그린 줄의 번호가 그대로다(앞에 붙은 줄은 음수).
 * 새 줄이 오면 맨 아래에 붙어 있을 때만 따라 내려간다 — 위로 올려 읽는 중이면 칸 아래 가운데 '↓ 새 글 N개' 알약(누르면 맨 아래 · 입력창에 커서).
 * pin 이 오르면(내가 보냄) 위로 올려 읽던 중이어도 맨 아래에 다시 붙는다.
 * 에이전트가 일하는 동안(표시 상태 '작업 중' — 승인 기다림은 승인 카드가 알린다) 맨 끝에 '작업 중…' 줄.
 * 서브에이전트가 돌면 부모 차례가 끝나도 작업 중이다(엔진) — 그 줄에 도는 수를 함께 적는다.
 * Claude 가 생각하는 동안은 그 줄이 '생각하는 중…'과 생각한 추정 토큰 수.
 * 서브에이전트 탭으로 가면 숨을 뿐 그대로다(펼친 줄·불러온 이전 대화) — 다시 보이면 읽던 자리로(ViewShown).
 * 위로 올려 읽는 동안엔 화면 맨 위에 걸친 차례를 연 말(내 말 · 전달된 메시지)이 위에 고정된다(StickyPrompt — 누르면 그 말로).
 * 메시지 탭의 '대화에서 보기'(messageFocus)면 그 메시지 줄로 가서 다시 들어오게 보이고 초점을 옮긴 뒤 요청을 지운다.
 * 찾기(Ctrl+K)에서 고른 지금 대화 줄(hitFocus)이면 그 줄로 가서 잠깐 노랗게 두르고 초점을 옮긴 뒤 지운다 — 앞에 숨긴 줄이면 그 줄까지 더 그린다.
 */
export function ChatList({ agentId, pin = 0 }: { agentId: AgentId; pin?: number }) {
  const v = useDure(s => ({
    items: s.history[agentId] ?? NONE,
    status: s.historyStatus[agentId]?.state ?? 'loading',
    streaming: s.streaming[agentId] ?? '',
  }))
  const work = useDure(s => {
    const a = s.agents.find(x => x.id === agentId)
    return { on: !!a && displayStatus(a, s.requests) === 'working', since: s.statusSince[agentId] }
  })
  // 도는 서브에이전트(부모의 Agent tool_use id) — 내용이 같으면 같은 배열(useDure 의 얕은 비교)이라 아래 Set·줄을 다시 만들지 않는다
  const running = useDure(s => s.agents.find(x => x.id === agentId)?.subagentsRunning ?? NO_IDS)
  // Claude 가 생각하는 중이면 작업 중 줄이 '생각하는 중…'(토큰 수가 오를 때만 다시 그린다 — 기록 줄은 그대로)
  const thinking = useDure(s => s.thinking[agentId] ?? null)
  // 생각 전 기다림 — 준비하는 중·Claude 답 받는 중·대화를 정리하는 중
  const phase = useDure(s => s.phase[agentId])
  const focus = useDure(s => (s.messageFocus?.agentId === agentId ? s.messageFocus : null))
  // 너무 앞(far)인 줄은 지난 대화 탭의 읽기 몫
  const hit = useDure(s => (s.hitFocus?.hit.agentId === agentId && s.hitFocus.hit.conversation.key === null && !s.hitFocus.far ? s.hitFocus : null))
  // 받은 기록의 첫 항목보다 앞 기록이 있을 수 있다 — [이전 대화 더 보기]
  const older = useDure(s => s.hasOlder[agentId] ?? false)
  const runningSet = useMemo(() => new Set(running), [running])
  const [limit, setLimit] = useState(PAGE)

  // 줄 번호의 0 — 처음 받은 목록의 첫 기록(origin). 그 앞에 기록이 붙어도 이 기록이 든 줄이 0 번이다.
  // 목록이 갈리면(새 대화 · 다시 받기) 새 첫 기록으로 다시 — 앞 기록을 불러온 뒤의 '다 그리기'와 새 글 알약도 처음부터
  const [origin, setOrigin] = useState<HistoryItem | undefined>(v.items[0])
  // [이전 대화 더 보기]를 눌렀다 — 받은 줄은 모두 그린다(불러온 앞 줄이 그리지 않은 줄로 숨지 않게)
  const [allShown, setAllShown] = useState(false)
  // 바닥에서 벗어난 순간(위로 올려 읽는 중) — 없으면 맨 아래에 붙어 있다. 새 글 알약이 그 뒤로 온 글을 센다
  const [away, setAway] = useState<Away | null>(null)
  const at = origin === undefined ? -1 : v.items.indexOf(origin)
  if (origin === undefined ? v.items.length > 0 : at < 0) {
    setOrigin(v.items[0])
    setAllShown(false)
    setAway(null)
  }

  // 흐르는 글은 따로 — 글자가 올 때마다 기록 전체를 다시 줄로 바꾸지 않는다(줄 객체가 그대로라 다시 그리지도 않는다).
  // 도는 목록을 넘겨야 요약 줄의 '도는 중'이 맞다(끝 기록이 없는데 돌지도 않으면 끊김)
  const all = useMemo(() => buildTranscript(v.items, undefined, Infinity, runningSet).lines, [v.items, runningSet])
  // 0 번 기록이 든 줄 앞의 줄 수 — 0 번 기록 앞에 기록이 붙을 때만 바뀐다(뒤에 붙는 기록은 앞 줄 수를 바꾸지 않는다).
  // 붙은 덩이 끝의 Claude 답이 0 번 기록의 답과 한 줄로 이어져도 맞다(전체 − 0 번 기록부터의 줄 수)
  const first = v.items[0]
  const base = useMemo(
    () => (at > 0 ? all.length - buildTranscript(v.items.slice(at), undefined, Infinity, runningSet).lines.length : 0),
    [first, at], // eslint-disable-line react-hooks/exhaustive-deps -- 첫 기록과 0 번 기록의 자리가 같으면 그 앞 줄 수도 같다
  )
  const hiddenBefore = allShown ? 0 : Math.max(0, all.length - limit)
  const lines = useMemo(() => (hiddenBefore > 0 ? all.slice(hiddenBefore) : all), [all, hiddenBefore])
  /** 번호로 센 줄 수 — 끝 줄 번호 + 1(앞에 붙은 줄은 세지 않는다) */
  const total = all.length - base

  const box = useRef<HTMLElement>(null)
  const stick = useRef(true)
  const keep = useRef<number | null>(null) // '더 보기' 직전의 바닥까지 거리 — 위에 줄이 늘어도 보던 자리 그대로
  // 탭을 바꾸면 이 목록은 그려 둔 채 숨는다(ViewShown). 숨은 스크롤 상자(display:none)는 Chromium 이 자리를 0 으로 되돌리므로
  // 보이는 동안 마지막으로 읽은 자리(top)를 들고 있다가 다시 보이면 되돌린다. 숨은 동안엔 스크롤을 읽지도 쓰지도 않는다
  const shown = useContext(ViewShown)
  const visible = useRef(shown)
  const top = useRef(0)

  // 지금 그린 것 — 바닥에서 벗어나는 순간(스크롤 · 줄로 가기)에 적는다. 그리기마다 맨 먼저 맞춘다
  const now = useRef<{ total: number; tail: ChatLine | undefined; live: number }>({ total: 0, tail: undefined, live: 0 })
  useLayoutEffect(() => {
    now.current = { total, tail: all[all.length - 1], live: v.streaming.length }
  })
  // 맨 아래에 붙음 — 벗어나는 순간 그때 줄 수 · 마지막 줄 모양 · 흐르던 글 길이를 적고(새 글 알약), 다시 붙으면 지운다
  const setStick = (on: boolean) => {
    if (stick.current === on) return
    stick.current = on
    const n = now.current
    setAway(on ? null : { total: n.total, tail: lineShape(n.tail), live: n.live })
  }

  // 위 고정 — 화면 맨 위에 걸친 차례를 연 줄 번호(앞에 숨긴 줄 포함). 스크롤·줄·크기가 바뀔 때 잰다(값이 같으면 다시 그리지 않는다)
  const [stuck, setStuck] = useState<number | null>(null)
  const measure = useCallback(() => {
    const el = box.current
    if (!el || !visible.current) return
    const boxes: PromptBox[] = []
    for (const n of el.querySelectorAll<HTMLElement>(':scope > .me, :scope > .ci-relay')) {
      const r = n.getBoundingClientRect()
      boxes.push({ index: Number(n.dataset.line), top: r.top, bottom: r.bottom })
    }
    setStuck(stickyPromptIndex(boxes, el.getBoundingClientRect().top, STICKY_ZONE_PX))
  }, [])

  // [이전 대화 더 보기] — 누른 순간의 맨 위 줄. 앞 기록이 붙은 그리기에서 그 줄을 그 자리에 둔다
  const anchor = useRef<Anchor | null>(null)
  const olderBusy = useRef(false)
  const olderButton = useRef<HTMLButtonElement>(null)
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'failed'>('idle')

  const onScroll = () => {
    const el = box.current
    if (!el || !visible.current) return // 숨으며 0 으로 돌아간 자리는 읽던 자리가 아니다
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX)
    top.current = el.scrollTop
    // 불러오는 사이 읽던 자리를 옮겼다 — 그 자리를 지킨다
    if (anchor.current) anchor.current = { ...anchor.current, row: topRow(el) }
    measure()
  }

  // 다시 보였다 — 맨 아래에 붙어 있었으면 맨 아래(숨은 동안 온 줄까지), 아니면 읽던 자리로.
  // 아래 효과들보다 먼저 둔다 — 같은 그리기에서 내가 보냄(pin)이 오면 그것이 이긴다
  useLayoutEffect(() => {
    if (visible.current === shown) return
    visible.current = shown
    const el = box.current
    if (!shown || !el) return
    el.scrollTop = stick.current ? el.scrollHeight : top.current
    measure()
  }, [shown, measure])

  useLayoutEffect(() => {
    const el = box.current
    if (!el || !visible.current) return
    if (keep.current !== null) {
      el.scrollTop = el.scrollHeight - keep.current
      keep.current = null
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight
    }
    top.current = el.scrollTop // 옮긴 자리도 읽던 자리 — 스크롤 이벤트가 오기 전에 숨어도
    measure()
  }, [lines, v.streaming, v.status, work.on, measure])

  // 앞 기록이 붙었다([이전 대화 더 보기]) — 누를 때 맨 위에 걸쳐 있던 줄을 그 자리로(번호는 그대로라 같은 줄이다).
  // 맨 앞까지 와서 누른 단추가 사라졌으면 초점은 맨 위 줄로(몸통으로 떨어지지 않게). 따라 내려가기 뒤 — 같은 그리기에서 이것이 이긴다
  useLayoutEffect(() => {
    const el = box.current
    const a = anchor.current
    if (!el || !a || !visible.current || v.items[0] === a.first) return
    anchor.current = null
    const node = a.row && el.querySelector<HTMLElement>(`:scope > [data-line="${a.row.line}"]`)
    if (a.row && node) el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - a.row.top
    top.current = el.scrollTop
    if (a.focused && !el.contains(document.activeElement)) {
      const head = el.querySelector<HTMLElement>(':scope > [data-line]')
      if (head) {
        head.tabIndex = -1
        head.focus({ preventScroll: true })
      }
    }
    measure()
  }, [v.items, shown, measure])

  // 보는 동안 새로 온 줄만 아래에서 들어온다 — 처음 그린 것 · 더 보기 · 앞 기록 불러오기(번호가 그대로) · 기록 다시 받기 · 흐르던 글이 줄이 된 것은 아니다
  const snap = useRef<LineSnap | null>(null)
  useLayoutEffect(() => {
    const cur: LineSnap = { agentId, ready: v.status === 'ready', total, streaming: !!v.streaming }
    const enter = enteringLines(snap.current, cur)
    snap.current = cur
    const el = box.current
    // 숨은 동안 온 줄은 기억만 한다 — 다시 보일 때 한꺼번에 들어오지 않는다
    if (!enter || !el || !visible.current || reducedMotion()) return
    for (let n = enter.from; n < enter.to; n++) {
      const node = el.querySelector<HTMLElement>(`[data-line="${n}"]`)
      if (node) playEnter(node, MOTION.line.enter)
    }
    if (enter.live) {
      const node = el.querySelector<HTMLElement>('[data-line="live"]')
      if (node) playEnter(node, MOTION.line.enter)
    }
  })

  // 내가 보냈다 — 내 말이 보이게 맨 아래로, 뒤에 오는 줄(내 말·답)도 따라가게 다시 붙인다(숨어 있으면 다시 보일 때 맨 아래로)
  useLayoutEffect(() => {
    const el = box.current
    if (!pin || !el) return
    setStick(true)
    keep.current = null
    if (visible.current) el.scrollTop = el.scrollHeight
  }, [pin]) // eslint-disable-line react-hooks/exhaustive-deps -- setStick 은 ref 와 상태 설정만 쓴다

  // 메시지 탭에서 '대화에서 보기' — 그 메시지 줄이 대화 칸 윗 여백 바로 아래에 오게 가고, 새 줄처럼 다시 들어오며 초점도 그 줄로.
  // 기록을 아직 못 받았으면 받은 뒤에(줄이 바뀔 때 다시 본다). 다 받았는데 그린 줄에 없으면(앞에 숨긴 줄) 요청만 지운다.
  // 따라 내려가기·다시 보이기 효과 뒤에 둔다 — 같은 그리기에서 이것이 이긴다
  useLayoutEffect(() => {
    const el = box.current
    if (!focus || !el || !visible.current) return
    const node = Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-msg]')).find(n => n.dataset.msg === focus.messageId)
    if (!node) {
      if (v.status === 'ready') getStore().doneMessageFocus(focus.n)
      return
    }
    setStick(false)
    keep.current = null
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - pad
    top.current = el.scrollTop
    if (!reducedMotion()) playEnter(node, MOTION.line.enter)
    node.tabIndex = -1
    node.focus({ preventScroll: true })
    measure()
    getStore().doneMessageFocus(focus.n)
  }, [focus, lines, v.status, shown, measure]) // eslint-disable-line react-hooks/exhaustive-deps -- setStick 은 ref 와 상태 설정만 쓴다

  // 찾기에서 고른 줄 — 그 기록이 든 줄(hitLineIndex)로 가서 잠깐 두르고 초점도 그 줄로. 기록을 다 받은 뒤에(앞쪽은 openHit 이 불러 두었다).
  // 앞에 숨긴 줄이면 그 줄까지 더 그리고 다시 본다 — openHit 이 그 줄부터 끝까지 HIT_MAX 항목 안일 때만 여기로 보내니 더 그리는 줄도 그 안이다.
  // 받은 기록보다 앞이거나 못 받았으면 요청만 지운다. 따라 내려가기 효과들 뒤 — 같은 그리기에서 이것이 이긴다
  useLayoutEffect(() => {
    const el = box.current
    if (!hit || !el || !visible.current) return
    if (v.status === 'error') {
      getStore().doneHitFocus(hit.n)
      return
    }
    if (v.status !== 'ready') return
    const k = hitLineIndex(all, hit.hit.t, hit.hit.who)
    if (k >= 0 && k < hiddenBefore) {
      setLimit(l => Math.max(l, all.length - k + HIT_CONTEXT))
      return
    }
    const node = k < 0 ? null : el.querySelector<HTMLElement>(`:scope > [data-line="${k - base}"]`)
    if (node) {
      setStick(false)
      keep.current = null
      revealHit(el, node)
      top.current = el.scrollTop
      measure()
    }
    getStore().doneHitFocus(hit.n)
  }, [hit, all, lines, hiddenBefore, base, v.status, shown, measure]) // eslint-disable-line react-hooks/exhaustive-deps -- setStick 은 ref 와 상태 설정만 쓴다

  // 칸이 줄어도(창 크기 · 위에 카드가 생김) 맨 아래에 붙어 있었으면 바닥을 지킨다 — 줄어드는 건 스크롤 이벤트가 안 온다.
  // 숨을 때(크기 0)는 건드리지 않는다
  useLayoutEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (visible.current && stick.current && keep.current === null) el.scrollTop = el.scrollHeight
      measure()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  // 위 고정 줄 — 그린 줄 가운데 차례를 연 줄일 때만(앞에 숨긴 줄은 그리지 않아 잴 수도 없다)
  const stuckLine = stuck === null ? null : lines[stuck + base - hiddenBefore]
  const prompt: PromptLine | null = stuckLine && (stuckLine.kind === 'me' || stuckLine.kind === 'relay') ? stuckLine : null
  // 그 말로 간다 — 말이 대화 칸 윗 여백 바로 아래에 오게. 초점도 그 말로(상자가 사라지며 초점이 몸통으로 떨어지지 않게)
  const jumpTo = () => {
    const el = box.current
    const node = stuck === null ? null : el?.querySelector<HTMLElement>(`:scope > [data-line="${stuck}"]`)
    if (!el || !node) return
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0
    const to = el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - pad
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: to, behavior: reducedMotion() ? 'auto' : 'smooth' })
    else el.scrollTop = to
    node.tabIndex = -1
    node.focus({ preventScroll: true })
  }

  const showMore = () => {
    const el = box.current
    if (el) keep.current = el.scrollHeight - el.scrollTop
    setLimit(l => l + PAGE)
  }

  // [이전 대화 더 보기] — 앞 500 항목을 한 번 불러온다. 불러오는 동안 또 누르면 아무 일도 없다(단추는 그대로 — 초점이 남는다)
  const loadOlder = () => {
    const el = box.current
    if (olderBusy.current || !el) return
    olderBusy.current = true
    anchor.current = { row: topRow(el), first: v.items[0], focused: document.activeElement === olderButton.current }
    setAllShown(true)
    setOlderState('loading')
    getStore()
      .loadOlder(agentId)
      .then(
        () => {
          // 붙은 것이 없으면(빈 덩이 · 그새 목록이 갈림) 자리를 지킬 일도 없다
          if (getStore().getState().history[agentId]?.[0] === anchor.current?.first) anchor.current = null
          setOlderState('idle')
        },
        () => {
          anchor.current = null
          setOlderState('failed')
        },
      )
      .finally(() => {
        olderBusy.current = false
      })
  }

  // 새 글 알약 — 바닥에서 벗어난 뒤 온 글 수(번호로: 앞에 붙은 줄은 세지 않는다)
  const unread = away
    ? unreadSince(away, { total, tail: lineShape(all[away.total - 1 + base]), lastKind: all[all.length - 1]?.kind ?? null, live: v.streaming.length })
    : 0
  // 누르면 맨 아래로 — 다시 붙고, 사라지는 알약 대신 바로 아래 입력창에 커서(휴대폰은 자판이 튀어 오르니 아니다)
  const toBottom = () => {
    const el = box.current
    if (!el) return
    setStick(true)
    keep.current = null
    el.scrollTop = el.scrollHeight
    top.current = el.scrollTop
    measure()
    if (!onPhone()) getStore().focusInput(agentId)
  }

  return (
    // 바깥 칸 — 위 끝에 바탕색으로 사라지는 짧은 막(.conv-wrap::before). 고정 카드 바로 아래로 스크롤되는 글이 줄처럼 끊겨 보이지 않게
    <div className="conv-wrap">
      <Presence show={prompt !== null}>{prompt && <StickyPrompt line={prompt} onJump={jumpTo} />}</Presence>
      <section ref={box} className="conv" aria-label="대화" onScroll={onScroll}>
        {v.status === 'loading' && v.items.length === 0 && <p className="conv-st">대화를 불러오는 중…</p>}
        {v.status === 'error' && (
          <p className="conv-st">
            대화를 불러오지 못했어요
            <button type="button" className="lk" onClick={() => getStore().selectAgent(agentId)}>
              다시 시도
            </button>
          </p>
        )}
        {/* 그리지 않은 앞 줄이 먼저, 다 그렸으면 그 앞 기록 — 같은 자리의 같은 단추라 누른 뒤에도 초점이 남는다 */}
        {hiddenBefore > 0 ? (
          <button type="button" className="conv-more" onClick={showMore}>
            <ArrowUp className="i" size={14} aria-hidden="true" />
            이전 대화 {hiddenBefore}개 더 보기
          </button>
        ) : older && v.status === 'ready' ? (
          <button
            ref={olderButton}
            type="button"
            className="conv-more"
            aria-disabled={olderState === 'loading' || undefined}
            onClick={loadOlder}
          >
            <ArrowUp className="i" size={14} aria-hidden="true" />
            {olderState === 'loading' ? W.olderLoading : olderState === 'failed' ? W.olderFailed : W.older}
          </button>
        ) : null}
        {lines.map((line, i) => (
          // 줄 번호는 새 줄이 붙어도 · 앞 기록이 붙어도 그대로 — 펼친 하는 일이 닫히지 않는다
          <ChatItem key={hiddenBefore + i - base} index={hiddenBefore + i - base} line={line} agentId={agentId} />
        ))}
        {v.streaming && <ChatItem line={{ kind: 'streaming', text: v.streaming }} />}
        <Presence show={work.on}>
          <WorkingRow since={work.since} subagents={running.length} thinking={thinking ?? undefined} phase={phase} />
        </Presence>
      </section>
      <Presence show={unread > 0}>{unread > 0 && <NewLinesPill n={unread} onClick={toBottom} />}</Presence>
    </div>
  )
}

/** 새 글 알약(시안 ② A) — 위로 올려 읽는 중 새 글이 오면 대화 칸 아래(입력창 바로 위) 가운데. 누르면 맨 아래로 */
function NewLinesPill({ n, onClick }: { n: number; onClick: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  useMotion(root, MOTION.line)
  return (
    <div ref={root} className="conv-new">
      <button type="button" className="conv-new-b" title={W.toBottom} onClick={onClick}>
        <ArrowDown className="i" size={14} aria-hidden="true" />
        {W.newLines(n)}
      </button>
    </div>
  )
}
