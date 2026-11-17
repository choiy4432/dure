// 파워 모드 화면이 쓰는 사건 먹이 — 스토어의 듣기(진짜 사건)를 그대로 넘긴다. 지어내거나 섞지 않는다.
// 창이 안 보이는 동안 온 사건은 버린다(다시 보일 때 지난 일이 한꺼번에 쏟아지지 않게).
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
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
 * 관제실은 이 값으로 관계도에 전환(빨려 들기 · 도약 · 펼쳐지기)을 걸고, 터미널 벽은 옛 창 격자를 지우고 새 방 창 격자를 켠다
 */
export function useRoomChange(roomId: RoomId | null): RoomChange {
  const [change, setChange] = useState<RoomChange>(() => ({ n: 0, prev: roomId, next: roomId }))
  if (change.next === roomId) return change
  const next: RoomChange = { n: change.n + 1, prev: change.next, next: roomId }
  setChange(next)
  return next
}

/**
 * 방이 바뀌면(n) 바로 새 방 값으로 바뀐 칸들(sel — root 안)이 짧게 흐려졌다 돌아온다(CSS .pw-swap 0.2초 — 같은 움직임을 처음부터 다시 건다).
 * 클래스는 그리기 밖에서 바로 단다 — React 가 그리는 className 은 그대로라 덮어쓰지 않는다
 */
export function useSwapFade(n: number, root: RefObject<HTMLElement | null>, sel: string): void {
  useLayoutEffect(() => {
    if (!n) return
    for (const el of root.current?.querySelectorAll<HTMLElement>(sel) ?? []) {
      el.classList.remove('pw-swap')
      void el.offsetWidth
      el.classList.add('pw-swap')
    }
  }, [n, root, sel])
}
