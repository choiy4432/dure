import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine, type Agent, type AgentStatus, type Engine, type EngineOptions, type HistoryItem, type Hold, type PendingRequest, type RelayMessage, type StreamEvent, type UserPart } from '../src/engine';
import { openMessageLog } from '../src/engine/messageLog';
import { openStore } from '../src/engine/store';
import { DENY } from '../src/shared/denyTexts';

const FAKE = path.resolve('test/fakeClaude.mjs');
let dir: string;
let dataDir: string;
let logFile: string;
let engines: Engine[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-'));
  dataDir = path.join(dir, 'data');
  logFile = path.join(dir, 'fake.log');
});
afterEach(async () => {
  await Promise.all(engines.map((e) => e.shutdown()));
  engines = [];
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface AgentEvent {
  agentId: string;
  event: StreamEvent;
  viaApproval?: boolean;
}
interface StatusEvent {
  agentId: string;
  status: AgentStatus;
  errorText: string | null;
}

/** 사용량은 기본으로 끈다 — 사용량 전용 프로세스가 다른 테스트의 기록을 흐리지 않게(사용량 테스트만 켠다) */
async function start(
  env: Record<string, string> = {},
  usage: EngineOptions['usage'] = false,
  extra: Partial<EngineOptions> = {},
): Promise<Engine> {
  const e = await createEngine({
    dataDir,
    claude: { command: process.execPath, argsPrefix: [FAKE] },
    env: { FAKE_CLAUDE_LOG: logFile, ...env },
    usage,
    ...extra,
  });
  engines.push(e);
  return e;
}
function folder(name: string): string {
  const f = path.join(dir, name);
  fs.mkdirSync(f, { recursive: true });
  return f;
}
function setup(e: Engine) {
  const room = e.addRoom('방');
  const a = e.addAgent({ roomId: room.id, name: 'A', role: '기획', folder: folder('a') });
  const b = e.addAgent({ roomId: room.id, name: 'B', role: '웹 화면', folder: folder('b') });
  return { room, a, b };
}
function waitFor<T = any>(e: Engine, name: string, pred: (v: T) => boolean = () => true, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const h = (v: T) => {
      if (!pred(v)) return;
      clearTimeout(timer);
      e.off(name, h);
      resolve(v);
    };
    const timer = setTimeout(() => {
      e.off(name, h);
      reject(new Error(`기다린 이벤트가 오지 않음: ${name}`));
    }, ms);
    e.on(name, h);
  });
}
const resultOf = (e: Engine, agentId: string) =>
  waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === agentId && x.event.kind === 'result');
const resultText = async (p: Promise<AgentEvent>) => {
  const { event } = await p;
  return event.kind === 'result' ? event.text : '';
};
const text = (t: string): UserPart[] => [{ type: 'text', text: t }];
const agentOf = (e: Engine, id: string) => e.agents().find((x) => x.id === id)!;

/** 가짜 claude 기록: argv 줄 {argv,pid,mcpToolTimeout} + 각 프로세스가 받은 stdin 줄 */
function readLog(): any[] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
const spawns = (): { argv: string[]; pid: number; mcpToolTimeout: string | null }[] =>
  readLog().filter((x) => Array.isArray(x.argv));
const spawnsOf = (name: string) => spawns().filter((s) => s.argv[s.argv.indexOf('-n') + 1] === name);
const lastSpawnOf = (name: string) => spawnsOf(name).at(-1)!;
const flagValue = (argv: string[], f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const userTexts = (): string[] =>
  readLog()
    .filter((x) => x.type === 'user')
    .map((x) => x.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'));
const controlRequests = (subtype: string) =>
  readLog().filter((x) => x.type === 'control_request' && x.request?.subtype === subtype);
/**
 * 에이전트의 MCP 설정으로 approve 를 직접 부른다 — 지금 차례와 상관없는(끊기거나 남은) 호출 흉내. 답은 SSE data 줄.
 * toolUseId 를 주면 진짜처럼 인자 tool_use_id 와 _meta 에 싣는다(probe14 A)
 */
async function approveDirect(agentId: string, toolName: string, signal?: AbortSignal, toolUseId?: string): Promise<unknown> {
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'run', agentId, 'mcp.json'), 'utf8')).mcpServers.dure;
  const args = { tool_name: toolName, input: {}, ...(toolUseId ? { tool_use_id: toolUseId } : {}) };
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...cfg.headers },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'approve', arguments: args, ...(toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {}) },
    }),
    signal,
  });
  const data = (await res.text()).split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(JSON.parse(data!.slice('data: '.length)).result.content[0].text);
}
/** 두레 도구(list_agents·send_message)를 직접 부른다 — toolUseId 를 주면 _meta 에. 답은 JSON 결과의 글·오류 표시 */
async function toolDirect(agentId: string, name: string, args: unknown, toolUseId?: string): Promise<{ text: string; isError: boolean }> {
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'run', agentId, 'mcp.json'), 'utf8')).mcpServers.dure;
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...cfg.headers },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args, ...(toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {}) },
    }),
  });
  const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: result.content[0].text, isError: result.isError === true };
}
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('A 가 SEND 로 자동 켜진 B 에게 → B 가 [두레 메시지 — 보낸 쪽: A(기획)] 로 받고 idle', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(b.id, { auto: true });
  const flags: unknown[] = [];
  e.on('flags', (f) => flags.push(f));
  const aToolResult = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'tool-result');
  const aDone = resultOf(e, a.id);
  const bDone = resultOf(e, b.id);

  await e.sendUser(a.id, text('SEND B: 화면 만들어 줘'));

  expect(await resultText(aDone)).toBe('B 에게 전달했습니다.');
  expect((await aToolResult).viaApproval).toBe(false);
  const expected = '[두레 메시지 — 보낸 쪽: A(기획)]\n화면 만들어 줘';
  expect(await resultText(bDone)).toBe(`받음: ${expected}`);
  expect(userTexts()).toContain(expected); // B 의 stdin 에 그대로
  expect(e.status(b.id)).toBe('idle');
  expect(e.messages()).toMatchObject([{ from: a.id, to: b.id, text: '화면 만들어 줘', state: 'delivered' }]);
  expect(flags).toContainEqual({ agentId: a.id, bypass: false, bySettings: false, pending: false });
  expect(agentOf(e, a.id).started).toBe(true);
});

test('B 자동 꺼짐 → message pending 이벤트, approveMessage 하면 B 가 받음', async () => {
  const e = await start();
  const { a, b } = setup(e);
  const pending = waitFor<RelayMessage>(e, 'message', (m) => m.state === 'pending');
  const aDone = resultOf(e, a.id);

  await e.sendUser(a.id, text('SEND B: 확인해 줘'));

  const m = await pending;
  expect(m).toMatchObject({ from: a.id, to: b.id, text: '확인해 줘' });
  expect(await resultText(aDone)).toBe('B 에게 보냈습니다. 사람이 확인하면 전달됩니다.');
  expect(spawnsOf('B')).toHaveLength(0); // 확인 전엔 B 를 띄우지 않는다

  const delivered = waitFor<RelayMessage>(e, 'message', (x) => x.id === m.id && x.state === 'delivered');
  const bDone = resultOf(e, b.id);
  e.approveMessage(m.id);
  await delivered;
  expect(await resultText(bDone)).toBe('받음: [두레 메시지 — 보낸 쪽: A(기획)]\n확인해 줘');
  expect(e.status(b.id)).toBe('idle');
});

test('ASK Write → request 이벤트, status awaiting → answerRequest allow → idle, tool-result viaApproval true', async () => {
  const e = await start();
  const { a } = setup(e);
  const statuses: AgentStatus[] = [];
  e.on('status', (s: StatusEvent) => s.agentId === a.id && statuses.push(s.status));
  const req = waitFor<PendingRequest>(e, 'request');

  await e.sendUser(a.id, text('ASK Write'));

  const r = await req;
  expect(r).toMatchObject({ agentId: a.id, toolName: 'Write', kind: 'permission' });
  expect(e.status(a.id)).toBe('awaiting');
  expect(e.pendingRequests(a.id).map((x) => x.id)).toEqual([r.id]);

  const resolved = waitFor(e, 'request-resolved');
  const toolResult = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'tool-result');
  const done = resultOf(e, a.id);
  e.answerRequest(r.id, { type: 'allow' });

  expect(await resolved).toEqual({ id: r.id, agentId: a.id });
  const t = await toolResult;
  expect(t.viaApproval).toBe(true);
  expect(t.event.kind === 'tool-result' && t.event.isError).toBe(false);
  expect(await resultText(done)).toBe('ok');
  expect(e.status(a.id)).toBe('idle');
  expect(e.pendingRequests()).toEqual([]);
  expect(statuses).toEqual(['working', 'awaiting', 'working', 'idle']);
});

test('interrupt 중 승인 대기 → 그 요청 deny, request-resolved', async () => {
  const e = await start();
  const { a } = setup(e);
  const req = waitFor<PendingRequest>(e, 'request');
  await e.sendUser(a.id, text('ASK Bash'));
  const r = await req;

  const resolved = waitFor(e, 'request-resolved');
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);

  expect(await resolved).toEqual({ id: r.id, agentId: a.id });
  expect(e.pendingRequests()).toEqual([]);
  await done; // 차례가 끝난다(거절이 먼저 닿든 interrupt 가 먼저 닿든)
  expect(e.status(a.id)).toBe('idle');
  expect(() => e.answerRequest(r.id, { type: 'allow' })).toThrow('대기 중인 요청이 없습니다');
});

test('approve 를 부른 쪽이 끊기면 승인 카드는 사라지고 상태가 돌아온다 — 늦은 allow-always 는 무시', async () => {
  const e = await start();
  const { a } = setup(e);
  const first = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await first;
  const req = waitFor<PendingRequest>(e, 'request');
  const ac = new AbortController();
  const call = approveDirect(a.id, 'Write', ac.signal).catch(() => 'aborted');
  const r = await req;
  expect(e.status(a.id)).toBe('awaiting');

  const resolved = waitFor(e, 'request-resolved');
  ac.abort();

  expect(await resolved).toEqual({ id: r.id, agentId: a.id });
  expect(await call).toBe('aborted');
  expect(e.pendingRequests()).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
  expect(() => e.answerRequest(r.id, { type: 'allow-always' })).toThrow('대기 중인 요청이 없습니다');
  expect(agentOf(e, a.id).alwaysAllow).toEqual([]);
  const next = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 둘')); // 막히지 않고 바로 간다
  expect(await resultText(next)).toBe('받음: echo 둘');
});

test('차례가 끝나면 그 에이전트에 남은 승인 요청을 정리한다 — 차례가 끝났습니다', async () => {
  const e = await start();
  const { a } = setup(e);
  const req = waitFor<PendingRequest>(e, 'request');
  await e.sendUser(a.id, text('ASK Write'));
  const live = await req;
  const leftoverReq = waitFor<PendingRequest>(e, 'request');
  const leftover = approveDirect(a.id, 'Edit'); // 이 차례와 상관없는 호출(떠난 프로세스가 남긴 것처럼)
  const r2 = await leftoverReq;
  expect(e.pendingRequests(a.id)).toHaveLength(2);

  const resolved = waitFor<{ id: string }>(e, 'request-resolved', (x) => x.id === r2.id);
  const done = resultOf(e, a.id);
  e.answerRequest(live.id, { type: 'allow' });

  expect(await resultText(done)).toBe('ok');
  expect(await resolved).toEqual({ id: r2.id, agentId: a.id });
  expect(await leftover).toEqual({ behavior: 'deny', message: '차례가 끝났습니다.' });
  expect(e.pendingRequests()).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
});

const resultTextIs = (e: Engine, agentId: string, t: string) =>
  waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === agentId && x.event.kind === 'result' && x.event.text === t);

test('일하는 중 사람이 또 입력하면 차례가 끝난 뒤 보낸다 — 대기 메시지보다 먼저, 두 줄을 동시에 보내지 않음', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  const init = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'init');
  await e.sendUser(a.id, text('SLOW'));
  await init;
  await e.sendUser(a.id, text('echo 둘째'));
  const bDone = resultOf(e, b.id);
  await e.sendUser(b.id, text('SEND A: 셋째'));
  expect(await resultText(bDone)).toBe('A 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
  const aTexts = () => userTexts().filter((t) => t !== 'SEND A: 셋째');
  expect(aTexts()).toEqual(['SLOW']); // 둘째·셋째는 아직 안 보냄

  const delivery = '[두레 메시지 — 보낸 쪽: B(웹 화면)]\n셋째';
  const third = resultTextIs(e, a.id, `받음: ${delivery}`);
  await e.interrupt(a.id);
  e.resumeHold(a.id); // 멈추면 둘째·셋째가 붙잡힌다 — 이어서 보낸다
  await third;
  expect(aTexts()).toEqual(['SLOW', 'echo 둘째', delivery]);
  expect(e.status(a.id)).toBe('idle');
});

test('받는 쪽이 읽기 전에 죽으면 메시지는 queued 로 남고, 다시 켜면 flushAll 로 전달', async () => {
  const dieFlag = path.join(dir, 'die');
  fs.writeFileSync(dieFlag, 'B');
  const e1 = await start({ FAKE_DIE_FLAG_FILE: dieFlag });
  const { a, b } = setup(e1);
  e1.updateAgent(b.id, { auto: true });
  const bError = waitFor<StatusEvent>(e1, 'status', (s) => s.agentId === b.id && s.status === 'error');
  const states: string[] = [];
  e1.on('message', (m: RelayMessage) => m.to === b.id && states.push(m.state));
  const requeued = waitFor<RelayMessage>(
    e1,
    'message',
    (m) => m.to === b.id && m.state === 'queued' && states.includes('delivered'),
  );
  const aDone = resultOf(e1, a.id);

  await e1.sendUser(a.id, text('SEND B: 사라지면 안 돼'));

  await aDone;
  await bError;
  await requeued;
  expect(states).toEqual(['queued', 'delivered', 'queued']); // 넘겼다가 → 읽기 전에 죽어서 되돌림
  expect(e1.messages({ to: b.id }).map((m) => m.state)).toEqual(['queued']);
  expect(e1.status(b.id)).toBe('error');
  expect(spawnsOf('B')).toHaveLength(1);

  fs.rmSync(dieFlag);
  await e1.shutdown();
  const e2 = await start({ FAKE_DIE_FLAG_FILE: dieFlag });
  expect(e2.messages()[0].state).toBe('delivered');
  expect(await resultText(resultOf(e2, b.id))).toBe('받음: [두레 메시지 — 보낸 쪽: A(기획)]\n사라지면 안 돼');
  expect(spawnsOf('B')).toHaveLength(2);
});

test('사람 입력을 읽기 전에 죽으면 그 입력은 다음 입력 앞에 다시 보낸다', async () => {
  const dieFlag = path.join(dir, 'die');
  fs.writeFileSync(dieFlag, 'B');
  const e = await start({ FAKE_DIE_FLAG_FILE: dieFlag });
  const { b } = setup(e);
  const bError = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === b.id && s.status === 'error');
  await e.sendUser(b.id, text('echo first'));
  await e.sendUser(b.id, text('echo held')); // first 가 일하는 중이라 기다린다
  await bError;
  expect(userTexts()).toEqual([]); // 죽은 프로세스는 아무것도 못 읽었다

  fs.rmSync(dieFlag);
  const second = resultTextIs(e, b.id, '받음: echo second');
  await e.sendUser(b.id, text('echo second'));
  await second;
  expect(userTexts()).toEqual(['echo first', 'echo held', 'echo second']); // 되살린 입력은 맨 앞
  expect(spawnsOf('B')).toHaveLength(2);
  expect(e.status(b.id)).toBe('idle');
});

test('제어 응답은 수신 확인이 아니다 — 보낸 뒤 제어 응답만 오고 죽으면 메시지는 queued 로', async () => {
  const dieFlag = path.join(dir, 'die');
  fs.writeFileSync(dieFlag, 'B:mute'); // 제어 요청에만 답하고 사용자 줄은 안 읽는다
  const e = await start({ FAKE_DIE_FLAG_FILE: dieFlag });
  const { a, b } = setup(e);
  e.updateAgent(b.id, { auto: true });
  const delivered = waitFor<RelayMessage>(e, 'message', (m) => m.to === b.id && m.state === 'delivered');
  const aDone = resultOf(e, a.id);
  await e.sendUser(a.id, text('SEND B: 읽었나'));
  await delivered;
  await aDone;

  await e.describe(b.id); // 메시지를 보낸 뒤에 제어 응답이 온다
  const errored = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === b.id && s.status === 'error');
  process.kill(lastSpawnOf('B').pid);
  await errored;

  expect(e.messages({ to: b.id }).map((m) => m.state)).toEqual(['queued']);
});

test('shutdown 으로 끝낸 세션이 못 읽은 메시지는 queued 로 남고 다음 시작 때 전달', async () => {
  const dieFlag = path.join(dir, 'die');
  fs.writeFileSync(dieFlag, 'B:hang'); // 아무것도 안 읽고 아무 말도 안 한다
  const e1 = await start({ FAKE_DIE_FLAG_FILE: dieFlag });
  const { a, b } = setup(e1);
  e1.updateAgent(b.id, { auto: true });
  const delivered = waitFor<RelayMessage>(e1, 'message', (m) => m.to === b.id && m.state === 'delivered');
  const aDone = resultOf(e1, a.id);
  await e1.sendUser(a.id, text('SEND B: 끝나기 전에'));
  await delivered;
  await aDone;
  expect(e1.status(b.id)).toBe('working');

  await e1.shutdown();

  expect(openMessageLog(dataDir).list({ to: b.id }).map((m) => m.state)).toEqual(['queued']);
  fs.rmSync(dieFlag);
  const e2 = await start({ FAKE_DIE_FLAG_FILE: dieFlag });
  expect(await resultText(resultOf(e2, b.id))).toBe('받음: [두레 메시지 — 보낸 쪽: A(기획)]\n끝나기 전에');
});

test('newConversation 으로 끝낸 세션이 못 읽은 사람 입력은 새 대화의 맨 앞으로', async () => {
  const dieFlag = path.join(dir, 'die');
  fs.writeFileSync(dieFlag, 'B:mute'); // 제어 요청에만 답하고 사용자 줄은 읽지 않는다(받은 줄을 기록만 한다)
  const e = await start({ FAKE_DIE_FLAG_FILE: dieFlag });
  const { b } = setup(e);
  await e.sendUser(b.id, text('echo 못 읽음'));
  expect(e.status(b.id)).toBe('working');
  await e.describe(b.id); // 그 프로세스가 떠서 플래그를 읽었다 — 이제 지워도 된다
  fs.rmSync(dieFlag); // 새 대화의 프로세스는 정상 — newConversation 이 남은 입력을 곧바로 보낸다

  await e.newConversation(b.id);

  const done = resultTextIs(e, b.id, '받음: echo 다음');
  await e.sendUser(b.id, text('echo 다음'));
  await done;
  // 첫 줄은 mute 프로세스가 받기만 한 기록 — 새 대화가 그 입력부터 받았다
  expect(userTexts()).toEqual(['echo 못 읽음', 'echo 못 읽음', 'echo 다음']);
  expect(flagValue(lastSpawnOf('B').argv, '--session-id')).toBe(agentOf(e, b.id).sessionId);
  expect(agentOf(e, b.id).sessionId).not.toBe(b.sessionId);
});

test('newConversation 때 남은 사람 입력은 새 대화로 보내고 idle 로 돌아온다 — 그 뒤 온 메시지도 전달', async () => {
  const dieFlag = path.join(dir, 'die');
  fs.writeFileSync(dieFlag, 'B:mute'); // 제어 요청에만 답하고 사용자 줄은 읽지 않는다(받은 줄을 기록만 한다)
  const e = await start({ FAKE_DIE_FLAG_FILE: dieFlag });
  const { a, b } = setup(e);
  e.updateAgent(b.id, { auto: true });
  await e.sendUser(b.id, text('echo 못 읽음'));
  await e.sendUser(b.id, text('SLOW')); // 일하는 중이라 기다린다
  await e.describe(b.id); // 그 프로세스가 떠서 플래그를 읽었다 — 이제 지워도 된다
  fs.rmSync(dieFlag);
  const first = resultTextIs(e, b.id, '받음: echo 못 읽음');

  await e.newConversation(b.id);

  await first; // 사람이 다시 치지 않아도 새 대화로 갔다
  expect(e.status(b.id)).toBe('working'); // 이어서 기다리던 SLOW
  const aDone = resultOf(e, a.id);
  await e.sendUser(a.id, text('SEND B: 이어서'));
  expect(await resultText(aDone)).toBe('B 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');

  const delivery = '[두레 메시지 — 보낸 쪽: A(기획)]\n이어서';
  const last = resultTextIs(e, b.id, `받음: ${delivery}`);
  await e.interrupt(b.id);
  e.resumeHold(b.id); // 멈추면 전달 대기 메시지가 붙잡힌다 — 이어서 보낸다
  await last;
  expect(e.status(b.id)).toBe('idle');
  // 첫 줄은 mute 프로세스가 받기만 한 기록
  expect(userTexts().filter((t) => t !== 'SEND B: 이어서')).toEqual(['echo 못 읽음', 'echo 못 읽음', 'SLOW', delivery]);
  expect(spawnsOf('B')).toHaveLength(2);
  expect(flagValue(lastSpawnOf('B').argv, '--session-id')).toBe(agentOf(e, b.id).sessionId);
  expect(e.messages({ to: b.id }).map((m) => m.state)).toEqual(['delivered']);
});

test('newConversation 때 남은 입력이 있는데 폴더가 없으면 status error 로 남고 던지지 않는다', async () => {
  const dieFlag = path.join(dir, 'die');
  fs.writeFileSync(dieFlag, 'B'); // 읽기 전에 죽는다 — 입력은 기다리는 줄로 돌아온다
  const e = await start({ FAKE_DIE_FLAG_FILE: dieFlag });
  const { b } = setup(e);
  const errored = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === b.id && s.status === 'error');
  await e.sendUser(b.id, text('echo 못 읽음'));
  await errored;
  fs.rmSync(b.folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

  await e.newConversation(b.id);

  expect(e.status(b.id)).toBe('error');
  expect(e.errorText(b.id)).toBe(`폴더를 찾을 수 없습니다: ${b.folder}`);
  expect(spawnsOf('B')).toHaveLength(1);
});

test('Claude 가 죽을 때 기다리던 사람 입력은 남고, 다음 입력 때 먼저 보낸 뒤 대기 메시지를 전달', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  const init = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'init');
  await e.sendUser(a.id, text('SLOW'));
  await init;
  await e.sendUser(a.id, text('echo 사람 하나')); // 기다리는 중
  const errored = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');
  process.kill(lastSpawnOf('A').pid);
  await errored;

  const bDone = resultOf(e, b.id);
  await e.sendUser(b.id, text('SEND A: 메시지')); // 남은 사람 입력이 있으니 바로 띄우지 않는다
  expect(await resultText(bDone)).toBe('A 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
  expect(spawnsOf('A')).toHaveLength(1);
  expect(e.status(a.id)).toBe('error');

  const delivery = '[두레 메시지 — 보낸 쪽: B(웹 화면)]\n메시지';
  const last = resultTextIs(e, a.id, `받음: ${delivery}`);
  await e.sendUser(a.id, text('echo 사람 둘'));
  await last;
  const aTexts = userTexts().filter((t) => t !== 'SEND A: 메시지');
  expect(aTexts).toEqual(['SLOW', 'echo 사람 하나', 'echo 사람 둘', delivery]);
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(a.sessionId);
});

test('재시작 유지: queued 메시지가 있는 채로 shutdown → createEngine 다시 → 받는 쪽에 전달됨', async () => {
  const e1 = await start();
  const { a, b } = setup(e1);
  e1.updateAgent(b.id, { auto: true });
  const bInit = waitFor<AgentEvent>(e1, 'agent-event', (x) => x.agentId === b.id && x.event.kind === 'init');
  await e1.sendUser(b.id, text('SLOW'));
  await bInit;
  expect(e1.status(b.id)).toBe('working');

  const aDone = resultOf(e1, a.id);
  await e1.sendUser(a.id, text('SEND B: 이어서 해 줘'));
  expect(await resultText(aDone)).toBe('B 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
  expect(e1.messages()[0].state).toBe('queued');
  await e1.shutdown();
  expect(openMessageLog(dataDir).list()[0].state).toBe('queued');

  const e2 = await start();
  expect(e2.messages()[0].state).toBe('delivered'); // createEngine 이 flushAll 로 바로 전달
  const bDone = resultOf(e2, b.id);
  expect(await resultText(bDone)).toBe('받음: [두레 메시지 — 보낸 쪽: A(기획)]\n이어서 해 줘');
  const argv = lastSpawnOf('B').argv;
  expect(flagValue(argv, '--resume')).toBe(b.sessionId);
});

test('CRASH: status error, 승인 대기 정리, 다음 sendUser 는 --resume <같은 sessionId> 로 띄움', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  let done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 처음'));
  await done;
  expect(agentOf(e, a.id).started).toBe(true);
  expect(flagValue(lastSpawnOf('A').argv, '--session-id')).toBe(a.sessionId);

  // 승인을 기다리는 중에 프로세스가 갑자기 죽는다
  const req = waitFor<PendingRequest>(e, 'request');
  await e.sendUser(a.id, text('ASK Write'));
  const r = await req;
  const bDone = resultOf(e, b.id);
  await e.sendUser(b.id, text('SEND A: 이것도 봐 줘'));
  expect(await resultText(bDone)).toBe('A 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');

  const resolved = waitFor(e, 'request-resolved');
  const errored = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');
  process.kill(lastSpawnOf('A').pid);
  expect(await resolved).toEqual({ id: r.id, agentId: a.id });
  expect((await errored).errorText).toBeTruthy();
  expect(e.status(a.id)).toBe('error');
  expect(e.pendingRequests(a.id)).toEqual([]);
  expect(e.messages({ to: a.id })[0].state).toBe('queued'); // 받을 메시지는 남는다

  // 다음 입력 → --resume 으로 다시 뜨고, 그 차례가 끝나면 대기 메시지도 전달
  const delivered = waitFor<RelayMessage>(e, 'message', (m) => m.to === a.id && m.state === 'delivered');
  done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 다시'));
  expect(await resultText(done)).toBe('받음: echo 다시');
  expect(spawnsOf('A')).toHaveLength(2);
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(a.sessionId);
  expect(lastSpawnOf('A').argv).not.toContain('--session-id');
  done = resultOf(e, a.id);
  await delivered;
  expect(await resultText(done)).toBe('받음: [두레 메시지 — 보낸 쪽: B(웹 화면)]\n이것도 봐 줘');

  // CRASH 명령으로 죽어도 같다
  const crashed = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');
  await e.sendUser(a.id, text('CRASH'));
  expect((await crashed).errorText).toContain('fake crash');
  expect(e.errorText(a.id)).toContain('fake crash');
  done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 셋'));
  expect(await resultText(done)).toBe('받음: echo 셋');
  expect(spawnsOf('A')).toHaveLength(3);
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(a.sessionId);
  expect(e.status(a.id)).toBe('idle');
  expect(e.errorText(a.id)).toBeNull();
});

