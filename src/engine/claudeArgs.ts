export const APPROVE_TOOL = 'mcp__dure__approve';
export const DURE_TOOLS = ['mcp__dure__list_agents', 'mcp__dure__send_message'];
export const BLOCKED_TOOLS = ['SendMessage', 'ListAgents'];
export const SPAWN_ENV_EXTRA = { MCP_TOOL_TIMEOUT: '86400000' };

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

export function buildMcpConfig(a: { port: number; token: string; agentId: string }): object {
  return {
    mcpServers: {
      dure: {
        type: 'http',
        url: `http://127.0.0.1:${a.port}/mcp`,
        headers: { Authorization: `Bearer ${a.token}`, 'X-Dure-Agent': a.agentId },
      },
    },
  };
}
