import { describe, expect, it } from 'vitest'
import { createStats } from '../src/renderer/power/stats'
import type { ScreenEvent } from '../src/renderer/power/events'

const tool = (t: string): ScreenEvent => ({ kind: 'tool', agentId: 'a', tool: t, target: 'x', real: true, at: 0 })

describe('createStats', () => {
  it('시작_값은_시안_그대로', () => {
    const s = createStats(1).snapshot()
    expect([s.tools, s.files, s.added, s.removed, s.handoffs, s.tokens]).toEqual([1284, 312, 2431, 918, 37, 1.82e6])
  })

  it('tool_은_도구_호출을_1_올린다', () => {
    const st = createStats(1)
    st.apply(tool('Bash'))
    const s = st.snapshot()
    expect(s.tools).toBe(1285)
    expect([s.added, s.removed, s.handoffs]).toEqual([2431, 918, 37])
  })

  it('Edit_·_Write_만_바꾼_줄을_올린다', () => {
    const st = createStats(1)
    st.apply(tool('Read'))
    st.apply(tool('Bash'))
    expect(st.snapshot().added).toBe(2431)
    st.apply(tool('Edit'))
    const a = st.snapshot().added
    expect(a).toBeGreaterThan(2431)
    st.apply(tool('Write'))
    expect(st.snapshot().added).toBeGreaterThan(a)
  })

  it('handoff_는_넘긴_일을_1', () => {
    const st = createStats(1)
    st.apply({ kind: 'handoff', from: 'a', to: 'b', text: 'x', real: true, at: 0 })
    const s = st.snapshot()
    expect(s.handoffs).toBe(38)
    expect(s.tools).toBe(1284)
  })

  it('second_60번_뒤_perSec_길이는_60', () => {
    const st = createStats(1)
    for (let i = 0; i < 75; i++) st.second()
    expect(st.snapshot().perSec).toHaveLength(60)
  })

  it('second_는_그_초의_도구_호출을_막대로_옮긴다', () => {
    const st = createStats(1)
    for (let i = 0; i < 3; i++) st.apply(tool('Bash'))
    st.second()
    const p = st.snapshot().perSec
    expect(p[p.length - 1]).toBe(3)
    st.second()
    expect(st.snapshot().perSec.at(-1)).toBe(0)
  })
})
