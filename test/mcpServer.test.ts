import { afterEach, describe, expect, test } from 'vitest';
import { startMcpServer, type McpHandlers, type McpServerHandle } from '../src/engine/mcpServer';

let handle: McpServerHandle | undefined;
afterEach(async () => { await handle?.close(); handle = undefined; });

function handlers(over: Partial<McpHandlers> = {}): McpHandlers {
  return {
    listAgents: () => '[]',
    sendMessage: () => 'ok',
    approve: async () => ({ behavior: 'allow', updatedInput: {} }),
    ...over,
  };
}

async function rpc(h: McpServerHandle, msg: unknown, opts: { token?: string | null; agent?: string | null; method?: string; raw?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token === undefined ? h.token : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const agent = opts.agent === undefined ? 'agent-A' : opts.agent;
  if (agent !== null) headers['x-dure-agent'] = agent;
  const method = opts.method ?? 'POST';
  return fetch(`http://127.0.0.1:${h.port}/mcp`, { method, headers, body: method === 'GET' ? undefined : (opts.raw ?? JSON.stringify(msg)) });
}
const call = (id: number, name: string, args: unknown) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('mcpServer', () => {
  test('토큰 없거나 틀리면 401', async () => {
    handle = await startMcpServer(handlers());
    expect((await rpc(handle, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null })).status).toBe(401);
    expect((await rpc(handle, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'wrong' })).status).toBe(401);
    expect((await rpc(handle, {}, { token: null, method: 'GET' })).status).toBe(401);
  });

  test('X-Dure-Agent 없으면 400', async () => {
    handle = await startMcpServer(handlers());
    expect((await rpc(handle, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { agent: null })).status).toBe(400);
  });

  test('initialize → protocolVersion 그대로 돌려줌, serverInfo.name dure', async () => {
    handle = await startMcpServer(handlers());
    const res = await rpc(handle, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const j = await res.json() as any;
    expect(j.id).toBe(1);
    expect(j.result.protocolVersion).toBe('2025-06-18');
    expect(j.result.serverInfo).toEqual({ name: 'dure', version: '0.1.0' });
    expect(j.result.capabilities).toEqual({ tools: {} });
  });

  test('notifications/initialized → 202, GET → 405', async () => {
    handle = await startMcpServer(handlers());
    expect((await rpc(handle, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await rpc(handle, {}, { method: 'GET' })).status).toBe(405);
  });

  test('tools/list → 도구 셋', async () => {
    handle = await startMcpServer(handlers());
    const j = await (await rpc(handle, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as any;
    expect(j.result.tools.map((t: any) => t.name)).toEqual(['list_agents', 'send_message', 'approve']);
    const send = j.result.tools[1];
    expect(send.inputSchema.required).toEqual(['to', 'text']);
    expect(send.description).toBe('이 두레 방의 다른 에이전트에게 일을 넘긴다(to = 에이전트 이름)');
  });

  test('list_agents → handler 에 헤더 agentId', async () => {
    const seen: string[] = [];
    handle = await startMcpServer(handlers({ listAgents: (id) => { seen.push(id); return '[{"name":"B"}]'; } }));
    const j = await (await rpc(handle, call(3, 'list_agents', {}))).json() as any;
    expect(seen).toEqual(['agent-A']);
    expect(j.result.content[0].text).toBe('[{"name":"B"}]');
  });

  test('send_message → handler 에 (헤더 agentId, to, text), 결과 text', async () => {
    const seen: unknown[] = [];
    handle = await startMcpServer(handlers({ sendMessage: async (a, to, text) => { seen.push([a, to, text]); return `queued ${to}`; } }));
    const j = await (await rpc(handle, call(4, 'send_message', { to: 'B', text: '파란 버튼' }))).json() as any;
    expect(seen).toEqual([['agent-A', 'B', '파란 버튼']]);
    expect(j.result.content).toEqual([{ type: 'text', text: 'queued B' }]);
    expect(j.result.isError).toBeUndefined();
  });

  test('approve → handler 결과를 JSON 문자열 text 로', async () => {
    const seen: unknown[] = [];
    handle = await startMcpServer(handlers({ approve: async (a, args) => { seen.push([a, args]); return { behavior: 'allow', updatedInput: { x: 1 } }; } }));
    const j = await (await rpc(handle, call(5, 'approve', { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' }))).json() as any;
    expect(JSON.parse(j.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { x: 1 } });
    expect(seen).toEqual([['agent-A', { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' }]]);
  });

  test('handler 가 throw → result.isError true, text = 에러 메시지', async () => {
    handle = await startMcpServer(handlers({ sendMessage: () => { throw new Error('그런 에이전트 없음'); } }));
    const res = await rpc(handle, call(6, 'send_message', { to: 'Z', text: 'hi' }));
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0].text).toBe('그런 에이전트 없음');
  });

  test('모르는 도구·잘못된 인자 → isError 한국어 메시지', async () => {
    handle = await startMcpServer(handlers());
    const a = await (await rpc(handle, call(7, 'nope', {}))).json() as any;
    expect(a.result.isError).toBe(true);
    expect(a.result.content[0].text).toBe('알 수 없는 도구: nope');
    const b = await (await rpc(handle, call(8, 'send_message', { to: 'B' }))).json() as any;
    expect(b.result.isError).toBe(true);
    expect(b.result.content[0].text).toBe('잘못된 인자입니다');
    const c = await (await rpc(handle, call(9, 'approve', { input: {} }))).json() as any;
    expect(c.result.isError).toBe(true);
  });

  test('모르는 메서드(id 있음) → result {}', async () => {
    handle = await startMcpServer(handlers());
    const j = await (await rpc(handle, { jsonrpc: '2.0', id: 10, method: 'server/discover' })).json() as any;
    expect(j).toEqual({ jsonrpc: '2.0', id: 10, result: {} });
  });

  test('깨진 JSON 본문 → 400', async () => {
    handle = await startMcpServer(handlers());
    expect((await rpc(handle, null, { raw: '{not json' })).status).toBe(400);
  });

  test('본문 1MB 넘으면 413', async () => {
    handle = await startMcpServer(handlers());
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'a'.repeat(1024 * 1024 + 10) } });
    expect((await rpc(handle, null, { raw: big })).status).toBe(413);
  });

  test('approve 가 끝나지 않아도 close() 가 곧 끝난다', async () => {
    handle = await startMcpServer(handlers({ approve: () => new Promise(() => {}) }));
    const p = rpc(handle, call(11, 'approve', { tool_name: 'Bash', input: {} })).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await handle.close();
    handle = undefined;
    expect(Date.now() - t0).toBeLessThan(2000);
    await p;
  });
});
