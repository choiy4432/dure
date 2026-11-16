// 숫자 띠의 셈 — 켠 순간 0에서 시작해 진짜 사건만큼 오른다. 지어낸 시작 값·난수는 없다.
import type { ScreenEvent } from './events'

/** 초당 막대 수 — 지난 1분 */
const SECONDS = 60

export type StatsSnapshot = {
  tools: number
  /** 읽은 고유 파일(Read 의 대상) */
  files: number
  /** 바꾼 줄 — 진짜 patch 에서 */
  added: number
  removed: number
  handoffs: number
  /** 지난 60초의 초당 도구 호출(오래된 것부터) */
  perSec: number[]
  /** 지난 60초의 도구 호출 수 */
  toolsPerMin: number
}

export function createStats() {
  let tools = 0
  let files = 0
  let added = 0
  let removed = 0
  let handoffs = 0
  let sec = 0
  const read = new Set<string>()
  const recent: number[] = new Array<number>(SECONDS).fill(0)

  const snapshot = (): StatsSnapshot => ({
    tools,
    files,
    added,
    removed,
    handoffs,
    perSec: [...recent],
    toolsPerMin: recent.reduce((p, v) => p + v, 0),
  })

  return {
    apply(ev: ScreenEvent): void {
      switch (ev.kind) {
        case 'tool':
          tools++
          sec++
          if (ev.tool === 'Read' && ev.target && !read.has(ev.target)) {
            read.add(ev.target)
            files++
          }
          return
        case 'result':
          added += ev.added
          removed += ev.removed
          return
        case 'handoff':
          handoffs++
          return
        default:
          return // 답 글·차례 끝은 셈하지 않는다
      }
    },
    /** 1초가 지났다 — 그 초의 도구 호출을 막대로 옮긴다 */
    second(): void {
      recent.push(sec)
      sec = 0
      if (recent.length > SECONDS) recent.shift()
    },
    snapshot,
  }
}
