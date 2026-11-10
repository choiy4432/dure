import { Search, Settings } from 'lucide-react'
import { SEARCH } from '../lib/words'
import { RoomSwitcher } from './RoomSwitcher'
import { TodoButton } from './TodoButton'
import { BrandMark } from './BrandMark'
import { PhonePill } from './PhoneSettings'

interface Props {
  /** 지금 방이 있는가 — 없으면 방 버튼을 숨긴다 */
  hasRoom: boolean
  /** 설정을 막는다(claude 가 없거나 처음 상태를 못 받았을 때) */
  settingsDisabled?: boolean
  onSettings: () => void
  /** 휴대폰 알약을 누름 — 설정 창을 휴대폰 탭으로. 없으면 알약도 없다 */
  onPhone?: () => void
  /** '찾기 · 옮기기' 칸을 누름 — 찾기 창을 열고 닫는다(Ctrl+K 와 같은 창). 없으면 칸도 없다 */
  onSearch?: () => void
  /** 찾기 창이 열려 있다 */
  searchOpen?: boolean
}

/**
 * 위 띠 48px = 창 제목 표시줄 — 두레 마크(판 없는 D, 읽는 이름 '두레') · 세로선 · 방 버튼(방 목록) · 할 일 · 여백 · 찾기 · 옮기기 칸(Ctrl K) ·
 * 휴대폰 알약(켜져 있을 때만) · 설정.
 * 오른쪽 끝은 Windows 단추 자리(main titleBarOverlay).
 * 빈 곳을 끌면 창이 옮겨지고 두 번 누르면 최대화(base.css .top 의 -webkit-app-region). 사용량은 아래 상태 띠, 에이전트 추가는 관계도로.
 */
export function TopBar({ hasRoom, settingsDisabled, onSettings, onPhone, onSearch, searchOpen = false }: Props) {
  return (
    <header className="top">
      <BrandMark />
      {hasRoom && (
        <>
          <span className="vr" aria-hidden="true" />
          <RoomSwitcher />
          <TodoButton />
        </>
      )}
      <span className="top-sp" />
      {hasRoom && onSearch && (
        // 입력칸처럼 보이는 단추(시안 ① A) — 누르면 가운데 찾기 창. 열린 채 다시 누르면 닫는다(찾기 창의 '바깥 누르기'에서 뺀다)
        <button
          type="button"
          className="top-find"
          data-search-trigger
          aria-label={SEARCH.title}
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          aria-keyshortcuts="Control+K"
          onClick={onSearch}
        >
          <Search className="i" aria-hidden="true" />
          <span className="top-find-t">{SEARCH.title}</span>
          <kbd className="kbd" aria-hidden="true">{SEARCH.key}</kbd>
        </button>
      )}
      {onPhone && <PhonePill onOpen={onPhone} />}
      <button type="button" className="ib" data-tour="settings-gear" title="설정" aria-label="설정" onClick={onSettings} disabled={settingsDisabled}>
        <Settings className="i" size={18} />
      </button>
    </header>
  )
}
