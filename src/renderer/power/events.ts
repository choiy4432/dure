// 화면 사건 — 파워 모드가 그리는 진짜 일: 도구 · 그 결과 · 답 글 · 넘김 · 차례 끝. 지어낸 사건은 없다. 화면이 사건을 모아 그리는 도우미도 여기.
export type PowerAgent = { id: string; name: string; role: string; color: string }

/** 화면에 보일 에이전트 상태 — 승인·질문 기다림 / 차례 도는 중 / 그 밖(쉬는 중·잠듦·오류) */
export type AgentState = 'working' | 'awaiting' | 'resting'

/** 고친 줄 하나 — 통합 diff 의 줄 머리 그대로 */
export type DiffLine = { sign: '+' | '-' | ' '; text: string }

export type ScreenEvent =
  | { kind: 'tool'; agentId: string; tool: string; target: string; at: number }
  /** 도구 결과 — text 는 첫 줄 · added/removed 는 patch 전체에서 · diff 는 앞 12줄까지 */
  | { kind: 'result'; agentId: string; ok: boolean; text: string; added: number; removed: number; diff: DiffLine[]; at: number }
  /** 답 글 문단의 첫 줄 — 기록 한 줄에서 셋까지 */
  | { kind: 'say'; agentId: string; text: string; at: number }
  | { kind: 'handoff'; from: string; to: string; text: string; at: number }
  /** 차례 끝 */
  | { kind: 'done'; agentId: string; at: number }

/** 줄바꿈을 칸으로 바꾸고, max 를 넘으면 '…' 로 끝나게 max 글자로 자른다. */
export const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s*[\r\n]+\s*/g, ' ')
  if (max <= 0) return ''
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

/** 씨앗을 받는 작은 난수기(mulberry32). 0 이상 1 미만 — 장식(별·은하) 자리에만 쓴다. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 화면이 사건을 모아 한 번에 그리는 간격 — 사건마다 React 상태를 바꾸지 않게 */
export const BATCH_MS = 100
/** 한 번에 모아 두는 사건 상한(넘치면 오래된 것부터 버린다) */
const BATCH_MAX = 200

/** 사건을 모아 ms 마다 한 번에 넘긴다 — 같은 때 온 사건은 한 번에 그려진다. 끄는 함수를 돌려준다 */
export function batched(subscribe: (fn: (ev: ScreenEvent) => void) => () => void, fn: (evs: ScreenEvent[]) => void, ms = BATCH_MS): () => void {
  let queue: ScreenEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const off = subscribe(ev => {
    queue.push(ev)
    if (queue.length > BATCH_MAX) queue.splice(0, queue.length - BATCH_MAX)
    timer ??= setTimeout(() => {
      timer = undefined
      const evs = queue
      queue = []
      fn(evs)
    }, ms)
  })
  return () => {
    off()
    clearTimeout(timer)
  }
}
