import { useCallback, useState } from 'react'
import { LucideProvider } from 'lucide-react'
import { getStore, useDure } from './state/store'
import { effectiveSetup } from './state/selectors'
import { TopBar } from './shell/TopBar'
import { StatusBar } from './shell/StatusBar'
import { SplitView } from './shell/SplitView'
import { Empty } from './shell/Empty'
import { Splash } from './shell/Splash'
import { SetupScreen } from './shell/SetupScreen'
import { NewRoomDialog } from './shell/RoomSwitcher'
import { AddAgentDialog } from './shell/AddAgentDialog'
import { SettingsDialog, type SettingsTab } from './shell/SettingsDialog'
import { PhonePane } from './shell/PhoneSettings'
import { Presence } from './lib/presence'
import { RelationMap } from './map/RelationMap'
import { AgentPanel } from './panel/AgentPanel'
import { useAttention } from './shell/useAttention'
import { Announcer } from './shell/Announcer'
import { UpdateToast } from './shell/UpdateToast'
import { TourLayer } from './tour/TourLayer'
import { SearchPalette, useSearchShortcut } from './shell/SearchPalette'
import { PowerLayer } from './power/PowerLayer'

type Dialog = 'room' | 'agent' | 'settings' | null

export function App() {
  const v = useDure(s => {
    const room = s.rooms.find(r => r.id === s.roomId) ?? null
    return {
      loadError: s.loadError,
      setup: s.app.setup,
      setupLoadFailed: s.app.setupLoadFailed,
      claudeMissing: s.claudeMissing,
      roomId: room?.id ?? null,
      agentCount: room ? s.agents.filter(a => a.roomId === room.id).length : 0,
    }
  })
  const announced = useAttention()
  // html 의 data-platform(mac 신호등 자리)은 진입점(main.tsx)이 React 를 띄우기 전에 단다 — 여기서 appInfo 를 기다려 달지 않는다
  const fork = useDure(s => s.forkDraft)
  /** 파워 모드 덮개가 앱 틀을 다 가린다 — 고른 에이전트의 대화 패널은 덮개 안 하나만 그린다(두 벌이면 입력창 커서·스크롤·기록 불러오기 효과가 두 번 돈다) */
  const powerOn = useDure(s => s.power.on)
  const [dialog, setDialog] = useState<Dialog>(null)
  /** 설정 창이 열리는 탭 — 톱니는 늘 일반, 위 띠 휴대폰 알약은 휴대폰 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  /** 설정 위에 겹친 창(묻지 않고 실행 확인 · 휴대폰의 짝 맺기·앱 받기·끊기 확인)이 떠 있다 — 그동안 투어 카드가 가리지 않게 */
  const [settingsCovered, setSettingsCovered] = useState(false)
  /** 찾기 · 옮기기 창(Ctrl+K · 위 띠 칸) — 다른 대화상자와 따로(그 창들이 떠 있으면 Ctrl+K 는 무시) */
  const [searching, setSearching] = useState(false)
  const closeSearch = useCallback(() => setSearching(false), [])
  const openSearch = useCallback(() => setSearching(true), [])
  const toggleSearch = useCallback(() => setSearching(s => !s), [])
  const close = () => setDialog(null)
  const openSettings = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab)
    setDialog('settings')
  }, [])
  /** 파워 모드 덮개의 [설정] — 늘 같은 함수(덮개가 화면을 다시 그리지 않게) */
  const openGeneral = useCallback(() => openSettings('general'), [openSettings])
  /** 안내 다시 보기 — 투어는 앱 화면을 가리킨다. 파워 모드 덮개가 그것을 가리고 있으면 먼저 끄고 시작한다(끄지 못하면 시작하지 않는다) */
  const replayTour = () => {
    close()
    const s = getStore()
    const start = () => s.startTour(s.getState().rooms.length > 0)
    if (s.getState().power.on) void s.setPower(false).then(start, () => {})
    else start()
  }
  const setupPhase = effectiveSetup(v.setup, v.claudeMissing, v.setupLoadFailed).phase
  const preparing = setupPhase === 'needs' || setupPhase === 'relaunching'
  const blocked = v.loadError !== null || preparing || setupPhase === 'checking' || v.claudeMissing
  // 찾을 것이 있을 때만(방이 있고 준비됨) — 위 띠의 방 버튼과 같은 때
  const canSearch = !blocked && v.roomId !== null
  // 찾을 수 없게 되면(준비 화면 · 불러오기 오류 · 방 없음) 열린 창은 닫힌 것 — canSearch 가 돌아와도 저절로 다시 뜨지 않는다
  if (!canSearch && searching) setSearching(false)
  useSearchShortcut(canSearch && !searching, openSearch)

  let body
  if (v.loadError !== null) {
    body = (
      <main className="cv">
        <LoadFailed message={v.loadError} />
      </main>
    )
  } else if (setupPhase === 'checking') {
    body = (
      <main className="cv">
        <Splash inline />
      </main>
    )
  } else if (preparing) {
    body = (
      <main className="cv">
        <SetupScreen />
      </main>
    )
  } else if (v.roomId === null) {
    body = (
      <main className="cv">
        <Empty kind="room" onAction={() => setDialog('room')} />
      </main>
    )
  } else {
    body = (
      <SplitView
        left={
          <main className="cv" aria-label="관계도">
            {v.agentCount === 0 ? <Empty kind="agent" onAction={() => setDialog('agent')} /> : <RelationMap onAddAgent={() => setDialog('agent')} />}
          </main>
        }
        right={powerOn ? null : <AgentPanel />}
      />
    )
  }

  return (
    <LucideProvider size={16} strokeWidth={1.75}>
      <div className="app">
        {/* 덮개에 가린 틀(위 띠·본문·상태 띠)은 켜진 동안 inert — Tab·화면 낭독기가 안 보이는 단추로 가지 않고, 닫히는 창이 초점을 그 밑으로 돌려주지 않는다.
            찾기·대화상자·토스트·투어·알림 낭독은 이 밖이라 그대로 덮개 위에서 쓴다. display: contents 라 배치는 그대로 */}
        <div style={{ display: 'contents' }} inert={powerOn || undefined}>
          <TopBar
            hasRoom={!blocked && v.roomId !== null}
            settingsDisabled={blocked}
            onSettings={() => openSettings('general')}
            onPhone={() => openSettings('phone')}
            onSearch={canSearch ? toggleSearch : undefined}
            searchOpen={searching && canSearch}
          />
          {body}
          <StatusBar />
        </div>
        <Announcer {...announced} />
        {/* 덮개의 [설정] 은 위 띠 톱니와 같은 때만(막혀 있으면 단추도 없다) — 설정 창은 이 밖(포털)이라 덮개 위에 뜬다 */}
        <PowerLayer onSettings={blocked ? undefined : openGeneral} />
        <UpdateToast />
        <Presence show={searching && canSearch}>
          <SearchPalette onClose={closeSearch} />
        </Presence>
        <Presence show={dialog === 'room'}>
          <NewRoomDialog onClose={close} />
        </Presence>
        <Presence show={dialog === 'agent'}>
          {v.roomId !== null && <AddAgentDialog roomId={v.roomId} onClose={close} />}
        </Presence>
        <Presence show={fork !== null}>
          {fork && <AddAgentDialog roomId={fork.roomId} fork={fork} onClose={() => getStore().closeFork()} />}
        </Presence>
        <Presence show={dialog === 'settings'}>
          <SettingsDialog
            onClose={close}
            initialTab={settingsTab}
            onCoveredChange={setSettingsCovered}
            phonePane={o => <PhonePane onCoveredChange={o.onCoveredChange} />}
            onReplayTour={replayTour}
          />
        </Presence>
        {/* 안내 투어·승인 한 번 — 대화상자 위 겹. 열린 창을 보고 단계를 넘기고, 새 방·에이전트 추가 창 · 설정 위에 겹친 창이 떠 있는 동안은 숨는다 */}
        <TourLayer
          dialog={dialog}
          covered={settingsCovered}
          onCloseDialog={close}
        />
      </div>
    </LucideProvider>
  )
}

const HANGUL = /[가-힣]/

/**
 * 처음 상태를 못 받았을 때 — '첫 방을 만들어 보세요' 대신 안내와 다시 시도.
 * 한국어 엔진 문구면 그대로 본문으로, 아니면(Electron IPC 원문 등 영어) 한국어 안내가 본문이고 원문은 작은 줄로만.
 */
function LoadFailed({ message }: { message: string }) {
  const korean = HANGUL.test(message)
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      await getStore().refresh() // 실패하면 스토어가 새 까닭을 남긴다
    } catch {
      // 문구는 스토어의 loadError 로 보인다
    } finally {
      setBusy(false)
    }
  }
  return (
    <Empty
      kind="load"
      text={korean ? message : undefined}
      detail={korean ? undefined : message}
      onAction={() => void retry()}
      busy={busy}
    />
  )
}
