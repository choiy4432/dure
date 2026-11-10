import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { AgentId, ConversationSummary, HistoryItem, SearchWho } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { buildTranscript } from '../state/transcript'
import { MOTION } from '../lib/motion'
import { PresenceList, useMotion } from '../lib/presence'
import { useNow } from '../lib/useNow'
import { errorMessage, PAST, pastWhyText, RESUME_BLOCK_WORD, SEARCH } from '../lib/words'
import { ChatItem } from './ChatItem'
import { ViewShown } from './PanelTabs'
import { nextAgentName, pastDateLine, resumeBlockOf } from './pastView'
import { HIT_WIN, hitLineIndex, revealHit } from './hitJump'

/** 엔진 conversation() 의 기본 줄 수 — 이만큼 왔으면 앞 줄이 더 있을 수 있다 */
const LAST = 500

const titleOf = (c: ConversationSummary) => c.title || PAST.untitled

/** 찾기에서 고른 지난 대화 줄 — 읽기가 그 줄로 간다 */
interface Jump {
  key: string
  t: number
  who: SearchWho
  n: number
}

/**
 * 지난 대화 탭(시안 pc-B1 목록 · pc-B2 읽기) — 같은 칸 안에서 목록 ↔ 읽기.
 * 목록 = 새것부터 한 줄씩(제목 · 날짜 줄 · 마지막 답 또는 이어 갈 수 없는 이유), 지금 대화는 '지금' 배지와 함께 — 누르면 대화 탭으로.
 * 목록은 탭을 열 때마다 · 지난 대화 수가 바뀔 때(경계) 다시 받는다 — 숨은 동안엔 받지 않는다(ViewShown).
 * 읽기를 닫으면(‹ · Esc) 연 줄로 초점이 돌아온다.
 * 찾기(Ctrl+K)에서 이 에이전트의 지난 대화 줄을 골랐으면(hitFocus) 그 뒤에 받은 목록으로 그 대화의 읽기를 열어 그 줄로 간다 — 목록에 없는 대화
 * (사람 말이 없는 대화)도 그 열쇠로 연다. 그새 그 대화로 돌아가 지금 대화가 됐으면 대화 탭의 그 줄로.
 * 지금 대화 줄인데 대화 탭으로는 너무 앞이면(hitFocus.far) 지금 대화를 읽기로 연다 — 단추 없이 그렇게 연 까닭만.
 */
