import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { resolveClaudeCommand, resolveSshCommand } from '../src/main/claudeCommand'

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

describe('resolveSshCommand', () => {
  it('uses DURE_SSH_COMMAND with JSON args', () => {
    const r = resolveSshCommand({ DURE_SSH_COMMAND: 'node', DURE_SSH_ARGS: '["fakeSsh.mjs"]', SystemRoot: 'D:\\Win' })
    expect(r).toEqual({ command: 'node', argsPrefix: ['fakeSsh.mjs'] })
  })
  it('defaults args to []', () => {
    expect(resolveSshCommand({ DURE_SSH_COMMAND: 'node' })).toEqual({ command: 'node', argsPrefix: [] })
  })
  it('throws on broken or non-array JSON', () => {
    const msg = 'DURE_SSH_ARGS 는 JSON 배열이어야 해요'
    expect(() => resolveSshCommand({ DURE_SSH_COMMAND: 'n', DURE_SSH_ARGS: '{oops' })).toThrow(msg)
    expect(() => resolveSshCommand({ DURE_SSH_COMMAND: 'n', DURE_SSH_ARGS: '[1]' })).toThrow(msg)
  })
  // platform 을 밝혀 넘긴다 — 기본값(process.platform)은 mac 러너에선 darwin 길이라 Windows 기대값을 보지 못한다
  it('defaults to Windows OpenSSH under SystemRoot (C:\\Windows when unset)', () => {
    expect(resolveSshCommand({ SystemRoot: 'D:\\Win' }, 'win32')).toEqual({ command: join('D:\\Win', 'System32', 'OpenSSH', 'ssh.exe'), argsPrefix: [] })
    expect(resolveSshCommand({}, 'win32')).toEqual({ command: join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'), argsPrefix: [] })
  })
  it('darwin_/usr/bin/ssh — 절대 경로(Finder 로 켠 앱의 빈약한 PATH 와 상관없이) · SystemRoot 는 보지 않는다', () => {
    expect(resolveSshCommand({}, 'darwin')).toEqual({ command: '/usr/bin/ssh', argsPrefix: [] })
    expect(resolveSshCommand({ SystemRoot: 'D:\\Win' }, 'darwin')).toEqual({ command: '/usr/bin/ssh', argsPrefix: [] })
  })
  it('DURE_SSH_COMMAND 손잡이는 운영체제와 상관없이 그대로', () => {
    for (const p of ['win32', 'darwin'] as const) {
      expect(resolveSshCommand({ DURE_SSH_COMMAND: 'node', DURE_SSH_ARGS: '["fakeSsh.mjs"]' }, p)).toEqual({ command: 'node', argsPrefix: ['fakeSsh.mjs'] })
    }
  })
})
