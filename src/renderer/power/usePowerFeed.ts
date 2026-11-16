// 파워 모드 화면이 쓰는 사건 먹이 — 스토어의 듣기(진짜 사건)를 그대로 넘긴다. 지어내거나 섞지 않는다.
// 창이 안 보이는 동안 온 사건은 버린다(다시 보일 때 지난 일이 한꺼번에 쏟아지지 않게).
import { useCallback, useMemo, useRef } from 'react'
import { getStore, useDure } from '../state/store'
import type { PowerAgent, ScreenEvent } from './events'
import { roomView, type PowerView } from './roomView'

export type { PowerView } from './roomView'

const sameAgents = (a: PowerAgent[], b: PowerAgent[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.role === b[i].role && x.color === b[i].color)

const sameView = (a: PowerView, b: PowerView): boolean =>
  a.roomName === b.roomName &&
  sameAgents(a.agents, b.agents) &&
  a.agents.every(x => a.state[x.id] === b.state[x.id]) &&
  a.subagents.length === b.subagents.length &&
  a.subagents.every((x, i) => x.agentId === b.subagents[i].agentId && x.label === b.subagents[i].label)

export function usePowerFeed(): {
  /** 켠 순간 굳힌 방 — 에이전트 목록은 그때 그대로(지워진 에이전트만 빠진다), 상태는 스토어를 따른다 */
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