test('폴더 지운 뒤 sendUser → status error, errorText 폴더를 찾을 수 없습니다, 엔진은 살아 있음', async () => {
  const e = await start();
  const { a, b } = setup(e);
  fs.rmSync(a.folder, { recursive: true, force: true });
  const errored = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');

  await expect(e.sendUser(a.id, text('안녕'))).rejects.toThrow('폴더를 찾을 수 없습니다');

  expect((await errored).errorText).toBe(`폴더를 찾을 수 없습니다: ${a.folder}`);
  expect(e.status(a.id)).toBe('error');
  expect(e.errorText(a.id)).toBe(`폴더를 찾을 수 없습니다: ${a.folder}`);
  expect(spawnsOf('A')).toHaveLength(0);

  // 엔진은 살아 있다 — B 는 일하고, A 에게 보낸 메시지는 사라지지 않는다
  e.updateAgent(a.id, { auto: true });
  const bDone = resultOf(e, b.id);
  await e.sendUser(b.id, text('SEND A: 받아 줘'));
  expect(await resultText(bDone)).toBe('A 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
  expect(e.messages({ to: a.id })[0].state).toBe('queued');
  expect(e.status(b.id)).toBe('idle');
});

test('첫 init 의 started 저장이 한 번 실패해도 engine-error 로 알리고 차례는 끝난다', async () => {
  const e = await start();
  const { a } = setup(e);
  const store = (e as any).store;
  const realUpdate = store.updateAgent;
  let thrown = 0;
  store.updateAgent = (id: string, patch: { started?: boolean }) => {
    if (patch.started === true && thrown === 0) {
      thrown++;
      throw new Error('저장 실패(가짜)');
    }
    return realUpdate(id, patch);
  };
  const errors: unknown[] = [];
  e.on('engine-error', (x) => errors.push(x));
  const done = resultOf(e, a.id);

  await e.sendUser(a.id, text('echo 하나'));

  expect(await resultText(done)).toBe('받음: echo 하나');
  expect(thrown).toBe(1);
  expect(errors).toEqual([{ agentId: a.id, message: '저장 실패(가짜)' }]);
  expect(e.status(a.id)).toBe('idle');
  // 다음 차례의 init 때 다시 쓴다
  const again = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 둘'));
  await again;
  expect(agentOf(e, a.id).started).toBe(true);
});

test('agent-event 듣는 쪽이 던져도 engine-error 로 알리고, 차례 끝의 다음 입력은 그대로 보낸다', async () => {
  const e = await start();
  const { a } = setup(e);
  let broke = false;
  e.on('agent-event', (x: AgentEvent) => {
    if (!broke && x.agentId === a.id && x.event.kind === 'result') {
      broke = true;
      throw new Error('화면 고장(가짜)');
    }
  });
  const errors: unknown[] = [];
  e.on('engine-error', (x) => errors.push(x));
  const second = resultTextIs(e, a.id, '받음: echo 둘');

  await e.sendUser(a.id, text('echo 하나'));
  await e.sendUser(a.id, text('echo 둘')); // 일하는 중 — 첫 차례의 result 뒤에 보낸다

  await second;
  expect(errors).toEqual([{ agentId: a.id, message: '화면 고장(가짜)' }]);
  expect(userTexts()).toEqual(['echo 하나', 'echo 둘']);
});

test('describe → commands·models, account 없음', async () => {
  const e = await start();
  const { a } = setup(e);
  const events: unknown[] = [];
  e.on('agent-event', (x) => events.push(x));

  const d = await e.describe(a.id);

  expect(d).toEqual({
    commands: [{ name: 'compact', description: '대화 요약', argumentHint: '' }],
    models: [
      { value: 'default', displayName: 'Default', resolvedModel: 'claude-sonnet-5-5', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'sonnet', displayName: 'Sonnet 5.5', description: '빠름', resolvedModel: 'claude-sonnet-5-5', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', resolvedModel: 'claude-opus-4-8' },
    ],
    permissionMode: 'default',
  });
  expect(d).not.toHaveProperty('account');
  expect(JSON.stringify(d)).not.toContain('fake-user@example.com');
  expect(JSON.stringify(events)).not.toContain('fake-user@example.com'); // 제어 응답도 밖으로 안 샌다

  await e.describe(a.id); // 같은 세션 동안 캐시
  expect(controlRequests('initialize')).toHaveLength(1);
  await e.newConversation(a.id); // 새 세션이면 다시 묻는다
  await e.describe(a.id);
  expect(controlRequests('initialize')).toHaveLength(2);
});

test('describe: effort 단계 — haiku 는 없음, 모르는 단계는 빠진다', async () => {
  const e = await start({ FAKE_EXTRA_LEVEL: 'turbo' });
  const { a } = setup(e);
  const d = await e.describe(a.id);
  const by = (v: string) => d.models.find((m) => m.value === v)!;
  expect(by('default')).toMatchObject({ supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] });
  expect(by('haiku')).not.toHaveProperty('supportsEffort');
  expect(by('haiku')).not.toHaveProperty('effortLevels');
});

test('setModel 저장 + 살아 있는 세션에 set_model', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setModel(a.id, 'haiku'); // 세션 없음 → 저장만
  expect(agentOf(e, a.id).model).toBe('haiku');
  expect(spawns()).toHaveLength(0);

  let done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await done;
  expect(flagValue(lastSpawnOf('A').argv, '--model')).toBe('haiku');

  await e.setModel(a.id, 'sonnet');
  expect(agentOf(e, a.id).model).toBe('sonnet');
  expect(controlRequests('set_model').map((x) => x.request.model)).toEqual(['sonnet']);
  const init = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'init');
  done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 둘'));
  const ev = (await init).event;
  expect(ev.kind === 'init' && ev.model).toBe('sonnet');
  await done;

  await e.setModel(a.id, null);
  expect(agentOf(e, a.id).model).toBeNull();
  expect(controlRequests('set_model').map((x) => x.request.model)).toEqual(['sonnet', 'default']);
  expect(spawns()).toHaveLength(1);
});

test('modelNow: 차례의 init 에서 풀린 모델 id 를 기억하고 model-now 를 알린다 · setModel 이 비운다', async () => {
  const e = await start();
  const { a } = setup(e);
  expect(e.modelNow(a.id)).toBeNull();
  const got: { agentId: string; modelNow: string | null }[] = [];
  e.on('model-now', (v) => got.push(v));
  const ev = waitFor(e, 'model-now', (x: any) => x.modelNow !== null);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  expect(await ev).toEqual({ agentId: a.id, modelNow: 'claude-opus-5-5' });
  await done;
  expect(e.modelNow(a.id)).toBe('claude-opus-5-5');

  // 같은 값이면 다시 알리지 않는다
  const done2 = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 둘'));
  await done2;
  expect(got).toHaveLength(1);

  await e.setModel(a.id, 'haiku');
  expect(e.modelNow(a.id)).toBeNull();
  expect(got).toEqual([
    { agentId: a.id, modelNow: 'claude-opus-5-5' },
    { agentId: a.id, modelNow: null },
  ]);
});

test('FAKE_PERMISSION_MODE=bypassPermissions → flags bypass true', async () => {
  const e = await start({ FAKE_PERMISSION_MODE: 'bypassPermissions' });
  const { a } = setup(e);
  const flag = waitFor(e, 'flags');
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  expect(await flag).toEqual({ agentId: a.id, bypass: true, bySettings: true, pending: false }); // 두레가 켠 것이 아니다 — 내 Claude 설정
  await done;
  expect((await e.describe(a.id)).permissionMode).toBe('bypassPermissions');
});

test('특수문자 본문이 A→MCP→기록→B stdin 까지 그대로', async () => {
  const special = '줄1\n"따옴표" \\ 백슬래시 🎉 한글';
  expect(special.includes('\\')).toBe(true);
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(b.id, { auto: true });
  const bDone = resultOf(e, b.id);

  await e.sendUser(a.id, text(`SEND B: ${special}`));

  const expected = `[두레 메시지 — 보낸 쪽: A(기획)]\n${special}`;
  expect(await resultText(bDone)).toBe(`받음: ${expected}`);
  expect(e.messages()[0].text).toBe(special);
  expect(openMessageLog(dataDir).list()[0].text).toBe(special); // 디스크 기록도
  const got = userTexts().find((t) => t.startsWith('[두레 메시지'));
  expect(got).toBe(expected);
  expect(got!.includes('\\')).toBe(true);
});

test('모든 spawn argv 에 --disallowedTools SendMessage ListAgents', async () => {
  const e1 = await start();
  const { a, b } = setup(e1);
  e1.updateAgent(b.id, { auto: true });
  const bDone = resultOf(e1, b.id);
  await e1.sendUser(a.id, text('SEND B: 하나'));
  await bDone;
  await e1.shutdown();
  const e2 = await start(); // --resume 으로 다시 뜨는 경우도
  const done = resultOf(e2, a.id);
  await e2.sendUser(a.id, text('echo 둘'));
  await done;

  const all = spawns();
  expect(all).toHaveLength(3);
  expect(flagValue(all[2].argv, '--resume')).toBe(a.sessionId);
  for (const { argv, mcpToolTimeout } of all) {
    const i = argv.indexOf('--disallowedTools');
    expect(argv.slice(i + 1, i + 3)).toEqual(['SendMessage', 'ListAgents']);
    expect(mcpToolTimeout).toBe('86400000');
  }
});

test('shutdown 뒤 모든 세션 pid 가 살아 있지 않다', async () => {
  const e = await start();
  const { a, b } = setup(e);
  const bInit = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === b.id && x.event.kind === 'init');
  await e.sendUser(b.id, text('SLOW'));
  await bInit;
  const req = waitFor<PendingRequest>(e, 'request');
  await e.sendUser(a.id, text('ASK Write')); // 승인 대기 중인 채로
  const r = await req;
  const pids = spawns().map((s) => s.pid);
  expect(pids).toHaveLength(2);
  expect(pids.every(isAlive)).toBe(true);

  const resolved = waitFor(e, 'request-resolved');
  await e.shutdown();

  expect(await resolved).toEqual({ id: r.id, agentId: a.id });
  expect(pids.filter(isAlive)).toEqual([]);
  await expect(e.sendUser(a.id, text('또'))).rejects.toThrow();
  expect(spawns()).toHaveLength(2);
});

test('newConversation → 세션 stop, 새 sessionId·started false, 다음은 --session-id 로', async () => {
  const e = await start();
  const { a } = setup(e);
  let done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await done;
  const oldPid = lastSpawnOf('A').pid;

  await e.newConversation(a.id);

  const now = agentOf(e, a.id);
  expect(now.sessionId).not.toBe(a.sessionId);
  expect(now.started).toBe(false);
  expect(isAlive(oldPid)).toBe(false);
  expect(e.status(a.id)).toBe('idle');
  done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 둘'));
  await done;
  expect(flagValue(lastSpawnOf('A').argv, '--session-id')).toBe(now.sessionId);
  expect(lastSpawnOf('A').argv).not.toContain('--resume');
});

test('removeAgent → 세션 정리, 그 에이전트가 받고 보낸 대기 메시지는 dismissed', async () => {
  const e = await start();
  const { room, a, b } = setup(e);
  const c = e.addAgent({ roomId: room.id, name: 'C', role: '서버', folder: folder('c') });
  let done = resultOf(e, a.id);
  await e.sendUser(a.id, text('SEND B: B 에게'));
  await done;
  done = resultOf(e, a.id);
  await e.sendUser(a.id, text('SEND C: C 에게'));
  await done;
  done = resultOf(e, b.id);
  await e.sendUser(b.id, text('SEND C: B 가 C 에게'));
  await done;
  const bPid = lastSpawnOf('B').pid;
  expect(e.messages().map((m) => m.state)).toEqual(['pending', 'pending', 'pending']);

  await e.removeAgent(b.id);

  expect(e.agents().map((x) => x.name)).toEqual(['A', 'C']);
  expect(e.messages().map((m) => [m.from, m.to, m.state])).toEqual([
    [a.id, b.id, 'dismissed'],
    [a.id, c.id, 'pending'],
    [b.id, c.id, 'dismissed'],
  ]);
  expect(isAlive(bPid)).toBe(false);
  expect(() => e.status(b.id)).toThrow('에이전트를 찾을 수 없습니다');
});

test('removeRoom → 방의 에이전트 세션을 멈추고 방·에이전트를 지운다', async () => {
  const e = await start();
  const { room, a } = setup(e);
  const other = e.addRoom('다른 방');
  e.addAgent({ roomId: other.id, name: 'Z', role: '기타', folder: folder('z') });
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await done;
  const aPid = lastSpawnOf('A').pid;

  await e.removeRoom(room.id);

  expect(e.rooms().map((r) => r.name)).toEqual(['다른 방']);
  expect(e.agents().map((x) => x.name)).toEqual(['Z']);
  expect(isAlive(aPid)).toBe(false);
});

test('MCP list_agents: 같은 방 다른 에이전트 [{name, role, status}] · 띄울 때마다 run/<id> 를 새로 쓴다', async () => {
  const e = await start();
  const { room, a } = setup(e);
  const other = e.addRoom('다른 방');
  e.addAgent({ roomId: other.id, name: 'Z', role: '기타', folder: folder('z') });
  let done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await done;

  const runDir = path.join(dataDir, 'run', a.id);
  const cfg = JSON.parse(fs.readFileSync(path.join(runDir, 'mcp.json'), 'utf8')).mcpServers.dure;
  const call = async (agentHeader: string, name: string, args: object) => {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cfg.headers, 'X-Dure-Agent': agentHeader },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await res.json()).result;
  };

  const list = await call(a.id, 'list_agents', {});
  expect(JSON.parse(list.content[0].text)).toEqual([{ name: 'B', role: '웹 화면', status: 'idle' }]);
  const nobody = await call('no-such-agent', 'list_agents', {});
  expect(nobody).toMatchObject({ isError: true, content: [{ text: '에이전트를 찾을 수 없습니다.' }] });
  const nobodySend = await call('no-such-agent', 'send_message', { to: 'B', text: 'x' });
  expect(nobodySend).toMatchObject({ isError: true, content: [{ text: '에이전트를 찾을 수 없습니다.' }] });

  let prompt = fs.readFileSync(path.join(runDir, 'prompt.md'), 'utf8');
  expect(prompt).toContain('B(웹 화면)');
  expect(prompt).not.toContain('Z(기타)');

  // 동료가 늘면 다음 실행 때 안내문을 새로 쓴다
  e.addAgent({ roomId: room.id, name: 'C', role: '서버', folder: folder('c') });
  await e.newConversation(a.id);
  done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 둘'));
  await done;
  prompt = fs.readFileSync(path.join(runDir, 'prompt.md'), 'utf8');
  expect(prompt).toContain('C(서버)');
});

// ── 대화 기록 ──
const historyKinds = (e: Engine, id: string, o?: { all?: boolean }) => e.history(id, o).map((x) => x.kind);

test('engine: 사람 입력과 Claude 답이 기록되고 다시 열어도 남는다', async () => {
  const e1 = await start();
  const { a } = setup(e1);
  const done = resultOf(e1, a.id);
  await e1.sendUser(a.id, text('안녕'));
  await done;
  await e1.shutdown();

  const e2 = await start();
  const items = e2.history(a.id);
  expect(items.map((x) => x.kind)).toEqual(['user', 'assistant', 'result']);
  expect(items[0]).toMatchObject({ kind: 'user', source: 'human', parts: [{ type: 'text', text: '안녕' }] });
  expect(items[0]).not.toHaveProperty('messageId');
  expect(items[1]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: '받음: 안녕' }] });
  expect(items[2]).toMatchObject({ kind: 'result', ok: true, subtype: 'success' });
  expect(typeof items[0].t).toBe('number');
});

test('engine: 전달 메시지는 source relay + messageId', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(b.id, { auto: true });
  const bDone = resultOf(e, b.id);
  const aDone = resultOf(e, a.id);
  await e.sendUser(a.id, text('SEND B: 하이'));
  await aDone;
  await bDone;
  const delivered = e.messages({ to: b.id }).find((m) => m.state === 'delivered')!;
  const user = e.history(b.id)[0];
  expect(user).toMatchObject({
    kind: 'user',
    source: 'relay',
    messageId: delivered.id,
    parts: [{ type: 'text', text: '[두레 메시지 — 보낸 쪽: A(기획)]\n하이' }],
  });
});

test('engine: 하는 일 입력은 화면이 읽는 칸만 기록 — 넘김 본문은 기록 파일에 없다(이벤트도 같은 모양)', async () => {
  const e = await start();
  const { a } = setup(e);
  const body = '아주 긴 넘김 본문 '.repeat(2000);
  const live: { kind: string; blocks?: unknown }[] = [];
  e.on('history', (h: { agentId: string; item: { kind: string } }) => h.agentId === a.id && live.push(h.item));
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text(`SEND B: ${body}`));
  await done;
  const stored = e.history(a.id).find((x) => x.kind === 'assistant')!;
  expect(stored).toMatchObject({
    kind: 'assistant',
    blocks: [{ type: 'tool_use', name: 'mcp__dure__send_message', input: { to: 'B' } }],
  });
  expect(stored.kind === 'assistant' && stored.blocks[0].type === 'tool_use' && stored.blocks[0].input).toEqual({ to: 'B' });
  expect(live.find((x) => x.kind === 'assistant')).toEqual(stored);
  // 기록 파일의 assistant 줄에도 본문이 없다(사람이 친 SEND 줄에만 있다)
  const lines = fs.readFileSync(path.join(dataDir, 'history', `${a.id}.jsonl`), 'utf8').split('\n');
  const assistantLine = lines.find((l) => l.includes('"kind":"assistant"'))!;
  expect(assistantLine).not.toContain('아주 긴 넘김 본문');
  expect(lines.filter((l) => l.includes('아주 긴 넘김 본문'))).toHaveLength(1);
});

/** 그 차례의 하는 일 결과 하나(EDIT·EDITBARE 는 하나뿐) */
async function editResult(env: Record<string, string>, line: string) {
  const e = await start(env);
  const { a } = setup(e);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text(line));
  await done;
  const r = e.history(a.id).find((x) => x.kind === 'tool-result')!;
  const file = fs.readFileSync(path.join(dataDir, 'history', `${a.id}.jsonl`), 'utf8');
  return { r, file };
}

test('수정: 결과의 structuredPatch 를 바뀐 줄(patch)로 기록 — 결과 글은 그대로, originalFile·옛/새 글 통째는 기록 파일에 없다', async () => {
  const { r, file } = await editResult({}, 'EDIT src/a.ts');
  expect(r).toEqual({
    t: expect.any(Number), kind: 'tool-result', toolUseId: expect.any(String), isError: false,
    text: 'The file src/a.ts has been updated successfully.', viaApproval: false,
    patch: [{ oldStart: 10, newStart: 10, lines: [' const a = 1', '-const b = 2', '+const b = 3', '+const c = 4', ' const d = 5'] }],
  });
  expect(file).not.toContain('ORIGINAL FILE BODY');
  expect(file).not.toContain('originalFile');
  expect(file).not.toContain('old_string');
  expect(file).not.toContain('oldLines');
});

test('수정: structuredPatch 가 없으면(서브에이전트 줄 등) 하는 일 입력으로 — 옛 줄 전부 - · 새 줄 전부 +, 줄 번호 null', async () => {
  const { r, file } = await editResult({}, 'EDITBARE');
  expect(r).toMatchObject({ kind: 'tool-result', isError: false, text: 'The file bare.txt has been updated successfully.' });
  expect(r.kind === 'tool-result' && r.patch).toEqual([{ oldStart: null, newStart: null, lines: ['-old 1', '-old 2', '+new 1', '+new 2', '+new 3'] }]);
  expect(r).not.toHaveProperty('patchCut');
  // 입력은 기록 파일에 지금처럼 화면이 읽는 칸만
  expect(file).not.toContain('old_string');
});

test('수정: MultiEdit 은 고친 군데마다 한 묶음', async () => {
  const { r } = await editResult({}, 'EDITBARE MULTI');
  expect(r.kind === 'tool-result' && r.patch).toEqual([
    { oldStart: null, newStart: null, lines: ['-a', '+A'] },
    { oldStart: null, newStart: null, lines: ['-b', '-c', '+B'] },
  ]);
});

test('수정: 실패한 결과엔 바뀐 줄이 없다(입력으로도 만들지 않는다)', async () => {
  const { r } = await editResult({}, 'EDITBARE FAIL');
  expect(r).toMatchObject({ kind: 'tool-result', isError: true, text: 'String to replace not found in file.' });
  expect(r).not.toHaveProperty('patch');
});

test('수정: 401줄이면 앞 400줄 + patchCut', async () => {
  const { r } = await editResult({}, 'EDIT big.txt 401');
  if (r.kind !== 'tool-result') throw new Error('tool-result 아님');
  expect(r.patch!.flatMap((h) => h.lines)).toHaveLength(400);
  expect(r.patch![0].lines.at(-1)).toBe('+줄 400');
  expect(r.patchCut).toBe(true);
});

test('수정: 살아 있는 agent-event 의 결과엔 바뀐 줄(patch)을 싣지 않는다 — 렌더러는 기록(줄인 것)만 읽는다', async () => {
  const e = await start();
  const { a } = setup(e);
  const events: AgentEvent[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === a.id && events.push(x));
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('EDIT big.txt 401'));
  await done;
  const live = events.find((x) => x.event.kind === 'tool-result')!;
  expect(live.event).toMatchObject({ kind: 'tool-result', text: 'The file big.txt has been updated successfully.' });
  expect(live.event).not.toHaveProperty('patch');
  // 기록은 그대로 줄인 바뀐 줄을 남긴다
  const r = e.history(a.id).find((x) => x.kind === 'tool-result')!;
  expect(r.kind === 'tool-result' && r.patch!.flatMap((h) => h.lines)).toHaveLength(400);
});

test('수정이 아닌 일(만듦)엔 structuredPatch 가 와도 바뀐 줄을 남기지 않는다', async () => {
  const { r, file } = await editResult({ FAKE_EDIT_TOOL: 'Write' }, 'EDIT src/a.ts');
  expect(r).toMatchObject({ kind: 'tool-result', text: 'The file src/a.ts has been updated successfully.' });
  expect(r).not.toHaveProperty('patch');
  expect(file).not.toContain('const c = 4');
});

test('engine: 이미지는 그림 칸에 저장하고 기록엔 바이트 수와 파일 이름만 — image() 로 다시 읽는다', async () => {
  const e = await start();
  const { a } = setup(e);
  const bytes = Buffer.alloc(1234, 7);
  const base64 = bytes.toString('base64');
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: '봐 줘' }, { type: 'image', mediaType: 'image/png', base64 }]);
  await done;
  const item = e.history(a.id)[0];
  expect(item).toMatchObject({
    kind: 'user',
    parts: [{ type: 'text', text: '봐 줘' }, { type: 'image', mediaType: 'image/png', bytes: 1234, file: expect.stringMatching(/^[0-9a-f]{32}\.png$/) }],
  });
  const file = path.join(dataDir, 'history', `${a.id}.jsonl`);
  expect(fs.readFileSync(file, 'utf8')).not.toContain(base64);
  const name = item.kind === 'user' && item.parts[1].type === 'image' ? item.parts[1].file! : '';
  expect(await e.image(a.id, name)).toBe(`data:image/png;base64,${base64}`);
  expect(await e.image(a.id, '../state.json')).toBeNull();
  await expect(e.image('없는-에이전트', name)).rejects.toThrow();
});

test('engine: 에이전트를 지우면 그 에이전트가 보낸 그림도 지운다', async () => {
  const e = await start();
  const { a } = setup(e);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'image', mediaType: 'image/png', base64: Buffer.alloc(10, 1).toString('base64') }]);
  await done;
  expect(fs.readdirSync(path.join(dataDir, 'images', a.id))).toHaveLength(1);
  await e.removeAgent(a.id);
  expect(fs.existsSync(path.join(dataDir, 'images', a.id))).toBe(false);
});

test('engine: newConversation 뒤 history() 는 boundary 이후만, all:true 는 전부', async () => {
  const e = await start();
  const { a } = setup(e);
  const first = resultOf(e, a.id);
  await e.sendUser(a.id, text('하나'));
  await first;
  await e.newConversation(a.id);
  expect(e.history(a.id)).toEqual([]);
  const second = resultOf(e, a.id);
  await e.sendUser(a.id, text('둘'));
  await second;
  expect(historyKinds(e, a.id)).toEqual(['user', 'assistant', 'result']);
  expect(historyKinds(e, a.id, { all: true })).toEqual(['user', 'assistant', 'result', 'boundary', 'user', 'assistant', 'result']);
  expect(e.history(a.id, { limit: 1 }).map((x) => x.kind)).toEqual(['result']); // 마지막 N 개
});

test('engine: history 이벤트가 append 마다', async () => {
  const e = await start();
  const { a } = setup(e);
  const seen: { agentId: string; item: { kind: string } }[] = [];
  e.on('history', (h) => seen.push(h));
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('이벤트'));
  await done;
  expect(seen.map((h) => h.item.kind)).toEqual(['user', 'assistant', 'result']);
  expect(seen.every((h) => h.agentId === a.id)).toBe(true);
  expect(seen.map((h) => h.item)).toEqual(e.history(a.id));
});

// ── 생각 신호(spec §4.4) ──
const thinkingOf = (events: StreamEvent[]) => events.filter((x) => x.kind === 'thinking');

test('생각: THINK 차례의 생각 신호가 차례대로 agent-event 로 나가고(글보다 먼저) 기록엔 남지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  const events: StreamEvent[] = [];
  const live: HistoryItem[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === a.id && events.push(x.event));
  e.on('history', (h: { agentId: string; item: HistoryItem }) => h.agentId === a.id && live.push(h.item));
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('THINK 다 생각했어요'));
  expect(await resultText(done)).toBe('다 생각했어요');
  // 시작(토큰 모름) → 278 → 452(system/thinking_tokens 의 누적 값만 — thinking_delta 의 값은 쓰지 않는다) → 글 블록 시작에서 끝
  expect(thinkingOf(events)).toEqual([
    { kind: 'thinking', active: true, tokens: null },
    { kind: 'thinking', active: true, tokens: 278 },
    { kind: 'thinking', active: true, tokens: 452 },
    { kind: 'thinking', active: false, tokens: null },
  ]);
  const order = events
    .filter((x) => x.kind === 'thinking' || x.kind === 'text-delta')
    .map((x) => (x.kind === 'text-delta' ? 'text' : x.active ? 'think' : 'end'));
  expect(order).toEqual(['think', 'think', 'think', 'end', 'text']);
  // 기록엔 생각이 없다 — 살아 있는 history 사건에도, 다시 읽은 기록에도, 기록 파일에도
  expect(live.map((x) => x.kind)).not.toContain('thinking');
  expect(e.history(a.id).map((x) => x.kind)).not.toContain('thinking');
  const file = fs.readFileSync(path.join(dataDir, 'history', `${a.id}.jsonl`), 'utf8');
  expect(file).not.toContain('thinking');
  expect(file).not.toContain('estimated_tokens');
});

test('API 상태: 요청 보냄(api-status requesting)이 생각보다 먼저 agent-event 로 나가고 기록엔 남지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  const events: StreamEvent[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === a.id && events.push(x.event));
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('THINK 요청'));
  await done;
  const order = events
    .filter((x) => x.kind === 'init' || x.kind === 'api-status' || x.kind === 'thinking')
    .map((x) => x.kind)
    .slice(0, 3);
  expect(order).toEqual(['init', 'api-status', 'thinking']);
  expect(events.find((x) => x.kind === 'api-status')).toEqual({ kind: 'api-status', status: 'requesting' });
  const file = fs.readFileSync(path.join(dataDir, 'history', `${a.id}.jsonl`), 'utf8');
  expect(file).not.toContain('requesting');
});

test('생각: 생각하는 중에 멈추면 그 뒤로 생각 신호가 오지 않는다 — 쉬는 상태 · 멈춤 알림으로 끝', async () => {
  const e = await start({ FAKE_THINK_MS: '150' });
  const { a } = setup(e);
  const events: StreamEvent[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === a.id && events.push(x.event));
  const thinking = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'thinking' && x.event.tokens === 278);
  await e.sendUser(a.id, text('THINK 못 끝냄'));
  await thinking;
  const ended = resultOf(e, a.id);
  await e.interrupt(a.id);
  await ended;
  const after = events.length;
  await new Promise((r) => setTimeout(r, 450)); // 남은 단계가 있었다면 그새 세 줄은 왔을 시간
  expect(thinkingOf(events.slice(after))).toEqual([]);
  expect(events.some((x) => x.kind === 'text-delta')).toBe(false);
  expect(e.status(a.id)).toBe('idle');
  expect(e.history(a.id).filter((x) => x.kind === 'notice')).toMatchObject([{ text: '멈췄어요' }]);
});

test('engine: 멈춤·비정상 종료는 notice 로 남고, 실행 중 아닌 건 안 남는다', async () => {
  const e = await start();
  const { a, b } = setup(e);
  await e.sendUser(a.id, text('SLOW'));
  expect(e.status(a.id)).toBe('working');
  const stopped = waitFor(e, 'history', (h: any) => h.agentId === a.id && h.item.kind === 'result');
  await e.interrupt(a.id);
  await stopped;
  expect(e.history(a.id).filter((x) => x.kind === 'notice')).toMatchObject([{ text: '멈췄어요' }]);

  const crashed = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === b.id && s.status === 'error');
  await e.sendUser(b.id, text('CRASH'));
  const err = await crashed;
  expect(e.history(b.id).filter((x) => x.kind === 'notice')).toMatchObject([{ text: err.errorText }]);
});

test('engine: 보내기 전 대기 중인 입력은 기록에 없고 보낼 때 나타난다', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.sendUser(a.id, text('SLOW'));
  expect(e.status(a.id)).toBe('working');
  await e.sendUser(a.id, text('나중'));
  expect(e.history(a.id).map((x) => x.kind)).toEqual(['user']);
  const second = waitFor(e, 'agent-event', (x: AgentEvent) => x.agentId === a.id && x.event.kind === 'result' && x.event.text === '받음: 나중');
  await e.interrupt(a.id);
  expect(e.history(a.id).filter((x) => x.kind === 'user')).toHaveLength(1); // 붙잡힌 입력도 기록에 없다
  e.resumeHold(a.id);
  await second;
  expect(e.history(a.id).filter((x) => x.kind === 'user').map((x: any) => x.parts[0].text)).toEqual(['SLOW', '나중']);
});

test('engine: removeAgent 는 기록 파일도 지운다', async () => {
  const e = await start();
  const { a } = setup(e);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('지워질 말'));
  await done;
  const file = path.join(dataDir, 'history', `${a.id}.jsonl`);
  expect(fs.existsSync(file)).toBe(true);
  await e.removeAgent(a.id);
  expect(fs.existsSync(file)).toBe(false);
});

test('autoStart false → createEngine 직후엔 queued 가 안 가고 start() 뒤에 간다', async () => {
  const e1 = await start();
  const { room, a, b } = setup(e1);
  e1.updateAgent(b.id, { auto: true });
  // B 를 못 읽는 상태로 queued 를 남긴다 — 로그에 직접 쓴다
  await e1.shutdown();
  openMessageLog(dataDir).create({ roomId: room.id, from: a.id, to: b.id, text: '나중에', state: 'queued' });
  const e2 = await createEngine({
    dataDir,
    claude: { command: process.execPath, argsPrefix: [FAKE] },
    env: { FAKE_CLAUDE_LOG: logFile },
    autoStart: false,
    usage: false,
  });
  engines.push(e2);
  expect(e2.messages()[0].state).toBe('queued');
  const done = resultOf(e2, b.id);
  e2.start();
  e2.start(); // 두 번째는 아무 일도 안 한다
  await done;
  expect(e2.messages()[0].state).toBe('delivered');
});

