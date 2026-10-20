import { Plus, Settings } from 'lucide-react'
import { RoomSwitcher } from './RoomSwitcher'
import { UsageMeters } from './UsageMeters'

interface Props {
  /** 지금 방이 있는가 — 없으면 방 버튼을 숨기고 에이전트 추가를 막는다 */
  hasRoom: boolean
  /** 설정을 막는다(claude 가 없거나 처음 상태를 못 받았을 때) */
  settingsDisabled?: boolean
  onAddAgent: () => void
  onSettings: () => void
}

/** 위 띠 48px — 두레 · 세로선 · 방 버튼(방 목록) · 여백 · 에이전트 추가 · 설정 */
export function TopBar({ hasRoom, settingsDisabled, onAddAgent, onSettings }: Props) {
  return (
    <header className="top">
      <span className="brand">두레</span>
      {hasRoom && (
        <>
          <span className="vr" aria-hidden="true" />
          <RoomSwitcher />
        </>
      )}
      <span className="top-sp" />
      <UsageMeters />
      <button type="button" className="btn pri" onClick={onAddAgent} disabled={!hasRoom}>
        <Plus className="i" />
        에이전트 추가
      </button>
      <button type="button" className="ib" title="설정" aria-label="설정" onClick={onSettings} disabled={settingsDisabled}>
        <Settings className="i" size={18} />
      </button>
    </header>
  )
}
