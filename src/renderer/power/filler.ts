// 채움 생성기 — 같은 씨앗이면 같은 사건열. 시각은 인자로만 받는다.
import { mulberry32, type PowerAgent, type ScreenEvent } from './events'
import { HAND, TARGETS, TOOL_MIX } from './fakeWorld'

export function createFiller(o: { agents: PowerAgent[]; seed: number }): {
  next(agentId: string, at: number): ScreenEvent
  handoff(at: number): ScreenEvent | null
} {
  const rnd = mulberry32(o.seed)
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
  return {
    next(agentId, at) {
      const tool = pick(TOOL_MIX)
      return { kind: 'tool', agentId, tool, target: pick(TARGETS[tool]), real: false, at }
    },
    handoff(at) {
      if (o.agents.length < 2) return null
      const from = pick(o.agents)
      const to = pick(o.agents.filter((a) => a.id !== from.id))
      return { kind: 'handoff', from: from.id, to: to.id, text: pick(HAND), real: false, at }
    },
  }
}