test('heldInput: 작업 중 sendUser 두 번 → 2, 차례가 끝나며 1 → 0, 이벤트도 바뀔 때마다', async () => {
  const e = await start();
  const { a } = setup(e);
  const counts: number[] = [];
  e.on('held-input', (v: { agentId: string; count: number }) => v.agentId === a.id && counts.push(v.count));
  await e.sendUser(a.id, text('SLOW'));
  expect(e.heldInput(a.id)).toBe(0);
  await e.sendUser(a.id, text('echo 하나'));
  await e.sendUser(a.id, text('echo 둘'));
  expect(e.heldInput(a.id)).toBe(2);
  const done = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'result' && x.event.text.includes('둘'));
  await e.interrupt(a.id);
  expect(e.heldInput(a.id)).toBe(0); // 붙잡힌 것은 세지 않는다
  e.resumeHold(a.id);
  await done;
  expect(e.heldInput(a.id)).toBe(0);
  // SLOW 는 넣자마자 나가고(1→0), 둘은 줄에 서고(1→2), 멈추면 붙잡혀 빠졌다가(0) 이어서 보내면 돌아와(2) 차례마다 하나씩(1→0)
  expect(counts).toEqual([1, 0, 1, 2, 0, 2, 1, 0]);
});

test('flags(): init 전엔 bypass false, FAKE_PERMISSION_MODE=bypassPermissions 이면 init 뒤 true', async () => {
  const e = await start({ FAKE_PERMISSION_MODE: 'bypassPermissions' });
  const { a, b } = setup(e);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await done;
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: true, pending: false });
  expect(e.flags(b.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

test('자동 전달 상한: 기본 3 · 저장돼 재시작 뒤에도 · 잘못된 값은 throw', async () => {
  const e = await start();
  expect(e.autoChainLimit()).toBe(3);
  for (const bad of [0, -1, 1.5, NaN]) expect(() => e.setAutoChainLimit(bad)).toThrow('상한은 1 이상이어야 해요.');
  expect(e.autoChainLimit()).toBe(3);
  e.setAutoChainLimit(5);
  expect(e.autoChainLimit()).toBe(5);
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))).toEqual({ autoChainLimit: 5 });
  await e.shutdown();
  const e2 = await start();
  expect(e2.autoChainLimit()).toBe(5);
});

test('묻지 않음 경고 닫힘: updateAgent 로 저장되고 다시 켜도 남는다 · true·false 가 아닌 값은 받지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  expect(e.agents().find((x) => x.id === a.id)!.bypassNoticeClosed).toBe(false);
  e.updateAgent(a.id, { bypassNoticeClosed: 'yes' as unknown as boolean });
  expect(e.agents().find((x) => x.id === a.id)!.bypassNoticeClosed).toBe(false);
  e.updateAgent(a.id, { bypassNoticeClosed: true });
  await e.shutdown();
  const e2 = await start();
  expect(e2.agents().find((x) => x.id === a.id)!.bypassNoticeClosed).toBe(true);
});

test('설정: allowBypass 는 기본 false · 켜면 파일에 남아 다시 켜도 true · autoChainLimit 과 서로 지우지 않는다', async () => {
  const e = await start();
  expect(e.allowBypass()).toBe(false);
  await e.setAllowBypass(true);
  e.setAutoChainLimit(7);
  expect(e.allowBypass()).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))).toEqual({ autoChainLimit: 7, allowBypass: true });
  await e.shutdown();
  const e2 = await start();
  expect(e2.allowBypass()).toBe(true);
  expect(e2.autoChainLimit()).toBe(7);
  await e2.shutdown();
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"autoChainLimit":5}');
  const e3 = await start();
  expect(e3.allowBypass()).toBe(false);
  expect(e3.autoChainLimit()).toBe(5);
});

test('설정: 허용을 끄면 모든 에이전트의 bypassOn 을 false 로 저장한다', async () => {
  const seed = openStore(dataDir);
  const r1 = seed.addRoom('A');
  const r2 = seed.addRoom('B');
  const x = seed.addAgent({ roomId: r1.id, name: 'x', role: 'r', folder: dir });
  const y = seed.addAgent({ roomId: r2.id, name: 'y', role: 'r', folder: dir });
  seed.updateAgent(x.id, { bypassOn: true });
  seed.updateAgent(y.id, { bypassOn: true });
  const e = await start();
  await e.setAllowBypass(true);
  await e.setAllowBypass(false);
  expect(e.allowBypass()).toBe(false);
  expect(e.agents().map((a) => a.bypassOn)).toEqual([false, false]);
  expect(openStore(dataDir).agents().map((a) => a.bypassOn)).toEqual([false, false]);
});

test('settings.json 이 깨졌으면 기본값 3', async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{깨짐');
  const e = await start();
  expect(e.autoChainLimit()).toBe(3);
});

test('approve 에 mcp__dure__ 도구 → 사람에게 안 묻고 바로 거절, request 이벤트 없음', async () => {
  const e = await start();
  const { a } = setup(e);
  const requests: unknown[] = [];
  e.on('request', (r) => requests.push(r));
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나')); // 프로세스를 띄워 mcp.json 을 만든다
  await done;
  expect(await approveDirect(a.id, 'mcp__dure__send_message')).toEqual({ behavior: 'deny', message: '두레 도구는 승인 대상이 아니에요.' });
  expect(requests).toEqual([]);
  expect(e.pendingRequests(a.id)).toEqual([]);
});

// ── effort ──
// effort 는 세션 명령 `/effort <단계>` 로 정한다(probe9) — 설정 층(apply_flag_settings)엔 max 가 없고, get_settings 는 세션 값을 모른다.
const effortEvents = (e: Engine) => {
  const got: { agentId: string; effort: string | null; effortNow: string | null }[] = [];
  e.on('effort', (v) => got.push(v));
  return got;
};
const controlLines = () => readLog().filter((x) => typeof x.control === 'string').map((x) => x.control as string);
/** 엔진이 써 넣은 /effort 줄 — 가짜 claude 가 받은 차례대로 */
const effortLines = () => userTexts().filter((t) => t.startsWith('/effort'));

test('effort: 안 고른 에이전트는 /effort 없이 get_settings 만 — effortNow 는 내 설정(가짜 high)', async () => {
  const e = await start();
  const { a } = setup(e);
  const got = effortEvents(e);
  const ev = waitFor(e, 'effort', (x: any) => x.agentId === a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  expect(await ev).toEqual({ agentId: a.id, effort: null, effortNow: 'high' });
  await done;
  expect(effortLines()).toEqual([]);
  expect(controlLines()).toContain('get_settings');
  expect(controlLines()).not.toContain('apply_flag_settings');
  expect(e.effortNow(a.id)).toBe('high');
  expect(got).toHaveLength(1);
});

test('effort: 세션 없이 고르면 저장 + 사건만 — 띄우면 /effort xhigh 가 첫 줄, 사람 입력보다 먼저, 기록엔 없다', async () => {
  const e = await start();
  const { a } = setup(e);
  const got = effortEvents(e);
  await e.setEffort(a.id, 'xhigh');
  expect(agentOf(e, a.id).effort).toBe('xhigh');
  expect(got).toEqual([{ agentId: a.id, effort: 'xhigh', effortNow: null }]);
  expect(readLog()).toHaveLength(0);

  const heard = waitFor(e, 'effort', (x: any) => x.effortNow === 'xhigh');
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  expect(await heard).toEqual({ agentId: a.id, effort: 'xhigh', effortNow: 'xhigh' });
  expect(await resultText(done)).toBe('받음: echo 하나');
  expect(userTexts()).toEqual(['/effort xhigh', 'echo 하나']);
  expect(controlLines()).not.toContain('apply_flag_settings');
  expect(controlLines()).not.toContain('get_settings'); // 세션 effort 는 get_settings 에 안 보인다 — 묻지 않는다
  expect(e.history(a.id).filter((h) => h.kind === 'user')).toHaveLength(1);
  expect(JSON.stringify(e.history(a.id))).not.toContain('/effort');
  expect(e.effortNow(a.id)).toBe('xhigh');
});

test('effort: /effort 만 보낸 세션도 시작된 것 — 다음 실행은 --resume(같은 --session-id 는 진짜 claude 가 거절한다)', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setEffort(a.id, 'low');
  const heard = waitFor(e, 'effort', (x: any) => x.effortNow === 'low');
  await e.describe(a.id); // 세션만 켠다 — 사람 입력 없음
  await heard;
  expect(agentOf(e, a.id).started).toBe(true);
  await e.shutdown();
  const e2 = await start();
  await e2.describe(a.id);
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(agentOf(e2, a.id).sessionId);
});

test('effort: 살아 있는 한가한 세션에 max → /effort max 한 줄 · effortNow max · 기록·agent-event·작업 중 없음', async () => {
  const e = await start();
  const { a } = setup(e);
  const ctx = waitFor(e, 'context', (x: any) => x.agentId === a.id && x.value);
  await settledTurn(e, a.id);
  await ctx;
  const contextAsks = controlLines().filter((c) => c === 'get_context_usage').length;
  const seen: string[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === a.id && seen.push(`agent-event:${x.event.kind}`));
  e.on('history', (x: { agentId: string; item: { kind: string } }) => x.agentId === a.id && seen.push(`history:${x.item.kind}`));
  e.on('status', (x: StatusEvent) => x.agentId === a.id && seen.push(`status:${x.status}`));
  const got = effortEvents(e);
  const heard = waitFor(e, 'effort', (x: any) => x.effortNow === 'max');
  await e.setEffort(a.id, 'max');
  expect(await heard).toEqual({ agentId: a.id, effort: 'max', effortNow: 'max' });
  await sleep(200); // 늦게 오는 것이 없는지
  expect(effortLines()).toEqual(['/effort max']);
  expect(got).toEqual([
    { agentId: a.id, effort: 'max', effortNow: null },
    { agentId: a.id, effort: 'max', effortNow: 'max' },
  ]);
  expect(seen).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
  expect(controlLines().filter((c) => c === 'get_context_usage').length).toBe(contextAsks);
  expect(controlLines()).not.toContain('apply_flag_settings');
  expect(e.effortNow(a.id)).toBe('max');
});

test('effort: 일하는 중에 고르면 그 차례의 result 뒤에, 기다리던 사람 입력보다 먼저 — 줄에 선 것은 마지막 값 하나만', async () => {
  const e = await start();
  const { a } = setup(e);
  await settledTurn(e, a.id);
  await e.sendUser(a.id, text('SLOW'));
  await e.setEffort(a.id, 'low');
  await e.sendUser(a.id, text('echo 둘'));
  await e.setEffort(a.id, 'medium'); // 줄에 선 low 를 바꾼다
  await sleep(200);
  expect(effortLines()).toEqual([]); // 차례 중엔 쓰지 않는다
  expect(e.heldInput(a.id)).toBe(1); // /effort 는 사람 입력 수에 들지 않는다
  const heard = waitFor(e, 'effort', (x: any) => x.effortNow === 'medium');
  const done = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'result' && x.event.text.includes('둘'));
  await e.interrupt(a.id);
  e.resumeHold(a.id); // 멈추면 둘이 붙잡힌다 — 이어서 보내도 /effort 가 먼저
  await done;
  await heard;
  expect(userTexts()).toEqual(['echo 하나', 'SLOW', '/effort medium', 'echo 둘']);
  expect(e.effortNow(a.id)).toBe('medium');
});

test('effort: 승인을 기다리는 중에 고르면 그 차례가 끝난 뒤에 쓴다', async () => {
  const e = await start();
  const { a } = setup(e);
  const req = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id);
  await e.sendUser(a.id, text('ASK Write'));
  const r = await req;
  await e.setEffort(a.id, 'low');
  await sleep(200);
  expect(effortLines()).toEqual([]);
  const heard = waitFor(e, 'effort', (x: any) => x.effortNow === 'low');
  e.answerRequest(r.id, { type: 'allow' });
  await heard;
  expect(userTexts()).toEqual(['ASK Write', '/effort low']);
});

test('effort: /effort 답을 기다리는 사이 다시 고르면 옛 답으로 돌아갔다 오지 않는다', async () => {
  const e = await start({ FAKE_SLOW_EFFORT_MS: '300' });
  const { a } = setup(e);
  await settledTurn(e, a.id);
  const got = effortEvents(e);
  await e.setEffort(a.id, 'low');
  await until('/effort low 를 씀', () => effortLines().length === 1);
  await e.setEffort(a.id, 'max');
  await waitFor(e, 'effort', (x: any) => x.effortNow === 'max');
  expect(effortLines()).toEqual(['/effort low', '/effort max']);
  expect(got).toEqual([
    { agentId: a.id, effort: 'low', effortNow: null },
    { agentId: a.id, effort: 'max', effortNow: null },
    { agentId: a.id, effort: 'max', effortNow: 'max' },
  ]);
});

test('effort: 띄운 직후 get_settings 답이 오기 전에 고르면 늦게 온 기본값이 덮지 않는다', async () => {
  const e = await start({ FAKE_SLOW_CONTROL_MS: '300' });
  const { a } = setup(e);
  const got = effortEvents(e);
  await e.describe(a.id); // 세션만 켠다 — get_settings 는 300 ms 늦게
  await e.setEffort(a.id, 'max');
  await waitFor(e, 'effort', (x: any) => x.effortNow === 'max');
  await until('get_settings 를 물음', () => controlLines().includes('get_settings'));
  await sleep(500);
  expect(got).toEqual([
    { agentId: a.id, effort: 'max', effortNow: null },
    { agentId: a.id, effort: 'max', effortNow: 'max' },
  ]);
  expect(e.effortNow(a.id)).toBe('max');
});

test('effort: 확인 문구가 다르면(모르는 말) effortNow 는 비운 채 — 오류 없음', async () => {
  const e = await start({ FAKE_EFFORT_REPLY: 'Effort is not supported for this model' });
  const { a } = setup(e);
  await settledTurn(e, a.id);
  const errs: unknown[] = [];
  e.on('engine-error', (x) => errs.push(x));
  const got = effortEvents(e);
  await e.setEffort(a.id, 'max');
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 둘')); // /effort 차례가 끝나야 나간다
  expect(await resultText(done)).toBe('받음: echo 둘');
  expect(effortLines()).toEqual(['/effort max']);
  expect(got).toEqual([{ agentId: a.id, effort: 'max', effortNow: null }]);
  expect(e.effortNow(a.id)).toBeNull();
  expect(errs).toEqual([]);
});

test('effort: 모르는 단계는 던지고 저장하지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  await expect(e.setEffort(a.id, 'turbo' as any)).rejects.toThrow('알 수 없는 effort 예요.');
  expect(agentOf(e, a.id).effort).toBeNull();
});

/** 차례 하나를 끝내고 Claude 의 지금 effort(가짜 기본 high)를 읽어 둔다 */
async function settledTurn(e: Engine, id: string, want = 'high'): Promise<void> {
  const read = waitFor(e, 'effort', (x: any) => x.agentId === id && x.effortNow === want);
  const done = resultOf(e, id);
  await e.sendUser(id, text('echo 하나'));
  await done;
  await read;
}

test('effort: 새 대화 뒤 고르면 옛 세션의 지금 값(high)이 따라오지 않는다 — 사건의 effortNow 는 null', async () => {
  const e = await start();
  const { a } = setup(e);
  await settledTurn(e, a.id);
  const cleared = waitFor(e, 'effort', (x: any) => x.agentId === a.id && x.effortNow === null);
  await e.newConversation(a.id);
  expect(await cleared).toEqual({ agentId: a.id, effort: null, effortNow: null });
  expect(e.effortNow(a.id)).toBeNull();
  const got = effortEvents(e);
  await e.setEffort(a.id, 'low');
  expect(got).toEqual([{ agentId: a.id, effort: 'low', effortNow: null }]);
  expect(e.effortNow(a.id)).toBeNull();
});

test('effort: 살아 있는 세션에 고르면 먼저 지금 값을 잊고(null) /effort 답으로 다시 채운다', async () => {
  const e = await start();
  const { a } = setup(e);
  await settledTurn(e, a.id);
  const got = effortEvents(e);
  const refilled = waitFor(e, 'effort', (x: any) => x.effortNow === 'low');
  await e.setEffort(a.id, 'low');
  await refilled;
  expect(got).toEqual([
    { agentId: a.id, effort: 'low', effortNow: null },
    { agentId: a.id, effort: 'low', effortNow: 'low' },
  ]);
});

test('effort: 세션이 예기치 않게 끝나면 지금 값을 잊는다', async () => {
  const e = await start();
  const { a } = setup(e);
  await settledTurn(e, a.id);
  const cleared = waitFor(e, 'effort', (x: any) => x.agentId === a.id && x.effortNow === null);
  await e.sendUser(a.id, text('CRASH'));
  expect(await cleared).toEqual({ agentId: a.id, effort: null, effortNow: null });
  expect(e.effortNow(a.id)).toBeNull();
});

test('effort: 모델을 바꾸면 지금 값을 잊고, set_model 뒤 저장된 값을 /effort 로 다시 보낸다', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setEffort(a.id, 'low');
  await settledTurn(e, a.id, 'low');
  const got = effortEvents(e);
  const refilled = waitFor(e, 'effort', (x: any) => x.effortNow === 'low');
  await e.setModel(a.id, 'sonnet');
  expect(got[0]).toEqual({ agentId: a.id, effort: 'low', effortNow: null });
  await refilled;
  expect(got).toEqual([
    { agentId: a.id, effort: 'low', effortNow: null },
    { agentId: a.id, effort: 'low', effortNow: 'low' },
  ]);
  expect(effortLines()).toEqual(['/effort low', '/effort low']);
  const order = readLog().map((x) =>
    x.type === 'control_request' ? `control:${x.request?.subtype}` : x.type === 'user' ? `user:${x.message.content[0]?.text}` : '',
  );
  expect(order.lastIndexOf('user:/effort low')).toBeGreaterThan(order.indexOf('control:set_model'));
  expect(order.indexOf('control:set_model')).toBeGreaterThanOrEqual(0);
  expect(controlLines()).not.toContain('apply_flag_settings');
  expect(e.effortNow(a.id)).toBe('low');
});

test('effort: get_settings 답이 오기 전에 에이전트를 지우면 그 에이전트의 사건이 오지 않는다', async () => {
  const e = await start({ FAKE_SLOW_CONTROL_MS: '300' });
  const { a } = setup(e);
  const got = effortEvents(e);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await done;
  await e.removeAgent(a.id);
  await new Promise((r) => setTimeout(r, 600));
  expect(got.filter((x) => x.agentId === a.id)).toEqual([]);
  expect(e.effortNow(a.id)).toBeNull();
});

// ── effort: /effort 차례 중의 일(넘김 · 죽음 · 새 대화 · 답 없음 · 멈추기) ──
/** 답 없는 /effort 의 시험용 한도 — 바쁜 기계에서도 가짜 claude 가 뜨고 줄을 읽을 만큼 */
const EFFORT_WAIT = 1000;
/** 다시 띄우기를 거치는 차례의 result — 한도 + 끄기 + 다시 띄우기까지 */
const slowResultOf = (e: Engine, agentId: string) =>
  waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === agentId && x.event.kind === 'result', EFFORT_WAIT * 8);
/** 그 이름(-n)으로 뜬 프로세스마다, 받은 사용자 줄 — 띄운 차례대로(가짜 claude 가 줄마다 pid 를 남긴다) */
const linesByProcess = (name: string): string[][] => {
  const log = readLog();
  const pids = log.filter((x) => Array.isArray(x.argv) && flagValue(x.argv, '-n') === name).map((x) => x.pid);
  return pids.map((pid) =>
    log
      .filter((x) => x.type === 'user' && x.pid === pid)
      .map((x) => x.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')),
  );
};
const RELAY_HI = '[두레 메시지 — 보낸 쪽: A(기획)]\n안녕';

test('effort: 막 띄운 세션이 /effort 차례 중이면 넘김 메시지는 기다렸다가 그 뒤에 — 한 번만 기록', async () => {
  const e = await start({ FAKE_SLOW_EFFORT_MS: '400' });
  const { a, b } = setup(e);
  e.updateAgent(b.id, { auto: true });
  await e.setEffort(b.id, 'max');
  const aDone = resultOf(e, a.id);
  const bDone = resultOf(e, b.id);
  await e.sendUser(a.id, text('SEND B: 안녕'));
  expect(await resultText(aDone)).toBe('B 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
  expect(await resultText(bDone)).toBe(`받음: ${RELAY_HI}`);
  expect(linesByProcess('B')).toEqual([['/effort max', RELAY_HI]]);
  expect(e.history(b.id).filter((h) => h.kind === 'user')).toHaveLength(1);
  expect(e.messages()[0].state).toBe('delivered');
  expect(e.effortNow(b.id)).toBe('max');
});

test('effort: /effort 차례 중에 claude 가 죽으면 — 기록 없음 · 기다리던 입력은 남고 · 다음에 띄우면 다시 /effort 부터', async () => {
  const e = await start({ FAKE_SLOW_EFFORT_MS: '600' });
  const { b } = setup(e);
  await e.setEffort(b.id, 'low');
  await e.sendUser(b.id, text('echo 하나'));
  await until('/effort 를 씀', () => effortLines().length === 1);
  process.kill(lastSpawnOf('B').pid);
  await until('오류', () => e.status(b.id) === 'error');
  expect(e.heldInput(b.id)).toBe(1);
  const results: string[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === b.id && x.event.kind === 'result' && results.push(x.event.text));
  await e.sendUser(b.id, text('echo 둘'));
  await until('두 차례', () => results.length === 2);
  expect(results).toEqual(['받음: echo 하나', '받음: echo 둘']);
  expect(linesByProcess('B')).toEqual([['/effort low'], ['/effort low', 'echo 하나', 'echo 둘']]);
  expect(JSON.stringify(e.history(b.id, { all: true }))).not.toContain('/effort');
});

test('effort: /effort 차례 중에 새 대화 — 새 세션이 다시 /effort, 기다리던 입력은 그 뒤 · 옛 세션 것은 안 보인다', async () => {
  const e = await start({ FAKE_SLOW_EFFORT_MS: '400' });
  const { b } = setup(e);
  await e.setEffort(b.id, 'xhigh');
  await e.sendUser(b.id, text('echo 하나'));
  await until('/effort 를 씀', () => effortLines().length === 1);
  const events: string[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === b.id && events.push(x.event.kind));
  const done = resultOf(e, b.id);
  await e.newConversation(b.id);
  expect(await resultText(done)).toBe('받음: echo 하나');
  expect(linesByProcess('B')).toEqual([['/effort xhigh'], ['/effort xhigh', 'echo 하나']]);
  expect(events).toEqual(['init', 'text-delta', 'assistant', 'result']);
  expect(e.history(b.id).filter((h) => h.kind === 'user')).toHaveLength(1);
  expect(JSON.stringify(e.history(b.id, { all: true }))).not.toContain('/effort');
  expect(e.effortNow(b.id)).toBe('xhigh');
});

test('effort: /effort 에 끝내 답이 없으면 — 시간이 지나 다시 띄우고(effort 없이) 기다리던 입력을 보낸다 · engine-error · 고르면 다시 해 본다', async () => {
  const e = await start({ FAKE_EFFORT_SILENT: '1' }, false, { effortTimeoutMs: EFFORT_WAIT });
  const { b } = setup(e);
  const errs: { agentId: string | null; message: string }[] = [];
  e.on('engine-error', (x) => errs.push(x));
  const statuses: string[] = [];
  e.on('status', (x: StatusEvent) => x.agentId === b.id && statuses.push(x.status));
  await e.setEffort(b.id, 'max');
  const done = slowResultOf(e, b.id);
  await e.sendUser(b.id, text('echo 하나'));
  expect(e.status(b.id)).toBe('working'); // 첫 입력이 멈춘 듯 보이지 않게 — 멈추기도 켜진다
  expect(await resultText(done)).toBe('받음: echo 하나');
  expect(linesByProcess('B')).toEqual([['/effort max'], ['echo 하나']]);
  expect(errs).toEqual([{ agentId: b.id, message: expect.stringContaining('effort') }]);
  // 사람에게도 보이게 — 대화에 안내 한 줄(보낸 입력보다 앞)
  expect(e.history(b.id).slice(0, 2).map((h) => (h.kind === 'notice' ? `notice:${h.text}` : h.kind))).toEqual([
    'notice:effort 를 적용하지 못해 기본값으로 이어 가요',
    'user',
  ]);
  await until('내 설정(가짜 high)을 읽음', () => e.effortNow(b.id) === 'high'); // 적용 못 한 값 대신 실제로 쓰는 값
  expect(statuses).toEqual(['working', 'idle']); // 다시 띄우는 사이에 대기로 깜박이지 않는다

  await e.setEffort(b.id, 'low'); // 고르면 다시 /effort 를 해 본다
  await until('/effort low 를 씀', () => linesByProcess('B')[1]?.includes('/effort low') ?? false);
  await until('두 번째 시간 초과', () => errs.length === 2, EFFORT_WAIT * 6);
  await sleep(200);
  expect(spawnsOf('B')).toHaveLength(2); // 기다리는 입력·메시지가 없으면 다시 띄우지 않는다
  expect(e.status(b.id)).toBe('idle');
}, 20_000);

test('effort: 막힌 /effort 를 다시 띄우면 줄에 선 넘김 메시지도 새 세션으로 간다', async () => {
  const e = await start({ FAKE_EFFORT_SILENT: '1' }, false, { effortTimeoutMs: EFFORT_WAIT });
  const { a, b } = setup(e);
  e.updateAgent(b.id, { auto: true });
  await e.setEffort(b.id, 'max');
  const bDone = slowResultOf(e, b.id);
  await e.sendUser(a.id, text('SEND B: 안녕'));
  expect(await resultText(bDone)).toBe(`받음: ${RELAY_HI}`);
  expect(linesByProcess('B')).toEqual([['/effort max'], [RELAY_HI]]);
  expect(e.messages()[0].state).toBe('delivered');
  await e.setModel(b.id, 'sonnet'); // 모델을 바꾸면 다시 /effort 를 해 본다
  await until('/effort max 를 다시 씀', () => linesByProcess('B')[1]?.includes('/effort max') ?? false);
}, 20_000);

test('effort: 다시 띄우려고 옛 claude 를 끄는 중에 shutdown 해도 그 프로세스가 꺼질 때까지 기다린다', async () => {
  const e = await start({ FAKE_EFFORT_SILENT: '1', FAKE_IGNORE_STDIN_END: '1' }, false, { effortTimeoutMs: EFFORT_WAIT });
  const { b } = setup(e);
  await e.setEffort(b.id, 'max');
  const stuck = waitFor(e, 'engine-error', () => true, EFFORT_WAIT * 6);
  await e.sendUser(b.id, text('echo 하나'));
  await until('/effort 를 읽음', () => effortLines().length === 1);
  await stuck; // 다시 띄우기가 옛 프로세스를 끄기 시작했다(stdin 을 닫아도 안 꺼지는 claude)
  const { pid } = lastSpawnOf('B');
  await e.shutdown();
  expect(isAlive(pid)).toBe(false);
}, 20_000);

test('effort: 끄는 상한이 먼저 지나도(느린 강제 종료) shutdown 은 남은 claude 를 끄고 나간다 — 떠도는 프로세스 없음', async () => {
  // 상한(1초)을 점잖게 기다리는 시간(3초)보다 짧게 — 바쁜 PC 에서 taskkill 이 늦어 상한이 먼저 끝나는 경우를 늘 만든다
  const e = await start({ FAKE_EFFORT_SILENT: '1', FAKE_IGNORE_STDIN_END: '1' }, false, { effortTimeoutMs: EFFORT_WAIT, stopLimitMs: 1000 });
  const { b } = setup(e);
  await e.setEffort(b.id, 'max');
  const stuck = waitFor(e, 'engine-error', () => true, EFFORT_WAIT * 6);
  await e.sendUser(b.id, text('echo 하나'));
  await until('/effort 를 읽음', () => effortLines().length === 1);
  await stuck;
  const { pid } = lastSpawnOf('B');
  await e.shutdown();
  expect(isAlive(pid)).toBe(false);
}, 20_000);

test('effort: /effort 차례 중 멈추기 — 기다리던 입력은 붙잡고 다시 띄운다, 이어서 보내면 /effort 부터 다시, 고른 effort 는 그대로', async () => {
  const e = await start({ FAKE_SLOW_EFFORT_MS: '600' }); // 멀쩡하지만 느린 시작('보냈다, 아차, 멈춤')
  const { b } = setup(e);
  const errs: unknown[] = [];
  e.on('engine-error', (x) => errs.push(x));
  await e.setEffort(b.id, 'max');
  const done = resultOf(e, b.id);
  await e.sendUser(b.id, text('echo 하나'));
  await until('/effort 를 씀', () => effortLines().length === 1);
  expect(e.status(b.id)).toBe('working');
  await e.interrupt(b.id);
  expect(e.hold(b.id)!.items.map((i) => i.text)).toEqual(['echo 하나']);
  expect(e.status(b.id)).toBe('idle');
  e.resumeHold(b.id);
  expect(await resultText(done)).toBe('받음: echo 하나');
  expect(linesByProcess('B')).toEqual([['/effort max'], ['/effort max', 'echo 하나']]);
  expect(e.effortNow(b.id)).toBe('max'); // 화면이 기본값으로 돌아가지 않는다
  expect(errs).toEqual([]); // 사람이 멈춘 것 — 오류가 아니다
  expect(JSON.stringify(e.history(b.id))).not.toContain('멈췄어요');

  const next = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === b.id && x.event.kind === 'result' && x.event.text.includes('둘'));
  await e.sendUser(b.id, text('echo 둘'));
  await next;
  expect(linesByProcess('B')).toEqual([['/effort max'], ['/effort max', 'echo 하나', 'echo 둘']]);
  expect(e.effortNow(b.id)).toBe('max');
});

test('effort: /effort 차례 중 남은 승인 카드에서 멈추기 — 기다리는 입력이 없으면 카드만 치우고 세션은 그대로', async () => {
  const e = await start({ FAKE_SLOW_EFFORT_MS: '800' });
  const { a } = setup(e);
  await settledTurn(e, a.id);
  await e.setEffort(a.id, 'low');
  await until('/effort 를 씀', () => effortLines().length === 1);
  const req = waitFor<PendingRequest>(e, 'request');
  const stray = approveDirect(a.id, 'Edit'); // 떠난 프로세스가 남긴 것 같은 호출
  await req;
  expect(e.status(a.id)).toBe('awaiting');
  const heard = waitFor(e, 'effort', (x: any) => x.effortNow === 'low');
  await e.interrupt(a.id);
  expect(await stray).toEqual({ behavior: 'deny', message: '사용자가 멈췄습니다.' });
  await heard; // 같은 세션의 /effort 가 그대로 끝난다
  expect(spawnsOf('A')).toHaveLength(1);
  expect(e.status(a.id)).toBe('idle');
});

test('effort: /effort 차례가 끝나면 남은 승인 요청도 정리한다 — 차례가 끝났습니다', async () => {
  const e = await start({ FAKE_SLOW_EFFORT_MS: '300' });
  const { a } = setup(e);
  await settledTurn(e, a.id);
  await e.setEffort(a.id, 'low');
  await until('/effort 를 씀', () => effortLines().length === 1);
  const leftoverReq = waitFor<PendingRequest>(e, 'request');
  const leftover = approveDirect(a.id, 'Edit'); // 떠난 프로세스가 남긴 것 같은 호출
  await leftoverReq;
  expect(await leftover).toEqual({ behavior: 'deny', message: '차례가 끝났습니다.' });
  expect(e.pendingRequests()).toEqual([]);
  expect(e.effortNow(a.id)).toBe('low');
});

test('effort: 답이 로컬 출력(local-command-stdout)으로 와도 읽는다 — 기록엔 없다', async () => {
  const e = await start({ FAKE_EFFORT_LOCAL_OUTPUT: '1' });
  const { a } = setup(e);
  await settledTurn(e, a.id);
  const heard = waitFor(e, 'effort', (x: any) => x.effortNow === 'max');
  await e.setEffort(a.id, 'max');
  await heard;
  expect(JSON.stringify(e.history(a.id))).not.toContain('Set effort level');
});

test('effort: /effort 차례 중 온 rate-limit 은 평소처럼 알린다', async () => {
  const e = await start({ FAKE_EFFORT_RATE_LIMIT: '1' });
  const { a } = setup(e);
  await settledTurn(e, a.id);
  const rl = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'rate-limit');
  await e.setEffort(a.id, 'max');
  expect((await rl).event).toMatchObject({ kind: 'rate-limit', info: { status: 'allowed' } });
});

