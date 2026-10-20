export const APPROVE_TOOL = 'mcp__dure__approve';
export const DURE_TOOLS = ['mcp__dure__list_agents', 'mcp__dure__send_message'];
export const BLOCKED_TOOLS = ['SendMessage', 'ListAgents'];
export const SPAWN_ENV_EXTRA = { MCP_TOOL_TIMEOUT: '86400000' };
// The CLI also aborts any MCP call that sends "no response or progress" for 300 s — separate
// from MCP_TOOL_TIMEOUT, and SSE comment lines don't count as progress. A per-server "timeout"
// lifts it for the dure server only, so a human can take longer than 5 min to answer an
// approval card (scripts/probe/probe5.mjs, docs/findings).
export const DURE_SERVER_TIMEOUT_MS = 86_400_000;

export function buildArgs(a: {
  sessionId: string;
  resume: boolean;
  mcpConfigPath: string;
  promptPath: string;
  model: string | null;
  name: string;
}): string[] {
  // --allowedTools / --disallowedTools are variadic: each must be followed by another flag.
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages',
    a.resume ? '--resume' : '--session-id', a.sessionId,
    '--mcp-config', a.mcpConfigPath,
    '--permission-prompts', 'host',
    '--permission-prompt-tool', APPROVE_TOOL,
    '--allowedTools', ...DURE_TOOLS,
    '--disallowedTools', ...BLOCKED_TOOLS,
    '--append-system-prompt-file', a.promptPath,
    ...(a.model ? ['--model', a.model] : []),
    '-n', a.name,
  ];
}

/**
 * 사용량만 묻고 바로 끄는 claude — 입력을 보내지 않는다(토큰을 쓰지 않음).
 * --strict-mcp-config 에 설정을 안 주면 MCP 서버를 하나도 띄우지 않는다 — 사용자의 MCP 서버를 깨우지 않게.
 */
export function buildUsageArgs(): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config',
    '--disallowedTools', ...BLOCKED_TOOLS,
  ];
}

export function buildMcpConfig(a: { port: number; token: string; agentId: string }): object {
  return {
    mcpServers: {
      dure: {
        type: 'http',
        url: `http://127.0.0.1:${a.port}/mcp`,
        headers: { Authorization: `Bearer ${a.token}`, 'X-Dure-Agent': a.agentId },
        timeout: DURE_SERVER_TIMEOUT_MS,
      },
    },
  };
}
