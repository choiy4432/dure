import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ClaudeSession, STDOUT_LINE_MAX } from '../src/engine/claudeSession.js';
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
    allowBypass: false,
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

test('쉬는 세션에 init 이 오면 working, 그 result 에 idle — 서브에이전트가 끝난 뒤 Claude 가 스스로 시작한 차례(probe13)', async () => {
  const s = make({ FAKE_SUB_MS: '50' });
  const seen: SessionStatus[] = [];
  s.on('status', (x) => seen.push(x));
  s.start();
  const launched = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  s.send(text('SUB 조사'));
  expect((await launched).text).toBe('LAUNCHED');
  expect(s.status).toBe('idle');
  const statusAtInit: SessionStatus[] = [];
  s.on('event', (e) => e.kind === 'init' && statusAtInit.push(s.status));
  const relayed = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  expect((await relayed).text).toBe('전달: 보고: 조사');
  expect(statusAtInit).toEqual(['working']); // 보낸 줄 없이 온 init
  expect(s.status).toBe('idle');
  expect(seen).toEqual(['working', 'idle', 'working', 'idle']);
});

test('send(quiet) 로 시작한 차례는 init 이 와도 상태를 바꾸지 않는다 — 그 result 뒤의 init 은 다시 working', async () => {
  const s = make({ FAKE_SUB_MS: '50' });
  const seen: SessionStatus[] = [];
  s.on('status', (x) => seen.push(x));
  s.start();
  const inits: unknown[] = [];
  s.on('event', (e) => e.kind === 'init' && inits.push(e));
  let done = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  s.send(text('/effort max'), { quiet: true });
  await done;
  expect(inits).toHaveLength(1);
  expect(seen).toEqual([]);
  expect(s.status).toBe('idle');
  // 조용한 차례가 끝났다 — 스스로 시작한 차례의 init 은 다시 작업 중으로
  done = waitFor<any>(s, 'event', (e) => e.kind === 'result' && e.text === '전달: 보고: 조사');
  s.send(text('SUB 조사'));
  await done;
  expect(seen).toEqual(['working', 'idle', 'working', 'idle']);
});

test('interrupt: 뒤에서 도는 서브에이전트는 멈춤(stopped) 끝 알림 — 스스로 시작한 차례는 오지 않고 세션은 쉰다(probe14 C)', async () => {
  const s = make({ FAKE_SUB_GATE: path.join(dir, 'gate') }); // 문을 만들지 않는다 — 서브에이전트는 일을 시작하지 못한다
  s.start();
  const events: any[] = [];
  s.on('event', (e) => events.push(e));
  const launched = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  s.send(text('SUB 조사'));
  await launched;
  const started = events.find((e) => e.kind === 'task-started');
  expect(started).toMatchObject({ description: '조사', subagentType: 'general-purpose', parentTaskId: null });
  const stopped = waitFor<any>(s, 'event', (e) => e.kind === 'task-ended');
  await s.interrupt();
  expect(await stopped).toMatchObject({ taskId: started.taskId, toolUseId: started.toolUseId, status: 'stopped' });
  await new Promise((r) => setTimeout(r, 300));
  expect(events.filter((e) => e.kind === 'init')).toHaveLength(1); // SUB 차례의 init 하나뿐
  expect(events.filter((e) => e.parent !== undefined)).toEqual([]); // 서브에이전트 줄도 없다
  expect(s.status).toBe('idle');
});