// ── context ──
const contextEvents = (e: Engine) => {
  const got: { agentId: string; value: any }[] = [];
  e.on('context', (v) => got.push(v));
  return got;
};
const RING = { total: 12000, max: 200000, percent: 6, autoCompactAt: 167000 };

test('context: 차례가 끝나면 대화 공간을 받아 사건 + 저장, 엔진을 다시 열어도 남는다', async () => {
  const e = await start();
  const { a } = setup(e);
  const ev = waitFor(e, 'context', (x: any) => x.agentId === a.id && x.value);
  await e.sendUser(a.id, text('echo 하나'));
  const got = await ev;
  expect(got.value).toMatchObject(RING);
  expect(typeof got.value.at).toBe('number');
  expect(agentOf(e, a.id).lastContext).toMatchObject(RING);
  expect(controlLines()).toContain('get_context_usage');
  await e.shutdown();
  const e2 = await start();
  expect(agentOf(e2, a.id).lastContext).toMatchObject(RING);
});

test('context: /compact 는 값을 비우고 그 차례 뒤엔 받지 않는다 — 다음 차례 뒤엔 다시 값', async () => {
  const e = await start();
  const { a } = setup(e);
  const first = waitFor(e, 'context', (x: any) => x.value);
  await e.sendUser(a.id, text('echo 하나'));
  await first;
  const got = contextEvents(e);
  const before = controlLines().filter((c) => c === 'get_context_usage').length;
  const cleared = waitFor(e, 'context', (x: any) => x.value === null);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('/compact'));
  await cleared;
  await done;
  await new Promise((r) => setTimeout(r, 300));
  expect(controlLines().filter((c) => c === 'get_context_usage').length).toBe(before);
  expect(got.map((x) => x.value)).toEqual([null]);
  expect(agentOf(e, a.id).lastContext).toBeNull();
  const again = waitFor(e, 'context', (x: any) => x.value);
  await e.sendUser(a.id, text('echo 둘'));
  expect((await again).value).toMatchObject(RING);
});

test('context: 새 대화는 값을 비운다', async () => {
  const e = await start();
  const { a } = setup(e);
  const first = waitFor(e, 'context', (x: any) => x.value);
  await e.sendUser(a.id, text('echo 하나'));
  await first;
  const cleared = waitFor(e, 'context', (x: any) => x.value === null);
  await e.newConversation(a.id);
  expect((await cleared).agentId).toBe(a.id);
  expect(agentOf(e, a.id).lastContext).toBeNull();
});

test('context: 답이 늦을 때 새 대화를 하면 늦게 온 값이 되살아나지 않는다', async () => {
  const e = await start({ FAKE_SLOW_CONTROL_MS: '300' });
  const { a } = setup(e);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await done;
  const got = contextEvents(e);
  await e.newConversation(a.id);
  await new Promise((r) => setTimeout(r, 700));
  expect(got.filter((x) => x.value !== null)).toEqual([]);
  expect(agentOf(e, a.id).lastContext).toBeNull();
});

// ── 사용량 ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`기다린 일이 일어나지 않음: ${what}`);
    await sleep(20);
  }
}
/** 사용량 전용 claude — 에이전트 실행엔 없는 --strict-mcp-config 로 뜬다 */
const probeSpawns = () => spawns().filter((s) => s.argv.includes('--strict-mcp-config'));
const PLAN = {
  windows: [
    { key: 'session', label: '5시간', percent: 12 },
    { key: 'week', label: '1주', percent: 34 },
    { key: 'model:Fable', label: 'Fable', percent: 81 },
  ],
};

test('usage: 에이전트 없이 시작 → 사용량 전용 claude 하나에 물어 사건 · engine.usage() 같은 값 · 답 뒤 그 프로세스는 꺼진다', async () => {
  const got: unknown[] = [];
  const e = await start({}, { startDelayMs: 0 });
  e.on('usage', (u) => got.push(u));
  const u = await waitFor(e, 'usage');
  expect(u).toMatchObject(PLAN);
  expect(typeof u.at).toBe('number');
  expect(e.usage()).toEqual(u);
  expect(spawns()).toHaveLength(1);
  const [probe] = probeSpawns();
  expect(probe).toBeDefined();
  expect(probe.argv.slice(probe.argv.indexOf('--disallowedTools') + 1)).toEqual(['SendMessage', 'ListAgents']);
  expect(probe.argv).not.toContain('--mcp-config');
  expect(probe.argv).not.toContain('-n');
  expect(probe.mcpToolTimeout).toBe('86400000'); // 에이전트와 같은 환경
  expect(controlRequests('get_usage').map((x) => x.request)).toEqual([{ subtype: 'get_usage', skip_behaviors: true }]);
  expect(fs.existsSync(path.join(dataDir, 'usage-probe'))).toBe(true);
  await until('사용량 전용 claude 종료', () => !isAlive(probe.pid));
  expect(got).toHaveLength(1);
});

test('usage: 사용량 전용 claude 가 답을 안 하면 시간이 지나 끄고 사건 없음 · 다시 띄우지 않음 · shutdown 뒤 남은 프로세스 없음', async () => {
  const got: unknown[] = [];
  const e = await start({ FAKE_USAGE_HANG: '1' }, { startDelayMs: 0, timeoutMs: 300 });
  e.on('usage', (u) => got.push(u));
  await until('get_usage 요청', () => controlRequests('get_usage').length === 1);
  const [probe] = probeSpawns();
  await until('시간 초과 뒤 사용량 전용 claude 종료', () => !isAlive(probe.pid));
  await sleep(300);
  expect(got).toEqual([]);
  expect(e.usage()).toBeNull();
  expect(probeSpawns()).toHaveLength(1);
  await e.shutdown();
  expect(isAlive(probe.pid)).toBe(false);
});

test('usage: 답을 기다리던 사용량 전용 claude 는 shutdown 때 함께 꺼진다', async () => {
  const e = await start({ FAKE_USAGE_HANG: '1' }, { startDelayMs: 0 });
  await until('get_usage 요청', () => controlRequests('get_usage').length === 1);
  const [probe] = probeSpawns();
  expect(isAlive(probe.pid)).toBe(true);
  await e.shutdown();
  expect(isAlive(probe.pid)).toBe(false);
});

test('usage: 차례가 끝나면 살아 있는 에이전트 세션에 묻는다 — 사용량 전용 claude 는 안 띄우고, 1분 안의 refreshUsage 는 다시 묻지 않는다', async () => {
  const e = await start({}, { startDelayMs: 60_000 });
  const { a } = setup(e);
  const got = waitFor(e, 'usage');
  await e.sendUser(a.id, text('echo 하나'));
  expect(await got).toMatchObject(PLAN);
  expect(probeSpawns()).toEqual([]);
  expect(spawnsOf('A')).toHaveLength(1);
  expect(controlRequests('get_usage')).toHaveLength(1);
  e.refreshUsage();
  await sleep(300);
  expect(controlRequests('get_usage')).toHaveLength(1);
});

test('usage: 서브에이전트만 돌아도(부모 차례는 끝나 세션은 쉼) 일하는 중으로 쳐 주기마다 묻는다', async () => {
  const gate = path.join(dir, 'gate'); // 만들지 않는다 — 서브에이전트는 끝나지 않는다
  const e = await start({ FAKE_SUB_GATE: gate }, { startDelayMs: 60_000, pollMs: 150 });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  expect(e.subagentsRunning(a.id)).toHaveLength(1);
  await until('차례 끝에 묻기', () => controlRequests('get_usage').length >= 1);
  const before = controlRequests('get_usage').length;
  await until('서브에이전트만 도는 동안 주기 묻기', () => controlRequests('get_usage').length >= before + 2, 3000);
});

test('usage: false 면 묻지 않는다 — usage() 는 null, refreshUsage 는 아무 일도 안 한다', async () => {
  const e = await start();
  const { a } = setup(e);
  e.refreshUsage();
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await done;
  await sleep(300);
  expect(controlRequests('get_usage')).toEqual([]);
  expect(probeSpawns()).toEqual([]);
  expect(e.usage()).toBeNull();
});

// ── 묻지 않음(bypass) ──
// 허용(설정)이 켜져 있으면 --allow-dangerously-skip-permissions 로 띄우고, 사용자가 켠 에이전트만 set_permission_mode 로 켠다(probe10·11).
const ALLOW_FLAG = '--allow-dangerously-skip-permissions';
const NOT_ALLOWED = '설정에서 묻지 않고 실행을 허용해야 켤 수 있어요.';
const ON_FAILED = "'묻지 않음'을 켜지 못했어요 — Claude 가 권한 모드를 바꾸지 않았어요.";
const ON_FAILED_NOTICE = "'묻지 않음'을 켜지 못해 평소처럼 승인을 물어요";
interface FlagsEvent {
  agentId: string;
  bypass: boolean;
  bySettings: boolean;
  pending: boolean;
}
/** 그 이름(-n)으로 뜬 프로세스마다, 받은 set_permission_mode('mode:<모드>')와 사용자 줄 — 받은 차례대로 */
const modeLines = (name: string): string[][] => {
  const log = readLog();
  const pids = log.filter((x) => Array.isArray(x.argv) && flagValue(x.argv, '-n') === name).map((x) => x.pid);
  return pids.map((pid) =>
    log
      .filter((x) => x.pid === pid && (x.type === 'user' || (x.type === 'control_request' && x.request?.subtype === 'set_permission_mode')))
      .map((x) =>
        x.type === 'user'
          ? x.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
          : `mode:${x.request.mode}`,
      ),
  );
};
const flagEvents = (e: Engine) => {
  const got: FlagsEvent[] = [];
  e.on('flags', (f: FlagsEvent) => got.push(f));
  return got;
};
const noticesOf = (e: Engine, id: string) => e.history(id).flatMap((h) => (h.kind === 'notice' ? [h.text] : []));
async function turn(e: Engine, id: string, t: string): Promise<void> {
  const done = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === id && x.event.kind === 'result' && x.event.text.includes(t));
  await e.sendUser(id, text(t));
  await done;
}

test('bypass: 허용이 꺼져 있으면 옵션 없이 띄우고 set_permission_mode 를 보내지 않는다 · setBypass(true) 는 던진다', async () => {
  const e = await start();
  const { a } = setup(e);
  await expect(e.setBypass(a.id, true)).rejects.toThrow(NOT_ALLOWED);
  expect(agentOf(e, a.id).bypassOn).toBe(false);
  await turn(e, a.id, 'echo 하나');
  await expect(e.setBypass(a.id, true)).rejects.toThrow(NOT_ALLOWED); // 세션이 있어도
  await sleep(100);
  expect(lastSpawnOf('A').argv).not.toContain(ALLOW_FLAG);
  expect(lastSpawnOf('A').argv).not.toContain('--dangerously-skip-permissions');
  expect(controlRequests('set_permission_mode')).toEqual([]);
  expect(agentOf(e, a.id).bypassOn).toBe(false);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

test('bypass: 허용 + 스위치 켜짐이면 옵션을 붙여 띄우고, 사람 입력보다 먼저 set_permission_mode bypassPermissions — flags {bypass:true, bySettings:false}', async () => {
  const e = await start();
  const { a, b } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true); // 세션이 없으면 저장만
  await e.setEffort(a.id, 'low'); // /effort 도 입력이다 — 그보다 먼저
  expect(agentOf(e, a.id).bypassOn).toBe(true);
  expect(spawns()).toEqual([]);
  const on = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === a.id && f.bypass);
  await turn(e, a.id, 'echo 하나');
  expect(await on).toEqual({ agentId: a.id, bypass: true, bySettings: false, pending: false });
  expect(lastSpawnOf('A').argv).toContain(ALLOW_FLAG);
  expect(lastSpawnOf('A').argv).not.toContain('--dangerously-skip-permissions');
  expect(lastSpawnOf('A').argv).not.toContain('--permission-mode');
  // 로그 순서: set_permission_mode 가 첫 사용자 줄(/effort 포함)보다 앞
  expect(modeLines('A')).toEqual([['mode:bypassPermissions', '/effort low', 'echo 하나']]);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(e.flags(b.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

test('bypass: 허용만 켜고 스위치는 꺼짐이면 옵션은 붙지만 평소 모드 — flags.bypass false', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  const got = flagEvents(e);
  await turn(e, a.id, 'echo 하나');
  expect(lastSpawnOf('A').argv).toContain(ALLOW_FLAG);
  expect(controlRequests('set_permission_mode')).toEqual([]);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(got.filter((f) => f.agentId === a.id && f.bypass)).toEqual([]);
});

test('bypass: 쉬는 에이전트를 켜면 다음 차례를 기다리지 않고 flags.bypass true(응답의 mode)', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await turn(e, a.id, 'echo 하나'); // 옵션으로 떠 있고 쉰다
  const got = flagEvents(e);
  await e.setBypass(a.id, true);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false }); // 다음 init 을 기다리지 않는다
  expect(got.at(-1)).toEqual({ agentId: a.id, bypass: true, bySettings: false, pending: false });
  expect(spawnsOf('A')).toHaveLength(1); // 다시 띄우지 않는다
  expect(modeLines('A')).toEqual([['echo 하나', 'mode:bypassPermissions']]);
  expect(e.status(a.id)).toBe('idle');
  await turn(e, a.id, 'echo 둘'); // 다음 차례의 init 도 같은 모드
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(spawnsOf('A')).toHaveLength(1);
});

test('bypass: 옵션 없이 떠 있던 세션에서 켜면 다시 띄워(--resume) 켜지고, 일하는 중이면 그 차례 뒤에 — 기다리던 입력은 새 세션으로', async () => {
  const e = await start();
  const { a, b } = setup(e);
  await turn(e, a.id, 'echo 하나'); // 허용 전에 띄운 세션 — 옵션 없음
  await e.sendUser(b.id, text('SLOW')); // B 는 일하는 중
  await e.setAllowBypass(true);

  // 쉬는 A — 바로 끝내고 옵션을 붙여 다시 띄운다(대화 그대로)
  await e.setBypass(a.id, true);
  expect(spawnsOf('A')).toHaveLength(2);
  expect(lastSpawnOf('A').argv).toContain(ALLOW_FLAG);
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(agentOf(e, a.id).sessionId);
  expect(modeLines('A')).toEqual([['echo 하나'], ['mode:bypassPermissions']]);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(e.status(a.id)).toBe('idle');

  // 일하는 B — 그 차례가 끝난 뒤에. 그새 넣은 입력은 새 세션이 받는다
  await e.setBypass(b.id, true);
  await e.sendUser(b.id, text('echo 둘'));
  await sleep(200);
  expect(spawnsOf('B')).toHaveLength(1);
  expect(e.heldInput(b.id)).toBe(1);
  const on = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === b.id && f.bypass);
  const done = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === b.id && x.event.kind === 'result' && x.event.text.includes('둘'));
  await e.interrupt(b.id);
  e.resumeHold(b.id); // 멈추면 둘이 붙잡힌다 — 이어서 보낸다
  expect(await resultText(done)).toBe('받음: echo 둘');
  expect(await on).toEqual({ agentId: b.id, bypass: true, bySettings: false, pending: false });
  expect(spawnsOf('B')).toHaveLength(2);
  expect(flagValue(lastSpawnOf('B').argv, '--resume')).toBe(agentOf(e, b.id).sessionId);
  expect(modeLines('B')).toEqual([['SLOW'], ['mode:bypassPermissions', 'echo 둘']]);
  expect(e.heldInput(b.id)).toBe(0);
  expect(controlRequests('set_permission_mode').map((x) => x.pid)).toEqual([lastSpawnOf('A').pid, lastSpawnOf('B').pid]); // 옵션 없는 세션엔 보내지 않는다
});

test('bypass: 끄면 get_settings 의 기본 모드로 — 기본 모드가 bypass(FAKE_PERMISSION_MODE)면 flags {bypass:true, bySettings:true}', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  await turn(e, a.id, 'echo 하나');
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  await e.setBypass(a.id, false);
  expect(agentOf(e, a.id).bypassOn).toBe(false);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(modeLines('A')).toEqual([['mode:bypassPermissions', 'echo 하나', 'mode:default']]);
  expect(spawnsOf('A')).toHaveLength(1);
  await e.shutdown();

  // 내 Claude 설정의 기본 모드가 bypassPermissions — 두레 스위치를 꺼도 내 설정을 따른다(켜져 있어도 원인은 내 설정)
  const e2 = await start({ FAKE_PERMISSION_MODE: 'bypassPermissions' });
  await e2.setBypass(a.id, true);
  await turn(e2, a.id, 'echo 둘');
  expect(e2.flags(a.id)).toEqual({ bypass: true, bySettings: true, pending: false });
  await e2.setBypass(a.id, false);
  expect(modeLines('A').at(-1)).toEqual(['mode:bypassPermissions', 'echo 둘', 'mode:bypassPermissions']);
  expect(e2.flags(a.id)).toEqual({ bypass: true, bySettings: true, pending: false });
});

test('bypass: 허용을 끄면 켜져 있던 세션은 바로 평소 모드 · 떠 있던 승인 카드는 그대로 · 다시 띄우지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  const on = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === a.id && f.bypass);
  const req = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id);
  await e.sendUser(a.id, text('ASK Write'));
  await on;
  const r = await req;

  await e.setAllowBypass(false);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(agentOf(e, a.id).bypassOn).toBe(false);
  expect(e.pendingRequests(a.id).map((x) => x.id)).toEqual([r.id]); // 승인 카드는 그대로
  expect(e.status(a.id)).toBe('awaiting');
  expect(spawnsOf('A')).toHaveLength(1);
  expect(modeLines('A')).toEqual([['mode:bypassPermissions', 'ASK Write', 'mode:default']]);

  const done = resultOf(e, a.id);
  e.answerRequest(r.id, { type: 'allow' });
  expect(await resultText(done)).toBe('ok');
  expect(spawnsOf('A')).toHaveLength(1);

  // 다음에 띄울 때는 옵션 없이
  await e.newConversation(a.id);
  await turn(e, a.id, 'echo 하나');
  expect(lastSpawnOf('A').argv).not.toContain(ALLOW_FLAG);
  expect(modeLines('A').at(-1)).toEqual(['echo 하나']);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

test('bypass: 오류 뒤·새 대화·effort 다시 띄우기에도 켠 에이전트만 다시 켜진다', async () => {
  const e = await start({ FAKE_EFFORT_SILENT: '1' }, false, { effortTimeoutMs: EFFORT_WAIT });
  const { a, b } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);

  // 오류 뒤
  const crashed = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');
  await e.sendUser(a.id, text('CRASH'));
  await crashed;
  await turn(e, a.id, 'echo 하나');
  await turn(e, b.id, 'echo 하나');
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });

  // 새 대화
  await e.newConversation(a.id);
  await turn(e, a.id, 'echo 둘');
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });

  // effort 의 다시 띄우기(/effort 에 답이 없음)
  await e.setEffort(a.id, 'max');
  const done = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'result' && x.event.text.includes('셋'), EFFORT_WAIT * 8);
  await e.sendUser(a.id, text('echo 셋'));
  await done;
  await until('켜짐', () => e.flags(a.id).bypass);

  expect(modeLines('A')).toEqual([
    ['mode:bypassPermissions', 'CRASH'],
    ['mode:bypassPermissions', 'echo 하나'],
    ['mode:bypassPermissions', 'echo 둘', '/effort max'],
    ['mode:bypassPermissions', 'echo 셋'],
  ]);
  for (const s of spawnsOf('A')) expect(s.argv).toContain(ALLOW_FLAG);
  expect(modeLines('B')).toEqual([['echo 하나']]); // 켜지 않은 에이전트는 평소 모드
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(e.flags(b.id)).toEqual({ bypass: false, bySettings: false, pending: false });
}, 20_000);

