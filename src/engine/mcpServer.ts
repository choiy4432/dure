import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { AgentId } from './types';

export type ApproveResult = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string };

export interface McpHandlers {
  /** toolUseId: 부른 하는 일의 tool_use id — tools/call 의 params._meta['claudecode/toolUseId'](probe14 A), 없으면 undefined */
  listAgents(agentId: AgentId, toolUseId?: string): string | Promise<string>;
  sendMessage(agentId: AgentId, to: string, text: string, toolUseId?: string): string | Promise<string>;
  /** signal: 부른 쪽(HTTP 연결)이 답을 받기 전에 끊기면 abort */
  approve(
    agentId: AgentId,
    args: { tool_name: string; input: unknown; tool_use_id?: string },
    signal: AbortSignal,
  ): Promise<ApproveResult>;
}

export interface McpServerHandle { port: number; token: string; close(): Promise<void> }

export interface McpServerOptions {
  /**
   * approve 를 기다리는 동안 SSE 주석을 보내는 간격. CLI 의 300초 무응답 제한은 주석을 진행으로 치지 않는다 —
   * 그 제한은 MCP 설정의 서버별 timeout 으로 푼다(claudeArgs DURE_SERVER_TIMEOUT_MS). 이 주석 줄은 사이 장비가
   * 조용한 연결을 끊지 않게 하는 덤일 뿐이다.
   */
  keepaliveMs?: number;
}

const MAX_BODY = 1024 * 1024;
const KEEPALIVE_MS = 30_000;
const HEADERS_TIMEOUT_MS = 60_000; // Node 기본값 — 머리글을 받는 시간만 제한(requestTimeout 0 과 함께 써도 된다)

const TOOLS = [
  { name: 'list_agents', description: '이 두레 방의 다른 에이전트 목록', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'send_message',
    description: '이 두레 방의 다른 에이전트에게 일을 넘긴다(to = 에이전트 이름)',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] },
  },
  {
    name: 'approve',
    description: '권한 확인용 — 두레 앱이 사람에게 묻는다',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: ['tool_name', 'input'] },
  },
];

function send(res: ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}): void {
  if (body === undefined) { res.writeHead(status, extra); res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}

const textResult = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function callTool(h: McpHandlers, agentId: AgentId, params: any, signal: AbortSignal): Promise<ReturnType<typeof textResult>> {
  const name = params?.name;
  const a = params?.arguments ?? {};
  const meta = params?._meta;
  const metaId = meta && typeof meta === 'object' ? meta['claudecode/toolUseId'] : undefined;
  const toolUseId = typeof metaId === 'string' ? metaId : undefined; // 부른 하는 일 — 서브에이전트인지 엔진이 가른다
  const bad = () => textResult('잘못된 인자입니다', true);
  try {
    if (name === 'list_agents') return textResult(await h.listAgents(agentId, toolUseId));
    if (name === 'send_message') {
      if (typeof a.to !== 'string' || typeof a.text !== 'string') return bad();
      return textResult(await h.sendMessage(agentId, a.to, a.text, toolUseId));
    }
    if (name === 'approve') {
      if (typeof a.tool_name !== 'string') return bad();
      const args: { tool_name: string; input: unknown; tool_use_id?: string } = { tool_name: a.tool_name, input: a.input };
      if (typeof a.tool_use_id === 'string') args.tool_use_id = a.tool_use_id;
      return textResult(JSON.stringify(await h.approve(agentId, args, signal)));
    }
    return textResult(`알 수 없는 도구: ${String(name)}`, true);
  } catch (e) {
    return textResult(e instanceof Error ? e.message : String(e), true);
  }
}

/**
 * tools/call — 부른 쪽이 답을 받기 전에 끊으면 signal 을 abort 한다.
 * approve 는 사람 답을 오래 기다릴 수 있어 SSE 로 답한다(오래 기다려도 안 끊기는 건 서버별 timeout 덕이다 —
 * 위 McpServerOptions 참고): 머리글을 곧바로 보내고 keepaliveMs 마다 주석 줄,
 * 답이 오면 `event: message` + `data: <JSON-RPC>` 한 번 보내고 끝낸다. 다른 도구는 application/json 그대로.
 */
function toolCall(h: McpHandlers, agentId: AgentId, m: any, res: ServerResponse, keepaliveMs: number): void {
  const aborter = new AbortController();
  let keepalive: NodeJS.Timeout | undefined;
  res.on('close', () => {
    clearInterval(keepalive);
    if (!res.writableEnded) aborter.abort();
  });
  const stream = m.params?.name === 'approve';
  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    keepalive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
    }, keepaliveMs);
  }
  void callTool(h, agentId, m.params, aborter.signal).then((result) => {
    clearInterval(keepalive);
    if (res.writableEnded || res.destroyed) return;
    const body = { jsonrpc: '2.0', id: m.id, result };
    if (stream) res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    else send(res, 200, body);
  });
}

function handle(h: McpHandlers, token: string, keepaliveMs: number, req: IncomingMessage, res: ServerResponse): void {
  if (req.headers.authorization !== `Bearer ${token}`) { send(res, 401); req.resume(); return; }
  const agent = req.headers['x-dure-agent'];
  if (typeof agent !== 'string' || agent === '') { send(res, 400); req.resume(); return; }
  if (req.url !== '/mcp') { send(res, 404); req.resume(); return; }
  if (req.method !== 'POST') { send(res, 405, undefined, { allow: 'POST' }); req.resume(); return; }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (d: Buffer) => {
    if (tooBig) return;
    size += d.length;
    if (size > MAX_BODY) {
      tooBig = true;
      chunks.length = 0;
      send(res, 413, undefined, { connection: 'close' });
      return;
    }
    chunks.push(d);
  });
  req.on('end', () => {
    if (tooBig) return;
    let m: any;
    try { m = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(res, 400); return; }
    if (m === null || typeof m !== 'object') { send(res, 400); return; }
    if (m.id === undefined) { send(res, 202); return; }
    const reply = (result: unknown) => send(res, 200, { jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') {
      reply({ protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dure', version: '0.1.0' } });
    } else if (m.method === 'tools/list') {
      reply({ tools: TOOLS });
    } else if (m.method === 'tools/call') {
      toolCall(h, agent, m, res, keepaliveMs);
    } else {
      reply({});
    }
  });
}

export function startMcpServer(h: McpHandlers, o: McpServerOptions = {}): Promise<McpServerHandle> {
  const token = randomBytes(24).toString('hex');
  const keepaliveMs = o.keepaliveMs ?? KEEPALIVE_MS;
  const sockets = new Set<Socket>();
  // 사람 답을 기다리는 approve 가 서버 쪽 시간 제한에 끊기지 않게 requestTimeout 은 끈다(keepAliveTimeout 은 기본값)
  const server = createServer({ requestTimeout: 0, headersTimeout: HEADERS_TIMEOUT_MS }, (req, res) =>
    handle(h, token, keepaliveMs, req, res),
  );
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') { reject(new Error('주소를 얻지 못했습니다')); return; }
      resolve({
        port: addr.port,
        token,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          for (const s of sockets) s.destroy();
        }),
      });
    });
  });
}
