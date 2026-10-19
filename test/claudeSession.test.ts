import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ClaudeSession } from '../src/engine/claudeSession.js';
import { buildArgs, buildMcpConfig } from '../src/engine/claudeArgs.js';
import type { SessionStatus } from '../src/engine/types.js';

const FAKE = path.resolve('test/fakeClaude.mjs');
let dir: string;
let sessions: ClaudeSession[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-'));
  fs.writeFileSync(path.join(dir, 'mcp.json'), '{}');
  fs.writeFileSync(path.join(dir, 'prompt.md'), 'x');
});
afterEach(async () => {
  await Promise.all(sessions.map((s) => s.stop()));
  sessions = [];
  fs.rmSync(dir, { recursive: true, force: true });
});

function make(env: Record<string, string> = {}, cwd = dir): ClaudeSession {
  const args = buildArgs({
    sessionId: 'sess-1',
    resume: false,
    mcpConfigPath: path.join(dir, 'mcp.json'),
    promptPath: path.join(dir, 'prompt.md'),
    model: null,
    name: 'a',
  });
  const s = new ClaudeSession({ command: process.execPath, args: [FAKE, ...args], cwd, env: { ...process.env, ...env } });
  sessions.push(s);
  return s;
}
const waitFor = <T>(s: ClaudeSession, name: string, pred: (v: any) => boolean = () => true) =>
  new Promise<T>((resolve) => {
    const h = (v: any) => {
      if (pred(v)) {
        s.off(name, h);
        resolve(v);
      }
    };
    s.on(name, h);
  });
const text = (t: string) => [{ type: 'text' as const, text: t }];

test('여러 차례: send → working → result → idle, 두 번', async () => {
  const s = make();
  const seen: SessionStatus[] = [];
  s.on('status', (x) => seen.push(x));
  s.start();
  for (const t of ['echo 하나', 'echo 둘']) {
    const done = waitFor<any>(s, 'event', (e) => e.kind === 'result');
    s.send(text(t));
    expect((await done).text).toBe(`받음: ${t}`);
  }
  expect(seen).toEqual(['working', 'idle', 'working', 'idle']);
});

test('initialize 로 명령·모델 목록', async () => {
  const s = make();
  s.start();
  const p = await s.request({ subtype: 'initialize' });
  expect(p.commands[0].name).toBe('compact');
  expect(p.models.map((m: any) => m.value)).toEqual(['default', 'sonnet']);
  expect(p.current_permission_mode).toBe('default');
});

test('interrupt: SLOW 중 → result ok false → idle', async () => {
  const s = make();
  s.start();
  const started = waitFor(s, 'event', (e) => e.kind === 'init');
  s.send(text('SLOW'));
  await started;
  const res = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  await s.interrupt();
  expect((await res).ok).toBe(false);
  expect(s.status).toBe('idle');
});

test('CRASH: status error, exit expected false, errorText 있음', async () => {
  const s = make();
  s.start();
  const ex = waitFor<any>(s, 'exit');
  s.send(text('CRASH'));
  const e = await ex;
  expect(e.expected).toBe(false);
  expect(e.code).toBe(3);
  expect(s.status).toBe('error');
  expect(s.errorText).toContain('fake crash');
  expect(() => s.send(text('hi'))).toThrow('세션이 실행 중이 아닙니다');
});

test('폴더 없음 → spawn 안 함, status error, errorText 폴더를 찾을 수 없습니다', () => {
  const s = make({}, path.join(dir, 'nope'));
  s.start();
  expect(s.pid).toBeUndefined();
  expect(s.status).toBe('error');
  expect(s.errorText).toContain('폴더를 찾을 수 없습니다');
});

test('stop: stdin 닫고 exit expected true, status stopped', async () => {
  const s = make();
  s.start();
  const ex = waitFor<any>(s, 'exit');
  await s.stop();
  const e = await ex;
  expect(e.expected).toBe(true);
  expect(e.code).toBe(0);
  expect(s.status).toBe('stopped');
  expect(() => s.send(text('hi'))).toThrow('세션이 실행 중이 아닙니다');
});

test('stdout 이 줄 중간에서 잘려 와도 한 줄로 합쳐 읽는다', async () => {
  const s = make({ FAKE_SPLIT_WRITES: '1' });
  s.start();
  const done = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  s.send(text('echo 가나다'));
  expect((await done).text).toBe('받음: echo 가나다');
});

test('request: 프로세스가 종료되면 대기 중 요청은 reject', async () => {
  const s = make();
  s.start();
  const p = s.request({ subtype: 'initialize' }, 5000).then(
    () => 'ok',
    (e) => (e as Error).message,
  );
  s.send(text('CRASH'));
  const r = await p;
  // initialize 응답이 먼저 오거나, 종료로 reject 되거나 — 어느 쪽이든 대기 요청은 남지 않는다
  expect(['ok', '프로세스가 종료되었습니다']).toContain(r);
});

test('SEND/ASK: 가짜가 MCP 서버에 JSON-RPC 로 호출한다', async () => {
  const calls: any[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const m = JSON.parse(b);
      calls.push({ m, auth: req.headers.authorization, agent: req.headers['x-dure-agent'] });
      res.setHeader('content-type', 'application/json');
      if (m.method === 'tools/call') {
        const text = m.params.name === 'approve' ? JSON.stringify({ behavior: 'deny', message: 'no' }) : 'delivered';
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } }));
      } else res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify(buildMcpConfig({ port, token: 'tok', agentId: 'a1' })),
  );
  const s = make();
  s.start();
  let done = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  s.send(text('SEND 두리: 안녕'));
  expect((await done).text).toBe('delivered');
  done = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  s.send(text('ASK Bash'));
  expect((await done).denials[0].toolName).toBe('Bash');
  const tc = calls.filter((c) => c.m.method === 'tools/call');
  expect(tc[0].m.params).toEqual({ name: 'send_message', arguments: { to: '두리', text: '안녕' } });
  expect(tc[0].auth).toBe('Bearer tok');
  expect(tc[0].agent).toBe('a1');
  await s.stop();
  await new Promise((r) => srv.close(r));
});
