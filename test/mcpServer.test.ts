import { afterEach, describe, expect, test } from 'vitest';
import { startMcpServer, type McpHandlers, type McpServerHandle } from '../src/engine/mcpServer';

let handle: McpServerHandle | undefined;
afterEach(async () => { await handle?.close(); handle = undefined; });

function handlers(over: Partial<McpHandlers> = {}): McpHandlers {
  return {
    listAgents: () => '[]',
    sendMessage: () => 'ok',
    approve: async () => ({ behavior: 'allow', updatedInput: {} }),
    createAgent: async () => 'made',
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

/** SSE 응답 본문 → data 줄의 JSON-RPC (주석 ': …'·'event:' 줄은 버린다) */
function sseData(body: string): any {
  const data = body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice('data: '.length));
  expect(data).toHaveLength(1);
  return JSON.parse(data[0]);
}
/** approve 는 SSE 로 온다 */
async function approveReply(res: Response): Promise<any> {
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  return sseData(await res.text());
}

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
    expect(j.result.tools.map((t: any) => t.name)).toEqual(['list_agents', 'send_message', 'create_agent', 'approve']);
    const send = j.result.tools[1];
    expect(send.inputSchema.required).toEqual(['to', 'text']);
    expect(send.description).toBe('이 두레 방의 다른 에이전트에게 일을 넘긴다(to = 에이전트 이름)');
    const create = j.result.tools[2];
    expect(create.inputSchema.required).toEqual(['name', 'role']);
    expect(Object.keys(create.inputSchema.properties)).toEqual(['name', 'role', 'folder', 'task']);
    for (const p of Object.values(create.inputSchema.properties) as any[]) expect(p.type).toBe('string');
  });

  test('create_agent → SSE 로 handler 결과 text · handler 에 (헤더 agentId, 인자, _meta toolUseId, signal) — 없는 folder·task 는 넘기지 않는다', async () => {
    const seen: unknown[] = [];
    handle = await startMcpServer(handlers({
      createAgent: async (a, args, toolUseId, signal) => {
        seen.push([a, args, toolUseId, signal instanceof AbortSignal]);
        return `만듦 ${args.name}`;
      },
    }));
    const full = { name: '테스트', role: '검사', folder: 'sub', task: 'README 정리' };
    const j = await approveReply(await rpc(handle, {
      jsonrpc: '2.0', id: 30, method: 'tools/call',
      params: { name: 'create_agent', arguments: full, _meta: { 'claudecode/toolUseId': 'toolu_make' } },
    }));
    expect(j.id).toBe(30);
    expect(j.result).toEqual({ content: [{ type: 'text', text: '만듦 테스트' }] });
    const k = await approveReply(await rpc(handle, call(31, 'create_agent', { name: '둘', role: '역할' })));
    expect(k.result.content[0].text).toBe('만듦 둘');
    expect(seen).toEqual([
      ['agent-A', full, 'toolu_make', true],
      ['agent-A', { name: '둘', role: '역할' }, undefined, true],
    ]);
  });

  test('create_agent — 잘못된 인자(이름·역할이 글이 아님 · folder·task 가 글이 아님)는 handler 없이 isError · handler 가 던지면 그 글로 isError', async () => {
    const seen: unknown[] = [];
    handle = await startMcpServer(handlers({
      createAgent: async (_a, args) => {
        seen.push(args);
        throw new Error('이름을 입력하세요');
      },
    }));
    for (const [i, args] of [{ role: 'r' }, { name: 'n' }, { name: 'n', role: 'r', folder: 3 }, { name: 'n', role: 'r', task: {} }].entries()) {
      const j = await approveReply(await rpc(handle, call(40 + i, 'create_agent', args)));
      expect(j.result).toEqual({ content: [{ type: 'text', text: '잘못된 인자입니다' }], isError: true });
    }
    expect(seen).toEqual([]);
    const j = await approveReply(await rpc(handle, call(45, 'create_agent', { name: '', role: 'r' })));
    expect(j.result).toEqual({ content: [{ type: 'text', text: '이름을 입력하세요' }], isError: true });
  });

  test('create_agent 를 부른 쪽이 끊으면 handler 의 signal 이 abort 된다 — 사람 답을 기다리는 카드가 남지 않게', async () => {
    let signal: AbortSignal | undefined;
    let done!: () => void;
    const aborted = new Promise<void>((r) => { done = r; });
    handle = await startMcpServer(handlers({
      createAgent: (_a, _args, _id, s) => {
        signal = s;
        return new Promise((_resolve, reject) => s.addEventListener('abort', () => { done(); reject(new Error('취소')); }));
      },
    }), { keepaliveMs: 20 });
    const client = new AbortController();
    const p = fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}`, 'x-dure-agent': 'agent-A' },
      body: JSON.stringify(call(46, 'create_agent', { name: 'n', role: 'r' })),
      signal: client.signal,
    }).then((r) => r.text()).catch(() => 'aborted');
    while (!signal) await new Promise((r) => setTimeout(r, 10));
    expect(signal.aborted).toBe(false);
    client.abort();
    await aborted;
    expect(signal.aborted).toBe(true);
    await p;
  });

  test('list_agents → handler 에 헤더 agentId', async () => {
    const seen: string[] = [];
    handle = await startMcpServer(handlers({ listAgents: (id) => { seen.push(id); return '[{"name":"B"}]'; } }));
    const res = await rpc(handle, call(3, 'list_agents', {}));
    expect(res.headers.get('content-type')).toContain('application/json'); // approve 말고는 SSE 아님
    const j = await res.json() as any;
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

  test('list_agents·send_message → _meta 의 claudecode/toolUseId 를 handler 에 — 없거나 문자열이 아니면 undefined', async () => {
    const lists: unknown[] = [];
    const sends: unknown[] = [];
    handle = await startMcpServer(handlers({
      listAgents: (id, toolUseId) => { lists.push([id, toolUseId]); return '[]'; },
      sendMessage: (a, to, text, toolUseId) => { sends.push([a, to, text, toolUseId]); return 'ok'; },
    }));
    const withMeta = (id: number, name: string, args: unknown, meta: unknown) => ({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: meta },
    });
    await rpc(handle, withMeta(20, 'list_agents', {}, { 'claudecode/toolUseId': 'toolu_sub', progressToken: 3 }));
    await rpc(handle, call(21, 'list_agents', {}));
    await rpc(handle, withMeta(22, 'send_message', { to: 'B', text: '안녕' }, { 'claudecode/toolUseId': 'toolu_sub2' }));
    await rpc(handle, withMeta(23, 'send_message', { to: 'B', text: '또' }, { 'claudecode/toolUseId': 42 }));
    await rpc(handle, withMeta(24, 'send_message', { to: 'B', text: '셋' }, 'not-an-object'));
    expect(lists).toEqual([['agent-A', 'toolu_sub'], ['agent-A', undefined]]);
    expect(sends).toEqual([
      ['agent-A', 'B', '안녕', 'toolu_sub2'],
      ['agent-A', 'B', '또', undefined],
      ['agent-A', 'B', '셋', undefined],
    ]);
  });

  test('approve → handler 결과를 JSON 문자열 text 로 (SSE event: message)', async () => {
    const seen: unknown[] = [];
    handle = await startMcpServer(handlers({ approve: async (a, args) => { seen.push([a, args]); return { behavior: 'allow', updatedInput: { x: 1 } }; } }));
    const res = await rpc(handle, call(5, 'approve', { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const body = await res.text();
    expect(body.endsWith('\n\n')).toBe(true);
    expect(body).toContain('event: message\ndata: ');
    const j = sseData(body);
    expect(j.id).toBe(5);
    expect(JSON.parse(j.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { x: 1 } });
    expect(seen).toEqual([['agent-A', { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' }]]);
  });

  test('approve 를 오래 기다리면 keepalive 주석을 보내다가 답을 data 줄로 보낸다', async () => {
    handle = await startMcpServer(
      handlers({ approve: () => new Promise((r) => setTimeout(() => r({ behavior: 'deny', message: '아니요' }), 100)) }),
      { keepaliveMs: 20 },
    );
    const res = await rpc(handle, call(12, 'approve', { tool_name: 'Bash', input: {} }));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    const lines = body.split('\n');
    const firstData = lines.findIndex((l) => l.startsWith('data: '));
    expect(lines.indexOf(': keepalive')).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(': keepalive')).toBeLessThan(firstData);
    expect(lines[firstData - 1]).toBe('event: message');
    expect(JSON.parse(sseData(body).result.content[0].text)).toEqual({ behavior: 'deny', message: '아니요' });
  });

  test('approve 를 부른 쪽이 끊으면 handler 의 signal 이 abort 된다 — 답을 보낸 뒤엔 abort 안 됨', async () => {
    let signal: AbortSignal | undefined;
    let done!: () => void;
    const aborted = new Promise<void>((r) => { done = r; });
    handle = await startMcpServer(handlers({
      approve: (_a, _args, s) => {
        signal = s;
        return new Promise((resolve) => s.addEventListener('abort', () => { done(); resolve({ behavior: 'deny', message: 'x' }); }));
      },
    }));
    const client = new AbortController();
    const p = fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}`, 'x-dure-agent': 'agent-A' },
      body: JSON.stringify(call(13, 'approve', { tool_name: 'Bash', input: {} })),
      signal: client.signal,
    }).then((r) => r.text()).catch(() => 'aborted');
    while (!signal) await new Promise((r) => setTimeout(r, 10));
    expect(signal.aborted).toBe(false);
    client.abort();
    await aborted;
    expect(signal.aborted).toBe(true);
    await p;

    // 정상으로 답한 요청의 signal 은 끝까지 abort 되지 않는다
    let kept: AbortSignal | undefined;
    await handle.close();
    handle = await startMcpServer(handlers({ approve: async (_a, _args, s) => { kept = s; return { behavior: 'allow', updatedInput: {} }; } }));
    await approveReply(await rpc(handle, call(14, 'approve', { tool_name: 'Bash', input: {} })));
    await new Promise((r) => setTimeout(r, 50));
    expect(kept!.aborted).toBe(false);
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
    const c = await approveReply(await rpc(handle, call(9, 'approve', { input: {} })));
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
