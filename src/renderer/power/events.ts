// 화면 사건 — 파워 모드가 그리는 "누가 무엇을 했다 / 누가 누구에게 넘겼다".
export type PowerAgent = { id: string; name: string; role: string; color: string; real: boolean }

export type ScreenEvent =
  | { kind: 'tool'; agentId: string; tool: string; target: string; real: boolean; at: number }
  | { kind: 'handoff'; from: string; to: string; text: string; real: boolean; at: number }

/** 줄바꿈을 칸으로 바꾸고, max 를 넘으면 '…' 로 끝나게 max 글자로 자른다. */
export const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s*[\r\n]+\s*/g, ' ')
  if (max <= 0) return ''
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

/** 씨앗을 받는 작은 난수기(mulberry32). 0 이상 1 미만. */
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