export function PastPanel({ agentId }: { agentId: AgentId }) {
  const shown = useContext(ViewShown)
  const pastCount = useDure(s => s.agents.find(a => a.id === agentId)?.pastCount ?? 0)
  const now = useNow()
  // 받은 목록과 그 부르기 번호(n) — 찾은 줄은 그 줄이 온 뒤에 부른 목록으로만 고른다
  const [got, setGot] = useState<{ list: ConversationSummary[]; n: number } | null>(null)
  const list = got?.list ?? null
  const [failed, setFailed] = useState<string | null>(null)
  const [open, setOpen] = useState<ConversationSummary | null>(null)
  const [jump, setJump] = useState<Jump | null>(null)
  const hit = useDure(s => (s.hitFocus?.hit.agentId === agentId && (s.hitFocus.hit.conversation.key !== null || s.hitFocus.far) ? s.hitFocus : null))
  const ask = useRef(0)

  // 늦게 온 옛 답이 새 목록을 덮지 않게 — 마지막으로 부른 것만 받는다. 부르기 번호를 돌려준다
  const load = useCallback((): number => {
    const n = ++ask.current
    setFailed(null)
    Promise.resolve()
      .then(() => window.dure.conversations(agentId))
      .then(
        l => { if (n === ask.current) setGot({ list: l, n }) },
        e => { if (n === ask.current) setFailed(errorMessage(e)) },
      )
    return n
  }, [agentId])

  useEffect(() => {
    if (shown) load()
  }, [shown, pastCount, load])

  // 찾기에서 고른 줄 — 보이고, 그 줄이 온 뒤의 목록을 받은 뒤에: 그때 부르는 중이던 목록(탭을 열며 부른 것)이 있으면 그것, 없으면 새로 부른다.
  // 숨은 동안 바뀐 옛 목록(/clear 로 지금 대화가 지난 대화가 됨 등)으로 고르지 않게. 요청(hitFocus)은 여기서 지우고, 그 줄로 가는 일은 읽기가 맡는다(jump)
  const hitAsk = useRef<{ n: number; ask: number } | null>(null)
  useEffect(() => {
    if (!hit || !shown) return
    if (hitAsk.current?.n !== hit.n) hitAsk.current = { n: hit.n, ask: got?.n === ask.current ? load() : ask.current }
    if (got === null || got.n < hitAsk.current.ask) return
    const h = hit.hit
    const store = getStore()
    let c: ConversationSummary | undefined
    if (hit.far) {
      // 지금 대화를 읽기로 — 목록에 없으면(사람 말이 없는 대화) 지금 세션의 열쇠로
      c = got.list.find(x => x.current)
      const a = c ? null : store.getState().agents.find(x => x.id === agentId)
      if (a) c = { key: a.sessionId, current: true, title: '', at: h.conversation.startedAt ?? h.t, turns: 0, lastReply: '', resumable: false, why: null }
    } else {
      const key = h.conversation.key!
      c = got.list.find(x => x.key === key)
      if (c?.current) {
        void store.openHit({ ...h, conversation: { ...h.conversation, key: null } })
        return
      }
      c ??= { key, current: false, title: '', at: h.conversation.startedAt ?? h.t, turns: 0, lastReply: '', resumable: false, why: null }
    }
    if (c) {
      setOpen(c)
      setJump({ key: c.key, t: h.t, who: h.who, n: hit.n })
    }
    store.doneHitFocus(hit.n)
  }, [hit, shown, got, load])
  const jumped = useCallback((n: number) => setJump(j => (j?.n === n ? null : j)), [])

  // 초점 — 읽기를 ‹·Esc 로 닫으면 연 줄로, 대화 탭으로 가면(지금 대화를 고름 · 돌아감) 입력창으로(숨은 칸에 있던 초점이 몸통으로 떨어지지 않게).
  // 목록이 다시 그려지고 탭이 바뀐 뒤에
  const box = useRef<HTMLElement>(null)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const returnTo = useRef<string | null>(null)
  const toChat = useRef(false)
  useLayoutEffect(() => {
    if (open) return
    if (toChat.current) box.current?.closest('.pnl')?.querySelector<HTMLElement>('.pnl-cmp textarea')?.focus()
    else if (returnTo.current !== null) rows.current.get(returnTo.current)?.focus()
    toChat.current = false
    returnTo.current = null
  })

  const choose = useCallback((c: ConversationSummary) => {
    if (!c.current) {
      setOpen(c)
      return
    }
    toChat.current = true
    getStore().setPanelTab(agentId, 'chat')
  }, [agentId])
  const back = useCallback(() => {
    returnTo.current = open?.key ?? null
    setOpen(null)
  }, [open])
  // 돌아갔다 — 대화 탭이 그 대화를 보인다(PastRead 가 탭을 바꾼다). 다시 열면 목록부터(읽던 대화는 이제 지금 대화)
  const resumed = useCallback(() => {
    toChat.current = true
    setOpen(null)
  }, [])

  if (open)
    return (
      <PastRead
        key={open.key}
        agentId={agentId}
        conv={open}
        now={now}
        jump={jump?.key === open.key ? jump : null}
        onJumped={jumped}
        onBack={back}
        onResumed={resumed}
      />
    )

  return (
    <section ref={box} className="pc-list" aria-label={PAST.tab}>
      {list === null ? (
        failed ? (
          <p className="conv-st">
            대화를 불러오지 못했어요
            <button type="button" className="lk" onClick={load}>
              다시 시도
            </button>
          </p>
        ) : (
          <p className="conv-st">대화를 불러오는 중…</p>
        )
      ) : (
        <PresenceList>
          {list.map(c => (
            <PastRow
              key={c.key}
              conv={c}
              now={now}
              onChoose={choose}
              rowRef={el => {
                if (el) rows.current.set(c.key, el)
                else rows.current.delete(c.key)
              }}
            />
          ))}
        </PresenceList>
      )}
    </section>
  )
}

