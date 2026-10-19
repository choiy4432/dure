import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine, type AgentStatus, type Engine, type PendingRequest, type RelayMessage, type StreamEvent, type UserPart } from '../src/engine';
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

async function start(env: Record<string, string> = {}): Promise<Engine> {
  const e = await createEngine({
    dataDir,
    claude: { command: process.execPath, argsPrefix: [FAKE] },
    env: { FAKE_CLAUDE_LOG: logFile, ...env },
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

test('describe → commands·models, account 없음', async () => {
  const e = await start();
  const { a } = setup(e);
  const events: unknown[] = [];
  e.on('agent-event', (x) => events.push(x));

  const d = await e.describe(a.id);

  expect(d).toEqual({
    commands: [{ name: 'compact', description: '대화 요약', argumentHint: '' }],
    models: [
      { value: 'default', displayName: 'Default' },
      { value: 'sonnet', displayName: 'Sonnet', description: '빠름' }, // resolvedModel 같은 나머지 필드는 버린다
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
