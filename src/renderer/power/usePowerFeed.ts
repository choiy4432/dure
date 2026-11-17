// 파워 모드 화면이 쓰는 사건 먹이 — 스토어의 듣기(진짜 사건)를 그대로 넘긴다. 지어내거나 섞지 않는다.
// 창이 안 보이는 동안 온 사건은 버린다(다시 보일 때 지난 일이 한꺼번에 쏟아지지 않게).
import { useCallback, useMemo, useRef, useState } from 'react'
import type { RoomId } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import type { PowerAgent, ScreenEvent } from './events'
import { roomView, type PowerView } from './roomView'

export type { PowerView } from './roomView'

const sameAgents = (a: PowerAgent[], b: PowerAgent[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.role === b[i].role && x.color === b[i].color)

const sameView = (a: PowerView, b: PowerView): boolean =>
  a.roomId === b.roomId &&
  a.roomName === b.roomName &&
  sameAgents(a.agents, b.agents) &&
  a.agents.every(x => a.state[x.id] === b.state[x.id]) &&
  a.subagents.length === b.subagents.length &&
  a.subagents.every((x, i) => x.agentId === b.subagents[i].agentId && x.label === b.subagents[i].label)

export function usePowerFeed(): {
  /** 파워 모드의 방(= 앱의 방) — 에이전트 목록은 그 방으로 옮긴 순간 그대로(지워진 에이전트만 빠진다), 상태는 스토어를 따른다 */
  view: PowerView
  subscribe(fn: (ev: ScreenEvent) => void): () => void
} {
  const fresh = useDure(roomView, sameView)
  // 상태만 바뀌면 에이전트 배열은 그대로 — 관계도가 장면을 새로 만들지 않게
  const agents = useRef(fresh.agents)
  if (agents.current !== fresh.agents && !sameAgents(agents.current, fresh.agents)) agents.current = fresh.agents
  const view = useMemo(() => (fresh.agents === agents.current ? fresh : { ...fresh, agents: agents.current }), [fresh])
  const subscribe = useCallback(
    (fn: (ev: ScreenEvent) => void) =>
      getStore().onPowerEvent(ev => {
        if (document.visibilityState !== 'visible') return
        fn(ev)
      }),
    [],
  )
  return { view, subscribe }
}

/** 화면이 그리는 방이 바뀐 일 — n 은 바뀔 때마다 오른다(처음 그릴 때 0, 그때 prev = next) */
export type RoomChange = { n: number; prev: RoomId | null; next: RoomId | null }

/**
 * 전환 신호 — 화면(관제실·터미널 벽)이 view.roomId 가 바뀐 것(prev → next)을 아는 한 곳.
 * 바뀐 그 그리기에서 바로 새 값을 준다(효과를 기다리지 않는다 — 옛 방 장면이 새 방 에이전트로 한 번 그려지지 않게).
 * 관제실은 이 값으로 관계도 장면을, 터미널 벽은 창 격자를 새 방 에이전트로 다시 짓는다 — 전환 연출(Task 2)은 그 자리에서 prev → next 를 받아 붙인다
 */
export function useRoomChange(roomId: RoomId | null): RoomChange {
  const [change, setChange] = useState<RoomChange>(() => ({ n: 0, prev: roomId, next: roomId }))
  if (change.next === roomId) return change
  const next: RoomChange = { n: change.n + 1, prev: change.next, next: roomId }
  setChange(next)
  return next
}
