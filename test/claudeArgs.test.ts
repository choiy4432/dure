import { describe, expect, test } from 'vitest';
import { APPROVE_TOOL, DURE_TOOLS, BLOCKED_TOOLS, SPAWN_ENV_EXTRA, buildArgs, buildMcpConfig, buildUsageArgs } from '../src/engine/claudeArgs';

const base = { sessionId: 'S', resume: false, mcpConfigPath: 'M.json', promptPath: 'P.md', model: null, name: 'world', allowBypass: false };

function after(a: string[], flag: string): string[] {
  const i = a.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < a.length && !a[j].startsWith('-'); j++) out.push(a[j]);
  return out;
}

describe('buildArgs', () => {
  test('기본 인자', () => {
    const a = buildArgs(base);
    expect(a.slice(0, 7)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
    expect(after(a, '--session-id')).toEqual(['S']);
    expect(a).not.toContain('--resume');
    expect(after(a, '--mcp-config')).toEqual(['M.json']);
    expect(after(a, '--permission-prompts')).toEqual(['host']);
    expect(after(a, '--permission-prompt-tool')).toEqual([APPROVE_TOOL]);
    expect(after(a, '--allowedTools')).toEqual(DURE_TOOLS);
    expect(after(a, '--disallowedTools')).toEqual(['SendMessage', 'ListAgents']);
    expect(after(a, '--append-system-prompt-file')).toEqual(['P.md']);
    expect(after(a, '-n')).toEqual(['world']);
    expect(a).not.toContain('--model');
    expect(a).not.toContain('--bare');
    expect(a).not.toContain('--strict-mcp-config');
  });
  test('resume 이면 --resume S, 모델 있으면 --model', () => {
    const a = buildArgs({ ...base, resume: true, model: 'opus' });
    expect(after(a, '--resume')).toEqual(['S']);
    expect(a).not.toContain('--session-id');
    expect(after(a, '--model')).toEqual(['opus']);
  });
  test('가변 인자 플래그는 마지막이 아니고 바로 뒤에 플래그가 온다', () => {
    for (const a of [buildArgs(base), buildArgs({ ...base, resume: true, model: 'opus' }), buildArgs({ ...base, allowBypass: true })]) {
      for (const f of ['--allowedTools', '--disallowedTools']) {
        const i = a.indexOf(f);
        const end = i + 1 + after(a, f).length;
        expect(end).toBeLessThan(a.length);
        expect(a[end].startsWith('--')).toBe(true);
      }
    }
  });
  test('buildArgs: allowBypass true 면 --allow-dangerously-skip-permissions, false 면 없음 · --dangerously-skip-permissions 는 어느 쪽에도 없다', () => {
    const on = buildArgs({ ...base, allowBypass: true });
    const off = buildArgs(base);
    expect(on.filter((x) => x === '--allow-dangerously-skip-permissions')).toHaveLength(1);
    expect(off).not.toContain('--allow-dangerously-skip-permissions');
    for (const a of [on, off, buildArgs({ ...base, allowBypass: true, resume: true, model: 'opus' })]) {
      expect(a).not.toContain('--dangerously-skip-permissions');
      expect(a).not.toContain('--permission-mode'); // 묻지 않음은 띄운 뒤 set_permission_mode 로만 켠다
      expect(after(a, '--disallowedTools')).toEqual(['SendMessage', 'ListAgents']);
    }
    // 옵션 하나를 더해도 나머지는 그대로
    expect(on.filter((x) => x !== '--allow-dangerously-skip-permissions')).toEqual(off);
  });
  test('공백·한글 이름도 argv 한 항목', () => {
    const a = buildArgs({ ...base, name: '월드 담당' });
    expect(a[a.indexOf('-n') + 1]).toBe('월드 담당');
  });
  test('상수', () => {
    expect(BLOCKED_TOOLS).toEqual(['SendMessage', 'ListAgents']);
    expect(SPAWN_ENV_EXTRA).toEqual({ MCP_TOOL_TIMEOUT: '86400000' });
  });
});

describe('buildUsageArgs — usage 전용 claude', () => {
  test('정해진 인자 그대로 — MCP 서버 없이 띄우고 내장 넘김 도구는 막는다', () => {
    const a = buildUsageArgs();
    expect(a).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--disallowedTools', 'SendMessage', 'ListAgents',
    ]);
    expect(after(a, '--disallowedTools')).toEqual(['SendMessage', 'ListAgents']);
    for (const f of ['--mcp-config', '--bare', '--effort', '--session-id', '--resume', '-n']) expect(a).not.toContain(f);
  });
});

describe('buildMcpConfig', () => {
  test('MCP 설정 형식', () => {
    expect(buildMcpConfig({ port: 5, token: 'T', agentId: 'A' })).toEqual({ mcpServers: { dure: {
      type: 'http', url: 'http://127.0.0.1:5/mcp', headers: { Authorization: 'Bearer T', 'X-Dure-Agent': 'A' },
      timeout: 86400000 } } });
  });
  test('dure 서버는 무응답 시간 제한을 하루로 — CLI 기본 300초면 사람 승인 대기가 끊긴다', () => {
    const cfg = buildMcpConfig({ port: 5, token: 'T', agentId: 'A' }) as any;
    expect(cfg.mcpServers.dure.timeout).toBeGreaterThan(300_000);
  });
});
