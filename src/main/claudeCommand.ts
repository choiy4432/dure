export interface ClaudeCommand {
  command: string
  argsPrefix: string[]
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
  if (override) {
    let argsPrefix: string[] = []
    const raw = env.DURE_CLAUDE_ARGS
    if (raw !== undefined && raw !== '') {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('DURE_CLAUDE_ARGS 는 JSON 배열이어야 해요')
      }
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
        throw new Error('DURE_CLAUDE_ARGS 는 JSON 배열이어야 해요')
      }
      argsPrefix = parsed
    }
    return { command: override, argsPrefix }
  }
  const found = locate()
  return found ? { command: found, argsPrefix: [] } : null
}
