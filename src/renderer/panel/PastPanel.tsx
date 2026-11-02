import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { AgentId, ConversationSummary, HistoryItem } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { buildTranscript } from '../state/transcript'
import { MOTION } from '../lib/motion'
import { PresenceList, useMotion } from '../lib/presence'
import { useNow } from '../lib/useNow'
import { errorMessage, PAST, PAST_WHY, RESUME_BLOCK_WORD } from '../lib/words'
import { ChatItem } from './ChatItem'
import { ViewShown } from './PanelTabs'
import { nextAgentName, pastDateLine, resumeBlockOf } from './pastView'

/** 엔진 conversation() 의 기본 줄 수 — 이만큼 왔으면 앞 줄이 더 있을 수 있다 */
const LAST = 500

const titleOf = (c: ConversationSummary) => c.title || PAST.untitled

/**
 * 지난 대화 탭(시안 pc-B1 목록 · pc-B2 읽기) — 같은 칸 안에서 목록 ↔ 읽기.
 * 목록 = 새것부터 한 줄씩(제목 · 날짜 줄 · 마지막 답 또는 이어 갈 수 없는 이유), 지금 대화는 '지금' 배지와 함께 — 누르면 대화 탭으로.
 * 목록은 탭을 열 때마다 · 지난 대화 수가 바뀔 때(경계) 다시 받는다 — 숨은 동안엔 받지 않는다(ViewShown).
 * 읽기를 닫으면(‹ · Esc) 연 줄로 초점이 돌아온다.
 */
export function PastPanel({ agentId }: { agentId: AgentId }) {
  const shown = useContext(ViewShown)
  const pastCount = useDure(s => s.agents.find(a => a.id === agentId)?.pastCount ?? 0)
  const now = useNow()
  const [list, setList] = useState<ConversationSummary[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [open, setOpen] = useState<ConversationSummary | null>(null)
  const ask = useRef(0)

  // 늦게 온 옛 답이 새 목록을 덮지 않게 — 마지막으로 부른 것만 받는다
  const load = useCallback(() => {
    const n = ++ask.current
    setFailed(null)
    Promise.resolve()
      .then(() => window.dure.conversations(agentId))
      .then(
        l => { if (n === ask.current) setList(l) },
        e => { if (n === ask.current) setFailed(errorMessage(e)) },
      )
  }, [agentId])

  useEffect(() => {
    if (shown) load()
  }, [shown, pastCount, load])

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

  if (open) return <PastRead key={open.key} agentId={agentId} conv={open} now={now} onBack={back} onResumed={resumed} />

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
  const third = c.why ? PAST_WHY[c.why] : c.lastReply
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
 */
function PastRead({ agentId, conv, now, onBack, onResumed }: {
  agentId: AgentId
  conv: ConversationSummary
  now: number
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

  const lines = useMemo(() => (items ? buildTranscript(items, undefined, Infinity).lines : []), [items])

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

  const why = conv.why ? PAST_WHY[conv.why] : null
  const blocked = block ? RESUME_BLOCK_WORD[block] : null
  // 안내 자리 — 이어 갈 수 없는 이유 > 지금 막는 까닭 > 거절당한 글 > 평소 안내
  const reason = why ?? blocked
  const alert = reason === null && failed !== null
  const title = titleOf(conv)

  return (
    // 칸 어디를 눌러도 초점이 이 안에 남게(tabIndex -1) — 그래야 Esc 가 여기로 온다
    <div className="pc-view" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="pc-band">
        <button ref={backBtn} type="button" className="ib" aria-label={PAST.back} onClick={onBack}>
          <ChevronLeft className="i" aria-hidden="true" />
        </button>
        <b className="trunc" title={title}>
          {title}
        </b>
        <span className="pc-band-d">· {pastDateLine(conv.at, now)}</span>
      </div>
      <section className="conv" aria-label={title} aria-busy={items === null}>
        {items === null && !loadError && <p className="conv-st">대화를 불러오는 중…</p>}
        {loadError && (
          <p className="conv-st">
            대화를 불러오지 못했어요
            <button type="button" className="lk" onClick={() => load(items !== null)}>
              다시 시도
            </button>
          </p>
        )}
        {items && !full && !loadError && items.length >= LAST && (
          <button type="button" className="conv-more" onClick={() => load(true)}>
            {PAST.more}
          </button>
        )}
        {lines.map((line, i) => (
          // 끝에서 센 자리 — 앞 줄을 모두 받아 위에 붙어도 같은 줄은 같은 key(펼친 하는 일이 다른 줄로 옮겨 가지 않게).
          // agentId 는 그림 보기용 — 서브에이전트 요약 줄은 누를 수 없게(서브에이전트 탭은 지금 대화 것)
          <ChatItem key={lines.length - i} line={line} agentId={agentId} navigable={false} />
        ))}
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
      </div>
    </div>
  )
}
