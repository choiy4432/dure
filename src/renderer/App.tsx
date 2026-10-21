import { useState } from 'react'
import { LucideProvider } from 'lucide-react'
import { getStore, useDure } from './state/store'
import { TopBar } from './shell/TopBar'
import { SplitView } from './shell/SplitView'
import { Empty } from './shell/Empty'
import { NewRoomDialog } from './shell/RoomSwitcher'
import { AddAgentDialog } from './shell/AddAgentDialog'
import { SettingsDialog } from './shell/SettingsDialog'
import { ConfirmDialog } from './shell/ConfirmDialog'
import { Presence } from './lib/presence'
import { RelationMap } from './map/RelationMap'
import { AgentPanel } from './panel/AgentPanel'

type Dialog = 'room' | 'agent' | 'settings' | null

export function App() {
  const v = useDure(s => {
    const room = s.rooms.find(r => r.id === s.roomId) ?? null
    return {
      loadError: s.loadError,
      claudeMissing: s.claudeMissing,
      roomId: room?.id ?? null,
      agentCount: room ? s.agents.filter(a => a.roomId === room.id).length : 0,
    }
  })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [askAllow, setAskAllow] = useState(false)
  const close = () => setDialog(null)
  const blocked = v.loadError !== null || v.claudeMissing

  let body
  if (v.loadError !== null) {
    body = (
      <main className="cv">
        <LoadFailed message={v.loadError} />
      </main>
    )
  } else if (v.claudeMissing) {
    body = (
      <main className="cv">
        <Empty kind="claude" />
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
            {v.agentCount === 0 ? <Empty kind="agent" onAction={() => setDialog('agent')} /> : <RelationMap />}
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
          onAddAgent={() => setDialog('agent')}
          onSettings={() => setDialog('settings')}
        />
        {body}
        <Presence show={dialog === 'room'}>
          <NewRoomDialog onClose={close} />
        </Presence>
        <Presence show={dialog === 'agent'}>
          {v.roomId !== null && <AddAgentDialog roomId={v.roomId} onClose={close} />}
        </Presence>
        <Presence show={dialog === 'settings'}>
          <SettingsDialog onClose={close} onAskAllow={() => setAskAllow(true)} />
        </Presence>
        <ConfirmDialog
          open={askAllow}
          title="묻지 않고 실행을 허용할까요?"
          body="허용하면 에이전트마다 '묻지 않음'을 켤 수 있어요. 켠 에이전트는 파일 수정·명령 실행을 묻지 않고 바로 해요. 믿을 수 있는 폴더에서만 켜 주세요."
          confirmLabel="허용"
          onConfirm={async () => {
            await window.dure.setAllowBypass(true)
            await getStore().refresh()
            setAskAllow(false)
          }}
          onCancel={() => setAskAllow(false)}
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
