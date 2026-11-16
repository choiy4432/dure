// 관제실이 쓰는 사건 먹이 — 켜질 때 믹서를 한 번 만들고(에이전트 목록은 그 세션 동안 고정), 250ms 마다 사건을 구독자에게 낸다.
import { useEffect, useRef, useState } from 'react'
import { getStore, useDure } from '../state/store'
import type { PowerAgent, ScreenEvent } from './events'
import { createMixer } from './mixer'
import { roomView } from './roomView'

export type PowerView = ReturnType<typeof roomView>
const TICK_MS = 250

const sameView = (a: PowerView, b: PowerView): boolean =>
  a.roomName === b.roomName &&
  a.subagents === b.subagents &&
  a.awaiting.size === b.awaiting.size &&
  [...a.awaiting].every(id => b.awaiting.has(id)) &&
  a.agents.length === b.agents.length &&
  a.agents.every((x, i) => x.id === b.agents[i].id && x.name === b.agents[i].name && x.role === b.agents[i].role && x.color === b.agents[i].color)

export function usePowerFeed(opts: { seed?: number; now?: () => number } = {}): {
  view: PowerView
  /** 켠 순간의 에이전트 — 세션 동안 고정(중간에 사라진 진짜 에이전트도 카드는 남는다) */
  agents: PowerAgent[]
  subscribe(fn: (ev: ScreenEvent) => void): () => void
} {
  const view = useDure(roomView, sameView)
  const viewRef = useRef(view)
  viewRef.current = view
  const [agents] = useState(() => view.agents)
  const subs = useRef(new Set<(ev: ScreenEvent) => void>())
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const now = () => (optsRef.current.now ?? Date.now)()
    const mixer = createMixer({ agents, seed: optsRef.current.seed ?? now() })
    const off = getStore().onPowerEvent(ev => mixer.real(ev))
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const waiting = viewRef.current.awaiting
      for (const ev of mixer.tick(now())) {
        // 진짜로 승인을 기다리는 에이전트에게는 지어낸 일을 붙이지 않는다
        if (!ev.real && (ev.kind === 'tool' ? waiting.has(ev.agentId) : waiting.has(ev.from) || waiting.has(ev.to))) continue
        for (const fn of [...subs.current]) fn(ev)
      }
    }, TICK_MS)
    return () => {
      clearInterval(id)
      off()
    }
  }, [agents])

  const subscribe = useRef((fn: (ev: ScreenEvent) => void) => {
    subs.current.add(fn)
    return () => {
      subs.current.delete(fn)
    }
  }).current

  return { view, agents, subscribe }
}