test('bypass: 앱을 다시 켜도(같은 dataDir 의 새 엔진) 켠 에이전트만 켜진다 · 허용이 꺼진 채 bypassOn:true 가 남아 있으면 끈 것으로 친다', async () => {
  const e = await start();
  const { a, b } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  await e.shutdown();

  const e2 = await start();
  expect(agentOf(e2, a.id).bypassOn).toBe(true);
  expect(agentOf(e2, b.id).bypassOn).toBe(false);
  await turn(e2, a.id, 'echo 하나');
  await turn(e2, b.id, 'echo 하나');
  expect(modeLines('A')).toEqual([['mode:bypassPermissions', 'echo 하나']]);
  expect(modeLines('B')).toEqual([['echo 하나']]);
  expect(e2.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(e2.flags(b.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  await e2.shutdown();

  // 손으로 고친 파일 — 허용은 꺼졌는데 에이전트 저장값은 켜짐
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ allowBypass: false }));
  const e3 = await start();
  expect(e3.allowBypass()).toBe(false);
  expect(agentOf(e3, a.id).bypassOn).toBe(true);
  await turn(e3, a.id, 'echo 둘');
  expect(lastSpawnOf('A').argv).not.toContain(ALLOW_FLAG);
  expect(modeLines('A').at(-1)).toEqual(['echo 둘']);
  expect(e3.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  // 그 뒤 허용을 켜도 남아 있던 켜짐은 살아나지 않는다 — 허용을 켠 순간 모두 꺼진 채
  await e3.setAllowBypass(true);
  expect(agentOf(e3, a.id).bypassOn).toBe(false);
  await e3.newConversation(a.id);
  await turn(e3, a.id, 'echo 셋');
  expect(lastSpawnOf('A').argv).toContain(ALLOW_FLAG);
  expect(modeLines('A').at(-1)).toEqual(['echo 셋']);
  expect(e3.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

test('bypass: set_permission_mode 실패(FAKE_SET_MODE_FAIL) · 응답 없음(FAKE_SET_MODE_SILENT)이면 bypassOn 은 false 로 되돌아가고 engine-error + 대화에 안내 한 줄', async () => {
  // 오류 응답 — 살아 있는 세션에서 켜기
  const e = await start({ FAKE_SET_MODE_FAIL: 'bypassPermissions' });
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await turn(e, a.id, 'echo 하나');
  const errs: { agentId: string | null; message: string }[] = [];
  e.on('engine-error', (x) => errs.push(x));
  const got = flagEvents(e);
  await e.setBypass(a.id, true);
  // 실패한 켜기 뒤엔 끄기(내 기본 모드)를 이어 보낸다 — 늦게라도 적용된 켜기를 덮게
  expect(modeLines('A')).toEqual([['echo 하나', 'mode:bypassPermissions', 'mode:default']]);
  expect(spawnsOf('A')).toHaveLength(1);
  expect(agentOf(e, a.id).bypassOn).toBe(false);
  expect(openStore(dataDir).agent(a.id)!.bypassOn).toBe(false);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(got.at(-1)).toEqual({ agentId: a.id, bypass: false, bySettings: false, pending: false }); // 마지막 실제 모드
  expect(errs).toEqual([{ agentId: a.id, message: ON_FAILED }]);
  expect(noticesOf(e, a.id)).toEqual([ON_FAILED_NOTICE]);
  await e.shutdown();

  // 응답 없음 — 띄울 때 켜기(띄울 때의 한도도 시험 옵션 bypassTimeoutMs 를 따른다)
  const e2 = await start({ FAKE_SET_MODE_SILENT: 'bypassPermissions' }, false, { bypassTimeoutMs: 300 });
  const errs2: { agentId: string | null; message: string }[] = [];
  e2.on('engine-error', (x) => errs2.push(x));
  await e2.setBypass(a.id, true);
  const failed = waitFor(e2, 'engine-error', () => true, 3000);
  await turn(e2, a.id, 'echo 둘'); // 사람 입력은 막히지 않는다
  await failed;
  const settled = waitFor<FlagsEvent>(e2, 'flags', (f) => f.agentId === a.id); // 이어 보낸 끄기의 답
  expect(await settled).toEqual({ agentId: a.id, bypass: false, bySettings: false, pending: false });
  expect(modeLines('A').at(-1)).toEqual(['mode:bypassPermissions', 'echo 둘', 'mode:default']);
  expect(agentOf(e2, a.id).bypassOn).toBe(false);
  expect(openStore(dataDir).agent(a.id)!.bypassOn).toBe(false);
  expect(e2.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(errs2).toEqual([{ agentId: a.id, message: ON_FAILED }]);
  expect(noticesOf(e2, a.id)).toEqual([ON_FAILED_NOTICE, ON_FAILED_NOTICE]);
});

// ── 묻지 않음: 실패 뒤 바로잡기(fix 1) ──
const OFF_FAILED = "'묻지 않음'을 끄지 못했어요 — Claude 가 권한 모드를 바꾸지 않았어요.";
const OFF_FAILED_NOTICE = "'묻지 않음'을 끄지 못해 쉴 때 다시 띄워 평소처럼 승인을 물어요";
const initModes = (e: Engine, id: string) => {
  const got: string[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === id && x.event.kind === 'init' && got.push(x.event.permissionMode));
  return got;
};

test('bypass: 답 없이 지난 켜기가 늦게 적용돼도 이어 보낸 끄기가 덮는다 — 다음 차례는 묻고, 스위치는 잠기지 않는다', async () => {
  // 켜기 요청은 3 초 뒤에야 적용·답한다(엔진 한도 2 초) — 진짜 claude 는 제어 요청을 차례대로 처리하니 이어 보낸 끄기는 그 뒤에.
  // 여유는 양쪽 다 약 1 초: 켜기는 한도(2 초)가 적용(3 초)보다 먼저 지나고, 2 초쯤 보낸 끄기는 3 초쯤 답해 제 한도(2 초) 안이다
  // (끄기도 같은 한도라 한도를 1 초로 두면 끄기마저 지나 다시 띄운다 — 바쁜 PC 에서 흔들리지 않게 둘 다 넓혔다)
  const e = await start({ FAKE_SET_MODE_LATE_MS: '3000' }, false, { bypassTimeoutMs: 2000 });
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  const errs: { agentId: string | null; message: string }[] = [];
  e.on('engine-error', (x) => errs.push(x));
  const modes = initModes(e, a.id);
  const failed = waitFor(e, 'engine-error', () => true, 5000);
  await turn(e, a.id, 'echo 하나');
  await failed;
  expect(agentOf(e, a.id).bypassOn).toBe(false);
  // 늦은 켜기 뒤에 처리된 끄기의 답 — 늦은 켜기가 적용되는 순간도 status 줄(probe16)로 보여 잠깐 bypass 로 알린 뒤 끄기가 덮는다
  const settled = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === a.id && !f.bypass, 8000);
  expect(await settled).toEqual({ agentId: a.id, bypass: false, bySettings: false, pending: false });
  await turn(e, a.id, 'echo 둘');
  expect(modes).toEqual(['default', 'default']); // 다음 차례도 묻는 모드
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(modeLines('A')).toEqual([['mode:bypassPermissions', 'echo 하나', 'mode:default', 'echo 둘']]);
  expect(errs).toEqual([{ agentId: a.id, message: ON_FAILED }]);
  expect(noticesOf(e, a.id)).toEqual([ON_FAILED_NOTICE]);
}, 20_000);

test('bypass: 옵션으로 뜬 세션이 스위치가 꺼진 채 bypass 로 알리면(init) 내 기본 모드로 맞춘다 — 내 설정이 bypass 면 그대로', async () => {
  // 시작부터 bypass(엔진 모르게 늦게 적용된 켜기 흉내) · 내 설정의 기본 모드는 default
  const e = await start({ FAKE_START_MODE: 'bypassPermissions' });
  const { a } = setup(e);
  await e.setAllowBypass(true); // 스위치는 꺼짐
  const settled = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === a.id && !f.bypass && controlRequests('set_permission_mode').length === 1);
  await turn(e, a.id, 'echo 하나');
  await settled;
  await turn(e, a.id, 'echo 둘');
  expect(modeLines('A')).toEqual([['echo 하나', 'mode:default', 'echo 둘']]);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  await e.shutdown();

  // 내 설정이 bypass 면 맞출 것이 없다
  const e2 = await start({ FAKE_PERMISSION_MODE: 'bypassPermissions' });
  const x = e2.addAgent({ roomId: e2.rooms()[0].id, name: 'X', role: 'r', folder: folder('x') });
  await turn(e2, x.id, 'echo 하나');
  await turn(e2, x.id, 'echo 둘');
  await sleep(100);
  expect(modeLines('X')).toEqual([['echo 하나', 'echo 둘']]);
  expect(e2.flags(x.id)).toEqual({ bypass: true, bySettings: true, pending: false });
});

test('bypass: 끄기에 실패하면 쉴 때 다시 띄워(--resume) 평소 모드로 — 차례는 끊지 않고 대화는 그대로', async () => {
  const e = await start({ FAKE_SET_MODE_FAIL: 'default' });
  const { a, b } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  await e.setBypass(b.id, true);
  await turn(e, a.id, 'echo 하나');
  const errs: { agentId: string | null; message: string }[] = [];
  e.on('engine-error', (x) => errs.push(x));

  // 쉬는 A — 바로 다시 띄운다. 새 세션은 bypass 를 보내지 않는다(스위치 꺼짐)
  await e.setBypass(a.id, false);
  expect(errs).toEqual([{ agentId: a.id, message: OFF_FAILED }]);
  expect(noticesOf(e, a.id)).toEqual([OFF_FAILED_NOTICE]);
  await until('A 를 다시 띄움', () => spawnsOf('A').length === 2); // 가짜 claude 는 뜬 뒤에 argv 를 남긴다
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(agentOf(e, a.id).sessionId);
  await turn(e, a.id, 'echo 둘');
  expect(modeLines('A')).toEqual([['mode:bypassPermissions', 'echo 하나', 'mode:default'], ['echo 둘']]);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(e.history(a.id).filter((h) => h.kind === 'user')).toHaveLength(2);

  // 일하는 B — 두레가 켠 채 남은 bypass 는 잠그지 않고(다시 끌 수 있게), 그 차례가 끝난 뒤에 다시 띄운다
  const onB = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === b.id && f.bypass);
  await e.sendUser(b.id, text('SLOW'));
  await onB;
  await e.setBypass(b.id, false);
  expect(e.flags(b.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  await sleep(200);
  expect(spawnsOf('B')).toHaveLength(1);
  const done = resultOf(e, b.id);
  await e.interrupt(b.id);
  await done;
  await until('B 를 다시 띄움', () => spawnsOf('B').length === 2);
  await turn(e, b.id, 'echo 하나');
  expect(modeLines('B')).toEqual([['mode:bypassPermissions', 'SLOW', 'mode:default'], ['echo 하나']]);
  expect(flagValue(lastSpawnOf('B').argv, '--resume')).toBe(agentOf(e, b.id).sessionId);
  expect(e.flags(b.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

test('bypass: 허용을 끄면 스위치는 꺼졌지만 두레가 켠 채 남은 세션도 평소 모드로', async () => {
  const e = await start({ FAKE_SET_MODE_FAIL: 'default:once' }); // 첫 끄기만 실패
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  const on = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === a.id && f.bypass);
  await e.sendUser(a.id, text('SLOW')); // 일하는 중 — 다시 띄우기는 차례 뒤
  await on;
  await e.setBypass(a.id, false); // 실패 — bypass 가 남는다
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(agentOf(e, a.id).bypassOn).toBe(false);

  await e.setAllowBypass(false);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(modeLines('A')).toEqual([['mode:bypassPermissions', 'SLOW', 'mode:default', 'mode:default']]);
  // 이미 평소 모드라 차례가 끝나도 다시 띄우지 않는다
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  await done;
  await sleep(200);
  expect(spawnsOf('A')).toHaveLength(1);
});

test('bypass: bySettings 는 get_settings 의 내 기본 모드가 bypass 일 때만(probe12) — 두레가 켠 bypass 는 내 설정 탓이 아니다', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  await turn(e, a.id, 'echo 하나');
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  await e.shutdown();

  // 내 설정이 bypass — 스위치가 꺼져 있든 켜져 있든 원인은 내 설정(끌 수 없다)
  const e2 = await start({ FAKE_PERMISSION_MODE: 'bypassPermissions' });
  const x = e2.addAgent({ roomId: e2.rooms()[0].id, name: 'X', role: 'r', folder: folder('x') });
  await turn(e2, x.id, 'echo 하나');
  expect(e2.flags(x.id)).toEqual({ bypass: true, bySettings: true, pending: false });
  await e2.setBypass(x.id, true);
  expect(e2.flags(x.id)).toEqual({ bypass: true, bySettings: true, pending: false });
  expect(e2.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false }); // 아직 안 띄움 — 다음에 띄울 때의 모드(허용 + 스위치 켜짐)
});

test('bypass: 켜고 바로 끄면 옛 켜기의 실패(답 없음)는 무시한다 — 되돌리기·오류·덧붙인 끄기 없음', async () => {
  const e = await start({ FAKE_SET_MODE_SILENT: 'bypassPermissions' }, false, { bypassTimeoutMs: 300 });
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await turn(e, a.id, 'echo 하나');
  const errs: unknown[] = [];
  e.on('engine-error', (x) => errs.push(x));
  const on = e.setBypass(a.id, true); // 답이 오지 않는다
  await e.setBypass(a.id, false);
  await on; // 한도가 지나 끝난다
  await sleep(200);
  expect(errs).toEqual([]);
  expect(noticesOf(e, a.id)).toEqual([]);
  expect(agentOf(e, a.id).bypassOn).toBe(false);
  expect(modeLines('A')).toEqual([['echo 하나', 'mode:bypassPermissions', 'mode:default']]);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

test('bypass: 일하는 중이라 미뤄 둔 다시 띄우기는 끄거나 허용을 끄면 거둔다', async () => {
  const e = await start();
  const { a, b } = setup(e);
  await e.sendUser(a.id, text('SLOW')); // 허용 전에 띄움 — 옵션 없음
  await e.sendUser(b.id, text('SLOW'));
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true); // 그 차례 뒤로 미룬다
  await e.setBypass(a.id, false); // 거둔다
  await e.setBypass(b.id, true);
  await e.setAllowBypass(false); // 허용을 꺼도 거둔다
  const doneA = resultOf(e, a.id);
  const doneB = resultOf(e, b.id);
  await e.interrupt(a.id);
  await e.interrupt(b.id);
  await doneA;
  await doneB;
  await sleep(300);
  expect(spawnsOf('A')).toHaveLength(1);
  expect(spawnsOf('B')).toHaveLength(1);
  expect(controlRequests('set_permission_mode')).toEqual([]);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(e.flags(b.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

test('bypass: 띄울 때 상태 알림을 듣는 쪽이 그 자리에서 입력을 보내도 set_permission_mode 가 먼저', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  const crashed = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');
  await e.sendUser(a.id, text('CRASH'));
  await crashed;
  let sent = false;
  e.on('status', (s: StatusEvent) => {
    // 오류 → 대기로 바뀌는 알림(다시 띄우는 순간)에서 바로 입력
    if (s.agentId !== a.id || s.status !== 'idle' || sent) return;
    sent = true;
    void e.sendUser(a.id, text('echo 끼어듦'));
  });
  const done = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'result' && x.event.text.includes('끼어듦'));
  await e.describe(a.id); // 입력 없이 띄운다
  await done;
  expect(sent).toBe(true);
  expect(modeLines('A').at(-1)).toEqual(['mode:bypassPermissions', 'echo 끼어듦']);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
});

test('bypass: 다시 띄우는 도중에 끄거나 허용을 끄면 새 세션은 켜지 않는다', async () => {
  const e = await start();
  const { a, b } = setup(e);
  await turn(e, a.id, 'echo 하나'); // 허용 전에 띄움 — 옵션 없음
  await turn(e, b.id, 'echo 하나');
  await e.setAllowBypass(true);
  const pa = e.setBypass(a.id, true); // 쉬는 A — 옛 세션을 끄는 중
  await e.setBypass(a.id, false);
  await pa;
  await until('A 를 다시 띄움', () => spawnsOf('A').length === 2); // 가짜 claude 는 뜬 뒤에 argv 를 남긴다
  expect(lastSpawnOf('A').argv).toContain(ALLOW_FLAG);
  const pb = e.setBypass(b.id, true);
  await e.setAllowBypass(false);
  await pb;
  await until('B 를 다시 띄움', () => spawnsOf('B').length === 2);
  expect(lastSpawnOf('B').argv).not.toContain(ALLOW_FLAG);
  await turn(e, a.id, 'echo 둘');
  await turn(e, b.id, 'echo 둘');
  expect(controlRequests('set_permission_mode')).toEqual([]);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(e.flags(b.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

// 살아 있는 세션이 없으면 flags 는 다음에 띄울 때의 모드 — 저장된 켜짐이 꺼짐으로 보여 스위치가 갇히지 않게
test('bypass: 세션 없는 에이전트의 flags 는 다음 모드(허용 && bypassOn) — 켜기·끄기마다 flags 사건', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  const got = flagEvents(e);
  await e.setBypass(a.id, true);
  expect(spawns()).toEqual([]);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(got).toContainEqual({ agentId: a.id, bypass: true, bySettings: false, pending: false });
  await e.setBypass(a.id, false);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(got[got.length - 1]).toEqual({ agentId: a.id, bypass: false, bySettings: false, pending: false });
});

test('bypass: 앱을 다시 켜도 허용 + bypassOn 이면 띄우기 전부터 flags.bypass true · 허용을 끄면 false', async () => {
  const e1 = await start();
  const { a } = setup(e1);
  await e1.setAllowBypass(true);
  await e1.setBypass(a.id, true);
  const e2 = await start();
  expect(e2.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(spawns()).toEqual([]);
  await e2.setAllowBypass(false);
  expect(e2.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

test('bypass: bypass 로 돌던 세션이 끝나도 flags 는 다음 모드(false 로 떨어지지 않는다)', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  await turn(e, a.id, 'echo 하나');
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  const got = flagEvents(e);
  await e.newConversation(a.id); // 보내지 않고 새 대화 — 세션이 끝난다
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(got.every((f) => f.agentId !== a.id || f.bypass)).toBe(true);
});

// ── 묻지 않음: 마지막 바로잡기 ──
const VALUE_INVALID = '켜기·끄기 값이 올바르지 않아요.';

test('bypass: setBypass · setAllowBypass 는 boolean 이 아닌 값을 던진다 — 문자열 "false" 가 켜짐으로 저장되지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  // 허용 — 문자열은 확인 창 없이 허용을 켜지 못한다
  for (const bad of ['false', 'true', 1, null, undefined]) {
    await expect(e.setAllowBypass(bad as any)).rejects.toThrow(VALUE_INVALID);
  }
  expect(e.allowBypass()).toBe(false);
  expect(fs.existsSync(path.join(dataDir, 'settings.json'))).toBe(false);

  await e.setAllowBypass(true);
  const got = flagEvents(e);
  for (const bad of ['false', 'true', 0, 1, null, undefined, {}]) {
    await expect(e.setBypass(a.id, bad as any)).rejects.toThrow(VALUE_INVALID);
  }
  expect(agentOf(e, a.id).bypassOn).toBe(false);
  expect(openStore(dataDir).agent(a.id)!.bypassOn).toBe(false);
  expect(got).toEqual([]);
  const f = e.flags(a.id);
  for (const v of Object.values(f)) expect(typeof v).toBe('boolean');
  expect(f.bypass).toBe(false);
  await turn(e, a.id, 'echo 하나'); // 다음에 띄워도 켜지지 않는다
  expect(controlRequests('set_permission_mode')).toEqual([]);
  expect(e.flags(a.id).bypass).toBe(false);
});

test('설정: 허용을 켤 때 남은 켜짐을 먼저 지운 뒤 허용을 저장한다 — 지우다 실패하면 허용도 저장하지 않는다', async () => {
  // 허용이 꺼진 채 bypassOn:true 가 남은 에이전트(손으로 고친 파일 등)
  const seed = openStore(dataDir);
  const r = seed.addRoom('방');
  const x = seed.addAgent({ roomId: r.id, name: 'X', role: 'r', folder: folder('x') });
  seed.updateAgent(x.id, { bypassOn: true });
  const e = await start();
  const write = fs.writeFileSync;
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: any[]) => {
    if (String(file).includes('state.json')) throw new Error('디스크 오류');
    return (write as any)(file, ...rest);
  }) as typeof fs.writeFileSync);
  try {
    await expect(e.setAllowBypass(true)).rejects.toThrow('디스크 오류');
  } finally {
    spy.mockRestore();
  }
  // 허용이 저장됐으면 남은 켜짐과 함께 다음에 띄울 때 묻지 않음이 켜진다
  expect(e.allowBypass()).toBe(false);
  const saved = fs.existsSync(path.join(dataDir, 'settings.json')) ? JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) : {};
  expect(saved.allowBypass).not.toBe(true);
  await e.shutdown();
  const e2 = await start();
  expect(e2.allowBypass()).toBe(false);
  await turn(e2, x.id, 'echo 하나');
  expect(controlRequests('set_permission_mode')).toEqual([]);

  // 다시 켜면 이번엔 지우고 허용
  await e2.setAllowBypass(true);
  expect(agentOf(e2, x.id).bypassOn).toBe(false);
  expect(openStore(dataDir).agent(x.id)!.bypassOn).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).allowBypass).toBe(true);
});

const RESTART_QUEUED = "이 차례가 끝나면 다시 시작해 '묻지 않음'을 켜요";

test('bypass: 옵션 없이 떠 일하는·승인 기다리는 중에 켜면 flags.pending + 대화 안내 한 줄 — 그 차례 뒤 다시 띄워 켜지면 pending 이 풀린다', async () => {
  const e = await start();
  const { room, a, b } = setup(e);
  const x = e.addAgent({ roomId: room.id, name: 'X', role: 'r', folder: folder('x') });
  await turn(e, x.id, 'echo 하나'); // 쉬는 X
  await e.sendUser(a.id, text('SLOW')); // 일하는 A
  const req = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === b.id);
  await e.sendUser(b.id, text('ASK Write')); // 승인 기다리는 B
  const r = await req;
  await e.setAllowBypass(true); // 셋 다 허용 전에 띄웠다 — 옵션 없음
  const got = flagEvents(e);

  await e.setBypass(a.id, true);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: true }); // 실제 모드는 아직 평소 — 바뀌는 중
  expect(got.at(-1)).toEqual({ agentId: a.id, bypass: false, bySettings: false, pending: true });
  expect(noticesOf(e, a.id)).toEqual([RESTART_QUEUED]);
  await e.setBypass(a.id, true); // 다시 와도 안내는 한 번
  expect(noticesOf(e, a.id)).toEqual([RESTART_QUEUED]);
  await e.setBypass(b.id, true);
  expect(e.flags(b.id)).toEqual({ bypass: false, bySettings: false, pending: true });
  expect(noticesOf(e, b.id)).toEqual([RESTART_QUEUED]);
  expect(e.pendingRequests(b.id).map((q) => q.id)).toEqual([r.id]); // 승인 카드는 그대로
  // 쉬는 X 는 바로 다시 띄운다 — 기다릴 차례가 없어 안내도 pending 도 없다
  await e.setBypass(x.id, true);
  expect(e.flags(x.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(noticesOf(e, x.id)).toEqual([]);
  expect(got.filter((f) => f.agentId === x.id && f.pending)).toEqual([]);

  // A — 그 차례가 끝나면 다시 띄워 켠다
  const onA = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === a.id && f.bypass);
  const doneA = resultOf(e, a.id);
  await e.interrupt(a.id);
  await doneA;
  expect(await onA).toEqual({ agentId: a.id, bypass: true, bySettings: false, pending: false });
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  await until('A 를 다시 띄움', () => spawnsOf('A').length === 2); // 가짜 claude 는 뜬 뒤에 argv 를 남긴다
  expect(got.filter((f) => f.agentId === a.id).at(-1)!.pending).toBe(false);

  // B — 사람이 답해 그 차례가 끝나면
  const onB = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === b.id && f.bypass);
  e.answerRequest(r.id, { type: 'allow' });
  expect(await onB).toEqual({ agentId: b.id, bypass: true, bySettings: false, pending: false });
  await until('B 를 다시 띄움', () => spawnsOf('B').length === 2);
  expect(noticesOf(e, b.id)).toEqual([RESTART_QUEUED]);
});

test('bypass: 다시 띄우기를 기다리는 중에 끄거나 허용을 끄면 거두고 pending 이 풀린다 — 안내는 더하지 않고 차례가 끝나도 다시 띄우지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.sendUser(a.id, text('SLOW')); // 허용 전에 띄움 — 옵션 없음
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  expect(e.flags(a.id).pending).toBe(true);
  const got = flagEvents(e);
  await e.setBypass(a.id, false); // 화면에서 다시 누름 — 거둔다
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(got).toEqual([{ agentId: a.id, bypass: false, bySettings: false, pending: false }]);
  expect(noticesOf(e, a.id)).toEqual([RESTART_QUEUED]);
  let done = resultOf(e, a.id);
  await e.interrupt(a.id);
  await done;
  await sleep(300);
  expect(spawnsOf('A')).toHaveLength(1);

  // 허용을 꺼도 거둔다
  await e.sendUser(a.id, text('SLOW'));
  await e.setBypass(a.id, true);
  expect(e.flags(a.id).pending).toBe(true);
  await e.setAllowBypass(false);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(got.filter((f) => f.agentId === a.id).at(-1)).toEqual({ agentId: a.id, bypass: false, bySettings: false, pending: false });
  done = resultOf(e, a.id);
  await e.interrupt(a.id);
  await done;
  await sleep(300);
  expect(spawnsOf('A')).toHaveLength(1);
  expect(controlRequests('set_permission_mode')).toEqual([]);
});

test('bypass: 띄운 직후 모드 답이 오기 전에도 flags() 는 마지막 사건과 같다 — 기록된 모드가 없고 띄울 때 보낸 켜기가 가는 중이면 다음 모드', async () => {
  const e = await start({ FAKE_SET_MODE_LATE_MS: '800' }); // 띄울 때 보낸 켜기는 0.8 초 뒤에 답한다(한도 안)
  const { a } = setup(e);
  await e.setAllowBypass(true);
  const got = flagEvents(e);
  await e.setBypass(a.id, true); // 세션 없음 — 다음 모드(켜짐)
  expect(got.at(-1)).toEqual({ agentId: a.id, bypass: true, bySettings: false, pending: false });
  await e.describe(a.id); // 띄운다(입력 없음)
  await until('내 설정을 읽음', () => controlRequests('get_settings').length === 1);
  await sleep(100);
  // 스냅샷을 다시 받아도 스위치가 꺼졌다 켜지지 않는다
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(got.filter((f) => f.agentId === a.id).every((f) => f.bypass)).toBe(true);
  const answered = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === a.id, 3000);
  expect(await answered).toEqual({ agentId: a.id, bypass: true, bySettings: false, pending: false }); // 켜기의 답(실제 모드)
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
});

test('bypass: 내 Claude 설정이 전부 허용이면 세션이 끝나도 경고 띠가 남는다 — 내 기본 모드를 에이전트마다 기억해 다음 모드 예측에', async () => {
  const e = await start({ FAKE_PERMISSION_MODE: 'bypassPermissions' });
  const { a, b } = setup(e);
  await turn(e, a.id, 'echo 하나'); // 허용은 꺼짐 — 내 설정 때문에 묻지 않는다
  await until('내 설정을 읽음', () => e.flags(a.id).bySettings);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: true, pending: false });
  const got = flagEvents(e);
  await e.newConversation(a.id); // 세션이 끝난다
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: true, pending: false });
  expect(got.filter((f) => f.agentId === a.id)).toEqual([{ agentId: a.id, bypass: true, bySettings: true, pending: false }]);
  // 비정상 종료 뒤에도
  await turn(e, a.id, 'echo 둘');
  const crashed = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');
  await e.sendUser(a.id, text('CRASH'));
  await crashed;
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: true, pending: false });
  expect(got.filter((f) => f.agentId === a.id).at(-1)).toEqual({ agentId: a.id, bypass: true, bySettings: true, pending: false });
  // 허용 + 두레 스위치를 켜면 원인은 두레 스위치(끌 수 있게), 다시 끄면 내 설정
  await e.setAllowBypass(true);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: true, pending: false });
  await e.setBypass(a.id, true);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  await e.setBypass(a.id, false);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: true, pending: false });
  // 내 설정을 읽은 적 없는 에이전트는 모른다 — 다음 모드는 두레 스위치만으로
  expect(e.flags(b.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

// ── 계획 먼저(plan) ──
// 계획 먼저로 보낸 입력은 쓰기 직전에 set_permission_mode plan — 계획은 ExitPlanMode 승인 요청(kind plan)으로 오고, 허용하면 CLI 가
// 스스로 기본 모드로 간다(probe16). 가짜 claude 의 PLAN <제목>(계획 모드일 때만 계획을 낸다)
const PLAN_ON_FAILED = '계획 모드로 바꾸지 못했어요 — Claude 가 권한 모드를 바꾸지 않았어요.';
const PLAN_ON_FAILED_STOPPED_NOTICE = '계획 모드로 바꾸지 못해 멈췄어요';
interface PlanModeEvent {
  agentId: string;
  on: boolean;
}
/** 그 에이전트의 'plan-mode' 사건 on 값 — 받은 차례대로 */
const planEvents = (e: Engine, id: string) => {
  const got: boolean[] = [];
  e.on('plan-mode', (p: PlanModeEvent) => p.agentId === id && got.push(p.on));
  return got;
};
const planRequest = (e: Engine, id: string, not?: string) =>
  waitFor<PendingRequest>(e, 'request', (r) => r.agentId === id && r.kind === 'plan' && r.id !== not);
const planText = (r: PendingRequest) => (r.input as { plan: string }).plan;

test('plan: 계획 먼저로 보내면 그 입력 전에 계획 모드 — 계획 승인 요청(kind plan)이 오고 허용하면 평소 모드로', async () => {
  const e = await start();
  const { a } = setup(e);
  const got = planEvents(e, a.id);
  const req = planRequest(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true });
  const r = await req;
  expect(r.toolName).toBe('ExitPlanMode');
  expect(planText(r).startsWith('# 헤더')).toBe(true);
  expect(e.planMode(a.id)).toBe(true);
  expect(got).toEqual([true]);
  expect(modeLines('A')).toEqual([['mode:plan', 'PLAN 헤더']]);

  const done = resultOf(e, a.id);
  e.answerRequest(r.id, { type: 'allow' });
  expect(await resultText(done)).toBe('approved');
  expect(e.planMode(a.id)).toBe(false);
  expect(got).toEqual([true, false]);
  // 승인 뒤엔 평소 모드 그대로 — 계획 먼저 없이 보낸 입력은 계획 모드로 가지 않는다
  await turn(e, a.id, 'echo 하나');
  expect(e.planMode(a.id)).toBe(false);
  expect(modeLines('A')).toEqual([['mode:plan', 'PLAN 헤더', 'echo 하나']]);
  expect(got).toEqual([true, false]);
});

test('plan: 고쳐 달라고 하기(거절 + 글)면 계획 모드 그대로 고친 계획이 다시 온다', async () => {
  const e = await start();
  const { a } = setup(e);
  const got = planEvents(e, a.id);
  const first = planRequest(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true });
  const r1 = await first;
  const second = planRequest(e, a.id, r1.id);
  e.answerRequest(r1.id, { type: 'deny', message: '태블릿도' });
  const r2 = await second;
  expect(planText(r2)).toContain('태블릿도');
  expect(e.planMode(a.id)).toBe(true);
  expect(got).toEqual([true]);

  // 고친 계획을 허용하면 그때 평소 모드로
  const done = resultOf(e, a.id);
  e.answerRequest(r2.id, { type: 'allow' });
  expect(await resultText(done)).toBe('approved');
  expect(e.planMode(a.id)).toBe(false);
  expect(got).toEqual([true, false]);
  expect(modeLines('A')).toEqual([['mode:plan', 'PLAN 헤더']]);
});

test('plan: 묻지 않음이 켜진 에이전트는 계획 승인 뒤 다시 bypass', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  const got = planEvents(e, a.id);
  const flags = flagEvents(e);
  const req = planRequest(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true }); // 세션 없이 — 띄울 때 bypass 대신 plan 을 보낸다
  const r = await req;
  expect(e.planMode(a.id)).toBe(true);
  expect(e.flags(a.id).bypass).toBe(false); // 계획 모드 동안은 묻지 않고 실행하지 않는다
  expect(got).toEqual([true]); // 깜박이지 않는다
  expect(flags.filter((f) => f.agentId === a.id && f.bypass)).toEqual([]);

  const done = resultOf(e, a.id);
  e.answerRequest(r.id, { type: 'allow' });
  await done;
  await until('다시 bypass', () => e.flags(a.id).bypass);
  expect(e.planMode(a.id)).toBe(false);
  expect(got).toEqual([true, false]);
  expect(agentOf(e, a.id).bypassOn).toBe(true);
  expect(modeLines('A')).toEqual([['mode:plan', 'PLAN 헤더', 'mode:bypassPermissions']]);
  await turn(e, a.id, 'echo 하나');
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  expect(lastSpawnOf('A').argv).not.toContain('--dangerously-skip-permissions');
});

test('plan: 계획 모드 중에 묻지 않음을 켜고 꺼도 계획 모드를 풀지 않는다 — 승인 뒤 그때의 값을 따른다', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await turn(e, a.id, 'echo 하나'); // 옵션으로 떠 있다 — 묻지 않음을 바로 바꿀 수 있는 세션
  await e.setPlanMode(a.id, true);
  await e.setBypass(a.id, true);
  expect(e.planMode(a.id)).toBe(true);
  await e.setBypass(a.id, false);
  expect(e.planMode(a.id)).toBe(true);
  await e.setBypass(a.id, true);
  expect(e.planMode(a.id)).toBe(true);
  expect(e.flags(a.id).bypass).toBe(false);

  // 이미 계획 모드 — 계획 먼저 없이 보내도 계획 모드 그대로
  const req = planRequest(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'));
  const r = await req;
  e.answerRequest(r.id, { type: 'allow' });
  await until('다시 bypass', () => e.flags(a.id).bypass);
  expect(e.planMode(a.id)).toBe(false);
  expect(modeLines('A')).toEqual([['echo 하나', 'mode:plan', 'PLAN 헤더', 'mode:bypassPermissions']]);
});

test('plan: 멈추면 계획 모드를 끄고 떠 있던 계획 요청을 치운다', async () => {
  const e = await start();
  const { a } = setup(e);
  const got = planEvents(e, a.id);
  const req = planRequest(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true });
  await req;
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  expect(e.pendingRequests(a.id)).toEqual([]);
  expect(e.planMode(a.id)).toBe(false);
  expect(got).toEqual([true, false]);
  expect(await resultText(done)).toBe('interrupted');
  expect(modeLines('A')).toEqual([['mode:plan', 'PLAN 헤더', 'mode:default']]);
  // 멈춘 뒤엔 계획 모드가 아니다 — PLAN 도 보통 글로
  const next = resultOf(e, a.id);
  await e.sendUser(a.id, text('PLAN 둘'));
  expect(await resultText(next)).toBe('받음: PLAN 둘');
  expect(e.pendingRequests(a.id)).toEqual([]);
});

