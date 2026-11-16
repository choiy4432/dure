// 숫자 띠의 셈 — 시안의 시작 값에서 사건마다 올라간다. 화면용 장식 숫자라 난수는 씨앗으로만.
import { mulberry32, type ScreenEvent } from './events'

export type StatsSnapshot = {
  tools: number
  files: number
  added: number
  removed: number
  handoffs: number
  tokens: number
  perSec: number[]
  toolsPerMin: number
}

export function createStats(seed: number) {
  const rnd = mulberry32(seed)
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
  let tools = 1284
  let files = 312
  let added = 2431
  let removed = 918
  let handoffs = 37
  let tokens = 1.82e6
  let sec = 0
  const recent: number[] = Array.from({ length: 60 }, () => int(1, 4))

  const snapshot = (): StatsSnapshot => ({
    tools,
    files,
    added,
    removed,
    handoffs,
    tokens,
    perSec: [...recent],
    toolsPerMin: Math.round((recent.reduce((p, v) => p + v, 0) / recent.length) * 60),
  })

  return {
    apply(ev: ScreenEvent): void {
      if (ev.kind === 'handoff') {
        handoffs++
        return
      }
      tools++
      sec++
      if (ev.tool === 'Read') files++
      if (ev.tool === 'Edit' || ev.tool === 'Write') {
        added += int(1, 24)
        removed += int(0, 10)
      }
    },
    second(): void {
      recent.push(sec)
      sec = 0
      if (recent.length > 60) recent.shift()
      tokens += int(600, 4200)
    },
    snapshot,
  }
}
