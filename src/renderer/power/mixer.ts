// 진짜 사건과 채움을 합친다. 진짜 tool 이 오면 그 에이전트의 도구 채움은 quietMs 동안 쉰다(넘김 채움은 계속).
import { mulberry32, oneLine, type PowerAgent, type ScreenEvent } from './events'
import { createFiller } from './filler'

const TOOL_GAP: [number, number] = [700, 2200]
const HAND_GAP: [number, number] = [380, 950]
/** tick 을 기다리는 진짜 사건은 이만큼까지(넘치면 오래된 것부터 버린다) — tick 이 오래 안 불려도 끝없이 쌓이지 않게 */
const MAX_PENDING = 100

export function createMixer(o: { agents: PowerAgent[]; seed: number; quietMs?: number }): {
  real(ev: ScreenEvent): void
  tick(now: number): ScreenEvent[]
} {
  const quietMs = o.quietMs ?? 4000
  const filler = createFiller({ agents: o.agents, seed: o.seed })
  const rnd = mulberry32((o.seed ^ 0x9e3779b9) >>> 0)
  const gap = ([lo, hi]: [number, number]) => lo + rnd() * (hi - lo)

  const pending: ScreenEvent[] = []
  const quietUntil = new Map<string, number>()
  const nextTool = new Map<string, number>()
  let nextHand: number | null = null

  return {
    real(ev) {
      const e: ScreenEvent = { ...ev, real: true }
      if (e.kind === 'handoff') e.text = oneLine(e.text, 80)
      if (e.kind === 'tool') {
        e.target = oneLine(e.target, 80)
        quietUntil.set(e.agentId, Math.max(quietUntil.get(e.agentId) ?? -Infinity, e.at + quietMs))
      }
      pending.push(e)
      if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
    },
    tick(now) {
      const out = pending.splice(0)
      for (const a of o.agents) {
        let t = nextTool.get(a.id)
        if (t === undefined) t = now + gap(TOOL_GAP)
        // 창이 숨었다 돌아오는 등 긴 공백이면 밀린 걸 되풀이하지 않고 지금부터 다시 잡는다.
        if (now - t > TOOL_GAP[1]) t = now + gap(TOOL_GAP)
        while (t <= now) {
          const q = quietUntil.get(a.id) ?? -Infinity
          if (t < q) t = q + gap(TOOL_GAP)
          else {
            out.push(filler.next(a.id, t))
            t += gap(TOOL_GAP)
          }
        }
        nextTool.set(a.id, t)
      }
      if (nextHand === null) nextHand = now + gap(HAND_GAP)
      if (now - nextHand > HAND_GAP[1]) nextHand = now + gap(HAND_GAP)
      while (nextHand <= now) {
        const h = filler.handoff(nextHand)
        if (h) out.push(h)
        nextHand += gap(HAND_GAP)
      }
      return out.sort((x, y) => x.at - y.at)
    },
  }
}
