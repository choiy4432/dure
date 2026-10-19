import { ChevronDown, Plus, Settings } from 'lucide-react'

interface Props {
  /** 지금 방 이름 — 방이 없으면 null(방 버튼을 숨기고 에이전트 추가를 막는다) */
  roomName: string | null
  onRoomMenu: () => void
  onAddAgent: () => void
  onSettings: () => void
}

/** 위 띠 48px — 두레 · 세로선 · 방 버튼 · 여백 · 에이전트 추가 · 설정 */
export function TopBar({ roomName, onRoomMenu, onAddAgent, onSettings }: Props) {
  return (
    <header className="top">
      <span className="brand">두레</span>
      {roomName !== null && (
        <>
          <span className="vr" aria-hidden="true" />
          <button type="button" className="room" onClick={onRoomMenu}>
            <span className="room-name">{roomName}</span>
            <ChevronDown className="i" />
          </button>
        </>
      )}
      <span className="top-sp" />
      <button type="button" className="btn pri" onClick={onAddAgent} disabled={roomName === null}>
        <Plus className="i" />
        에이전트 추가
      </button>
      <button type="button" className="ib" title="설정" aria-label="설정" onClick={onSettings}>
        <Settings className="i" size={18} />
      </button>
    </header>
  )
}
