import { describe, it, expect } from 'vitest'
import { enteringLines, type LineSnap } from '../../src/renderer/panel/newLines'

const s = (over: Partial<LineSnap> = {}): LineSnap => ({ agentId: 'a', ready: true, total: 5, streaming: false, ...over })

describe('enteringLines — 이번에 들어올 줄', () => {
  it('처음 그린 것은 없다', () => expect(enteringLines(null, s())).toBeNull())
  it('보는 동안 하나 늘면 그 줄', () => expect(enteringLines(s(), s({ total: 6 }))).toEqual({ from: 5, to: 6, live: false }))
  it('다른 에이전트면 없다', () => expect(enteringLines(s(), s({ agentId: 'b', total: 9 }))).toBeNull())
  it('기록을 받는 중이던 것(불러오는 중 → 다 받음)은 없다', () => expect(enteringLines(s({ ready: false, total: 0 }), s({ total: 300 }))).toBeNull())
  it('받는 중으로 돌아가도 없다', () => expect(enteringLines(s(), s({ ready: false, total: 9 }))).toBeNull())
  it('더 보기는 total 이 같아 없다', () => expect(enteringLines(s(), s())).toBeNull())
  it('흐르던 글이 줄로 자리 잡으면 없다', () => expect(enteringLines(s({ streaming: true }), s({ total: 6 }))).toBeNull())
  it('흐르는 글이 생기면 그 글만', () => expect(enteringLines(s(), s({ streaming: true }))).toEqual({ from: 5, to: 5, live: true }))
  it('흐르는 글이 이어지는 중이면 없다', () => expect(enteringLines(s({ streaming: true }), s({ streaming: true }))).toBeNull())
})
