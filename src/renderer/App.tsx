import { LucideProvider } from 'lucide-react'
import { useDure } from './state/store'
import { TopBar } from './shell/TopBar'
import { SplitView } from './shell/SplitView'
import { Empty } from './shell/Empty'

// 방 고르기·방 만들기·에이전트 추가·설정 대화상자는 아직 없다 — 생기면 아래 처리들을 잇는다
const openRoomMenu = () => {}
const openAddRoom = () => {}
const openAddAgent = () => {}
const openSettings = () => {}

export function App() {
  const v = useDure(s => {
    const room = s.rooms.find(r => r.id === s.roomId) ?? null
    return {
      claudeMissing: s.claudeMissing,
      roomName: room?.name ?? null,
      agentCount: room ? s.agents.filter(a => a.roomId === room.id).length : 0,
      selectedName: s.agents.find(a => a.id === s.selectedAgentId)?.name ?? null,
    }
  })

  let body
  if (v.claudeMissing) {
    body = (
      <main className="cv">
        <Empty kind="claude" />
      </main>
    )
  } else if (v.roomName === null) {
    body = (
      <main className="cv">
        <Empty kind="room" onAction={openAddRoom} />
      </main>
    )
  } else {
    body = (
      <SplitView
        left={
          <main className="cv" aria-label="관계도">
            {v.agentCount === 0 && <Empty kind="agent" onAction={openAddAgent} />}
          </main>
        }
        right={<aside className="pnl" aria-label={v.selectedName ?? '에이전트'} />}
      />
    )
  }

  return (
    <LucideProvider size={16} strokeWidth={1.75}>
      <div className="app">
        <TopBar
          roomName={v.claudeMissing ? null : v.roomName}
          onRoomMenu={openRoomMenu}
          onAddAgent={openAddAgent}
          onSettings={openSettings}
        />
        {body}
      </div>
    </LucideProvider>
  )
}