test('plan: setPlanMode(false) 는 평소 모드로 · 세션이 없으면 바라는 값만', async () => {
  const e = await start();
  const { a, b } = setup(e);
  // 세션 없음 — 던지지 않고 바라는 값만(띄우지 않는다)
  await e.setPlanMode(b.id, false);
  expect(e.planMode(b.id)).toBe(false);
  await e.setPlanMode(b.id, true);
  expect(e.planMode(b.id)).toBe(true);
  await e.setPlanMode(b.id, false);
  expect(e.planMode(b.id)).toBe(false);
  expect(spawnsOf('B')).toEqual([]);
  await expect(e.setPlanMode(b.id, 'false' as never)).rejects.toThrow('켜기·끄기 값이 올바르지 않아요.');

  // 계획 모드 중 끄기
  await turn(e, a.id, 'echo 하나');
  const got = planEvents(e, a.id);
  await e.setPlanMode(a.id, true);
  expect(e.planMode(a.id)).toBe(true);
  await e.setPlanMode(a.id, true); // 이미 계획 모드 — 더 보내지 않는다
  await e.setPlanMode(a.id, false);
  expect(e.planMode(a.id)).toBe(false);
  expect(got).toEqual([true, false]);
  expect(modeLines('A')).toEqual([['echo 하나', 'mode:plan', 'mode:default']]);
  const next = resultOf(e, a.id);
  await e.sendUser(a.id, text('PLAN 둘'));
  expect(await resultText(next)).toBe('받음: PLAN 둘');
});

test('plan: 오류 뒤·effort 다시 띄우기에도 계획 모드를 다시 맞추고, 새 대화는 끈 채', async () => {
  const e = await start({ FAKE_EFFORT_SILENT: '1' }, false, { effortTimeoutMs: EFFORT_WAIT });
  const { a, b } = setup(e);
  await e.setPlanMode(a.id, true); // 세션이 없으면 바라는 값만 — 띄울 때 맞춘다
  expect(spawns()).toEqual([]);

  // 오류 뒤
  const crashed = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');
  await e.sendUser(a.id, text('CRASH'));
  await crashed;
  expect(e.planMode(a.id)).toBe(true);
  await turn(e, a.id, 'echo 하나');
  await turn(e, b.id, 'echo 하나');
  expect(e.planMode(a.id)).toBe(true);

  // 묻지 않음 켜기의 다시 띄우기(옵션 없이 뜬 세션) — 계획 모드 그대로, bypass 는 계획을 승인하거나 끈 뒤에
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  expect(spawnsOf('A')).toHaveLength(3);
  expect(e.planMode(a.id)).toBe(true);
  expect(e.flags(a.id).bypass).toBe(false);

  // effort 의 다시 띄우기(/effort 에 답이 없음)
  await e.setEffort(a.id, 'max');
  const done = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'result' && x.event.text.includes('셋'), EFFORT_WAIT * 8);
  await e.sendUser(a.id, text('echo 셋'));
  await done;
  expect(e.planMode(a.id)).toBe(true);

  // 새 대화 — 계획 모드를 끈 채(묻지 않음은 그대로)
  const off = waitFor<PlanModeEvent>(e, 'plan-mode', (p) => p.agentId === a.id && !p.on);
  await e.newConversation(a.id);
  await off;
  expect(e.planMode(a.id)).toBe(false);
  await turn(e, a.id, 'echo 넷');
  expect(e.planMode(a.id)).toBe(false);

  expect(modeLines('A')).toEqual([
    ['mode:plan', 'CRASH'],
    ['mode:plan', 'echo 하나'],
    ['mode:plan', '/effort max'],
    ['mode:plan', 'echo 셋'],
    ['mode:bypassPermissions', 'echo 넷'],
  ]);
  for (const s of spawnsOf('A')) expect(s.argv).not.toContain('--dangerously-skip-permissions');
  expect(modeLines('B')).toEqual([['echo 하나']]); // 계획 모드를 켜지 않은 에이전트는 평소 모드
  expect(e.planMode(b.id)).toBe(false);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
}, 20_000);

test('plan: 막 띄운 세션(새로 띄움·미리 띄움)의 계획 모드 요청은 띄울 때의 한도로 기다린다 — 늦은 답을 실패로 치지 않는다', async () => {
  // 첫 계획 모드 요청의 답이 1.5 초 뒤(시작·대화 읽기가 느린 CLI) — 평소 한도(0.5 초)는 넘고 띄울 때 한도(4 초) 안이다
  const e = await start({ FAKE_SET_MODE_LATE_MS: '1500', FAKE_SET_MODE_LATE_MODE: 'plan' }, false, {
    bypassTimeoutMs: 500, bypassSpawnTimeoutMs: 4000,
  });
  const { a, b } = setup(e);
  const errs: string[] = [];
  e.on('engine-error', (x: { message: string }) => errs.push(x.message));
  const results: string[] = [];
  e.on('agent-event', (x: AgentEvent) => x.event.kind === 'result' && results.push(x.event.text));

  // 새로 띄움 — 세션 없이 계획 먼저로 보낸다
  await e.sendUser(a.id, text('SLOW'), { plan: true });
  // 미리 띄움 — 골라서 띄운 뒤(아직 아무 줄도 안 받았다) 계획 먼저로 보낸다
  e.setSelected(b.id);
  await until('B 띄움', () => spawnsOf('B').length === 1);
  await e.sendUser(b.id, text('SLOW'), { plan: true });

  await sleep(1000); // 평소 한도(0.5 초)를 넉넉히 지났다 — 그 한도였다면 이미 실패로 쳐 멈췄다
  // 늦은 답이 왔다 — SLOW 차례의 init(default) 뒤 status 줄로 plan
  await until('계획 모드', () => e.planMode(a.id) && e.planMode(b.id), 6000);
  expect(errs).toEqual([]);
  expect(noticesOf(e, a.id)).toEqual([]);
  expect(noticesOf(e, b.id)).toEqual([]);
  expect(results).toEqual([]); // 멈추지 않았다 — 두 SLOW 차례가 그대로 돈다
  expect(e.status(a.id)).toBe('working');
  expect(e.status(b.id)).toBe('working');
  expect(modeLines('A')).toEqual([['mode:plan', 'SLOW']]);
  expect(modeLines('B')).toEqual([['mode:plan', 'SLOW']]);
}, 15_000);

test('plan: 계획 모드로 바꾸지 못하면 알리고 그 차례를 멈춘다 — 계획 없이 일하지 않는다', async () => {
  const e = await start({ FAKE_SET_MODE_FAIL: 'plan' });
  const { a } = setup(e);
  const errs: string[] = [];
  e.on('engine-error', (x: { message: string }) => errs.push(x.message));
  const got = planEvents(e, a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('SLOW'), { plan: true });
  expect(await resultText(done)).toBe('interrupted');
  expect(e.planMode(a.id)).toBe(false);
  expect(got).toEqual([true, false]);
  expect(errs).toEqual([PLAN_ON_FAILED]);
  expect(noticesOf(e, a.id)).toEqual([PLAN_ON_FAILED_STOPPED_NOTICE]);
});

// ── 붙잡기(멈추면 기다리던 내 입력·전달 대기 메시지를 사람이 고를 때까지 보내지 않는다) ──
interface HoldEvent {
  agentId: string;
  hold: Hold | null;
}
const holdEvents = (e: Engine, id: string) => {
  const got: (Hold | null)[] = [];
  e.on('hold', (h: HoldEvent) => h.agentId === id && got.push(h.hold));
  return got;
};
/** SLOW 차례를 열고 init 까지 — interrupt 가 올 때까지 일하는 중 */
async function slowTurn(e: Engine, id: string): Promise<void> {
  const init = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === id && x.event.kind === 'init');
  await e.sendUser(id, text('SLOW'));
  await init;
}
/** b 가 a 에게 보낸 메시지 — a 가 바쁘면 queued 로 남는다 */
async function relayTo(e: Engine, b: string, line: string): Promise<void> {
  const bDone = resultOf(e, b);
  await e.sendUser(b, text(line));
  expect(await resultText(bDone)).toBe('A 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
}
const textsToA = () => userTexts().filter((t) => !t.startsWith('SEND A:'));

test('hold: 일하는 중에 더 친 말이 있을 때 멈추면 붙잡고, 그 차례가 끝나도 보내지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('둘째'));
  expect(e.heldInput(a.id)).toBe(1);
  const got = holdEvents(e, a.id);
  const held: number[] = [];
  e.on('held-input', (h: { agentId: string; count: number }) => h.agentId === a.id && held.push(h.count));
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  const h = e.hold(a.id)!;
  expect(h.items).toEqual([{ id: expect.any(String), source: 'human', from: null, text: '둘째', images: 0 }]);
  expect(h.since).toBeGreaterThan(0);
  expect(e.heldInput(a.id)).toBe(0); // 붙잡힌 것은 기다리는 입력 수에 들지 않는다
  expect(held).toEqual([0]);
  expect(got).toEqual([h]);
  expect(await resultText(done)).toBe('interrupted');
  // 그 차례의 result 에서 다음 입력을 보냈다면 이미 작업 중이다
  expect(e.status(a.id)).toBe('idle');
  expect(userTexts()).not.toContain('둘째');
  expect(e.hold(a.id)).toEqual(h);
});

test('hold: 기다리는 것이 없으면 붙잡지 않는다', async () => {
  const e = await start();
  const { a, b } = setup(e);
  const got = holdEvents(e, a.id);
  await slowTurn(e, a.id);
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  await done;
  await e.interrupt(b.id); // 세션 없는 에이전트도
  expect(e.hold(a.id)).toBeNull();
  expect(e.hold(b.id)).toBeNull();
  expect(got).toEqual([]);
});

test('hold: 전달 대기 메시지도 붙잡고 보낸 쪽을 적는다', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  await slowTurn(e, a.id);
  await relayTo(e, b.id, 'SEND A: 셋째\n둘째 줄');
  const [m] = e.messages({ to: a.id });
  expect(m.state).toBe('queued');
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  expect(e.hold(a.id)!.items).toEqual([{ id: m.id, source: 'relay', from: b.id, text: '셋째', images: 0 }]);
  await done;
  expect(e.status(a.id)).toBe('idle');
  expect(e.messages({ to: a.id }).map((x) => x.state)).toEqual(['queued']);
  expect(textsToA()).toEqual(['SLOW']);
});

test('hold: 이어서 보내기 = 내 입력 먼저 그다음 메시지, 붙잡기 풀림', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('echo 둘째'));
  await relayTo(e, b.id, 'SEND A: 셋째');
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  expect(e.hold(a.id)!.items.map((i) => i.source)).toEqual(['human', 'relay']);
  await done;
  const got = holdEvents(e, a.id);
  const delivery = '[두레 메시지 — 보낸 쪽: B(웹 화면)]\n셋째';
  const third = resultTextIs(e, a.id, `받음: ${delivery}`);
  e.resumeHold(a.id);
  expect(e.hold(a.id)).toBeNull();
  expect(got).toEqual([null]);
  await third;
  expect(textsToA()).toEqual(['SLOW', 'echo 둘째', delivery]);
  expect(e.messages({ to: a.id }).map((x) => x.state)).toEqual(['delivered']);
  expect(e.status(a.id)).toBe('idle');
});

test('hold: 계획 먼저로 친 입력은 이어서 보내도 계획 모드로 나간다', async () => {
  const e = await start();
  const { a } = setup(e);
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true });
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  await done;
  const req = planRequest(e, a.id);
  e.resumeHold(a.id);
  await req;
  expect(e.planMode(a.id)).toBe(true);
  expect(modeLines('A')).toEqual([['SLOW', 'mode:plan', 'PLAN 헤더']]);
});

test('hold: 빼기·모두 버리기 — 내 입력은 버리고 메시지는 dismissed, 다 빠지면 풀림', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  const holdUp = async (mine: string, msg: string) => {
    await slowTurn(e, a.id);
    await e.sendUser(a.id, text(mine));
    await relayTo(e, b.id, `SEND A: ${msg}`);
    const done = resultOf(e, a.id);
    await e.interrupt(a.id);
    await done;
    return e.hold(a.id)!.items;
  };
  const got = holdEvents(e, a.id);
  const [mine, msg] = await holdUp('echo 둘째', '셋째');
  expect([mine.source, msg.source]).toEqual(['human', 'relay']);
  e.dropHoldItem(a.id, mine.id);
  expect(e.hold(a.id)!.items).toEqual([msg]);
  expect(e.heldInput(a.id)).toBe(0);
  e.dropHoldItem(a.id, msg.id);
  expect(e.hold(a.id)).toBeNull();
  expect(got.map((h) => h?.items.length ?? null)).toEqual([2, 1, null]);
  expect(e.messages({ to: a.id }).map((x) => x.state)).toEqual(['dismissed']);

  expect(await holdUp('echo 넷째', '다섯째')).toHaveLength(2);
  got.length = 0;
  e.dropHold(a.id);
  expect(e.hold(a.id)).toBeNull();
  expect(got).toEqual([null]);
  expect(e.messages({ to: a.id }).map((x) => x.state)).toEqual(['dismissed', 'dismissed']);
  // 버린 것은 나가지 않는다 — 다음 차례는 새로 친 말 하나
  const next = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 여섯째'));
  expect(await resultText(next)).toBe('받음: echo 여섯째');
  expect(textsToA()).toEqual(['SLOW', 'SLOW', 'echo 여섯째']);
});

test('hold: 붙잡힌 동안 새로 친 말은 바로 나가고 목록은 그대로', async () => {
  const e = await start();
  const { a } = setup(e);
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('둘째'));
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  await done;
  const before = e.hold(a.id);
  const next = resultOf(e, a.id);
  await e.sendUser(a.id, text('새 말'));
  expect(await resultText(next)).toBe('받음: 새 말');
  expect(e.hold(a.id)).toEqual(before);
  expect(userTexts()).toEqual(['SLOW', '새 말']);
  expect(e.status(a.id)).toBe('idle');
});

test('hold: 붙잡힌 동안 새로 전달 대기가 된 메시지는 목록 끝에', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('둘째'));
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  await done;
  expect(e.hold(a.id)!.items).toHaveLength(1);
  const got = holdEvents(e, a.id);
  await relayTo(e, b.id, 'SEND A: 셋째'); // a 는 쉬지만 붙잡혀 있다 — 전달 쪽에선 바쁨
  const [m] = e.messages({ to: a.id });
  const items = e.hold(a.id)!.items;
  expect(items).toHaveLength(2);
  expect(items[1]).toEqual({ id: m.id, source: 'relay', from: b.id, text: '셋째', images: 0 });
  expect(got).toHaveLength(1);
  expect(m.state).toBe('queued');
  expect(textsToA()).toEqual(['SLOW']);
});

test('hold: 목록의 글은 첫 줄(200자까지) · 그림은 수만 · 에이전트를 지우면 같이 지운다', async () => {
  const e = await start();
  const { a } = setup(e);
  const png = Buffer.alloc(10, 1).toString('base64');
  await slowTurn(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: `\n  ${'가'.repeat(250)}\n둘째 줄` }, { type: 'image', mediaType: 'image/png', base64: png }]);
  await e.sendUser(a.id, [{ type: 'image', mediaType: 'image/png', base64: png }, { type: 'image', mediaType: 'image/png', base64: png }]);
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  await done;
  expect(e.hold(a.id)!.items.map(({ text: t, images }) => ({ t, images }))).toEqual([
    { t: '가'.repeat(200), images: 1 },
    { t: '', images: 2 },
  ]);
  const got = holdEvents(e, a.id);
  await e.removeAgent(a.id);
  expect(got).toEqual([null]);
  expect(() => e.hold(a.id)).toThrow('에이전트를 찾을 수 없습니다');
});

// ── 서브에이전트 ──
// 가짜 claude 의 SUB(뒤에서 도는)·SUBFG(앞에서 도는) — 서브에이전트 줄엔 parent_tool_use_id, 시작·끝은 task_started·task_notification(probe13·14)
interface SubagentsEvent {
  agentId: string;
  running: string[];
}
/** 기록에서 부모가 띄운 Agent 하는 일의 id */
function agentToolId(e: Engine, id: string): string {
  for (const h of e.history(id)) {
    if (h.kind !== 'assistant' || h.parent) continue;
    for (const b of h.blocks) if (b.type === 'tool_use' && b.name === 'Agent') return b.id;
  }
  throw new Error('Agent 하는 일이 기록에 없음');
}
const hasParent = (h: HistoryItem) => (h.kind === 'assistant' || h.kind === 'tool-result') && h.parent !== undefined;
const parentOf = (h: HistoryItem) => (h.kind === 'assistant' || h.kind === 'tool-result' ? h.parent : undefined);

test('subagent: SUB — 부모 차례가 끝나도 도는 동안 작업 중 · 끝 알림 뒤 비고, 스스로 시작한 차례 동안 작업 중이다가 끝나면 대기', async () => {
  const gate = path.join(dir, 'gate');
  const e = await start({ FAKE_SUB_GATE: gate });
  const { a } = setup(e);
  const timeline: string[] = [];
  e.on('status', (s: StatusEvent) => s.agentId === a.id && timeline.push(`status:${s.status}`));
  e.on('history', (h: { agentId: string; item: HistoryItem }) => h.agentId === a.id && timeline.push(`item:${h.item.kind}`));
  const runs: SubagentsEvent[] = [];
  e.on('subagents', (x: SubagentsEvent) => runs.push(x));

  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  const tool = agentToolId(e, a.id);
  expect(e.status(a.id)).toBe('working'); // 부모 차례는 끝났지만 서브에이전트가 돈다
  expect(e.subagentsRunning(a.id)).toEqual([tool]);
  expect(runs).toEqual([{ agentId: a.id, running: [tool] }]);
  expect(timeline.filter((x) => x.startsWith('status:'))).toEqual(['status:working']); // 대기로 떨어지지 않았다

  const ended = waitFor<SubagentsEvent>(e, 'subagents', (x) => x.agentId === a.id && x.running.length === 0);
  const relayed = resultTextIs(e, a.id, '전달: 보고: 조사');
  fs.writeFileSync(gate, '');
  await ended;
  await relayed;
  expect(runs).toEqual([{ agentId: a.id, running: [tool] }, { agentId: a.id, running: [] }]);
  expect(e.subagentsRunning(a.id)).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
  // 끝난 뒤 Claude 가 스스로 여는 차례를 기다리는 동안도 작업 중 — 대기로 깜박이지 않고, 그 차례의 글 뒤에 한 번 idle
  const end = timeline.indexOf('item:subagent-end');
  expect(end).toBeGreaterThan(0);
  const after = timeline.slice(end);
  expect(after.filter((x) => x.startsWith('status:'))).toEqual(['status:idle']);
  expect(after.indexOf('status:idle')).toBeGreaterThan(after.indexOf('item:assistant'));
  expect(timeline.filter((x) => x.startsWith('status:'))).toEqual(['status:working', 'status:idle']);
});

test('subagent: 기록 — 서브에이전트 줄엔 parent(= Agent 하는 일 id), 시작·끝 기록 하나씩 · 부모 줄엔 parent 가 없다', async () => {
  const e = await start({ FAKE_SUB_MS: '50' });
  const { a } = setup(e);
  const relayed = resultTextIs(e, a.id, '전달: 보고: 조사');
  await e.sendUser(a.id, text('SUB 조사'));
  await relayed;
  const h = e.history(a.id);
  const tool = agentToolId(e, a.id);
  const sub = h.filter(hasParent);
  expect(sub.map((x) => x.kind)).toEqual(['assistant', 'tool-result', 'assistant']);
  expect(sub.map(parentOf)).toEqual([tool, tool, tool]);
  expect(sub[0]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'tool_use', name: 'Read', input: { file_path: 'note.txt' } }] });
  expect(sub[2]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: '보고: 조사' }] });
  const starts = h.filter((x) => x.kind === 'subagent-start');
  expect(starts).toEqual([
    { t: expect.any(Number), kind: 'subagent-start', toolUseId: tool, taskId: expect.any(String), description: '조사', subagentType: 'general-purpose', parentTaskId: null },
  ]);
  const ends = h.filter((x) => x.kind === 'subagent-end');
  expect(ends).toEqual([
    {
      t: expect.any(Number), kind: 'subagent-end', toolUseId: tool, taskId: (starts[0] as { taskId: string }).taskId,
      status: 'completed', summary: '보고: 조사', toolUses: 1, durationMs: expect.any(Number),
    },
  ]);
  // 부모 줄 — parent 칸이 없다. 스스로 시작한 차례는 사람 입력 없이 이어진다
  const parentLines = h.filter((x) => !hasParent(x));
  expect(parentLines.map((x) => x.kind)).toEqual([
    'user', 'assistant', 'subagent-start', 'tool-result', 'assistant', 'result', 'subagent-end', 'assistant', 'result',
  ]);
  for (const x of parentLines) expect(x).not.toHaveProperty('parent');
});

test('subagent: SUBFG — 앞에서 도는 서브에이전트도 같은 기록, 스스로 시작한 차례 없이 대기', async () => {
  const e = await start({ FAKE_SUB_MS: '50' });
  const { a } = setup(e);
  const statuses: AgentStatus[] = [];
  e.on('status', (s: StatusEvent) => s.agentId === a.id && statuses.push(s.status));
  const runs: SubagentsEvent[] = [];
  e.on('subagents', (x: SubagentsEvent) => runs.push(x));
  const done = resultTextIs(e, a.id, '정리: 보고: 조사');
  await e.sendUser(a.id, text('SUBFG 조사'));
  await done;
  const tool = agentToolId(e, a.id);
  expect(e.status(a.id)).toBe('idle');
  expect(e.subagentsRunning(a.id)).toEqual([]);
  expect(runs).toEqual([{ agentId: a.id, running: [tool] }, { agentId: a.id, running: [] }]);
  const h = e.history(a.id);
  expect(h.filter(hasParent).map((x) => x.kind)).toEqual(['assistant', 'tool-result', 'assistant']);
  expect(h.filter(hasParent).map(parentOf)).toEqual([tool, tool, tool]);
  expect(h.filter((x) => !hasParent(x)).map((x) => x.kind)).toEqual([
    'user', 'assistant', 'subagent-start', 'subagent-end', 'tool-result', 'assistant', 'result',
  ]);
  expect(h.find((x) => x.kind === 'subagent-end')).toMatchObject({ toolUseId: tool, status: 'completed', summary: '보고: 조사', toolUses: 1 });
  await sleep(300); // 스스로 시작한 차례가 오지 않는다
  expect(e.history(a.id)).toHaveLength(h.length);
  expect(statuses).toEqual(['working', 'idle']);
});

test('subagent: 서브에이전트가 도는 중에 세션이 죽거나 새 대화로 끝나면 도는 목록을 비우고 사건 — 끝 기록은 남기지 않는다', async () => {
  const gate = path.join(dir, 'gate'); // 만들지 않는다 — 서브에이전트는 끝나지 않는다
  const e = await start({ FAKE_SUB_GATE: gate });
  const { a } = setup(e);
  let launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  expect(e.subagentsRunning(a.id)).toHaveLength(1);

  let cleared = waitFor<SubagentsEvent>(e, 'subagents', (x) => x.agentId === a.id && x.running.length === 0);
  const errored = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');
  await e.sendUser(a.id, text('CRASH')); // 도는 중에도 사람 입력은 바로 간다 — 그 차례에서 죽는다
  await cleared;
  await errored;
  expect(e.subagentsRunning(a.id)).toEqual([]);
  expect(e.status(a.id)).toBe('error'); // 작업 중에 갇히지 않는다
  expect(e.history(a.id).filter((x) => x.kind === 'subagent-end')).toEqual([]); // 화면이 '끊김'으로 본다

  launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 다시'));
  await launched;
  expect(e.subagentsRunning(a.id)).toHaveLength(1);
  cleared = waitFor<SubagentsEvent>(e, 'subagents', (x) => x.agentId === a.id && x.running.length === 0);
  await e.newConversation(a.id);
  await cleared;
  expect(e.subagentsRunning(a.id)).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
});

test('subagent: 서브에이전트만 도는 동안 사람 입력은 기다리지 않고 바로 보내 그 답이 기록된다', async () => {
  const gate = path.join(dir, 'gate'); // 서브에이전트는 잡아 둔다
  const e = await start({ FAKE_SUB_GATE: gate });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  const reply = resultTextIs(e, a.id, '받음: echo 끼어듦');
  await e.sendUser(a.id, text('echo 끼어듦'));
  expect(e.heldInput(a.id)).toBe(0); // 줄에 세우지 않았다
  await reply;
  expect(userTexts()).toEqual(['SUB 조사', 'echo 끼어듦']);
  const h = e.history(a.id);
  expect(h.filter((x) => x.kind === 'user').map((x: any) => x.parts[0].text)).toEqual(['SUB 조사', 'echo 끼어듦']);
  expect(h.at(-2)).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: '받음: echo 끼어듦' }] });
  expect(e.status(a.id)).toBe('working'); // 서브에이전트는 아직 돈다
});

test('subagent: 서브에이전트가 아닌 일(백그라운드 명령)의 끝 알림은 버린다 — 끝 기록·subagents 사건·agent-event 없고 도는 목록은 그대로', async () => {
  const gate = path.join(dir, 'gate'); // 서브에이전트 하나를 돌려 둔 채
  const e = await start({ FAKE_SUB_GATE: gate });
  const { a } = setup(e);
  const runs: SubagentsEvent[] = [];
  e.on('subagents', (x: SubagentsEvent) => runs.push(x));
  const taskEvents: StreamEvent[] = [];
  e.on('agent-event', (x: AgentEvent) => {
    if (x.agentId === a.id && (x.event.kind === 'task-started' || x.event.kind === 'task-ended')) taskEvents.push(x.event);
  });
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  const tool = agentToolId(e, a.id);

  const done = resultTextIs(e, a.id, 'BG DONE');
  await e.sendUser(a.id, text('BGTASK npm run build')); // 시작(local_bash)은 파서가 버리고 끝 알림만 온다
  await done;
  expect(runs).toEqual([{ agentId: a.id, running: [tool] }]); // 서브에이전트 시작 때 하나뿐
  expect(taskEvents).toEqual([expect.objectContaining({ kind: 'task-started', toolUseId: tool })]);
  expect(e.history(a.id).filter((x) => x.kind === 'subagent-end')).toEqual([]);
  const bash = e.history(a.id).filter((x) => !hasParent(x)).slice(-4);
  expect(bash.map((x) => x.kind)).toEqual(['assistant', 'tool-result', 'assistant', 'result']); // 그 차례엔 하는 일·결과·글만
  expect(e.subagentsRunning(a.id)).toEqual([tool]);
  expect(e.status(a.id)).toBe('working'); // 서브에이전트는 아직 돈다
});

test('subagent: 둘이 돌면 시작 순 [A, B] — A 가 끝나면 [B], 둘 다 끝나면 []', async () => {
  const e = await start({ FAKE_SUB_MS: '400' }); // 둘 다 띄운 뒤에 일을 시작한다 — 먼저 띄운 A 가 먼저 끝난다
  const { a } = setup(e);
  const runs: string[][] = [];
  e.on('subagents', (x: SubagentsEvent) => x.agentId === a.id && runs.push(x.running));
  let launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 하나'));
  await launched;
  launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 둘'));
  await launched;
  const [first, second] = e
    .history(a.id)
    .flatMap((h) => (h.kind === 'subagent-start' ? [h.toolUseId] : []));
  expect(e.subagentsRunning(a.id)).toEqual([first, second]);
  const both = Promise.all([resultTextIs(e, a.id, '전달: 보고: 하나'), resultTextIs(e, a.id, '전달: 보고: 둘')]);
  await both;
  expect(runs).toEqual([[first], [first, second], [second], []]);
  expect(e.status(a.id)).toBe('idle');
});

test('subagent: 서브에이전트가 돌아도 승인 대기가 앞선다 — 답하면 다시 작업 중', async () => {
  const gate = path.join(dir, 'gate');
  const e = await start({ FAKE_SUB_GATE: gate });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  const req = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id);
  await e.sendUser(a.id, text('ASK Write'));
  const r = await req;
  expect(e.subagentsRunning(a.id)).toHaveLength(1);
  expect(e.status(a.id)).toBe('awaiting');
  const done = resultTextIs(e, a.id, 'ok');
  e.answerRequest(r.id, { type: 'allow' });
  await done;
  expect(e.status(a.id)).toBe('working'); // 부모 차례는 끝났고 서브에이전트는 돈다
});

test('subagent: 서브에이전트 줄·시작·끝은 보낸 줄을 읽었다는 뜻이 아니다 — 읽기 전에 죽으면 그 입력을 다시 보낸다', async () => {
  const gate = path.join(dir, 'gate');
  const mute = path.join(dir, 'mute');
  const e = await start({ FAKE_SUB_GATE: gate, FAKE_MUTE_FILE: mute });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  fs.writeFileSync(mute, ''); // 이제 가짜는 사용자 줄을 읽지 않고, 스스로 시작한 차례도 미룬다
  await e.sendUser(a.id, text('echo 못 읽음'));
  const ended = waitFor<SubagentsEvent>(e, 'subagents', (x) => x.agentId === a.id && x.running.length === 0);
  fs.writeFileSync(gate, '');
  await ended; // 서브에이전트 줄과 끝 알림은 왔다
  const errored = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');
  process.kill(lastSpawnOf('A').pid);
  await errored;
  expect(e.heldInput(a.id)).toBe(1); // 읽지 않은 줄은 기다리는 줄 맨 앞으로
  fs.rmSync(mute);
  const second = resultTextIs(e, a.id, '받음: echo 다음');
  await e.sendUser(a.id, text('echo 다음'));
  await second;
  expect(userTexts()).toEqual(['SUB 조사', 'echo 못 읽음', 'echo 못 읽음', 'echo 다음']);
});

