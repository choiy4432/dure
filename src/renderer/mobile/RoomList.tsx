// 휴대폰 방 고르기(시안 mobile-rooms-v2) — 머리(마크 · 연결된 PC · 연결 점 · ⋯) → 할 일 N(누르면 그 대화로 바로) → 방 N(순서 그대로) → 이 PC에 새 방.
// 이름은 PC 와 같은 '할 일', 수는 줄(에이전트) 수가 아니라 할 일 수(PC 의 할 일 수 · 판의 '할 일 N' 과 같다)
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  ArrowRightLeft, BellRing, ChevronRight, MessageCircleQuestionMark, Pencil, Plus, ShieldAlert, Smartphone, Trash2, TriangleAlert,
} from 'lucide-react'
import type { Room, RoomId } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { ago, errorMessage, josa } from '../lib/words'
import { useNow } from '../lib/useNow'
import { BrandMark } from '../shell/BrandMark'
import { ConfirmDialog } from '../shell/ConfirmDialog'
import { FormDialog } from '../shell/FormDialog'
import { ServerTag } from '../shell/RemoteCheck'
import type { PhoneAndroidApp } from '../../shared/phoneWire'
import { useConn } from './connection'
import { meDevice, meInfo } from './phoneHttp'
import { appContext, needsUpdate, openInAppHref, setSteerLater, steerLater, subscribePushHere } from './androidApp'
import { PUSH_DENIED, PUSH_FAILED } from './PairScreen'
import { MobileTop, MoreMenu, OFFLINE_HINT, OfflineBand, Sheet, useOffline } from './parts'
import { todoCounts } from '../state/attention'
import { pcName, roomLine, todoTotal, waitingRows, type WaitKind, type WaitRow } from './rooms'

export const PUSH_ON = '알림을 켰어요'
export const PUSH_UNSUPPORTED = '이 브라우저에서는 알림을 받을 수 없어요 — 아이폰은 홈 화면에 추가한 두레에서 켜 주세요'

const CONN_WORD = { open: '연결됨', reconnecting: '끊김', connecting: '잇는 중' } as const
const CONN_DOT = { open: 'g', reconnecting: 's', connecting: 's' } as const

const LEAD: Record<WaitKind, { tone: string; Icon: typeof ShieldAlert }> = {
  approval: { tone: 'a', Icon: ShieldAlert },
  question: { tone: 'a', Icon: MessageCircleQuestionMark },
  handoff: { tone: 'a', Icon: ArrowRightLeft },
  remote: { tone: 'r', Icon: TriangleAlert },
}

/** 길게 누름(약 0.5초) — 방 줄의 이름 바꾸기·지우기. 손이 움직이면(스크롤) 취소, 길게 누른 뒤의 누름(click)은 삼킨다 */
function useLongPress(onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    start.current = null
  }
  useEffect(() => clear, [])
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      fired.current = false
      start.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        fired.current = true
        clear()
        onLong()
      }, 520)
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const s = start.current
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
    /** 길게 누른 뒤 손을 떼며 생긴 누름이면 true — 그 누름은 방을 열지 않는다 */
    swallow: () => {
      const f = fired.current
      fired.current = false
      return f
    },
  }
}

