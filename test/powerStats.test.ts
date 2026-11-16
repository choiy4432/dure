import { describe, expect, it } from 'vitest'
import { createStats } from '../src/renderer/power/stats'
import type { ScreenEvent } from '../src/renderer/power/events'

const tool = (t: string, target = 'x'): ScreenEvent => ({ kind: 'tool', agentId: 'a', tool: t, target, at: 0 })
const result = (added: number, removed: number): ScreenEvent => ({ kind: 'result', agentId: 'a', ok: true, text: '', added, removed, diff: [], at: 0 })

describe('createStats', () => {
  it('0에서_시작', () => {
    const s = createStats().snapshot()
    expect([s.tools, s.files, s.added, s.removed, s.handoffs, s.toolsPerMin]).toEqual([0, 0, 0, 0, 0, 0])
    expect(s.perSec).toHaveLength(60)
    expect(s.perSec.every(v => v === 0)).toBe(true)
    expect(s).not.toHaveProperty('tokens')
  })

  it('tool_은_도구_호출을_1_올린다', () => {
    const st = createStats()
    st.apply(tool('Bash'))
    const s = st.snapshot()
    expect(s.tools).toBe(1)
    expect([s.added, s.removed, s.handoffs, s.files]).toEqual([0, 0, 0, 0])
  })

  it('result_의_added_removed_만_바꾼_줄에', () => {
    const st = createStats()
    st.apply(tool('Edit', 'a.ts'))
    st.apply(tool('Write', 'b.ts'))
    expect([st.snapshot().added, st.snapshot().removed]).toEqual([0, 0])
    st.apply(result(7, 2))
    st.apply(result(0, 0))
    st.apply(result(3, 5))
    const s = st.snapshot()
    expect([s.added, s.removed]).toEqual([10, 7])
    expect(s.tools).toBe(2) // 결과는 도구 호출이 아니다
  })

  it('handoff_는_넘긴_일을_1', () => {
    const st = createStats()
    st.apply({ kind: 'handoff', from: 'a', to: 'b', text: 'x', at: 0 })
    const s = st.snapshot()
    expect(s.handoffs).toBe(1)
    expect(s.tools).toBe(0)
  })

  it('say_·_done_은_숫자를_바꾸지_않는다', () => {
    const st = createStats()
    st.apply({ kind: 'say', agentId: 'a', text: '말', at: 0 })
    st.apply({ kind: 'done', agentId: 'a', at: 0 })
    expect(st.snapshot()).toEqual(createStats().snapshot())
  })

  it('같은_파일_Read_두_번은_files_1', () => {
    const st = createStats()
    st.apply(tool('Read', 'a.ts'))
    st.apply(tool('Read', 'a.ts'))
    expect(st.snapshot().files).toBe(1)
    st.apply(tool('Read', 'b.ts'))
    expect(st.snapshot().files).toBe(2)
    st.apply(tool('Read', '')) // 대상을 모르면 세지 않는다
    expect(st.snapshot().files).toBe(2)
  })

  it('second_60번_뒤_perSec_길이는_60', () => {
    const st = createStats()
    for (let i = 0; i < 75; i++) st.second()
    expect(st.snapshot().perSec).toHaveLength(60)
  })

  it('second_는_그_초의_도구_호출을_막대로_옮기고_분당은_지난_60초의_합', () => {
    const st = createStats()
    for (let i = 0; i < 3; i++) st.apply(tool('Bash'))
    st.second()
    const p = st.snapshot().perSec
    expect(p[p.length - 1]).toBe(3)
    expect(st.snapshot().toolsPerMin).toBe(3)
    st.apply(tool('Bash'))
    st.second()
    expect(st.snapshot().perSec.at(-1)).toBe(1)
    expect(st.snapshot().toolsPerMin).toBe(4)
    for (let i = 0; i < 59; i++) st.second()
    expect(st.snapshot().toolsPerMin).toBe(1) // 처음 초는 1분 밖으로 나갔다
  })
})
