import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine, type AgentStatus, type Engine, type EngineOptions, type PendingRequest, type RelayMessage, type StreamEvent, type UserPart } from '../src/engine';
import { openMessageLog } from '../src/engine/messageLog';

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
/** 에이전트의 MCP 설정으로 approve 를 직접 부른다 — 지금 차례와 상관없는(끊기거나 남은) 호출 흉내. 답은 SSE data 줄 */
async function approveDirect(agentId: string, toolName: string, signal?: AbortSignal): Promise<unknown> {
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'run', agentId, 'mcp.json'), 'utf8')).mcpServers.dure;
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...cfg.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: toolName, input: {} } } }),
    signal,
  });
  const data = (await res.text()).split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(JSON.parse(data!.slice('data: '.length)).result.content[0].text);
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
  expect(flags).toContainEqual({ agentId: a.id, bypass: false });
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
  expect(await flag).toEqual({ agentId: a.id, bypass: true });
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

test('engine: 이미지는 바이트 수만 기록', async () => {
  const e = await start();
  const { a } = setup(e);
  const bytes = Buffer.alloc(1234, 7);
  const base64 = bytes.toString('base64');
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: '봐 줘' }, { type: 'image', mediaType: 'image/png', base64 }]);
  await done;
  expect(e.history(a.id)[0]).toMatchObject({
    kind: 'user',
    parts: [{ type: 'text', text: '봐 줘' }, { type: 'image', mediaType: 'image/png', bytes: 1234 }],
  });
  const file = path.join(dataDir, 'history', `${a.id}.jsonl`);
  expect(fs.readFileSync(file, 'utf8')).not.toContain(base64);
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
  await done;
  expect(e.heldInput(a.id)).toBe(0);
  expect(counts).toEqual([1, 0, 1, 2, 1, 0]); // SLOW 는 넣자마자 나가고(1→0), 둘은 줄에 서고(1→2), 차례마다 하나씩(1→0)
});

test('flags(): init 전엔 bypass false, FAKE_PERMISSION_MODE=bypassPermissions 이면 init 뒤 true', async () => {
  const e = await start({ FAKE_PERMISSION_MODE: 'bypassPermissions' });
  const { a, b } = setup(e);
  expect(e.flags(a.id)).toEqual({ bypass: false });
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await done;
  expect(e.flags(a.id)).toEqual({ bypass: true });
  expect(e.flags(b.id)).toEqual({ bypass: false });
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

test('effort: /effort 차례 중 멈추기 — 같은 프로세스에 이어 쓰지 않고 다시 띄워 /effort 부터 다시, 고른 effort 는 그대로', async () => {
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
