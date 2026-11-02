import { join } from 'node:path'

export interface ClaudeCommand {
  command: string
  argsPrefix: string[]
}

/** 손잡이의 앞 인자 — 없거나 빈 글이면 [], 글 배열 JSON 이 아니면 던진다 */
function jsonArgs(raw: string | undefined, name: string): string[] {
  if (raw === undefined || raw === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${name} 는 JSON 배열이어야 해요`)
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
    throw new Error(`${name} 는 JSON 배열이어야 해요`)
  }
  return parsed
}

/**
 * DURE_CLAUDE_COMMAND (+ DURE_CLAUDE_ARGS as a JSON array) lets E2E and dev use a fake claude.
 * Otherwise falls back to the located real one; null when neither exists.
 */
export function resolveClaudeCommand(
  env: Record<string, string | undefined>,
  locate: () => string | null,
): ClaudeCommand | null {
  const override = env.DURE_CLAUDE_COMMAND
  if (override) return { command: override, argsPrefix: jsonArgs(env.DURE_CLAUDE_ARGS, 'DURE_CLAUDE_ARGS') }
  const found = locate()
  return found ? { command: found, argsPrefix: [] } : null
}

/**
 * 서버(SSH) 방의 ssh — DURE_SSH_COMMAND (+ DURE_SSH_ARGS, JSON 배열)로 E2E·개발은 가짜 ssh.
 * 아니면 윈도우 내장 OpenSSH(%SystemRoot%\System32\OpenSSH\ssh.exe) — 있는지는 엔진의 sshAvailable 이 본다
 */
export function resolveSshCommand(env: Record<string, string | undefined>): ClaudeCommand {
  const override = env.DURE_SSH_COMMAND
  if (override) return { command: override, argsPrefix: jsonArgs(env.DURE_SSH_ARGS, 'DURE_SSH_ARGS') }
  return { command: join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'), argsPrefix: [] }
}
