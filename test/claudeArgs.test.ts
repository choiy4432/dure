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
    // 보낸 말을 Claude 가 읽은 순간 되돌려 받는다 — 일하는 중에 보낸 말이 언제 읽혔는지(probe17)
    expect(a).toContain('--replay-user-messages');
  });
  test('resume 이면 --resume S, 모델 있으면 --model', () => {
    const a = buildArgs({ ...base, resume: true, model: 'opus' });
    expect(after(a, '--resume')).toEqual(['S']);
    expect(a).not.toContain('--session-id');
    expect(after(a, '--model')).toEqual(['opus']);
  });
  test('forkOf 면 그 자리에 --resume OLD --fork-session --session-id NEW(probe22) — --resume NEW 없음 · forkOf null 이면 지금 그대로', () => {
    const a = buildArgs({ ...base, sessionId: 'NEW', forkOf: 'OLD' });
    const i = a.indexOf('--resume');
    expect(a.slice(i, i + 5)).toEqual(['--resume', 'OLD', '--fork-session', '--session-id', 'NEW']);
    expect(a.filter((x) => x === '--resume')).toHaveLength(1);
    expect(a.filter((x) => x === '--session-id')).toHaveLength(1);
    expect(a[i - 1]).toBe('--replay-user-messages'); // 지금의 --resume/--session-id 자리
    expect(a[i + 5]).toBe('--mcp-config');
    expect(after(a, '--disallowedTools')).toEqual(['SendMessage', 'ListAgents']);
    expect(buildArgs({ ...base, forkOf: null })).toEqual(buildArgs(base));
    expect(buildArgs({ ...base, resume: true, forkOf: null })).toEqual(buildArgs({ ...base, resume: true }));
    expect(buildArgs(base)).not.toContain('--fork-session');
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
  test('addDirs → --add-dir', () => {
    const dirs = ['C:\\Users\\x\\AppData\\Roaming\\Dure\\attachments\\a 1', '/home/a/.dure/attachments/a1'];
    const a = buildArgs({ ...base, addDirs: dirs });
    // 폴더마다 --add-dir 한 쌍 — 공백 있는 경로도 한 항목, 값 바로 뒤는 플래그(가변 인자가 다음 값을 삼키지 않게)
    const at = a.flatMap((x, i) => (x === '--add-dir' ? [i] : []));
    expect(at.map((i) => a[i + 1])).toEqual(dirs);
    for (const i of at) expect(a[i + 2].startsWith('-')).toBe(true);
    // 나머지는 그대로 · 없거나 비면 --add-dir 없음
    const rest = a.filter((_, i) => !at.some((j) => i === j || i === j + 1));
    expect(rest).toEqual(buildArgs(base));
    expect(buildArgs(base)).not.toContain('--add-dir');
    expect(buildArgs({ ...base, addDirs: [] })).toEqual(buildArgs(base));
  });
  test('공백·한글 이름도 argv 한 항목', () => {
    const a = buildArgs({ ...base, name: '월드 담당' });
    expect(a[a.indexOf('-n') + 1]).toBe('월드 담당');
  });
  test('상수', () => {
    expect(BLOCKED_TOOLS).toEqual(['SendMessage', 'ListAgents']);
    // 두레 도구는 Claude 자체 승인 없이 — create_agent 의 승인은 두레 카드가 한다
    expect(DURE_TOOLS).toEqual(['mcp__dure__list_agents', 'mcp__dure__send_message', 'mcp__dure__create_agent']);
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
