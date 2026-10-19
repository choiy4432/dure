import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { AgentId } from './types';

export type ApproveResult = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string };

export interface McpHandlers {
  listAgents(agentId: AgentId): string | Promise<string>;
  sendMessage(agentId: AgentId, to: string, text: string): string | Promise<string>;
  approve(agentId: AgentId, args: { tool_name: string; input: unknown; tool_use_id?: string }): Promise<ApproveResult>;
}

export interface McpServerHandle { port: number; token: string; close(): Promise<void> }

const MAX_BODY = 1024 * 1024;

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

async function callTool(h: McpHandlers, agentId: AgentId, params: any): Promise<ReturnType<typeof textResult>> {
  const name = params?.name;
  const a = params?.arguments ?? {};
  const bad = () => textResult('잘못된 인자입니다', true);
  try {
    if (name === 'list_agents') return textResult(await h.listAgents(agentId));
    if (name === 'send_message') {
      if (typeof a.to !== 'string' || typeof a.text !== 'string') return bad();
      return textResult(await h.sendMessage(agentId, a.to, a.text));
    }
    if (name === 'approve') {
      if (typeof a.tool_name !== 'string') return bad();
      const args: { tool_name: string; input: unknown; tool_use_id?: string } = { tool_name: a.tool_name, input: a.input };
      if (typeof a.tool_use_id === 'string') args.tool_use_id = a.tool_use_id;
      return textResult(JSON.stringify(await h.approve(agentId, args)));
    }
    return textResult(`알 수 없는 도구: ${String(name)}`, true);
  } catch (e) {
    return textResult(e instanceof Error ? e.message : String(e), true);
  }
}

function handle(h: McpHandlers, token: string, req: IncomingMessage, res: ServerResponse): void {
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
      void callTool(h, agent, m.params).then((r) => { if (!res.writableEnded && !res.destroyed) reply(r); });
    } else {
      reply({});
    }
  });
}

export function startMcpServer(h: McpHandlers): Promise<McpServerHandle> {
  const token = randomBytes(24).toString('hex');
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => handle(h, token, req, res));
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
