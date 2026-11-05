// 휴대폰 카드 판(시안 A) — 머리 ‹ · 방 이름 · 받은 일 N · ⋯, 몸통은 PC 관계도(touch: 한 손가락 끌기 = 판 이동, 두 손가락 = 확대·축소, 맞춤)
// 받은 일 = PC 의 '내가 할 일'(아무도 안 고른 패널) — 에이전트끼리 넘기는 일의 승인(넘기는 메시지 · 이어 보내기 한도)을 여기서
import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { RoomId } from '../../engine/types'
import { useDure } from '../state/store'
import { roomTotal, todoCounts } from '../state/attention'
import { RelationMap } from '../map/RelationMap'
import { Inbox } from '../panel/Inbox'
import { ServerTag } from '../shell/RemoteCheck'
import { MobileTop, MoreMenu, OfflineBand } from './parts'
import { RemoveRoomConfirm, RenameRoomDialog } from './RoomList'

interface BoardProps {
  roomId: RoomId
  onBack: () => void
  onInbox: () => void
  onAddAgent: () => void
  /** 방을 지웠다 — 방 목록으로 */
  onRemoved: () => void
}

export function RoomBoard({ roomId, onBack, onInbox, onAddAgent, onRemoved }: BoardProps) {
  const room = useDure(s => s.rooms.find(r => r.id === roomId) ?? null)
  const agents = useDure(s => s.agents.filter(a => a.roomId === roomId).length)
  const todo = useDure(s => roomTotal(todoCounts(s).rooms[roomId]))
  // 관계도는 스토어의 지금 방을 그린다 — MobileApp 이 이 방으로 맞춘 뒤에 그린다(다른 방이 한 번 그려졌다 바뀌지 않게)
  const current = useDure(s => s.roomId === roomId)
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  if (!room) return null
  return (
    <main className="m-scr m-board">
      <MobileTop
        onBack={onBack}
        actions={
          <>
            <button type="button" className={`m-todo${todo > 0 ? ' on' : ''}`} onClick={onInbox}>
              받은 일{todo > 0 && <> <em>{todo}</em></>}
            </button>
            <MoreMenu
              label="방 메뉴"
              items={[
                { label: '에이전트 추가', icon: <Plus className="i" aria-hidden="true" />, onSelect: onAddAgent },
                { label: '방 이름 바꾸기', icon: <Pencil className="i" aria-hidden="true" />, onSelect: () => setRenaming(true) },
                { label: '방 지우기', icon: <Trash2 className="i" aria-hidden="true" />, onSelect: () => setRemoving(true), danger: true },
              ]}
            />
          </>
        }
      >
        <div className="m-who">
          <h1 className="trunc">{room.name}</h1>
          {room.remote && <ServerTag host={room.remote.host} />}
        </div>
      </MobileTop>
      <OfflineBand />
      <div className="m-canvas" aria-label="관계도">
        {agents === 0 ? (
          <div className="m-empty">
            <b>아직 에이전트가 없어요</b>
            <p>에이전트를 넣으면 카드로 보여요. 카드를 누르면 대화가 열려요.</p>
            <button type="button" className="btn pri m-btn" onClick={onAddAgent}>
              <Plus className="i" aria-hidden="true" />
              에이전트 추가
            </button>
          </div>
        ) : (
          current && <RelationMap touch />
        )}
      </div>
      {renaming && <RenameRoomDialog room={room} onClose={() => setRenaming(false)} />}
      <RemoveRoomConfirm room={removing ? room : null} onClose={() => setRemoving(false)} onRemoved={onRemoved} />
    </main>
  )
}

/** 받은 일 — PC 의 '내가 할 일' 목록을 화면 전체로(넘기는 메시지 승인 · 이어 보내기 · 승인·질문 · 새 결과 · 지금 하는 일) */
export function InboxScreen({ roomId, onBack }: { roomId: RoomId; onBack: () => void }) {
  const room = useDure(s => s.rooms.find(r => r.id === roomId) ?? null)
  const todo = useDure(s => roomTotal(todoCounts(s).rooms[roomId]))
  const current = useDure(s => s.roomId === roomId)
  if (!room) return null
  return (
    <main className="m-scr m-inbox">
      <MobileTop onBack={onBack}>
        <div className="m-who">
          <h1 className="trunc">받은 일{todo > 0 && <em className="m-count"> {todo}</em>}</h1>
          <span className="trunc">{room.name}</span>
        </div>
      </MobileTop>
      <OfflineBand />
      <div className="m-inbox-body">
        {/* 목록 안 제목(새 결과·지금 하는 일)이 h3 이라 그 위 단계를 채운다 — 보이는 제목은 위 머리 */}
        <h2 className="sr-only">내가 할 일</h2>
        {current && <Inbox />}
      </div>
    </main>
  )
}