// ── 서브에이전트 승인 · 두레 도구(spec §4.4·§4.7) ──
// 가짜 claude 의 SUBASK(서브에이전트가 묻는다)·SUBSEND(서브에이전트가 두레 도구)·SUBNEST(안쪽 서브에이전트가 스트림에 없던 id 로 묻는다)
/** 기록에 실린 하는 일 id — 스트림에서 본 tool_use */
const streamToolIds = (e: Engine, id: string): string[] =>
  e.history(id).flatMap((h) => (h.kind === 'assistant' ? h.blocks.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])) : []));

test('subagent: SUBASK — 서브에이전트가 물은 승인은 fromSubagent · 허용하면 서브에이전트가 끝까지 간다', async () => {
  const e = await start({ FAKE_SUB_MS: '50' });
  const { a } = setup(e);
  const req = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id);
  await e.sendUser(a.id, text('SUBASK Write'));
  const r = await req;
  const tool = agentToolId(e, a.id);
  expect(r).toMatchObject({ agentId: a.id, toolName: 'Write', kind: 'permission', fromSubagent: true });
  expect(e.pendingRequests(a.id)).toEqual([r]);
  expect(e.status(a.id)).toBe('awaiting');

  const relayed = resultTextIs(e, a.id, '전달: 보고: Write');
  e.answerRequest(r.id, { type: 'allow' });
  await relayed;
  const h = e.history(a.id);
  expect(h.filter(hasParent).find((x) => x.kind === 'tool-result')).toMatchObject({
    kind: 'tool-result', toolUseId: r.toolUseId, isError: false, text: 'ok', viaApproval: true, parent: tool,
  });
  expect(h.find((x) => x.kind === 'subagent-end')).toMatchObject({ toolUseId: tool, status: 'completed', summary: '보고: Write' });
  expect(e.subagentsRunning(a.id)).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
});

test('subagent: 부모 차례가 끝날 때 — 부모 승인은 차례가 끝났습니다로 거절되고, 도는 서브에이전트가 물은 승인은 남는다', async () => {
  const gate = path.join(dir, 'gate');
  const e = await start({ FAKE_SUB_GATE: gate });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUBASK Write'));
  await launched;
  const tool = agentToolId(e, a.id);
  // 서브에이전트가 도는 중에 부모 차례 — 부모의 승인이 떠 있다
  const liveReq = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id);
  await e.sendUser(a.id, text('ASK Write'));
  const live = await liveReq;
  // 서브에이전트도 묻는다
  const subReq = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id && r.id !== live.id);
  fs.writeFileSync(gate, '');
  const sub = await subReq;
  // 이 차례와 상관없는 부모 것 호출(tool_use id 없음 — 떠난 프로세스가 남긴 것처럼)
  const strayReq = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id && r.id !== live.id && r.id !== sub.id);
  const leftover = approveDirect(a.id, 'Edit');
  const stray = await strayReq;
  expect(live).not.toHaveProperty('fromSubagent');
  expect(sub).toMatchObject({ toolName: 'Write', fromSubagent: true });
  expect(stray).not.toHaveProperty('fromSubagent');
  expect(e.pendingRequests(a.id)).toHaveLength(3);

  const done = resultTextIs(e, a.id, 'ok');
  e.answerRequest(live.id, { type: 'allow' });
  await done;
  expect(await leftover).toEqual({ behavior: 'deny', message: DENY.turnEnded });
  expect(e.pendingRequests(a.id)).toEqual([sub]); // 서브에이전트 카드는 남는다
  expect(e.status(a.id)).toBe('awaiting');
  expect(e.subagentsRunning(a.id)).toEqual([tool]);

  const relayed = resultTextIs(e, a.id, '전달: 보고: Write');
  e.answerRequest(sub.id, { type: 'allow' });
  await relayed; // 서브에이전트는 끝까지 갔다
  expect(e.pendingRequests()).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
});

test('subagent: 도는 서브에이전트가 없으면 서브에이전트 것으로 친 승인도 차례가 끝날 때 거절 — 못 본 id 는 잠깐 기다린 뒤 서브에이전트', async () => {
  const e = await start({}, false, { seenWaitMs: 100 });
  const { a } = setup(e);
  const liveReq = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id);
  await e.sendUser(a.id, text('ASK Write'));
  const live = await liveReq;
  const strayReq = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id && r.id !== live.id);
  const t0 = Date.now();
  const leftover = approveDirect(a.id, 'Edit', undefined, 'toolu_nowhere'); // 스트림에 없던 id
  const stray = await strayReq;
  expect(Date.now() - t0).toBeGreaterThanOrEqual(90); // 기다린 뒤에야 카드
  expect(stray).toMatchObject({ toolName: 'Edit', toolUseId: 'toolu_nowhere', fromSubagent: true });
  expect(live).not.toHaveProperty('fromSubagent'); // 스트림에서 본 부모의 id

  const done = resultTextIs(e, a.id, 'ok');
  e.answerRequest(live.id, { type: 'allow' });
  await done;
  expect(await leftover).toEqual({ behavior: 'deny', message: DENY.turnEnded });
  expect(e.pendingRequests()).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
});

test('subagent: 늘 허용한 도구는 못 본 id 라도 기다리지 않고 허용 — 부른 쪽을 가를 필요가 없다', async () => {
  const e = await start({}, false, { seenWaitMs: 3_000 });
  const { a } = setup(e);
  const first = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나')); // 세션을 띄운다
  await first;
  // 늘 허용 — 카드에서 '늘 허용'으로 답한다(id 없는 부르기는 부모 것이라 기다리지 않는다)
  const askReq = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id);
  const ask = approveDirect(a.id, 'Edit');
  e.answerRequest((await askReq).id, { type: 'allow-always' });
  expect(await ask).toEqual({ behavior: 'allow', updatedInput: {} });
  expect(agentOf(e, a.id).alwaysAllow).toEqual(['Edit']);
  const requests: PendingRequest[] = [];
  e.on('request', (r: PendingRequest) => requests.push(r));
  const t0 = Date.now();
  expect(await approveDirect(a.id, 'Edit', undefined, 'toolu_nowhere')).toEqual({ behavior: 'allow', updatedInput: {} });
  expect(Date.now() - t0).toBeLessThan(1_500);
  expect(requests).toEqual([]);
});

test('subagent: 못 본 id 를 기다리는 사이 세션이 끝나면(새 대화) 카드를 만들지 않는다 — 서브에이전트로도 치지 않는다', async () => {
  const e = await start({}, false, { seenWaitMs: 30_000 });
  const { a } = setup(e);
  const first = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나')); // 세션을 띄운다
  await first;
  const requests: PendingRequest[] = [];
  e.on('request', (r: PendingRequest) => requests.push(r));
  const call = approveDirect(a.id, 'Write', undefined, 'toolu_nowhere'); // 기다리기 시작
  await new Promise((r) => setTimeout(r, 200));
  await e.newConversation(a.id);
  expect(await call).toEqual({ behavior: 'deny', message: DENY.claudeExited });
  expect(requests).toEqual([]);
  expect(e.pendingRequests()).toEqual([]);
});

test('subagent: 못 본 id 의 send_message·list_agents 를 기다리는 사이 세션이 끝나면(새 대화) 실행하지 않는다 — 승인과 같은 거절 문구', async () => {
  const e = await start({}, false, { seenWaitMs: 30_000 });
  const { a } = setup(e);
  const first = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나')); // 세션을 띄운다
  await first;
  const send = toolDirect(a.id, 'send_message', { to: 'B', text: '늦게' }, 'toolu_nowhere'); // 기다리기 시작
  const list = toolDirect(a.id, 'list_agents', {}, 'toolu_nowhere2');
  await new Promise((r) => setTimeout(r, 200));
  await e.newConversation(a.id);
  expect(await send).toEqual({ text: DENY.claudeExited, isError: true });
  expect(await list).toEqual({ text: DENY.claudeExited, isError: true });
  expect(e.messages()).toEqual([]); // 넘기지 않았다
});

test('subagent: SUBSEND — 서브에이전트의 send_message 는 실행하지 않고 오류로 · 부모의 SEND 는 카드 없이 지금처럼(기다림이 길어도 바로)', async () => {
  const e = await start({ FAKE_SUB_MS: '50' }, false, { seenWaitMs: 30_000 }); // 부모·서브에이전트 모두 스트림에서 본 id — 기다리면 시간 초과
  const { room, a } = setup(e);
  const d = e.addAgent({ roomId: room.id, name: '디자인', role: '디자인', folder: folder('d') });
  const requests: PendingRequest[] = [];
  e.on('request', (r: PendingRequest) => requests.push(r));

  const relayed = resultTextIs(e, a.id, '전달: 보고: 디자인: 안녕');
  await e.sendUser(a.id, text('SUBSEND 디자인: 안녕'));
  await relayed;
  const tool = agentToolId(e, a.id);
  expect(e.messages()).toEqual([]); // 넘기지 않았다
  const sub = e.history(a.id).filter(hasParent);
  expect(sub.find((x) => x.kind === 'assistant' && x.blocks.some((b) => b.type === 'tool_use' && b.name === 'mcp__dure__send_message'))).toBeDefined();
  expect(sub.find((x) => x.kind === 'tool-result')).toMatchObject({
    kind: 'tool-result', isError: true, text: DENY.subagentDureTool, viaApproval: false, parent: tool,
  });

  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('SEND 디자인: 안녕'));
  expect(await resultText(done)).toBe('디자인 에게 보냈습니다. 사람이 확인하면 전달됩니다.');
  expect(e.messages()).toMatchObject([{ from: a.id, to: d.id, text: '안녕', state: 'pending' }]);
  expect(requests).toEqual([]); // 어느 쪽도 카드가 없다
});

test('subagent: 서브에이전트(못 본 id)의 list_agents·send_message 도 거절 — id 없이 부르면 부모 것으로 실행', async () => {
  const e = await start({}, false, { seenWaitMs: 100 });
  const { a } = setup(e);
  const first = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나')); // 세션을 띄운다
  await first;
  expect(await toolDirect(a.id, 'list_agents', {}, 'toolu_inner')).toEqual({ text: DENY.subagentDureTool, isError: true });
  expect(await toolDirect(a.id, 'send_message', { to: 'B', text: '몰래' }, 'toolu_inner2')).toEqual({ text: DENY.subagentDureTool, isError: true });
  expect(e.messages()).toEqual([]);
  const mine = await toolDirect(a.id, 'list_agents', {});
  expect(mine.isError).toBe(false);
  expect(JSON.parse(mine.text).map((x: { name: string }) => x.name)).toEqual(['B']);
});

test('subagent: SUBNEST — 안쪽 서브에이전트의 승인은 스트림에 없던 id 라도 fromSubagent · 안쪽은 바깥 아래(parentTaskId)', async () => {
  const e = await start({ FAKE_SUB_MS: '50' }, false, { seenWaitMs: 100 });
  const { a } = setup(e);
  const req = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id);
  await e.sendUser(a.id, text('SUBNEST Write'));
  const r = await req;
  expect(r).toMatchObject({ agentId: a.id, toolName: 'Write', kind: 'permission', fromSubagent: true, toolUseId: expect.any(String) });
  expect(streamToolIds(e, a.id)).not.toContain(r.toolUseId); // 안쪽 서브에이전트의 줄은 오지 않는다(probe14 A)

  const relayed = resultTextIs(e, a.id, '전달: 보고: Write');
  e.answerRequest(r.id, { type: 'allow' });
  await relayed;
  const h = e.history(a.id);
  const starts = h.filter((x) => x.kind === 'subagent-start');
  expect(starts).toHaveLength(2);
  expect(starts[0]).toMatchObject({ toolUseId: agentToolId(e, a.id), parentTaskId: null });
  expect(starts[1]).toMatchObject({ parentTaskId: (starts[0] as { taskId: string }).taskId });
  expect(h.filter((x) => x.kind === 'subagent-end').map((x) => (x as { status: string }).status)).toEqual(['completed', 'completed']);
  expect(e.subagentsRunning(a.id)).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
});

// ── 서브에이전트 멈추기 · 다시 띄우기·/effort 미루기(spec §4.3·§4.6) ──
// 서브에이전트가 도는 동안, 그리고 끝난 뒤 Claude 가 스스로 여는 차례를 기다리는 동안(autoTurnGraceMs)은 다시 띄우지 않고 /effort 도 보내지 않는다.
// 사람 입력·받은 메시지는 막지 않는다(다시 띄우기를 기다리는 동안만 빼고)
const isText = (h: HistoryItem, t: string) =>
  h.kind === 'assistant' && !h.parent && h.blocks.some((b) => b.type === 'text' && b.text === t);
type EffortEvent = { agentId: string; effortNow: string | null };

test('subagent: 서브에이전트만 돌 때 멈추기 — interrupt 가 가고 끝 기록 stopped · 멈췄어요 · 스스로 시작한 차례가 없으면 기다림 뒤 대기', async () => {
  const gate = path.join(dir, 'gate'); // 만들지 않는다 — 서브에이전트는 끝나지 않는다
  const e = await start({ FAKE_SUB_GATE: gate }, false, { autoTurnGraceMs: 300 });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  const tool = agentToolId(e, a.id);
  expect(e.status(a.id)).toBe('working');
  const statuses: AgentStatus[] = [];
  e.on('status', (s: StatusEvent) => s.agentId === a.id && statuses.push(s.status));
  const runs: SubagentsEvent[] = [];
  e.on('subagents', (x: SubagentsEvent) => runs.push(x));
  const idle = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'idle');

  const t0 = Date.now();
  await e.interrupt(a.id);
  expect(controlRequests('interrupt')).toHaveLength(1);
  expect(runs).toEqual([{ agentId: a.id, running: [] }]);
  expect(e.status(a.id)).toBe('working'); // 스스로 시작한 차례를 잠깐 기다린다 — 대기로 깜박이지 않게
  await idle;
  expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  expect(statuses).toEqual(['idle']);
  const h = e.history(a.id);
  expect(h.find((x) => x.kind === 'subagent-end')).toMatchObject({ toolUseId: tool, status: 'stopped' });
  expect(noticesOf(e, a.id)).toEqual(['멈췄어요']);
  expect(h.slice(-2).map((x) => x.kind)).toEqual(['subagent-end', 'notice']);
});

test('subagent: 서브에이전트가 도는 동안 고른 effort 는 보내지 않는다 — 끝나고 스스로 시작한 차례가 끝난 뒤에 /effort', async () => {
  const gate = path.join(dir, 'gate');
  const e = await start({ FAKE_SUB_GATE: gate });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  await e.setEffort(a.id, 'low');
  await sleep(200);
  // /effort 차례는 사건을 삼킨다 — 그 사이 끝 알림이 오면 작업 중에 갇히고, 스스로 시작한 차례가 오면 대화가 사라진다
  expect(effortLines()).toEqual([]);
  expect(e.status(a.id)).toBe('working');

  const order: string[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === a.id && x.event.kind === 'result' && order.push(`result:${x.event.text}`));
  e.on('effort', (x: EffortEvent) => x.agentId === a.id && x.effortNow && order.push(`effort:${x.effortNow}`));
  const heard = waitFor<EffortEvent>(e, 'effort', (x) => x.agentId === a.id && x.effortNow === 'low');
  fs.writeFileSync(gate, '');
  await heard;
  expect(order).toEqual(['result:전달: 보고: 조사', 'effort:low']);
  expect(userTexts()).toEqual(['SUB 조사', '/effort low']);
  expect(e.history(a.id).filter((x) => isText(x, '전달: 보고: 조사'))).toHaveLength(1); // 스스로 시작한 차례는 기록된다
  expect(e.status(a.id)).toBe('idle');
});

test('subagent: 부모 차례 중에 서브에이전트가 끝나면 — 그 차례 뒤 Claude 가 스스로 여는 차례까지 /effort 를 미룬다(probe14 B)', async () => {
  const gate = path.join(dir, 'gate');
  const e = await start({ FAKE_SUB_GATE: gate });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  const req = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id);
  await e.sendUser(a.id, text('ASK Write')); // 부모 차례 — 승인을 기다리는 동안 서브에이전트가 끝난다
  const r = await req;
  await e.setEffort(a.id, 'low');
  const ended = waitFor<SubagentsEvent>(e, 'subagents', (x) => x.agentId === a.id && x.running.length === 0);
  fs.writeFileSync(gate, '');
  await ended;

  const order: string[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === a.id && x.event.kind === 'result' && order.push(`result:${x.event.text}`));
  e.on('effort', (x: EffortEvent) => x.agentId === a.id && x.effortNow && order.push(`effort:${x.effortNow}`));
  const heard = waitFor<EffortEvent>(e, 'effort', (x) => x.agentId === a.id && x.effortNow === 'low');
  e.answerRequest(r.id, { type: 'allow' });
  await heard;
  expect(order).toEqual(['result:ok', 'result:전달: 보고: 조사', 'effort:low']);
  expect(userTexts()).toEqual(['SUB 조사', 'ASK Write', '/effort low']);
  expect(e.history(a.id).filter((x) => isText(x, '전달: 보고: 조사'))).toHaveLength(1);
});

test('subagent: 다시 띄워야 하는 세션도 서브에이전트가 도는 동안엔 그대로 — 입력도 기다리고, 멈추기로 끝나면 기다림 뒤 다시 띄운다', async () => {
  const gate = path.join(dir, 'gate'); // 만들지 않는다
  const e = await start({ FAKE_SUB_GATE: gate }, false, { autoTurnGraceMs: 50 });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사')); // 허용 전에 띄운 세션 — 옵션 없음
  await launched;
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true); // 부모 차례는 끝났지만 서브에이전트가 돈다 — 다시 띄우기를 미룬다
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: true });
  expect(noticesOf(e, a.id)).toEqual([RESTART_QUEUED]);
  await e.sendUser(a.id, text('echo 둘')); // 켜지 않은 세션엔 보내지 않는다 — 다시 띄운 세션이 받는다
  await sleep(300);
  expect(spawnsOf('A')).toHaveLength(1);
  expect(e.heldInput(a.id)).toBe(1);
  expect(e.subagentsRunning(a.id)).toHaveLength(1);
  expect(e.status(a.id)).toBe('working');

  const on = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === a.id && f.bypass);
  const done = resultTextIs(e, a.id, '받음: echo 둘');
  await e.interrupt(a.id); // 멈춘 서브에이전트 뒤엔 스스로 시작한 차례가 오지 않는다(probe14 C) — 기다림(50 ms) 뒤 다시 띄운다
  e.resumeHold(a.id); // 멈추면 둘이 붙잡힌다 — 이어서 보낸다
  await done;
  expect(await on).toEqual({ agentId: a.id, bypass: true, bySettings: false, pending: false });
  expect(spawnsOf('A')).toHaveLength(2);
  expect(lastSpawnOf('A').argv).toContain(ALLOW_FLAG);
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(agentOf(e, a.id).sessionId);
  expect(modeLines('A')).toEqual([['SUB 조사'], ['mode:bypassPermissions', 'echo 둘']]);
  expect(noticesOf(e, a.id)).toEqual([RESTART_QUEUED, '멈췄어요']);
  expect(e.heldInput(a.id)).toBe(0);
});

test('subagent: 서브에이전트 때문에 미룬 다시 띄우기를 거두면 기다리던 입력은 바로 간다 — 서브에이전트가 아직 돌아도', async () => {
  const gate = path.join(dir, 'gate'); // 만들지 않는다
  const e = await start({ FAKE_SUB_GATE: gate });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사')); // 허용 전에 띄운 세션 — 옵션 없음
  await launched;
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true); // 미룬다
  await e.sendUser(a.id, text('echo 둘'));
  await sleep(200);
  expect(e.heldInput(a.id)).toBe(1);

  const reply = resultTextIs(e, a.id, '받음: echo 둘');
  await e.setBypass(a.id, false); // 거둔다
  await reply;
  expect(e.heldInput(a.id)).toBe(0);
  expect(spawnsOf('A')).toHaveLength(1);
  expect(e.flags(a.id)).toEqual({ bypass: false, bySettings: false, pending: false });
  expect(e.subagentsRunning(a.id)).toHaveLength(1);
  expect(e.status(a.id)).toBe('working');
});

test('subagent: 서브에이전트의 승인이 떠 있어도 사람 입력·받은 메시지는 바로 간다 — 상태는 승인 대기, 카드는 남는다', async () => {
  const e = await start({ FAKE_SUB_MS: '50' });
  const { a, b } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  const req = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === a.id);
  await e.sendUser(a.id, text('SUBASK Write'));
  await launched; // 부모 차례는 끝났다
  const r = await req;
  expect(r.fromSubagent).toBe(true);
  expect(e.status(a.id)).toBe('awaiting');

  const reply = resultTextIs(e, a.id, '받음: echo 끼어듦');
  await e.sendUser(a.id, text('echo 끼어듦'));
  expect(e.heldInput(a.id)).toBe(0); // 줄에 세우지 않았다
  await reply;
  expect(e.pendingRequests(a.id)).toEqual([r]); // 그 차례가 끝나도 서브에이전트 카드는 남는다
  expect(e.status(a.id)).toBe('awaiting');

  const pending = waitFor<RelayMessage>(e, 'message', (m) => m.to === a.id && m.state === 'pending');
  await e.sendUser(b.id, text('SEND A: 확인해 줘'));
  const m = await pending;
  const got = resultTextIs(e, a.id, '받음: [두레 메시지 — 보낸 쪽: B(웹 화면)]\n확인해 줘');
  e.approveMessage(m.id); // 서브에이전트 카드가 떠 있어도 바쁘지 않다 — 바로 전달
  await got;
  expect(e.messages().find((x) => x.id === m.id)?.state).toBe('delivered');
  expect(e.pendingRequests(a.id)).toEqual([r]);

  const relayed = resultTextIs(e, a.id, '전달: 보고: Write');
  e.answerRequest(r.id, { type: 'allow' });
  await relayed;
  expect(userTexts().filter((t) => !t.startsWith('SEND'))).toEqual([
    'SUBASK Write', 'echo 끼어듦', '[두레 메시지 — 보낸 쪽: B(웹 화면)]\n확인해 줘',
  ]);
  expect(e.status(a.id)).toBe('idle');
});

test('subagent: 새 대화 — 스스로 시작할 차례를 기다리는 중이어도 바로 대기, 새 세션은 그 기다림을 이어받지 않는다', async () => {
  const gate = path.join(dir, 'gate');
  const mute = path.join(dir, 'mute');
  const e = await start({ FAKE_SUB_GATE: gate, FAKE_MUTE_FILE: mute }, false, { autoTurnGraceMs: 300 });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  fs.writeFileSync(mute, ''); // 가짜가 스스로 시작한 차례를 미룬다
  const ended = waitFor<SubagentsEvent>(e, 'subagents', (x) => x.agentId === a.id && x.running.length === 0);
  fs.writeFileSync(gate, '');
  await ended;
  expect(e.status(a.id)).toBe('working'); // 스스로 시작할 차례를 기다린다
  const statuses: AgentStatus[] = [];
  e.on('status', (s: StatusEvent) => s.agentId === a.id && statuses.push(s.status));

  await e.newConversation(a.id);
  expect(e.status(a.id)).toBe('idle');
  await e.describe(a.id); // 새 세션을 띄운다(입력 없음)
  expect(spawnsOf('A')).toHaveLength(2);
  expect(e.status(a.id)).toBe('idle');
  await sleep(500); // 옛 기다림 타이머가 남아 있었다면 이 사이에 울린다
  expect(statuses).toEqual(['idle']);
});

test('subagent: 뒤에서 돈 것으로 못 본 서브에이전트가 마지막으로 끝나도 — 미뤄 둔 다시 띄우기와 기다리던 입력이 나가고 대기로', async () => {
  const gate = path.join(dir, 'gate');
  const e = await start({ FAKE_SUB_GATE: gate, FAKE_INTERRUPT_SPARES_TASKS: '1' });
  const { a } = setup(e);
  // 앞에서 도는 서브에이전트(뒤에서 돈다는 표시 없음) — 이 가짜에선 부모 차례를 멈춰도 계속 돌고, 끝 알림은 그 차례의 result 뒤 쉬는 중에 온다
  const started = waitFor<SubagentsEvent>(e, 'subagents', (x) => x.agentId === a.id && x.running.length === 1);
  await e.sendUser(a.id, text('SUBFG 조사'));
  await started;
  const stopped = resultOf(e, a.id);
  await e.interrupt(a.id);
  await stopped;
  expect(e.subagentsRunning(a.id)).toHaveLength(1);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true); // 서브에이전트가 돌아 미룬다
  expect(e.flags(a.id).pending).toBe(true);
  await e.sendUser(a.id, text('echo 둘'));
  await sleep(200);
  expect(e.heldInput(a.id)).toBe(1);

  const on = waitFor<FlagsEvent>(e, 'flags', (f) => f.agentId === a.id && f.bypass);
  const done = resultTextIs(e, a.id, '받음: echo 둘');
  fs.writeFileSync(gate, '');
  await done;
  expect(await on).toEqual({ agentId: a.id, bypass: true, bySettings: false, pending: false });
  expect(modeLines('A')).toEqual([['SUBFG 조사'], ['mode:bypassPermissions', 'echo 둘']]);
  expect(e.history(a.id).find((x) => x.kind === 'subagent-end')).toMatchObject({ status: 'completed' });
  expect(e.heldInput(a.id)).toBe(0);
  expect(e.status(a.id)).toBe('idle');
});

test('subagent: 스스로 시작할 차례를 기다리는 중 보낸 사람 입력의 차례는 그 기다림을 쓰지 않는다 — /effort 는 진짜 스스로 시작한 차례 뒤에', async () => {
  const gate = path.join(dir, 'gate');
  // 스스로 시작한 차례를 늦게 연다 · 사용자 줄의 init 앞에 서브에이전트 system 줄(부모 줄이 아니다 — 보낸 줄을 읽은 것으로 치지 않는다)
  const e = await start({ FAKE_SUB_GATE: gate, FAKE_SELF_TURN_MS: '400', FAKE_PRE_INIT_SYSTEM: '1' });
  const { a } = setup(e);
  const launched = resultTextIs(e, a.id, 'LAUNCHED');
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  await e.setEffort(a.id, 'low');
  const ended = waitFor<SubagentsEvent>(e, 'subagents', (x) => x.agentId === a.id && x.running.length === 0);
  fs.writeFileSync(gate, '');
  await ended;

  const order: string[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === a.id && x.event.kind === 'result' && order.push(`result:${x.event.text}`));
  e.on('effort', (x: EffortEvent) => x.agentId === a.id && x.effortNow && order.push(`effort:${x.effortNow}`));
  const heard = waitFor<EffortEvent>(e, 'effort', (x) => x.agentId === a.id && x.effortNow === 'low');
  await e.sendUser(a.id, text('echo 끼어듦')); // 기다리는 중에도 입력은 바로 간다
  expect(e.heldInput(a.id)).toBe(0);
  await heard;
  expect(order).toEqual(['result:받음: echo 끼어듦', 'result:전달: 보고: 조사', 'effort:low']);
  expect(userTexts()).toEqual(['SUB 조사', 'echo 끼어듦', '/effort low']);
  expect(e.history(a.id).filter((x) => isText(x, '전달: 보고: 조사'))).toHaveLength(1);
  expect(e.status(a.id)).toBe('idle');
});

// ── 새 에이전트 만들기(create_agent) ──
const MAKE_TOOL = 'mcp__dure__create_agent';
interface AgentAddedEvent {
  agent: Agent;
  by: string;
}
const requestOf = (e: Engine, agentId: string) => waitFor<PendingRequest>(e, 'request', (r) => r.agentId === agentId);
const names = (e: Engine) => e.agents().map((x) => x.name);
const lastToolResult = (e: Engine, id: string) => e.history(id).filter((h) => h.kind === 'tool-result').at(-1);
/** create_agent 를 직접 부른다(SSE) — toolUseId 를 주면 _meta 에. 답은 data 줄 결과의 글·오류 표시 */
async function createDirect(
  agentId: string,
  args: unknown,
  o: { toolUseId?: string; signal?: AbortSignal } = {},
): Promise<{ text: string; isError: boolean }> {
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'run', agentId, 'mcp.json'), 'utf8')).mcpServers.dure;
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...cfg.headers },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'create_agent', arguments: args, ...(o.toolUseId ? { _meta: { 'claudecode/toolUseId': o.toolUseId } } : {}) },
    }),
    signal: o.signal,
  });
  const data = (await res.text()).split('\n').find((l) => l.startsWith('data: '));
  const { result } = JSON.parse(data!.slice('data: '.length)) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: result.content[0].text, isError: result.isError === true };
}

test('create_agent: MAKE — 카드(create-agent · 폴더 전체 경로 · task null) 동안 승인 기다림 · 만들기면 같은 방에 생기고 결과 글 · agent-added', async () => {
  const e = await start();
  const { room, a } = setup(e);
  const added: AgentAddedEvent[] = [];
  e.on('agent-added', (x: AgentAddedEvent) => added.push(x));
  const req = requestOf(e, a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('MAKE 테스트|검사|'));
  const r = await req;
  expect(r).toMatchObject({
    agentId: a.id, toolName: MAKE_TOOL, kind: 'create-agent', toolUseId: expect.any(String),
    input: { name: '테스트', role: '검사', folder: a.folder, task: null },
  });
  expect(r).not.toHaveProperty('fromSubagent');
  expect(e.status(a.id)).toBe('awaiting');
  expect(names(e)).toEqual(['A', 'B']); // 승인 전엔 없다

  e.answerRequest(r.id, { type: 'allow' });
  expect(await resultText(done)).toBe("에이전트 '테스트'를 만들었어요.");
  const made = e.agents().find((x) => x.name === '테스트')!;
  expect(made).toMatchObject({ roomId: room.id, role: '검사', folder: a.folder, started: false });
  expect(added).toEqual([{ agent: made, by: a.id }]);
  expect(lastToolResult(e, a.id)).toMatchObject({ isError: false, text: "에이전트 '테스트'를 만들었어요.", viaApproval: true });
  expect(e.messages()).toEqual([]); // 첫 할 일이 없으면 메시지도 없다
  expect(spawnsOf('테스트')).toHaveLength(0); // 할 일이 오기 전엔 띄우지 않는다
  expect(e.pendingRequests()).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
});