test('initialize 로 명령·모델 목록', async () => {
  const s = make();
  s.start();
  const p = await s.request({ subtype: 'initialize' });
  expect(p.commands[0].name).toBe('compact');
  expect(p.models.map((m: any) => m.value)).toEqual(['default', 'sonnet', 'haiku', 'claude-opus-4-8']);
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

// stdout 줄 읽기 — 띄우지 않은 세션에 조각을 바로 넣는다(파이프가 주는 64KB 조각처럼)
const CHUNK = 64 * 1024;
function reader() {
  const s = new ClaudeSession({ command: process.execPath, args: [], cwd: dir, env: {} });
  const events: any[] = [];
  s.on('event', (e) => events.push(e));
  return { feed: (chunk: string) => (s as any).onStdout(chunk), events };
}
const resultLine = (t: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: t });
const resultEvent = (t: string) => ({ kind: 'result', ok: true, subtype: 'success', text: t, denials: [] });

test('아주 긴 줄(20MiB PDF 의 되돌림 ~28MB)도 조각으로 받아 한 줄로 — 받은 조각만 훑는다(줄 길이에 비례)', () => {
  const { feed, events } = reader();
  // probe29 P3: 되돌림엔 보낸 문서 블록이 data 째 실려 온다. 한글 글이 섞여 두 바이트 글이 되는 꼴
  const data = 'QUJD'.repeat(Math.ceil((20 * 1024 * 1024) / 3)); // 20MiB 의 base64(4 글자 = 3 바이트) — 27,962,028 글자
  const human = '읽어 줘';
  const lines = '\n\n첨부 파일:\n- C:\\data\\attachments\\x\\20261104-090507-큰.pdf';
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  const replay = JSON.stringify({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text: human }, doc, { type: 'text', text: lines }] } });
  expect(replay.length).toBeGreaterThan(27_962_028);
  const all = `${replay}\r\n${resultLine('끝')}\n`;
  const t = performance.now();
  for (let i = 0; i < all.length; i += CHUNK) feed(all.slice(i, i + CHUNK));
  const ms = performance.now() - t;
  expect(events).toEqual([{ kind: 'replay', text: `${human}\n${lines}` }, resultEvent('끝')]);
  // 조각마다 모은 줄 전체를 다시 훑고 이어 붙이면(옛 꼴) 이 PC 에서 2초 넘게 main 이 멈췄다 — 지금은 수십 ms
  expect(ms).toBeLessThan(1000);
});

test('STDOUT_LINE_MAX(글자 수)까지의 줄은 읽고, 넘는 줄은 줄바꿈까지 버린 뒤 다음 줄을 읽는다 — V8 글 상한에 닿아 main 이 죽지 않게', () => {
  // 두레가 보내는 가장 큰 되돌림(문서 블록 합 10MiB → base64 ~14M 글자)·20MiB PDF(~28M)보다 넉넉하고 V8 글 상한(536,870,888)보다 한참 아래
  expect(STDOUT_LINE_MAX).toBe(64 * 1024 * 1024);
  const { feed, events } = reader();
  const blank = ' '.repeat(CHUNK); // 같은 조각을 되풀이해 넣는다(시험 메모리를 아끼려고) — JSON 뒤 공백은 그대로 읽힌다
  /** head 로 시작하고 공백으로 total 글자를 채운 한 줄 */
  const line = (head: string, total: number) => {
    feed(head);
    let n = head.length;
    while (n + CHUNK <= total) {
      feed(blank);
      n += CHUNK;
    }
    feed(`${' '.repeat(total - n)}\n`);
  };
  line(resultLine('딱 상한'), STDOUT_LINE_MAX);
  line(resultLine('하나 넘침'), STDOUT_LINE_MAX + 1);
  feed(`${resultLine('다음')}\n`);
  expect(events).toEqual([resultEvent('딱 상한'), resultEvent('다음')]);
});

test('request: 프로세스가 종료되면 대기 중 요청은 reject', async () => {
  const s = make({ FAKE_NO_CONTROL_REPLY: '1' });
  s.start();
  const p = s.request({ subtype: 'initialize' }, 5000);
  const assertion = expect(p).rejects.toThrow('프로세스가 종료되었습니다');
  s.send(text('CRASH'));
  await assertion;
});

test('request: 시간 초과면 reject', async () => {
  const s = make({ FAKE_NO_CONTROL_REPLY: '1' });
  s.start();
  await expect(s.request({ subtype: 'initialize' }, 50)).rejects.toThrow('요청 시간이 초과되었습니다');
});