/** 방 이름 바꾸기 — 판의 ⋯ 와 방 줄 길게 누르기가 같이 쓴다 */
export function RenameRoomDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const [name, setName] = useState(room.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const submit = async () => {
    const next = name.trim()
    if (next === room.name) return onClose()
    setBusy(true)
    setError(null)
    try {
      await window.dure.renameRoom(room.id, next)
      await getStore().refresh().catch(() => {})
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <FormDialog title="방 이름 바꾸기" submitLabel="저장" canSubmit={name.trim() !== ''} busy={busy} onSubmit={() => void submit()} onClose={onClose} error={error}>
      <div className="fld">
        <label className="fld-l" htmlFor={id}>
          방 이름
        </label>
        <input id={id} className="inp" value={name} onChange={e => setName(e.target.value)} autoComplete="off" />
      </div>
    </FormDialog>
  )
}

/** 방 지우기 확인 — PC 의 방 목록과 같은 말. 지운 뒤 onRemoved(방 목록으로) */
export function RemoveRoomConfirm({ room, onClose, onRemoved }: { room: Room | null; onClose: () => void; onRemoved: () => void }) {
  const agents = useDure(s => (room ? s.agents.filter(a => a.roomId === room.id).length : 0))
  return (
    <ConfirmDialog
      open={room !== null}
      title={room ? `방 ${room.name}${josa(room.name, '을/를')} 지울까요?` : ''}
      body={agents > 0 ? `안의 에이전트 ${agents}개와 대화 기록도 지워져요.` : undefined}
      confirmLabel="지우기"
      danger
      onConfirm={async () => {
        if (!room) return
        await window.dure.removeRoom(room.id) // 실패하면 확인 대화상자에 문구
        onClose()
        await getStore().refresh().catch(() => {})
        onRemoved()
      }}
      onCancel={onClose}
    />
  )
}

/** 이 PC에 새 방 — 이름만(서버 방은 ssh 설정을 읽어야 해서 PC 에서). 만들면 그 방의 판으로 */
function NewRoomDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: RoomId) => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const submit = async () => {
    setBusy(true)
    setError(null)
    let room: Room
    try {
      room = await window.dure.addRoom(name.trim())
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
      return
    }
    await getStore().refresh().catch(() => {})
    onClose()
    onCreated(room.id)
  }
  return (
    <FormDialog title="이 PC에 새 방" submitLabel="만들기" canSubmit={name.trim() !== ''} busy={busy} onSubmit={() => void submit()} onClose={onClose} error={error}>
      <div className="fld">
        <label className="fld-l" htmlFor={id}>
          방 이름
        </label>
        <input id={id} className="inp" placeholder="예: 여름 캠페인" value={name} onChange={e => setName(e.target.value)} autoComplete="off" />
        <p className="fld-note">서버 방은 PC 의 두레에서 만들 수 있어요.</p>
      </div>
    </FormDialog>
  )
}

/** PC 가 내어 줄 앱(/api/me) — 한 번 받으면 이 화면을 다시 그려도 다시 묻지 않는다(방 목록으로 돌아올 때 띠가 깜빡이지 않게). 못 받으면 다음에 다시 */
let pcAppSeen: { app: PhoneAndroidApp | null } | null = null

/**
 * 두레 앱(안드로이드) 띠 — 시안 phone-a. 방 목록 위에:
 * - 안드로이드 크롬(앱 밖): '두레 앱으로 쓰면 알림에 주소가 안 붙어요.' [두레 앱으로 열기](intent — 앱이 없으면 크롬이 /dure.apk 를 받는다) [나중에](이번 세션만 접기)
 * - 앱 안: PC 의 앱 판이 앱이 알린 판보다 크면 '앱 업데이트가 있어요' [받기](/dure.apk — 같은 열쇠라 덮어 깔린다). 드물어서 [나중에]는 없다
 * PC 가 내어 줄 앱이 없으면(androidApp null) 둘 다 없다. 아이폰·PC 브라우저는 /api/me 도 묻지 않는다
 */
function AppBand() {
  const [ctx] = useState(appContext)
  const [later, setLater] = useState(steerLater)
  const [pcApp, setPcApp] = useState<PhoneAndroidApp | null>(() => pcAppSeen?.app ?? null)
  const wanted = ctx.inApp || (ctx.androidChrome && !later)
  useEffect(() => {
    if (!wanted || pcAppSeen) return
    let live = true
    void meInfo().then(m => {
      if (!m) return
      pcAppSeen = { app: m.androidApp }
      if (live) setPcApp(m.androidApp)
    })
    return () => {
      live = false
    }
  }, [wanted])
  if (!wanted || !pcApp) return null
  if (ctx.inApp) {
    if (!needsUpdate(pcApp.versionCode, ctx.appVersion)) return null
    return (
      <section className="m-appband" aria-label="앱 업데이트">
        <p className="m-appband-t">앱 업데이트가 있어요</p>
        <div className="m-appband-act">
          <a className="btn pri m-appband-go" href="/dure.apk" download>
            받기
          </a>
        </div>
      </section>
    )
  }
  return (
    <section className="m-appband" aria-label="두레 앱으로 쓰기">
      <p className="m-appband-t">두레 앱으로 쓰면 알림에 주소가 안 붙어요.</p>
      <div className="m-appband-act">
        <a className="btn pri m-appband-go" href={openInAppHref(location.origin, location.pathname + location.hash, pcApp.packageName)}>
          두레 앱으로 열기
        </a>
        <button
          type="button"
          className="btn m-appband-later"
          onClick={() => {
            setSteerLater()
            setLater(true)
          }}
        >
          나중에
        </button>
      </div>
    </section>
  )
}