test('create_agent: 물려받기 — 모델·effort·자동은 만든 쪽 저장값 · 묻지 않음은 꺼짐 · 늘 허용은 빈 목록(만든 쪽이 켜고 늘 허용해도) · 묻지 않음이어도 카드는 뜬다', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  await e.setModel(a.id, 'haiku');
  await e.setEffort(a.id, 'low');
  e.updateAgent(a.id, { auto: true });
  const ask = requestOf(e, a.id); // 늘 허용 — 승인 카드의 항상 허용으로 더한다
  const asked = resultOf(e, a.id);
  await e.sendUser(a.id, text('ASK Write'));
  e.answerRequest((await ask).id, { type: 'allow-always' });
  await asked;
  expect(agentOf(e, a.id)).toMatchObject({ model: 'haiku', effort: 'low', auto: true, bypassOn: true, alwaysAllow: ['Write'] });

  const req = requestOf(e, a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('MAKE 테스트|검사|'));
  e.answerRequest((await req).id, { type: 'allow' });
  expect(await resultText(done)).toBe("에이전트 '테스트'를 만들었어요.");
  const made = e.agents().find((x) => x.name === '테스트')!;
  expect(made).toMatchObject({ model: 'haiku', effort: 'low', auto: true, bypassOn: false, alwaysAllow: [] });
  expect(e.flags(made.id)).toEqual({ bypass: false, bySettings: false, pending: false });
});

test('create_agent: 첫 할 일 — 새 에이전트 자동이 꺼져 있어도 확인 없이 만든 쪽이 보낸 메시지로 전달 · 결과 글 끝에 첫 메시지를 보냈어요', async () => {
  const e = await start();
  const { a } = setup(e);
  const states: string[] = [];
  e.on('message', (m: RelayMessage) => states.push(m.state));
  const req = requestOf(e, a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('MAKE 테스트|검사||README 정리해 줘'));
  const r = await req;
  expect(r.input).toEqual({ name: '테스트', role: '검사', folder: a.folder, task: 'README 정리해 줘' });
  const added = waitFor<AgentAddedEvent>(e, 'agent-added');
  e.answerRequest(r.id, { type: 'allow' });
  const { agent: made, by } = await added;
  expect(by).toBe(a.id);
  expect(made.auto).toBe(false);
  const theirs = resultOf(e, made.id);
  expect(await resultText(done)).toBe("에이전트 '테스트'를 만들었어요. 첫 메시지를 보냈어요.");
  expect(await resultText(theirs)).toBe('받음: [두레 메시지 — 보낸 쪽: A(기획)]\nREADME 정리해 줘');
  expect(states).toEqual(['queued', 'delivered']); // pending(확인 대기)을 거치지 않는다
  const [m] = e.messages();
  expect(m).toMatchObject({ from: a.id, to: made.id, text: 'README 정리해 줘', state: 'delivered' });
  expect(e.history(made.id).find((h) => h.kind === 'user')).toMatchObject({ source: 'relay', messageId: m.id });
});

test('create_agent: 첫 할 일은 사람이 승인한 메시지처럼 — 자동 상한에 걸려 있어도 held 가 아니고, 그 방 연속 횟수를 0 으로', async () => {
  const e = await start({}, false, { autoChainLimit: 1 });
  const { a, b } = setup(e);
  e.updateAgent(b.id, { auto: true });
  const first = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나')); // 세션을 띄운다
  await first;
  // 사람 입력 없이(MCP 직접) 자동 전달 하나 — 상한 1 에 닿는다
  const bDone = resultOf(e, b.id);
  expect(await toolDirect(a.id, 'send_message', { to: 'B', text: '하나' })).toEqual({ text: 'B 에게 전달했습니다.', isError: false });
  await bDone;

  const req = requestOf(e, a.id);
  const call = createDirect(a.id, { name: '테스트', role: '검사', task: '첫 일' });
  e.answerRequest((await req).id, { type: 'allow' });
  expect(await call).toEqual({ text: "에이전트 '테스트'를 만들었어요. 첫 메시지를 보냈어요.", isError: false });
  expect(e.messages().find((m) => m.text === '첫 일')?.state).toMatch(/^(queued|delivered)$/);
  // 연속 횟수가 0 이 됐다 — 다음 자동 전달은 상한에 걸리지 않는다(안 되돌렸으면 held)
  expect(await toolDirect(a.id, 'send_message', { to: 'B', text: '둘' })).toEqual({ text: 'B 에게 전달했습니다.', isError: false });
  expect(e.messages().filter((m) => m.state === 'held')).toEqual([]);
});

test('create_agent: 폴더 — 상대 경로는 만든 쪽 폴더 기준 · 절대 경로는 정규화해 그대로 · 없는 폴더는 카드 없이 오류', async () => {
  const e = await start();
  const { a } = setup(e);
  const sub = folder('a/sub');
  const other = folder('elsewhere');
  const requests: PendingRequest[] = [];
  e.on('request', (r: PendingRequest) => requests.push(r));

  let req = requestOf(e, a.id);
  let done = resultOf(e, a.id);
  await e.sendUser(a.id, text('MAKE 하위작업|검사|sub|'));
  let r = await req;
  expect(r.input).toEqual({ name: '하위작업', role: '검사', folder: sub, task: null });
  e.answerRequest(r.id, { type: 'allow' });
  expect(await resultText(done)).toBe("에이전트 '하위작업'을 만들었어요."); // 받침 있으면 을
  expect(e.agents().find((x) => x.name === '하위작업')?.folder).toBe(sub);

  req = requestOf(e, a.id);
  done = resultOf(e, a.id);
  await e.sendUser(a.id, text(`MAKE 절대|검사|${path.join(other, '..', 'elsewhere')}|`));
  r = await req;
  expect(r.input).toMatchObject({ folder: other });
  e.answerRequest(r.id, { type: 'deny' });
  await done;

  const missing = path.join(a.folder, 'nope');
  const seen = requests.length;
  done = resultOf(e, a.id);
  await e.sendUser(a.id, text('MAKE 없음|검사|nope|'));
  expect(await resultText(done)).toBe(`폴더를 찾을 수 없습니다: ${missing}`);
  expect(requests).toHaveLength(seen);
  expect(lastToolResult(e, a.id)).toMatchObject({ isError: true, text: `폴더를 찾을 수 없습니다: ${missing}`, viaApproval: false });
  expect(names(e)).toEqual(['A', 'B', '하위작업']);
});

test('create_agent: 미리 보기 — 이름 빔·역할 빔·이름 겹침(대소문자 무시)은 카드 없이 오류 글', async () => {
  const e = await start();
  const { a } = setup(e);
  const requests: PendingRequest[] = [];
  e.on('request', (r: PendingRequest) => requests.push(r));
  for (const [line, want] of [
    ['MAKE |검사|', '이름을 입력하세요'],
    ['MAKE  |검사|', '이름을 입력하세요'],
    ['MAKE 테스트||', '역할을 입력하세요'],
    ['MAKE 테스트| |', '역할을 입력하세요'],
    ['MAKE b|검사|', '이미 있는 이름입니다: b'],
    ['MAKE A|검사|', '이미 있는 이름입니다: A'],
  ]) {
    const done = resultOf(e, a.id);
    await e.sendUser(a.id, text(line));
    expect(await resultText(done)).toBe(want);
    expect(lastToolResult(e, a.id)).toMatchObject({ isError: true, text: want });
  }
  expect(requests).toEqual([]);
  expect(e.pendingRequests()).toEqual([]);
  expect(names(e)).toEqual(['A', 'B']);
});

test('create_agent: 미리 보기 — 이름·역할의 줄바꿈·제어 문자, 이름 40자·역할 200자 넘음은 카드 없이 오류 글 · 사람이 더하는 길은 그대로', async () => {
  const e = await start();
  const { room, a } = setup(e);
  const requests: PendingRequest[] = [];
  e.on('request', (r: PendingRequest) => requests.push(r));
  const NAME_CTRL = '이름에 줄바꿈이나 제어 문자를 쓸 수 없어요';
  const ROLE_CTRL = '역할에 줄바꿈이나 제어 문자를 쓸 수 없어요';
  for (const [line, want] of [
    ['MAKE 가\n나|검사|', NAME_CTRL],
    ['MAKE 가\r\n나|검사|', NAME_CTRL],
    ['MAKE 가\t나|검사|', NAME_CTRL],
    ['MAKE 가나\u0007|검사|', NAME_CTRL], // 끝의 제어 문자는 앞뒤 빈칸 자르기로 안 지워진다
    ['MAKE 테스트|검사\n하기|', ROLE_CTRL],
    ['MAKE 테스트|검사\u0000|', ROLE_CTRL],
    ['MAKE 테스트|검사\u009b하기|', ROLE_CTRL], // C1 제어 문자
    [`MAKE ${'가'.repeat(41)}|검사|`, '이름은 40자까지예요'],
    [`MAKE 테스트|${'역'.repeat(201)}|`, '역할은 200자까지예요'],
  ]) {
    const done = resultOf(e, a.id);
    await e.sendUser(a.id, text(line));
    expect(await resultText(done)).toBe(want);
    expect(lastToolResult(e, a.id)).toMatchObject({ isError: true, text: want, viaApproval: false });
  }
  // 줄 나눔 문자(U+2028·2029) — 가짜 claude 의 readline 이 그 글자에서 사용자 줄을 끊어 MCP 로 바로 부른다
  expect(await createDirect(a.id, { name: `가${String.fromCharCode(0x2028)}나`, role: '검사' })).toEqual({ text: NAME_CTRL, isError: true });
  expect(await createDirect(a.id, { name: '테스트', role: `검사${String.fromCharCode(0x2029)}하기` })).toEqual({ text: ROLE_CTRL, isError: true });
  expect(requests).toEqual([]);
  expect(names(e)).toEqual(['A', 'B']);

  // 끝 자리 — 이름 40자·역할 200자는 된다(앞뒤 빈칸·줄바꿈은 잘라 낸 뒤 센다)
  const req = requestOf(e, a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text(`MAKE ${'가'.repeat(40)} |${'역'.repeat(200)}\n|`));
  const r = await req;
  expect(r.input).toMatchObject({ name: '가'.repeat(40), role: '역'.repeat(200) });
  e.answerRequest(r.id, { type: 'deny' });
  await done;

  // 사람이 더하는 길(에이전트 추가 대화상자)은 그대로 — 이 검사는 create_agent 에만
  const mine = e.addAgent({ roomId: room.id, name: '사'.repeat(41), role: '역할\n둘째 줄', folder: folder('h') });
  expect(mine).toMatchObject({ name: '사'.repeat(41), role: '역할\n둘째 줄' });
});

test('create_agent: 폴더 — Git Bash 꼴(/c/...·/c)은 Windows 경로(C:\\...)로 바꿔 쓴다 · 드라이브 글자 하나일 때만', async () => {
  const e = await start();
  const { a } = setup(e);
  const sub = folder('a/sub');
  expect(sub).toMatch(/^[A-Za-z]:\\/); // 시험 폴더는 드라이브 경로
  const drive = sub[0];
  const bash = `/${drive.toLowerCase()}${sub.slice(2).replace(/\\/g, '/')}`; // C:\…\a\sub → /c/…/a/sub
  const requests: PendingRequest[] = [];
  e.on('request', (r: PendingRequest) => requests.push(r));

  let req = requestOf(e, a.id);
  let done = resultOf(e, a.id);
  await e.sendUser(a.id, text(`MAKE 배시|검사|${bash}|`));
  let r = await req;
  expect(r.input).toMatchObject({ folder: sub });
  e.answerRequest(r.id, { type: 'allow' });
  expect(await resultText(done)).toBe("에이전트 '배시'를 만들었어요.");
  expect(e.agents().find((x) => x.name === '배시')?.folder).toBe(sub);

  // 대문자 드라이브·끝 빗금도 · 드라이브만(/c)이면 그 드라이브 맨 위
  req = requestOf(e, a.id);
  done = resultOf(e, a.id);
  await e.sendUser(a.id, text(`MAKE 배시2|검사|/${drive.toUpperCase()}/|`));
  r = await req;
  expect(r.input).toMatchObject({ folder: `${drive.toUpperCase()}:\\` });
  e.answerRequest(r.id, { type: 'deny' });
  await done;

  // 드라이브 글자가 아니면(두 글자) 바꾸지 않는다 — 지금처럼 내 폴더 기준으로 푼다
  const seen = requests.length;
  done = resultOf(e, a.id);
  await e.sendUser(a.id, text('MAKE 배시3|검사|/cc/nope|'));
  expect(await resultText(done)).toBe(`폴더를 찾을 수 없습니다: ${path.resolve(a.folder, '/cc/nope')}`);
  expect(requests).toHaveLength(seen);
});

test('create_agent: 거절 — 결과는 새 에이전트 만들기를 거절했어요(오류), 에이전트 없음 · 항상 허용은 던지고 카드는 그대로', async () => {
  const e = await start();
  const { a } = setup(e);
  const added: unknown[] = [];
  e.on('agent-added', (x: unknown) => added.push(x));
  const req = requestOf(e, a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('MAKE 테스트|검사||할 일'));
  const r = await req;
  expect(() => e.answerRequest(r.id, { type: 'allow-always' })).toThrow();
  expect(e.pendingRequests()).toHaveLength(1);
  expect(agentOf(e, a.id).alwaysAllow).toEqual([]);
  e.answerRequest(r.id, { type: 'deny' });
  expect(DENY.createAgentDenied).toBe('사용자가 새 에이전트 만들기를 거절했어요.');
  expect(await resultText(done)).toBe(DENY.createAgentDenied);
  expect(lastToolResult(e, a.id)).toMatchObject({ isError: true, text: DENY.createAgentDenied, viaApproval: true });
  expect(names(e)).toEqual(['A', 'B']);
  expect(added).toEqual([]);
  expect(e.messages()).toEqual([]);
});

test('create_agent: 카드가 떠 있는 동안 만든 쪽 세션이 끝나면(새 대화·멈추기·종료) 카드가 사라지고 만들지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  const added: unknown[] = [];
  e.on('agent-added', (x: unknown) => added.push(x));
  for (const end of [(id: string) => e.newConversation(id), (id: string) => e.interrupt(id), () => e.shutdown()]) {
    const req = requestOf(e, a.id);
    await e.sendUser(a.id, text('MAKE 테스트|검사||할 일'));
    const r = await req;
    const gone = waitFor(e, 'request-resolved', (x: { id: string }) => x.id === r.id);
    await end(a.id);
    expect(await gone).toEqual({ id: r.id, agentId: a.id });
    expect(e.pendingRequests()).toEqual([]);
    expect(() => e.answerRequest(r.id, { type: 'allow' })).toThrow('대기 중인 요청이 없습니다');
  }
  await sleep(200); // 늦게 만들어지지도 않는다
  expect(names(e)).toEqual(['A', 'B']);
  expect(added).toEqual([]);
  expect(e.messages()).toEqual([]);
});

test('create_agent: 부른 쪽이 끊으면(MCP 호출이 끊김) 카드가 사라지고 만들지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  const first = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나')); // 세션을 띄운다
  await first;
  const req = requestOf(e, a.id);
  const ac = new AbortController();
  const call = createDirect(a.id, { name: '테스트', role: '검사' }, { signal: ac.signal }).catch(() => 'aborted');
  const r = await req;
  expect(e.status(a.id)).toBe('awaiting');
  const gone = waitFor(e, 'request-resolved', (x: { id: string }) => x.id === r.id);
  ac.abort();
  expect(await gone).toEqual({ id: r.id, agentId: a.id });
  expect(await call).toBe('aborted');
  expect(e.pendingRequests()).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
  expect(names(e)).toEqual(['A', 'B']);
});

test('create_agent: 못 본 id 를 기다리는 사이 세션이 끝나거나 살아 있는 세션이 없으면 — 카드 없이 Claude 가 종료되었습니다', async () => {
  const e = await start({}, false, { seenWaitMs: 30_000 });
  const { a } = setup(e);
  const first = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나')); // 세션을 띄운다
  await first;
  const requests: PendingRequest[] = [];
  e.on('request', (r: PendingRequest) => requests.push(r));
  const call = createDirect(a.id, { name: '테스트', role: '검사' }, { toolUseId: 'toolu_nowhere' }); // 기다리기 시작
  await sleep(200);
  await e.newConversation(a.id);
  expect(await call).toEqual({ text: DENY.claudeExited, isError: true });
  // 세션이 없는 채로 온 부르기(끝난 프로세스의 늦은 호출) — 세션 끝 정리가 치울 수 없는 카드를 만들지 않는다
  expect(await createDirect(a.id, { name: '테스트', role: '검사' })).toEqual({ text: DENY.claudeExited, isError: true });
  expect(requests).toEqual([]);
  expect(names(e)).toEqual(['A', 'B']);
});

test('create_agent: 카드가 떠 있는 사이 사람이 같은 이름을 먼저 만들면 — 만들기 때 다시 확인해 만들지 않고 이름 겹침 오류', async () => {
  const e = await start();
  const { room, a } = setup(e);
  const added: unknown[] = [];
  e.on('agent-added', (x: unknown) => added.push(x));
  const req = requestOf(e, a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('MAKE 테스트|검사||할 일'));
  const r = await req;
  const mine = e.addAgent({ roomId: room.id, name: '테스트', role: '사람이 만듦', folder: folder('t') });
  e.answerRequest(r.id, { type: 'allow' });
  expect(await resultText(done)).toBe('이미 있는 이름입니다: 테스트');
  expect(lastToolResult(e, a.id)).toMatchObject({ isError: true, text: '이미 있는 이름입니다: 테스트' });
  expect(e.agents().filter((x) => x.name === '테스트')).toEqual([mine]);
  expect(added).toEqual([]);
  expect(e.messages()).toEqual([]); // 첫 할 일도 보내지 않는다
});

test('create_agent: 카드가 떠 있는 사이 폴더가 사라지면 — 만들기 때 다시 확인해 만들지 않고 폴더 오류', async () => {
  const e = await start();
  const { a } = setup(e);
  const sub = folder('a/sub');
  const req = requestOf(e, a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('MAKE 테스트|검사|sub|'));
  const r = await req;
  fs.rmSync(sub, { recursive: true });
  e.answerRequest(r.id, { type: 'allow' });
  expect(await resultText(done)).toBe(`폴더를 찾을 수 없습니다: ${sub}`);
  expect(names(e)).toEqual(['A', 'B']);
});

test('create_agent: SUBMAKE — 서브에이전트가 부르면 카드 없이 거절(서브에이전트는 두레 도구를 못 쓴다)', async () => {
  const e = await start({ FAKE_SUB_MS: '50' }, false, { seenWaitMs: 30_000 }); // 서브에이전트 줄은 스트림에서 본 id — 기다리면 시간 초과
  const { a } = setup(e);
  const requests: PendingRequest[] = [];
  e.on('request', (r: PendingRequest) => requests.push(r));
  const relayed = resultTextIs(e, a.id, '전달: 보고: 테스트|검사||할 일');
  await e.sendUser(a.id, text('SUBMAKE 테스트|검사||할 일'));
  await relayed;
  const tool = agentToolId(e, a.id);
  const sub = e.history(a.id).filter(hasParent);
  expect(sub.find((x) => x.kind === 'assistant' && x.blocks.some((b) => b.type === 'tool_use' && b.name === MAKE_TOOL))).toBeDefined();
  expect(sub.find((x) => x.kind === 'tool-result')).toMatchObject({
    kind: 'tool-result', isError: true, text: DENY.subagentDureTool, viaApproval: false, parent: tool,
  });
  expect(requests).toEqual([]);
  expect(names(e)).toEqual(['A', 'B']);
  expect(e.messages()).toEqual([]);
});

// ── 미리 띄우기(고른 에이전트) ──
test('미리 띄우기: 고르면 claude 를 띄우고 줄은 쓰지 않는다 — 다시 골라도 하나, 보내면 그 프로세스가 받는다', async () => {
  const e = await start();
  const { a } = setup(e);
  e.setSelected(a.id);
  await until('A 가 뜸', () => spawnsOf('A').length === 1);
  e.setSelected(a.id);
  await sleep(100);
  expect(spawnsOf('A')).toHaveLength(1);
  expect(userTexts()).toEqual([]);
  expect(e.status(a.id)).toBe('idle');
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('안녕'));
  expect(await resultText(done)).toBe('받음: 안녕');
  expect(spawnsOf('A')).toHaveLength(1);
});

test('미리 띄우기: 아무 줄도 안 받은 세션은 고르지 않게 되고 prewarmIdleMs 뒤에 끈다 — 그 사이 다시 고르면 그대로', async () => {
  const e = await start({}, false, { prewarmIdleMs: 300 });
  const { a, b } = setup(e);
  e.setSelected(a.id);
  await until('A 가 뜸', () => spawnsOf('A').length === 1);
  const pid = spawnsOf('A')[0].pid;
  e.setSelected(b.id);
  await sleep(150);
  e.setSelected(a.id); // 돌아옴 — 끄기 취소
  await sleep(450);
  expect(isAlive(pid)).toBe(true);
  e.setSelected(null);
  await until('A 가 꺼짐', () => !isAlive(pid));
  expect(e.status(a.id)).toBe('idle');
  e.setSelected(a.id); // 다시 고르면 새로 띄운다
  await until('A 가 다시 뜸', () => spawnsOf('A').length === 2);
});

test('미리 띄우기: 한 번이라도 줄을 받은 세션은 고르지 않게 돼도 끄지 않는다', async () => {
  const e = await start({}, false, { prewarmIdleMs: 100 });
  const { a, b } = setup(e);
  e.setSelected(a.id);
  await until('A 가 뜸', () => spawnsOf('A').length === 1);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('일'));
  await done;
  e.setSelected(b.id);
  await sleep(400);
  expect(isAlive(spawnsOf('A')[0].pid)).toBe(true);
});

test('미리 띄우기: 오류로 멈춘 에이전트는 고르기만으로 다시 띄우지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  const crashed = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === a.id && s.status === 'error');
  await e.sendUser(a.id, text('CRASH'));
  await crashed;
  e.setSelected(a.id);
  await sleep(150);
  expect(spawnsOf('A')).toHaveLength(1);
  expect(e.status(a.id)).toBe('error');
});

test('미리 띄우기: 폴더가 없으면 던지지 않고 보낼 때와 같은 오류 상태 · 모르는 에이전트는 조용히 넘어간다', async () => {
  const e = await start();
  const { a } = setup(e);
  fs.rmSync(agentOf(e, a.id).folder, { recursive: true });
  expect(() => e.setSelected(a.id)).not.toThrow();
  expect(e.status(a.id)).toBe('error');
  expect(e.errorText(a.id)).toContain('폴더를 찾을 수 없습니다');
  expect(() => e.setSelected('없는-에이전트')).not.toThrow();
  expect(spawns()).toHaveLength(0);
});

test('API 상태: 차례 밖(result 뒤)에 온 상태 줄은 버린다 — 서브에이전트만 도는 동안·늦게 온 끝이 단계를 바꾸지 않게', async () => {
  const e = await start({ FAKE_STATUS_AFTER_RESULT: '1' });
  const { a } = setup(e);
  const events: StreamEvent[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === a.id && events.push(x.event));
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('THINK 답'));
  await done;
  await sleep(200); // 차례 밖 상태 줄 둘이 올 시간
  expect(events.filter((x) => x.kind === 'api-status')).toEqual([{ kind: 'api-status', status: 'requesting' }]);
});

test('미리 띄우기: 고른 에이전트에서 새 대화를 시작하면 새 대화로 다시 미리 띄운다', async () => {
  const e = await start();
  const { a } = setup(e);
  e.setSelected(a.id);
  await until('A 가 뜸', () => spawnsOf('A').length === 1);
  await e.newConversation(a.id);
  await until('A 가 새 대화로 다시 뜸', () => spawnsOf('A').length === 2);
  const [first, second] = spawnsOf('A');
  expect(flagValue(second.argv, '--session-id')).toBeDefined();
  expect(flagValue(second.argv, '--session-id')).not.toBe(flagValue(first.argv, '--session-id') ?? flagValue(first.argv, '--resume'));
  expect(userTexts()).toEqual([]);
});

test('미리 띄우기: 고르지 않은 에이전트에서 새 대화를 시작해도 띄우지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.newConversation(a.id);
  await sleep(150);
  expect(spawnsOf('A')).toHaveLength(0);
});

test('미리 띄우기: 묻지 않음을 켜려고 다시 띄운 세션도 미리 띄운 세션 — 고르지 않게 되면 끈다', async () => {
  const e = await start({}, false, { prewarmIdleMs: 300 });
  const { a, b } = setup(e);
  e.setSelected(a.id); // 허용이 꺼진 때 — 옵션 없이 뜬다
  await until('A 가 뜸', () => spawnsOf('A').length === 1);
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true); // 옵션 없이 뜬 세션 — 쉬니 바로 --resume 으로 다시 띄운다
  await until('A 가 옵션을 달고 다시 뜸', () => spawnsOf('A').length === 2);
  const second = spawnsOf('A')[1];
  expect(second.argv).toContain('--allow-dangerously-skip-permissions');
  e.setSelected(b.id);
  await until('다시 띄운 A 가 꺼짐', () => !isAlive(second.pid));
});

test('notify 기본 asks true·finished false — setNotify 가 settings.json 에 남고 다시 켜도 그대로', async () => {
  const e = await start();
  expect(e.notify()).toEqual({ asks: true, finished: false });
  e.setNotify({ finished: true });
  expect(e.notify()).toEqual({ asks: true, finished: true });
  e.setAutoChainLimit(7);
  // 바꾼 칸만 파일에 — asks 는 건드리지 않았으니 없고, 다른 설정을 지우지도 않는다
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))).toEqual({ autoChainLimit: 7, notifyFinished: true });
  e.setNotify({ asks: false });
  await e.shutdown();
  const e2 = await start();
  expect(e2.notify()).toEqual({ asks: false, finished: true });
});

test('theme 기본은 Windows 따라감(system) — setTheme 이 settings.json 에 남고 다시 켜도 그대로', async () => {
  const e = await start();
  expect(e.theme()).toBe('system');
  e.setTheme('dark');
  expect(e.theme()).toBe('dark');
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
  e.setTheme('light');
  await e.shutdown();
  const e2 = await start();
  expect(e2.theme()).toBe('light');
});

test('theme — 모르는 값은 받지 않고, 파일의 이상한 값은 기본값', async () => {
  const e = await start();
  expect(() => e.setTheme('blue' as never)).toThrow('화면 테마는 라이트·다크·Windows 따라감 중 하나예요');
  expect(e.theme()).toBe('system');
  await e.shutdown();
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ theme: 7 }));
  const e2 = await start();
  expect(e2.theme()).toBe('system');
});

test('settings.json 의 알림 값이 불리언이 아니면 기본값', async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ notifyAsks: 'no', notifyFinished: 1 }));
  const e = await start();
  expect(e.notify()).toEqual({ asks: true, finished: false });
});

test('alwaysAllow: 되돌리면 다음 요청부터 다시 묻는다 · 없는 도구는 그대로 · 없는 에이전트는 던진다', async () => {
  const e = await start();
  const { a } = setup(e);
  // 늘 허용 목록이 바뀔 때마다 사건 — 화면의 메뉴 수·대화상자가 스냅샷을 기다리지 않게
  const always: { agentId: string; alwaysAllow: string[] }[] = [];
  e.on('always-allow', (p: { agentId: string; alwaysAllow: string[] }) => always.push(p));
  const ask1 = requestOf(e, a.id);
  const asked1 = resultOf(e, a.id);
  await e.sendUser(a.id, text('ASK Bash'));
  e.answerRequest((await ask1).id, { type: 'allow-always' });
  expect(always).toEqual([{ agentId: a.id, alwaysAllow: ['Bash'] }]); // 답한 그 자리에서
  await asked1;
  expect(agentOf(e, a.id).alwaysAllow).toEqual(['Bash']);

  expect(e.revokeAlwaysAllow(a.id, 'Write').alwaysAllow).toEqual(['Bash']); // 없는 도구는 그대로
  expect(always).toHaveLength(1); // 바뀌지 않았으면 사건도 없다
  expect(e.revokeAlwaysAllow(a.id, 'Bash').alwaysAllow).toEqual([]);
  expect(always).toEqual([{ agentId: a.id, alwaysAllow: ['Bash'] }, { agentId: a.id, alwaysAllow: [] }]);
  expect(agentOf(e, a.id).alwaysAllow).toEqual([]);
  expect(() => e.revokeAlwaysAllow('없는-에이전트', 'Bash')).toThrow();

  const ask2 = requestOf(e, a.id); // 다시 묻는다
  const asked2 = resultOf(e, a.id);
  await e.sendUser(a.id, text('ASK Bash'));
  const r = await ask2;
  expect(r.toolName).toBe('Bash');
  e.answerRequest(r.id, { type: 'allow' });
  await asked2;
});