test('request: ok 가 아닌 응답이면 reject', async () => {
  const s = make();
  s.start();
  await expect(s.request({ subtype: 'bogus' } as any)).rejects.toThrow('요청이 거부되었습니다');
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
  const blocks: any[] = [];
  s.on('event', (e) => e.kind === 'assistant' && blocks.push(...e.blocks));
  let done = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  s.send(text('SEND 두리: 안녕'));
  expect((await done).text).toBe('delivered');
  done = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  s.send(text('ASK Bash'));
  expect((await done).denials[0].toolName).toBe('Bash');
  const [sendBlock, askBlock] = blocks.filter((b) => b.type === 'tool_use');
  expect(sendBlock.name).toBe('mcp__dure__send_message');
  expect(askBlock.name).toBe('Bash');
  // 진짜(probe14 A)처럼 부르기마다 _meta 에 그 하는 일의 tool_use id
  const tc = calls.filter((c) => c.m.method === 'tools/call');
  expect(tc[0].m.params).toEqual({
    name: 'send_message',
    arguments: { to: '두리', text: '안녕' },
    _meta: { 'claudecode/toolUseId': sendBlock.id },
  });
  expect(tc[1].m.params).toEqual({
    name: 'approve',
    arguments: { tool_name: 'Bash', input: { x: 1 }, tool_use_id: askBlock.id },
    _meta: { 'claudecode/toolUseId': askBlock.id },
  });
  expect(tc[0].auth).toBe('Bearer tok');
  expect(tc[0].agent).toBe('a1');
  await s.stop();
  await new Promise((r) => srv.close(r));
});

test('interrupt: ASK 가 승인 응답을 기다리는 중 → result ok false → idle, 늦은 응답은 무시', async () => {
  const held: http.ServerResponse[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const m = JSON.parse(b);
      res.setHeader('content-type', 'application/json');
      if (m.method === 'tools/call') held.push(res);
      else res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify(buildMcpConfig({ port: (srv.address() as any).port, token: 't', agentId: 'a1' })),
  );
  const s = make();
  s.start();
  const results: any[] = [];
  s.on('event', (e) => e.kind === 'result' && results.push(e));
  const asked = waitFor(s, 'event', (e) => e.kind === 'assistant');
  s.send(text('ASK Bash'));
  await asked;
  while (held.length === 0) await new Promise((r) => setTimeout(r, 10));
  const res = waitFor<any>(s, 'event', (e) => e.kind === 'result');
  await s.interrupt();
  expect((await res).ok).toBe(false);
  expect(s.status).toBe('idle');
  held[0].end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"behavior":"allow"}' }] } }));
  await new Promise((r) => setTimeout(r, 100));
  expect(results).toHaveLength(1);
  await s.stop();
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

// ── 서버 방 손잡이 — 머리말·stderr 조각·띄우기 미루기 ──
/** stdin 을 그대로 파일에 받아 적는 가짜(입력이 끝나면 끝남) — 무엇을 어떤 차례로 썼는지 본다 */
const COPY_STDIN =
  "const fs=require('fs');const f=process.argv[1];fs.writeFileSync(f,'');process.stderr.write('DURE_PID='+process.pid+String.fromCharCode(10));" +
  "process.stdin.on('data',d=>fs.appendFileSync(f,d));process.stdin.on('end',()=>process.exit(0))";
function copier(o: { stdinPreamble?: string; onStderr?: (c: string) => void; startAfter?: Promise<unknown> } = {}) {
  const out = path.join(dir, 'stdin.txt');
  const s = new ClaudeSession({ command: process.execPath, args: ['-e', COPY_STDIN, out], cwd: dir, env: { ...process.env }, ...o });
  sessions.push(s);
  return { s, out };
}
const userLine = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });

test('stdinPreamble: 띄운 직후 맨 먼저 쓴다 — 그다음 보낸 줄', async () => {
  const { s, out } = copier({ stdinPreamble: 'QUFB\nQkJC\n' });
  s.start();
  s.send(text('하나'));
  await s.stop();
  const got = fs.readFileSync(out, 'utf8');
  expect(got.startsWith('QUFB\nQkJC\n')).toBe(true);
  expect(got.slice('QUFB\nQkJC\n'.length).trim()).toBe(userLine('하나'));
});

test('onStderr: stderr 조각을 받는 대로 넘긴다 — errorText(stderr 꼬리)는 그대로', async () => {
  const chunks: string[] = [];
  const { s } = copier({ onStderr: (c) => chunks.push(c) });
  s.start();
  await new Promise<void>((r) => {
    const t = setInterval(() => chunks.join('').includes('\n') && (clearInterval(t), r()), 10);
  });
  expect(chunks.join('')).toBe(`DURE_PID=${s.pid}\n`);
  await s.stop();

  const seen: string[] = [];
  const crash = new ClaudeSession({ ...(make() as any).opts, onStderr: (c: string) => seen.push(c) });
  sessions.push(crash);
  crash.start();
  const ex = waitFor<any>(crash, 'exit');
  crash.send(text('CRASH'));
  await ex;
  expect(seen.join('')).toContain('fake crash');
  expect(crash.errorText).toContain('fake crash');
});

test('startAfter: 끝날 때까지 띄우지 않고 쓴 줄을 모아 둔다 — 띄우면 머리말 → 모은 줄 → 그 뒤 줄 차례', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const { s, out } = copier({ stdinPreamble: 'PRE\n', startAfter: gate });
  const statuses: SessionStatus[] = [];
  s.on('status', (x) => statuses.push(x));
  s.start();
  expect(s.status).toBe('idle');
  s.send(text('하나')); // 띄우기 전이어도 받는다
  expect(s.status).toBe('working');
  await new Promise((r) => setTimeout(r, 50));
  expect(s.pid).toBeUndefined();
  expect(fs.existsSync(out)).toBe(false);
  open();
  await new Promise<void>((r) => {
    const t = setInterval(() => s.pid !== undefined && (clearInterval(t), r()), 10);
  });
  s.send(text('둘'));
  await s.stop();
  expect(fs.readFileSync(out, 'utf8')).toBe(`PRE\n${userLine('하나')}\n${userLine('둘')}\n`);
  expect(statuses.at(-1)).toBe('stopped');
});

test('startAfter: 끝나기 전에 stop — 띄우지 않고 바로 멈춤(exit expected), 대기 요청은 거절', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const { s, out } = copier({ startAfter: gate });
  s.start();
  const ex = waitFor<any>(s, 'exit');
  const req = s.request({ subtype: 'initialize' }, 5000);
  const rejected = expect(req).rejects.toThrow('프로세스가 종료되었습니다');
  await s.stop();
  expect(await ex).toMatchObject({ expected: true, code: null });
  await rejected;
  expect(s.status).toBe('stopped');
  expect(() => s.send(text('x'))).toThrow('세션이 실행 중이 아닙니다');
  open();
  await new Promise((r) => setTimeout(r, 150));
  expect(s.pid).toBeUndefined();
  expect(fs.existsSync(out)).toBe(false);
  await s.forceKill(10); // 띄우지 않은 세션 — 아무 일도 없다
});

test('startAfter: 제어 요청의 시간은 그 줄을 실제로 쓸 때부터 잰다 — 정리를 기다리는 동안은 재지 않는다', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const s = new ClaudeSession({ ...(make() as any).opts, startAfter: gate });
  sessions.push(s);
  s.start();
  const req = s.request({ subtype: 'initialize' }, 2000);
  await new Promise((r) => setTimeout(r, 2500)); // 요청 한도보다 오래 기다린 정리
  open();
  await expect(req).resolves.toBeTruthy();
}, 15000);