interface Props {
  onOpenRoom: (id: RoomId) => void
  onOpenAgent: (row: WaitRow) => void
}

export function RoomList({ onOpenRoom, onOpenAgent }: Props) {
  const v = useDure(s => ({ rooms: s.rooms, agents: s.agents, requests: s.requests, messages: s.messages }))
  const failed = useDure(s => s.loadError !== null)
  const conn = useConn()
  const { offline } = useOffline()
  const now = useNow()
  const rows = useMemo(() => waitingRows(v), [v])
  const counts = useMemo(() => todoCounts(v), [v])
  const todo = todoTotal(v, undefined, counts)
  const [creating, setCreating] = useState(false)
  const [pressed, setPressed] = useState<RoomId | null>(null)
  const [renaming, setRenaming] = useState<RoomId | null>(null)
  const [removing, setRemoving] = useState<RoomId | null>(null)
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null)
  const [device, setDevice] = useState<string | null>(null)
  const asked = useRef(false)
  const waitId = useId()
  const roomsId = useId()
  const room = (id: RoomId | null) => v.rooms.find(r => r.id === id) ?? null

  // 알림 켜기 — 누른 그 자리에서 부른다(아이폰은 사용자 손짓이 있어야 허락을 묻는다)
  const enablePush = () => {
    setNotice(null)
    void subscribePushHere().then(r =>
      setNotice(
        r === 'on' ? { text: PUSH_ON, tone: 'ok' }
          : { text: r === 'denied' ? PUSH_DENIED : r === 'unsupported' ? PUSH_UNSUPPORTED : PUSH_FAILED, tone: 'bad' },
      ),
    )
  }
  // 메뉴를 처음 열 때 이 휴대폰 이름(PC 가 기억하는 것)을 묻는다
  const onMenuOpen = () => {
    if (asked.current) return
    asked.current = true
    void meDevice().then(d => setDevice(d?.name ?? null))
  }

  const empty = v.rooms.length === 0
  return (
    <main className="m-scr m-rooms">
      <MobileTop
        actions={
          <MoreMenu
            label="메뉴"
            onOpen={onMenuOpen}
            header={
              <div className="m-pop-hd">
                <Smartphone className="i" aria-hidden="true" />
                <span className="m-pop-hd-tx">
                  <b>{device ?? '이 휴대폰'}</b>
                  <span>이름 바꾸기와 짝 끊기는 PC 설정의 휴대폰 칸에서 해요</span>
                </span>
              </div>
            }
            items={[{ label: '휴대폰 알림 켜기', icon: <BellRing className="i" aria-hidden="true" />, onSelect: enablePush }]}
          />
        }
      >
        <span className="m-mark">
          <BrandMark />
        </span>
        <div className="m-pc">
          <b className="trunc">{pcName(location.hostname)}</b>
          <span>
            <i className={`dot ${CONN_DOT[conn]}`} aria-hidden="true" />
            {CONN_WORD[conn]}
          </span>
        </div>
      </MobileTop>
      <OfflineBand />
      <div className={`m-body${offline ? ' stale' : ''}`}>
        {/* 끊긴 동안은 숨긴다 — 앱으로 열어도·받아도 PC 에 닿지 않는다 */}
        {!offline && <AppBand />}
        {notice && (
          <p className={`m-notice ${notice.tone}`} role={notice.tone === 'bad' ? 'alert' : undefined}>
            {notice.text}
          </p>
        )}
        {rows.length > 0 && (
          <section className="m-sec" aria-labelledby={waitId}>
            <h2 className="m-sec-h" id={waitId}>
              할 일{todo > 0 && <> <em>{todo}</em></>}
            </h2>
            <div className="m-grp pend">
              {rows.map(r => {
                const lead = LEAD[r.kind]
                const body = (
                  <>
                    <span className={`m-lead ${lead.tone}`} aria-hidden="true">
                      <lead.Icon className="i" size={15} />
                    </span>
                    <span className="m-row-main">
                      <span className="mw-t">
                        <b>{r.name}</b> <span className={`mw-what ${r.kind === 'remote' ? 'r' : 'a'}`}>{r.what}</span>
                      </span>
                      <span className="m-row-m">
                        <span className="trunc">{r.roomName}</span>
                        {r.kind !== 'remote' && <span className="m-age">{ago(r.at, now)}</span>}
                      </span>
                    </span>
                    <ChevronRight className="i m-go" size={18} aria-hidden="true" />
                  </>
                )
                return offline ? (
                  <div key={r.agentId} className="m-row mw">
                    {body}
                  </div>
                ) : (
                  <button key={r.agentId} type="button" className="m-row mw" onClick={() => onOpenAgent(r)}>
                    {body}
                  </button>
                )
              })}
            </div>
          </section>
        )}
        {!empty && (
          <section className="m-sec" aria-labelledby={roomsId}>
            <h2 className="m-sec-h" id={roomsId}>
              방 <em>{v.rooms.length}</em>
            </h2>
            <div className="m-grp">
              {v.rooms.map(r => (
                <RoomRow key={r.id} room={r} line={roomLine(v, r.id, rows, counts)} stale={offline} onOpen={() => onOpenRoom(r.id)} onLong={() => setPressed(r.id)} />
              ))}
            </div>
          </section>
        )}
        {!empty && !offline && (
          <button type="button" className="m-add" onClick={() => setCreating(true)}>
            <Plus className="i" aria-hidden="true" />이 PC에 새 방
          </button>
        )}
        {empty && !offline && !failed && (
          <div className="m-empty">
            <span className="m-empty-mark">
              <BrandMark />
            </span>
            <b>아직 방이 없어요</b>
            <p>방을 만들고 에이전트를 넣으면 여기서 일을 보고 승인할 수 있어요.</p>
            <button type="button" className="btn pri m-btn" onClick={() => setCreating(true)}>
              <Plus className="i" aria-hidden="true" />이 PC에 새 방
            </button>
          </div>
        )}
        {empty && (offline || failed) && <p className="m-empty-t">아직 받은 내용이 없어요</p>}
        {(offline || failed) && <p className="m-hint">{OFFLINE_HINT}</p>}
      </div>
      {creating && <NewRoomDialog onClose={() => setCreating(false)} onCreated={onOpenRoom} />}
      {/* 길게 누른 방 — 이름 바꾸기 · 지우기 */}
      <Sheet open={pressed !== null && !offline} title={room(pressed)?.name ?? '방'} head={<b className="trunc">{room(pressed)?.name}</b>} onClose={() => setPressed(null)}>
        <div className="am-list">
          <button type="button" className="mi" onClick={() => { setRenaming(pressed); setPressed(null) }}>
            <Pencil className="i" aria-hidden="true" />
            방 이름 바꾸기
          </button>
          <button type="button" className="mi dng-t" onClick={() => { setRemoving(pressed); setPressed(null) }}>
            <Trash2 className="i" aria-hidden="true" />
            방 지우기
          </button>
        </div>
      </Sheet>
      {room(renaming) && <RenameRoomDialog room={room(renaming)!} onClose={() => setRenaming(null)} />}
      <RemoveRoomConfirm room={room(removing)} onClose={() => setRemoving(null)} onRemoved={() => {}} />
    </main>
  )
}

