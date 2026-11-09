import { useState } from 'react'
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
  const fork = useDure(s => s.forkDraft)
  const [dialog, setDialog] = useState<Dialog>(null)
  /** 설정 창이 열리는 탭 — 톱니는 늘 일반, 위 띠 휴대폰 알약은 휴대폰 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  /** 설정 위에 겹친 창(묻지 않고 실행 확인 · 휴대폰의 짝 맺기·앱 받기·끊기 확인)이 떠 있다 — 그동안 투어 카드가 가리지 않게 */
  const [settingsCovered, setSettingsCovered] = useState(false)
  const close = () => setDialog(null)
  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab)
    setDialog('settings')
  }
  const setupPhase = effectiveSetup(v.setup, v.claudeMissing, v.setupLoadFailed).phase
  const preparing = setupPhase === 'needs' || setupPhase === 'relaunching'
  const blocked = v.loadError !== null || preparing || setupPhase === 'checking' || v.claudeMissing

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
        right={<AgentPanel />}
      />
    )
  }

  return (
    <LucideProvider size={16} strokeWidth={1.75}>
      <div className="app">
        <TopBar
          hasRoom={!blocked && v.roomId !== null}
          settingsDisabled={blocked}
          onSettings={() => openSettings('general')}
          onPhone={() => openSettings('phone')}
        />
        {body}
        <StatusBar />
        <Announcer {...announced} />
        <UpdateToast />
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
            onReplayTour={() => {
              close()
              getStore().startTour(getStore().getState().rooms.length > 0)
            }}
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
