import { describe, it, expect } from 'vitest'
import { resolveClaudeCommand } from '../src/main/claudeCommand'

describe('resolveClaudeCommand', () => {
  it('uses DURE_CLAUDE_COMMAND with JSON args', () => {
    const r = resolveClaudeCommand(
      { DURE_CLAUDE_COMMAND: 'node', DURE_CLAUDE_ARGS: '["fake.mjs","--x"]' },
      () => 'ignored',
    )
    expect(r).toEqual({ command: 'node', argsPrefix: ['fake.mjs', '--x'] })
  })
  it('defaults args to []', () => {
    expect(resolveClaudeCommand({ DURE_CLAUDE_COMMAND: 'node' }, () => null)).toEqual({
      command: 'node',
      argsPrefix: [],
    })
  })
  it('throws on broken or non-array JSON', () => {
    const msg = 'DURE_CLAUDE_ARGS 는 JSON 배열이어야 해요'
    expect(() => resolveClaudeCommand({ DURE_CLAUDE_COMMAND: 'n', DURE_CLAUDE_ARGS: '{oops' }, () => null)).toThrow(msg)
    expect(() => resolveClaudeCommand({ DURE_CLAUDE_COMMAND: 'n', DURE_CLAUDE_ARGS: '{"a":1}' }, () => null)).toThrow(msg)
  })
  it('falls back to locate', () => {
    expect(resolveClaudeCommand({}, () => 'C:/bin/claude.exe')).toEqual({ command: 'C:/bin/claude.exe', argsPrefix: [] })
  })
  it('returns null when nothing found', () => {
    expect(resolveClaudeCommand({}, () => null)).toBeNull()
  })
})
