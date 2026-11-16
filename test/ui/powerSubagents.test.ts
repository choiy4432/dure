import { describe, it, expect } from 'vitest'
import { shownSubagents } from '../../src/renderer/power/subagents'

describe('보여 줄 서브에이전트 수', () => {
  it('진짜_수가_0보다_크면_그대로_아니면_4', () => {
    expect(shownSubagents({ subagents: 0 })).toBe(4)
    expect(shownSubagents({ subagents: 2 })).toBe(2)
  })
})