/** 목록 한 줄 — 제목(+ 지금) · 날짜 줄(· N차례 · 읽기만) · 마지막 답 또는 이어 갈 수 없는 이유. 새로 생긴 줄만 들어온다 */
function PastRow({ conv: c, now, onChoose, rowRef }: {
  conv: ConversationSummary
  now: number
  onChoose: (c: ConversationSummary) => void
  rowRef: (el: HTMLButtonElement | null) => void
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  useMotion(ref, MOTION.line)
  const third = c.why ? pastWhyText(c.why, c.at, now) : c.lastReply
  return (
    <button
      ref={el => {
        ref.current = el
        rowRef(el)
      }}
      type="button"
      className={`pc-it${c.why ? ' pc-old' : ''}`}
      onClick={() => onChoose(c)}
    >
      <span className="pc-t">
        <span className="pc-tt">{titleOf(c)}</span>
        {c.current && <span className="pc-cur">{PAST.current}</span>}
      </span>
      <span className="pc-m">
        {pastDateLine(c.at, now)} · {PAST.turns(c.turns)}
        {c.why && ` · ${PAST.readOnly}`}
      </span>
      {third && <span className="pc-s">{third}</span>}
    </button>
  )
}

/**
 * 읽기 — 위 띠(‹ 목록으로 · 제목 · 날짜) · 대화(지금 대화와 같은 ChatItem, 입력창·카드 없음) · 아래 줄(안내 + 두 단추).
 * 끝 500줄만 받고, 500줄이 왔으면 맨 위에 '앞 줄 모두 보기'. Esc = 목록.
 * '이 대화로 돌아가기'는 일하는 중·카드 기다림·붙잡은 입력이면 꺼지고 그 까닭이 안내 자리에 — 본문은 그대로.
 * '새 에이전트로 이어 가기'는 일하는 중에도 된다(돌아가기가 막힐 때의 다른 길). 이어 갈 수 없는 대화면 둘 다 꺼짐 + 이유.
 * 엔진이 거절하면 그 글을 안내 자리에(다음 동작까지).
 * jump 면 그 줄로 가서 잠깐 두르고 초점을 옮긴다 — 끝 500줄보다 앞이면 앞 줄을 모두 받은 뒤(한 번에, 받는 동안 줄은 그리지 않는다).
 * 그때부터는 그 줄 둘레(HIT_WIN)만 그리고, 위·아래 끝의 '앞 줄 더 보기' · '뒤 줄 더 보기'로 조금씩 더 — 긴 대화를 통째로 그리지 않는다.
 * 지금 대화(찾은 줄이 대화 탭으로는 너무 앞)면 두 단추 없이 안내 자리에 그렇게 연 까닭.
 */
function PastRead({ agentId, conv, now, jump, onJumped, onBack, onResumed }: {
  agentId: AgentId
  conv: ConversationSummary
  now: number
  jump: Jump | null
  onJumped: (n: number) => void
  onBack: () => void
  onResumed: () => void
}) {
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [full, setFull] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const block = useDure(s => {
    const a = s.agents.find(x => x.id === agentId)
    return a ? resumeBlockOf(a) : null
  })
  const backBtn = useRef<HTMLButtonElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const view = useRef<HTMLElement>(null)
  const noteId = useId()
  const ask = useRef(0)
  const key = conv.key

  const load = useCallback((all: boolean) => {
    const n = ++ask.current
    setLoadError(null)
    Promise.resolve()
      .then(() => (all ? window.dure.conversation(agentId, key, { limit: Infinity }) : window.dure.conversation(agentId, key)))
      .then(
        got => {
          if (n !== ask.current) return
          setItems(got)
          setFull(all)
        },
        e => { if (n === ask.current) setLoadError(errorMessage(e)) },
      )
  }, [agentId, key])

  useEffect(() => load(false), [load])

  // 열면 초점은 띠의 ‹ 로 — Esc·Enter 로 바로 돌아갈 수 있게
  useLayoutEffect(() => {
    backBtn.current?.focus()
  }, [])

  // 줄로 바꾸기는 통째로 해도 싸다(1만 항목 약 7 ms) — 비싼 것은 줄마다 그리는 것(마크다운)이라 그리는 범위만 줄인다(win)
  const lines = useMemo(() => (items ? buildTranscript(items, undefined, Infinity).lines : []), [items])
  const more = items !== null && !full && items.length >= LAST
  // 찾은 줄이 받은 끝 500줄보다 앞 — 모두 받을 때까지 줄을 그리지 않는다(끝 쪽을 잠깐 그렸다 버리지 않게)
  const waiting = jump !== null && items !== null && more && jump.t < items[0].t
  const k = useMemo(() => (jump && items !== null && !waiting ? hitLineIndex(lines, jump.t, jump.who) : null), [jump, items, waiting, lines])

  // 그리는 범위 — 찾기로 열었으면 그 줄 둘레만, 아니면(보통 읽기 · null) 모두. 끝에서 센 자리(줄 key 와 같다)로 들고 있어
  // 앞 줄을 모두 받아 위에 붙어도 같은 줄들이다: top = 그리는 맨 위 줄의 끝에서 센 자리 · bottom = 그리지 않는 아래 줄 수
  const [win, setWin] = useState<{ n: number; top: number; bottom: number } | null>(null)
  if (jump && k !== null && win?.n !== jump.n) {
    // 새로 고른 줄 — 이 그리기에서 바로 그 둘레로(통째로 한 번 그리지 않게). 모든 줄보다 앞(-1)이면 맨 앞 둘레
    const at = Math.max(0, k)
    setWin({ n: jump.n, top: lines.length - Math.max(0, at - HIT_WIN.lead), bottom: Math.max(0, lines.length - at - HIT_WIN.after) })
  }
  const total = lines.length
  const from = win ? Math.max(0, total - win.top) : 0
  const to = win ? Math.max(from, total - win.bottom) : total

  // 찾기에서 고른 줄로 — 받은 끝 500줄보다 앞이면 앞 줄까지 모두 받고 다시 본다(못 받으면 다시 시도로 받을 때까지 기다린다).
  // 줄(data-t 를 가진 자식)은 그린 줄(lines 의 from 부터)과 같은 차례다
  useLayoutEffect(() => {
    if (!jump || items === null) return
    if (waiting) {
      load(true)
      return
    }
    const el = view.current
    const node = el && k !== null && k >= from ? el.querySelectorAll<HTMLElement>(':scope > [data-t]')[k - from] : undefined
    if (el && node) revealHit(el, node)
    onJumped(jump.n)
  }, [jump, items, waiting, k, from, load, onJumped])

  // 가장자리 단추 — 앞 줄은 보던 자리 그대로(바닥까지 거리를 지킨다). 앞에 받지 않은 줄이 남았으면 모두 받고 그 끝에서 센 자리로 더 보인다.
  // 누른 단추가 사라지면(끝까지 보임) 초점은 읽기 칸으로 — 몸통으로 떨어지면 Esc 가 안 든다
  const keep = useRef<{ gap: number; untilFull: boolean } | null>(null)
  const held = useRef<'top' | 'bottom' | null>(null)
  const topBtn = useRef<HTMLButtonElement>(null)
  const bottomBtn = useRef<HTMLButtonElement>(null)
  const earlier = () => {
    const el = view.current
    const all = from < HIT_WIN.more && more
    if (el) keep.current = { gap: el.scrollHeight - el.scrollTop, untilFull: all }
    held.current = 'top'
    if (all) load(true)
    setWin(w => w && { ...w, top: w.top + HIT_WIN.more })
  }
  const later = () => {
    held.current = 'bottom'
    setWin(w => w && { ...w, bottom: Math.max(0, w.bottom - HIT_WIN.more) })
  }
  // 모두 받는 중이면 받아서 위에 붙을 때까지 지킨다
  useLayoutEffect(() => {
    const el = view.current
    if (!el || keep.current === null) return
    el.scrollTop = el.scrollHeight - keep.current.gap
    if (!keep.current.untilFull || full) keep.current = null
  }, [from, total, full])
  useLayoutEffect(() => {
    if (held.current === null || (held.current === 'top' ? topBtn : bottomBtn).current) return
    held.current = null
    if (document.activeElement === null || document.activeElement === document.body) root.current?.focus({ preventScroll: true })
  })

  const resume = async () => {
    setFailed(null)
    setBusy(true)
    try {
      await window.dure.resumeConversation(agentId, key)
    } catch (e) {
      setFailed(errorMessage(e))
      setBusy(false)
      return
    }
    setBusy(false)
    getStore().setPanelTab(agentId, 'chat')
    onResumed()
  }

  const fork = () => {
    setFailed(null)
    const s = getStore().getState()
    const a = s.agents.find(x => x.id === agentId)
    if (!a) return
    const taken = s.agents.filter(x => x.roomId === a.roomId).map(x => x.name) // 이름 검사는 방마다
    getStore().openFork({ from: agentId, key, roomId: a.roomId, name: nextAgentName(a.name, taken), role: a.role, folder: a.folder })
  }

  // Esc = 목록 — 이 칸 안에서 누른 것만(그림 크게 보기 같은 떠 있는 창의 Esc 는 그 창 몫). 막아 두어 관계도의 Esc(고르기 풀기)도 안 돈다
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return
    e.preventDefault()
    onBack()
  }

  const why = conv.why ? pastWhyText(conv.why, conv.at, now) : null
  const blocked = block ? RESUME_BLOCK_WORD[block] : null
  // 안내 자리 — (지금 대화면 그렇게 연 까닭) 이어 갈 수 없는 이유 > 지금 막는 까닭 > 거절당한 글 > 평소 안내
  const reason = conv.current ? SEARCH.far : (why ?? blocked)
  const alert = reason === null && failed !== null
  const title = titleOf(conv)

  return (
    // 칸 어디를 눌러도 초점이 이 안에 남게(tabIndex -1) — 그래야 Esc 가 여기로 온다
    <div ref={root} className="pc-view" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="pc-band">
        <button ref={backBtn} type="button" className="ib" aria-label={PAST.back} onClick={onBack}>
          <ChevronLeft className="i" aria-hidden="true" />
        </button>
        <b className="trunc" title={title}>
          {title}
        </b>
        <span className="pc-band-d">· {pastDateLine(conv.at, now)}</span>
      </div>
      <section ref={view} className="conv" aria-label={title} aria-busy={items === null || waiting}>
        {(items === null || waiting) && !loadError && <p className="conv-st">대화를 불러오는 중…</p>}
        {loadError && (
          <p className="conv-st">
            대화를 불러오지 못했어요
            <button type="button" className="lk" onClick={() => load(items !== null)}>
              다시 시도
            </button>
          </p>
        )}
        {!waiting && !loadError && (win ? from > 0 || more : more) && (
          // 보통 읽기 = 앞 줄 모두 받기 · 찾기로 연 읽기 = 앞 줄 조금 더(남은 앞 줄을 아직 안 받았으면 받으며)
          <button ref={topBtn} type="button" className="conv-more" onClick={win ? earlier : () => load(true)}>
            {win ? PAST.earlier : PAST.more}
          </button>
        )}
        {!waiting &&
          lines.slice(from, to).map((line, i) => (
            // 끝에서 센 자리 — 앞 줄을 모두 받아 위에 붙어도 · 그리는 범위가 늘어도 같은 줄은 같은 key(펼친 하는 일이 다른 줄로 옮겨 가지 않게).
            // agentId 는 그림 보기용 — 서브에이전트 요약 줄은 누를 수 없게(서브에이전트 탭은 지금 대화 것)
            <ChatItem key={total - from - i} line={line} agentId={agentId} navigable={false} />
          ))}
        {!waiting && to < total && (
          <button ref={bottomBtn} type="button" className="conv-more" onClick={later}>
            {PAST.later}
          </button>
        )}
      </section>
      <div className="pc-back">
        {alert ? (
          <p key="err" id={noteId} className="pc-err" role="alert">
            {failed}
          </p>
        ) : (
          <p key="note" id={noteId}>
            {reason ?? PAST.note}
          </p>
        )}
        {/* 지금 대화(찾은 줄이 너무 앞이라 연 것)엔 돌아가기 · 이어 가기가 없다 — 이미 그 대화다 */}
        {!conv.current && (
          <div className="pc-acts">
            <button
              type="button"
              className="btn sec"
              disabled={busy || !conv.resumable}
              aria-describedby={why ? noteId : undefined}
              onClick={fork}
            >
              {PAST.fork}
            </button>
            <button
              type="button"
              className="btn pri"
              disabled={busy || !conv.resumable || block !== null}
              aria-describedby={reason ? noteId : undefined}
              onClick={() => void resume()}
            >
              {PAST.resume}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