function RoomRow({ room, line, stale, onOpen, onLong }: {
  room: Room
  line: ReturnType<typeof roomLine>
  stale: boolean
  onOpen: () => void
  onLong: () => void
}) {
  const press = useLongPress(onLong)
  const quiet = line.agents > 0 && line.working === 0 && line.todo === 0 && line.waiting === 0 && !line.issue
  const body = (
    <>
      <span className="m-row-main">
        <span className="mr-t">{room.name}</span>
        <span className="m-row-m">
          {room.remote && <ServerTag host={room.remote.host} />}
          <span>{line.agents > 0 ? `에이전트 ${line.agents}개` : '에이전트 없음'}</span>
          {line.working > 0 && (
            <span className="m-st">
              <i className="dot g" aria-hidden="true" />
              일하는 중 {line.working}
            </span>
          )}
          {line.todo > 0 && (
            <span className="m-st">
              <i className="dot a" aria-hidden="true" />
              할 일 {line.todo}
            </span>
          )}
          {line.issue && (
            <span className="m-st m-issue">
              <TriangleAlert className="i" size={13} aria-hidden="true" />
              서버 문제
            </span>
          )}
          {quiet && (
            <span className="m-st">
              <i className="dot s" aria-hidden="true" />
              모두 쉬는 중
            </span>
          )}
        </span>
      </span>
      <ChevronRight className="i m-go" size={18} aria-hidden="true" />
    </>
  )
  if (stale) return <div className="m-row mr">{body}</div>
  const { swallow, ...handlers } = press
  return (
    <button
      type="button"
      className="m-row mr"
      {...handlers}
      onClick={() => {
        if (!swallow()) onOpen()
      }}
    >
      {body}
    </button>
  )
}
