import { Settings } from 'lucide-react'
import { RoomSwitcher } from './RoomSwitcher'
import { TodoButton } from './TodoButton'
import mark from '../../../resources/icon/dure-24.svg'

interface Props {
  /** 지금 방이 있는가 — 없으면 방 버튼을 숨긴다 */
  hasRoom: boolean
  /** 설정을 막는다(claude 가 없거나 처음 상태를 못 받았을 때) */
  settingsDisabled?: boolean
  onSettings: () => void
}

/**
 * 위 띠 48px = 창 제목 표시줄 — 두레 아이콘(D 넘김, 읽는 이름 '두레') · 세로선 · 방 버튼(방 목록) · 할 일 · 여백 · 설정. 오른쪽 끝은 Windows 단추 자리(main titleBarOverlay).
 * 빈 곳을 끌면 창이 옮겨지고 두 번 누르면 최대화(base.css .top 의 -webkit-app-region). 사용량은 아래 상태 띠, 에이전트 추가는 관계도로.
 */
export function TopBar({ hasRoom, settingsDisabled, onSettings }: Props) {
  return (
    <header className="top">
      <img className="brand" src={mark} alt="두레" width={22} height={22} draggable={false} />
      {hasRoom && (
        <>
          <span className="vr" aria-hidden="true" />
          <RoomSwitcher />
          <TodoButton />
        </>
      )}
      <span className="top-sp" />
      <button type="button" className="ib" title="설정" aria-label="설정" onClick={onSettings} disabled={settingsDisabled}>
        <Settings className="i" size={18} />
      </button>
    </header>
  )
}
