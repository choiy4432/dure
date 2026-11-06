import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createEngine, type Agent, type AgentStatus, type Engine, type EngineEventMap, type EngineOptions, type HistoryItem, type Hold, type PendingRequest, type RelayMessage, type StreamEvent, type UserPart } from '../src/engine';
import { newAgentFolder } from '../src/engine/engine';
import { openMessageLog } from '../src/engine/messageLog';
import { joinDeliveries } from '../src/engine/router';
import { openStore } from '../src/engine/store';
import { DENY } from '../src/shared/denyTexts';
import { ATTACH_MAX_BYTES, MEDIA_INLINE_MAX_B64, PDF_INLINE_MAX_BYTES, PDF_INLINE_MAX_PAGES } from '../src/shared/attachments';
import { packedPdf, pdfOf } from './pdfFixtures';
import type { ReadyPart } from '../src/engine/types';
import { attachmentsCleanupScript, uploadScript } from '../src/engine/remote';
import { ClaudeSession } from '../src/engine/claudeSession';
import { Readable } from 'node:stream';

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

test('일하는 중엔 사람 말도 받은 메시지도 바로 지금 차례에 끼어든다(probe17) — 멈추면 안 읽힌 끼운 말은 claude 를 내려 돌려받아 붙잡는다(probe20)', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  const init = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'init');
  await e.sendUser(a.id, text('SLOW'));
  await init;
  await e.sendUser(a.id, text('echo 둘째'));
  expect(e.heldInput(a.id)).toBe(0); // 줄에 서지 않고 바로 나갔다
  expect(e.history(a.id).filter((x) => x.kind === 'user')).toHaveLength(2); // 보낸 줄은 그때 기록된다
  const bDone = resultOf(e, b.id);
  await e.sendUser(b.id, text('SEND A: 셋째'));
  expect(await resultText(bDone)).toBe('A 에게 전달했습니다. 지금 하는 일 사이에 읽습니다.');
  const delivery = '[두레 메시지 — 보낸 쪽: B(웹 화면)]\n셋째';
  const aTexts = () => userTexts().filter((t) => t !== 'SEND A: 셋째');
  expect(aTexts()).toEqual(['SLOW', 'echo 둘째', delivery]); // 둘 다 바로
  expect(e.history(a.id).flatMap((x) => (x.kind === 'user' ? [x.source] : []))).toEqual(['human', 'human', 'relay']);

  // 멈추면 — 그대로 두면 Claude 가 아직 안 읽은 끼운 말로 곧바로 새 차례를 연다(probe17). 이미 claude 안에 들어간 말을 돌려받는 길은
  // claude 를 내리는 것뿐(그 말은 기록에 안 남는다, probe20) — 돌려받아 붙잡고, --resume 으로 다시 띄워 둔다. 이어서 보내기 전엔 안 나간다
  const first = spawnsOf('A')[0].pid;
  const slept = sleepEvents(e, a.id);
  await e.interrupt(a.id);
  expect(slept.at(-1) ?? { asleep: false }).toMatchObject({ asleep: false }); // 다시 띄웠다 — 화면이 '잠듦'으로 남지 않는다
  expect(e.hold(a.id)?.items.map((x) => [x.source, x.text])).toEqual([['human', 'echo 둘째'], ['relay', '셋째']]);
  expect(e.messages({ to: a.id }).map((m) => m.state)).toEqual(['queued']);
  expect(e.history(a.id).some((x) => x.kind === 'notice' && x.text === '멈췄어요 — Claude 가 아직 읽지 않은 말 2개는 붙잡았어요')).toBe(true);
  await until('A 가 꺼짐', () => !isAlive(first));
  await until('다시 띄움', () => spawnsOf('A').length === 2);
  expect(lastSpawnOf('A').argv).toContain('--resume');
  await until('쉼', () => e.status(a.id) === 'idle');
  await sleep(300);
  expect(aTexts()).toEqual(['SLOW', 'echo 둘째', delivery]); // 새 claude 엔 아무것도 안 갔다
  // 이어서 보내기 — 내 말 먼저, 메시지는 그다음
  const own = resultTextIs(e, a.id, '받음: echo 둘째');
  const relayed = resultTextIs(e, a.id, `받음: ${delivery}`);
  e.resumeHold(a.id);
  await own;
  await relayed;
  expect(e.messages({ to: a.id }).map((m) => m.state)).toEqual(['delivered']);
  expect(aTexts()).toEqual(['SLOW', 'echo 둘째', delivery, 'echo 둘째', delivery]);
});

test('일하는 중에 끼어든 줄이 안 읽힌 채 차례가 끝나면 그 줄의 차례까지 쉬지 않는다 — 받은 메시지도 같이 끼어 그 차례에서 읽는다', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  await e.sendUser(a.id, text('SLOW'));
  await waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'init');
  await e.sendUser(a.id, text('echo 끼어듦'));
  const bDone = resultOf(e, b.id);
  await e.sendUser(b.id, text('SEND A: 메시지'));
  expect(await resultText(bDone)).toBe('A 에게 전달했습니다. 지금 하는 일 사이에 읽습니다.');
  const first = resultOf(e, a.id);
  const own = resultTextIs(e, a.id, '받음: echo 끼어듦');
  const statuses: string[] = [];
  e.on('status', (x: StatusEvent) => x.agentId === a.id && statuses.push(x.status));
  // 엔진이 스스로 멈춘 차례(계획 모드 바꾸기 실패 — planOnFailed)처럼 세션에 바로 — 사람의 멈추기는 끼운 말을 돌려받아 붙잡는다(probe20 시험)
  await (e as any).sessions.get(a.id).interrupt();
  expect(await resultText(first)).toBe('interrupted');
  await own;
  expect(statuses).toEqual(['idle']); // 끼어든 줄의 차례가 끝난 뒤 한 번 — 멈춘 차례와 그 차례 사이에 쉬는 틈이 없었다
  expect(userTexts().filter((t) => t !== 'SEND A: 메시지')).toEqual(['SLOW', 'echo 끼어듦', '[두레 메시지 — 보낸 쪽: B(웹 화면)]\n메시지']);
});

test('받는 쪽이 끼워 넣을 수 없는 동안(먼저 기다리는 입력) 쌓인 메시지는 쉴 때 한 줄로 묶어 — 기록은 메시지마다', async () => {
  const e = await start();
  const { a, b } = setup(e);
  const c = e.addAgent({ roomId: agentOf(e, a.id).roomId, name: 'C', role: '검수', folder: a.folder });
  e.updateAgent(a.id, { auto: true });
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('/대기')); // 줄에 서는 입력 — 그 뒤 메시지는 끼어들지 않는다(차례를 앞지르지 않게)
  await relayTo(e, b.id, 'SEND A: 첫 지시');
  const cDone = resultOf(e, c.id);
  await e.sendUser(c.id, text('SEND A: 앞 지시 취소'));
  expect(await resultText(cDone)).toBe('A 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
  const first = '[두레 메시지 — 보낸 쪽: B(웹 화면)]\n첫 지시';
  const second = '[두레 메시지 — 보낸 쪽: C(검수)]\n앞 지시 취소';
  const joined = joinDeliveries([first, second]);
  const both = resultTextIs(e, a.id, `받음: ${joined}`);
  await e.interrupt(a.id);
  e.resumeHold(a.id); // 붙잡힌 '/대기'·메시지 둘 — 이어서 보내면 내 입력 먼저, 메시지는 한 번에
  await both;
  expect(textsToA().filter((t) => t !== 'SEND A: 앞 지시 취소')).toEqual(['SLOW', '/대기', joined]);
  const relays = e.history(a.id).filter((x) => x.kind === 'user' && x.source === 'relay');
  expect(relays.map((x) => (x.kind === 'user' ? x.messageId : null))).toEqual(e.messages({ to: a.id }).map((m) => m.id));
  expect(relays.map((x) => (x.kind === 'user' ? x.parts : null))).toEqual([[{ type: 'text', text: first }], [{ type: 'text', text: second }]]);
  expect(e.messages({ to: a.id }).map((m) => m.state)).toEqual(['delivered', 'delivered']);
});

test('끼어든 말의 되돌림이 안 오면(맞추지 못함) 차례가 끝난 뒤 midGraceMs 기다렸다가 다시 쉰다', async () => {
  const e = await start({ FAKE_REPLAY_OFF: '1' }, false, { midGraceMs: 300 });
  const { a } = setup(e);
  const slow = resultOf(e, a.id);
  await e.sendUser(a.id, text('THINK 생각'));
  await e.sendUser(a.id, text('echo 끼어듦'));
  await slow;
  expect(e.status(a.id)).toBe('working'); // 아직 안 읽혔다고 본다
  await waitFor<StatusEvent>(e, 'status', (x) => x.agentId === a.id && x.status === 'idle');
  const next = resultTextIs(e, a.id, '받음: echo 다음');
  await e.sendUser(a.id, text('echo 다음'));
  await next;
});

test('슬래시 명령·계획 먼저는 일하는 중이면 끼어들지 않고 차례를 기다린다', async () => {
  const e = await start();
  const { a } = setup(e);
  await e.sendUser(a.id, text('SLOW'));
  await waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'init');
  await e.sendUser(a.id, text('/compact'));
  expect(e.heldInput(a.id)).toBe(1);
  await e.sendUser(a.id, text('echo 뒤에')); // 먼저 기다리는 입력이 있으면 앞지르지 않는다
  expect(e.heldInput(a.id)).toBe(2);
  expect(userTexts()).toEqual(['SLOW']);
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

  const restored = resultTextIs(e, b.id, '받음: echo 못 읽음');
  await e.newConversation(b.id);
  await restored; // 새 대화가 남은 입력부터 보냈다 — 그 차례가 끝난 뒤 다음 입력(일하는 중이면 끼어든다)

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
  await e.sendUser(b.id, text('SLOW')); // 일하는 중이라 바로 보낸다 — mute 라 못 읽은 채 새 대화로 돌아온다
  await e.describe(b.id); // 그 프로세스가 떠서 플래그를 읽었다 — 이제 지워도 된다
  fs.rmSync(dieFlag);
  const first = resultTextIs(e, b.id, '받음: echo 못 읽음');

  await e.newConversation(b.id);

  await first; // 사람이 다시 치지 않아도 새 대화로 갔다
  expect(e.status(b.id)).toBe('working'); // 이어서 기다리던 SLOW
  const aDone = resultOf(e, a.id);
  await e.sendUser(a.id, text('SEND B: 이어서'));
  expect(await resultText(aDone)).toBe('B 에게 전달했습니다. 지금 하는 일 사이에 읽습니다.'); // SLOW 차례에 끼어든다

  const delivery = '[두레 메시지 — 보낸 쪽: A(기획)]\n이어서';
  await e.interrupt(b.id); // 끼어든 메시지를 안 읽은 채 멈춤 — claude 를 내려 돌려받고 붙잡는다(probe20), 새 대화 세션을 --resume 으로 다시 띄운다
  expect(e.hold(b.id)?.items.map((x) => x.source)).toEqual(['relay']);
  await until('다시 띄움', () => spawnsOf('B').length === 3);
  const last = resultTextIs(e, b.id, `받음: ${delivery}`);
  e.resumeHold(b.id);
  await last;
  await until('쉼', () => e.status(b.id) === 'idle');
  // 첫 줄은 mute 프로세스가 받기만 한 기록 · 끼어들었다 돌려받은 메시지는 이어서 보낼 때 다시
  expect(userTexts().filter((t) => t !== 'SEND B: 이어서')).toEqual(['echo 못 읽음', 'SLOW', 'echo 못 읽음', 'SLOW', delivery, delivery]);
  expect(flagValue(spawnsOf('B')[1].argv, '--session-id')).toBe(agentOf(e, b.id).sessionId);
  expect(flagValue(lastSpawnOf('B').argv, '--resume')).toBe(agentOf(e, b.id).sessionId);
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
  await e.sendUser(a.id, text('echo 사람 하나')); // 일하는 중이라 바로 보낸다 — 읽기 전에 죽으면 기다리는 줄로 돌아온다
  // 가짜 claude 가 그 줄을 읽은 뒤에 죽인다 — 안 그러면 kill 이 먼저 닿아 줄이 기록에 없을 수 있다(부하에서 흔들림, SLOW 는 끼운 말을 되돌리지 않음)
  await until('A 가 받음', () => userTexts().includes('echo 사람 하나'));
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
  expect(aTexts).toEqual(['SLOW', 'echo 사람 하나', 'echo 사람 하나', 'echo 사람 둘', delivery]); // 둘째 '하나' = 다시 띄운 세션
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(a.sessionId);
});

test('재시작 유지: 끼어들었지만 못 읽은 메시지가 있는 채로 shutdown → queued 로 남고 → createEngine 다시 → 받는 쪽에 전달됨', async () => {
  const e1 = await start();
  const { a, b } = setup(e1);
  e1.updateAgent(b.id, { auto: true });
  const bInit = waitFor<AgentEvent>(e1, 'agent-event', (x) => x.agentId === b.id && x.event.kind === 'init');
  await e1.sendUser(b.id, text('SLOW'));
  await bInit;
  expect(e1.status(b.id)).toBe('working');

  const aDone = resultOf(e1, a.id);
  await e1.sendUser(a.id, text('SEND B: 이어서 해 줘'));
  expect(await resultText(aDone)).toBe('B 에게 전달했습니다. 지금 하는 일 사이에 읽습니다.');
  expect(e1.messages()[0].state).toBe('delivered'); // 끼어들었다 — 아직 안 읽음
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
  expect(await resultText(bDone)).toBe('A 에게 전달했습니다. 지금 하는 일 사이에 읽습니다.'); // 승인 대기도 차례 중 — 끼어든다

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
  const broken = waitFor(e, 'engine-error', () => true);
  const rested = waitFor<StatusEvent>(e, 'status', (x) => x.agentId === a.id && x.status === 'idle');
  const second = resultTextIs(e, a.id, '받음: echo 둘');

  await e.sendUser(a.id, text('echo 하나'));
  await broken; // 듣는 쪽이 이 차례의 result 에서 던졌다(그 뒤 듣는 쪽엔 그 사건이 안 간다 — 그래서 result 대신 이것을 기다린다)
  await rested;
  await e.sendUser(a.id, text('echo 둘'));

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

test('newConversation 의 경계에 끝난 대화의 세션 id — 나중에 그 대화로 돌아갈 수 있게. 시작 안 한 대화는 없음', async () => {
  const e = await start();
  const { a } = setup(e);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 하나'));
  await done;
  await e.newConversation(a.id);
  const second = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id); // 한 마디도 안 한 대화 — 돌아갈 대화가 없다
  const bounds = e.history(a.id, { all: true }).filter((x) => x.kind === 'boundary');
  expect(bounds).toHaveLength(2);
  expect(bounds[0]).toMatchObject({ kind: 'boundary', ended: a.sessionId });
  expect(bounds[1]).not.toHaveProperty('ended');
  expect(second).not.toBe(a.sessionId);
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

test('지금 대화는 세션으로 고른다 — resumed 경계 앞의 같은 세션 구간까지', async () => {
  const e1 = await start();
  const { a } = setup(e1);
  await e1.shutdown();
  const S1 = 's1-session';
  const S2 = 's2-session';
  const stateFile = path.join(dataDir, 'state.json');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const ag = st.agents.find((x: any) => x.id === a.id);
  ag.sessionId = S1;
  ag.started = true;
  fs.writeFileSync(stateFile, JSON.stringify(st));
  const u = (t: string, n: number) => ({ t: n, kind: 'user', source: 'human', parts: [{ type: 'text', text: t }] });
  const lines = [
    u('하나', 1),
    { t: 2, kind: 'boundary', ended: S1 },
    u('둘', 3),
    { t: 4, kind: 'boundary', ended: S2, resumed: S1 },
    { t: 5, kind: 'notice', text: '이 대화로 돌아왔어요' },
  ];
  fs.mkdirSync(path.join(dataDir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'history', `${a.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const e2 = await start();
  const h = e2.history(a.id);
  expect(h.filter((x) => x.kind === 'user').map((x: any) => x.parts[0].text)).toEqual(['하나']);
  expect(h[h.length - 1]).toMatchObject({ kind: 'notice', text: '이 대화로 돌아왔어요' });
});

test('init 의 session_id 가 다르면 저장값을 그것으로', async () => {
  const other = crypto.randomUUID();
  const e = await start({ FAKE_INIT_SESSION: other });
  const { a } = setup(e);
  expect(agentOf(e, a.id).sessionId).not.toBe(other);
  await talk(e, a.id);
  expect(agentOf(e, a.id).sessionId).toBe(other);
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
  await e.sendUser(a.id, text('/나중')); // 슬래시 명령은 일하는 중이면 줄에 선다(끼어들지 않는다)
  expect(e.history(a.id).map((x) => x.kind)).toEqual(['user']);
  const second = waitFor(e, 'agent-event', (x: AgentEvent) => x.agentId === a.id && x.event.kind === 'result' && x.event.text === '받음: /나중');
  await e.interrupt(a.id);
  expect(e.history(a.id).filter((x) => x.kind === 'user')).toHaveLength(1); // 붙잡힌 입력도 기록에 없다
  e.resumeHold(a.id);
  await second;
  expect(e.history(a.id).filter((x) => x.kind === 'user').map((x: any) => x.parts[0].text)).toEqual(['SLOW', '/나중']);
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
  await e.sendUser(a.id, text('/하나')); // 슬래시 명령 — 일하는 중이면 줄에 선다
  await e.sendUser(a.id, text('/둘'));
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
  await e.sendUser(a.id, text('/둘')); // 줄에 서는 입력(슬래시 명령 — 보통 말은 바로 끼어든다)
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
  expect(userTexts()).toEqual(['echo 하나', 'SLOW', '/effort medium', '/둘']);
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
  // 첫 계획 모드 요청의 답이 1.5 초 뒤(시작·대화 읽기가 느린 CLI) — 평소 한도(0.5 초)는 넘고 띄울 때 한도(10 초) 안이다.
  // 띄울 때 한도는 가짜 claude 의 시작 시간까지 들어가니 넉넉히 — 평소 한도보다 훨씬 길기만 하면 된다
  const e = await start({ FAKE_SET_MODE_LATE_MS: '1500', FAKE_SET_MODE_LATE_MODE: 'plan' }, false, {
    bypassTimeoutMs: 500, bypassSpawnTimeoutMs: 10_000,
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

/** 묻지 않음을 켜고 옵션으로 띄워 bypass 인 세션 — 'echo 하나' 차례까지 */
async function bypassSession(e: Engine, id: string): Promise<void> {
  await e.setAllowBypass(true);
  await e.setBypass(id, true);
  await turn(e, id, 'echo 하나');
  expect(e.flags(id).bypass).toBe(true);
}

test('plan: 묻지 않음이 켜진 에이전트가 계획 모드를 끄거나 멈추면 다시 bypass', async () => {
  const e = await start();
  const { a } = setup(e);
  await bypassSession(e, a.id);
  // 끄기
  await e.setPlanMode(a.id, true);
  expect(e.planMode(a.id)).toBe(true);
  expect(e.flags(a.id).bypass).toBe(false);
  await e.setPlanMode(a.id, false);
  expect(e.planMode(a.id)).toBe(false);
  expect(e.flags(a.id)).toEqual({ bypass: true, bySettings: false, pending: false });
  // 멈추기 — 계획을 세워 승인을 기다리는 중에
  const req = planRequest(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true });
  await req;
  await e.interrupt(a.id);
  await until('다시 bypass', () => e.flags(a.id).bypass);
  expect(e.planMode(a.id)).toBe(false);
  expect(agentOf(e, a.id).bypassOn).toBe(true);
  expect(modeLines('A')).toEqual([
    ['mode:bypassPermissions', 'echo 하나', 'mode:plan', 'mode:bypassPermissions', 'mode:plan', 'PLAN 헤더', 'mode:bypassPermissions'],
  ]);
});

test('plan: 묻지 않고 실행하는 세션에 계획 먼저 — 계획 모드 답이 온 뒤에야 그 입력을 쓴다(그 전엔 아무 차례도 돌지 않는다)', async () => {
  // 계획 모드 요청의 답이 1.5 초 뒤 — 그 사이 입력을 쓰면 bypass 그대로 차례가 돈다(가짜는 계획 모드가 아니면 PLAN 을 보통 글로 받는다)
  const e = await start({ FAKE_SET_MODE_LATE_MS: '1500', FAKE_SET_MODE_LATE_MODE: 'plan' });
  const { a } = setup(e);
  await bypassSession(e, a.id);
  const results: string[] = [];
  const inits: string[] = [];
  e.on('agent-event', (x: AgentEvent) => {
    if (x.agentId !== a.id) return;
    if (x.event.kind === 'result') results.push(x.event.text);
    if (x.event.kind === 'init') inits.push(x.event.permissionMode);
  });
  const req = planRequest(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true });
  expect(e.status(a.id)).toBe('working'); // 쥔 입력 — 보낸 것과 같다
  expect(e.heldInput(a.id)).toBe(0);
  await sleep(800);
  expect(userTexts()).not.toContain('PLAN 헤더'); // 답 전엔 쓰지 않았다
  expect(inits).toEqual([]);
  expect(results).toEqual([]);
  const r = await req;
  expect(inits).toEqual(['plan']); // 그 차례는 계획 모드로 시작했다
  expect(results).toEqual([]);
  expect(modeLines('A')).toEqual([['mode:bypassPermissions', 'echo 하나', 'mode:plan', 'PLAN 헤더']]);
  // 승인하면 다시 bypass
  const done = resultOf(e, a.id);
  e.answerRequest(r.id, { type: 'allow' });
  expect(await resultText(done)).toBe('approved');
  await until('다시 bypass', () => e.flags(a.id).bypass);
}, 15_000);

test('plan: 묻지 않고 실행하는 세션이 계획 모드로 못 바꾸면 그 입력을 쓰지 않고 붙잡는다', async () => {
  const e = await start({ FAKE_SET_MODE_FAIL: 'plan' });
  const { a } = setup(e);
  await bypassSession(e, a.id);
  const errs: string[] = [];
  e.on('engine-error', (x: { message: string }) => errs.push(x.message));
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true });
  await until('붙잡음', () => e.hold(a.id) !== null);
  expect(e.hold(a.id)!.items).toEqual([expect.objectContaining({ source: 'human', text: 'PLAN 헤더' })]);
  expect(userTexts()).not.toContain('PLAN 헤더');
  expect(errs).toEqual([PLAN_ON_FAILED]);
  expect(noticesOf(e, a.id)).toEqual([PLAN_ON_FAILED_STOPPED_NOTICE]);
  expect(e.planMode(a.id)).toBe(false);
  expect(e.flags(a.id).bypass).toBe(true); // 묻지 않음은 그대로
  expect(e.status(a.id)).toBe('idle');
  expect(e.heldInput(a.id)).toBe(0);
});

test('plan: 계획 모드를 기다리는 동안 묻지 않음을 끄고 계획 모드로 못 바꾸면 — 입력은 붙잡고 두레가 켠 bypass 는 걷는다', async () => {
  // 계획 모드 요청에 끝내 답이 없다(1 초 한도) — 그 사이 스위치를 끈다(계획 모드 중이라 끄기는 보내지 않고 미룬다)
  const e = await start({ FAKE_SET_MODE_SILENT: 'plan' }, false, { bypassTimeoutMs: 1000, bypassSpawnTimeoutMs: 10_000 });
  const { a } = setup(e);
  await bypassSession(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true });
  await e.setBypass(a.id, false);
  await until('붙잡음', () => e.hold(a.id) !== null);
  await until('bypass 걷힘', () => !e.flags(a.id).bypass);
  expect(agentOf(e, a.id).bypassOn).toBe(false);
  expect(e.planMode(a.id)).toBe(false);
  expect(userTexts()).not.toContain('PLAN 헤더');
  expect(noticesOf(e, a.id)).toEqual([PLAN_ON_FAILED_STOPPED_NOTICE]);
  expect(modeLines('A')).toEqual([['mode:bypassPermissions', 'echo 하나', 'mode:plan', 'mode:default']]);
}, 15_000);

test('plan: 계획 모드 답을 기다리며 쥔 입력은 멈추면 붙잡는다 — 늦게 온 답이 쓰지 않는다', async () => {
  const e = await start({ FAKE_SET_MODE_LATE_MS: '1000', FAKE_SET_MODE_LATE_MODE: 'plan' });
  const { a } = setup(e);
  await bypassSession(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true });
  await e.interrupt(a.id);
  expect(e.hold(a.id)!.items.map((i) => i.text)).toEqual(['PLAN 헤더']);
  expect(e.heldInput(a.id)).toBe(0);
  await until('다시 bypass', () => e.flags(a.id).bypass && !e.planMode(a.id));
  await sleep(300);
  expect(userTexts()).not.toContain('PLAN 헤더');
  expect(e.status(a.id)).toBe('idle');
  expect(noticesOf(e, a.id)).toEqual(['멈췄어요']);
}, 15_000);

test('plan: 계획 모드 요청이 실패하면 그사이 차례 번호가 올랐어도 알린다 — 바라는 값이 남아 다음 계획 먼저가 계획 없이 나가지 않는다', async () => {
  const e = await start({ FAKE_SET_MODE_FAIL: 'plan:once' });
  const { a } = setup(e);
  await turn(e, a.id, 'echo 하나'); // 허용 없이 뜬 세션(옵션 없음)
  const errs: string[] = [];
  e.on('engine-error', (x: { message: string }) => errs.push(x.message));
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('SLOW'), { plan: true });
  // 옵션 없이 뜬 세션의 끄기 — 보낼 것이 없다(전엔 여기서 차례 번호만 올라 위 실패를 말없이 넘겼다)
  await e.setBypass(a.id, false);
  expect(await resultText(done)).toBe('interrupted'); // 계획 없이 돌던 차례를 멈췄다
  expect(errs).toEqual([PLAN_ON_FAILED]);
  expect(e.planMode(a.id)).toBe(false);
  // 바라는 값이 남지 않았다 — 다음 계획 먼저 입력은 다시 계획 모드를 청한다
  const req = planRequest(e, a.id);
  await e.sendUser(a.id, text('PLAN 헤더'), { plan: true });
  await req;
  expect(e.planMode(a.id)).toBe(true);
  expect(modeLines('A')).toEqual([['echo 하나', 'mode:plan', 'SLOW', 'mode:plan', 'PLAN 헤더']]);
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
  await e.sendUser(a.id, text('/둘째')); // 줄에 서는 입력(슬래시 명령) — 보통 말은 바로 끼어든다
  expect(e.heldInput(a.id)).toBe(1);
  const got = holdEvents(e, a.id);
  const held: number[] = [];
  e.on('held-input', (h: { agentId: string; count: number }) => h.agentId === a.id && held.push(h.count));
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  const h = e.hold(a.id)!;
  expect(h.items).toEqual([{ id: expect.any(String), source: 'human', from: null, text: '/둘째', images: 0 }]);
  expect(h.since).toBeGreaterThan(0);
  expect(e.heldInput(a.id)).toBe(0); // 붙잡힌 것은 기다리는 입력 수에 들지 않는다
  expect(held).toEqual([0]);
  expect(got).toEqual([h]);
  expect(await resultText(done)).toBe('interrupted');
  // 그 차례의 result 에서 다음 입력을 보냈다면 이미 작업 중이다
  expect(e.status(a.id)).toBe('idle');
  expect(userTexts()).not.toContain('/둘째');
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
  await e.sendUser(a.id, text('/대기')); // 줄에 서는 입력 — 그 뒤 메시지는 끼어들지 않고 queued
  await relayTo(e, b.id, 'SEND A: 셋째\n둘째 줄');
  const [m] = e.messages({ to: a.id });
  expect(m.state).toBe('queued');
  const done = resultOf(e, a.id);
  await e.interrupt(a.id);
  expect(e.hold(a.id)!.items.slice(1)).toEqual([{ id: m.id, source: 'relay', from: b.id, text: '셋째', images: 0 }]);
  await done;
  expect(e.status(a.id)).toBe('idle');
  expect(e.messages({ to: a.id }).map((x) => x.state)).toEqual(['queued']);
  expect(textsToA()).toEqual(['SLOW']);
});

test('hold: 일하는 중에 온 메시지는 끼어든다 — 안 읽은 채 멈추면 그 메시지로 새 차례가 열리지 않고 붙잡힌다', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  await slowTurn(e, a.id);
  const bDone = resultOf(e, b.id);
  await e.sendUser(b.id, text('SEND A: 멈춰'));
  expect(await resultText(bDone)).toBe('A 에게 전달했습니다. 지금 하는 일 사이에 읽습니다.');
  const delivery = '[두레 메시지 — 보낸 쪽: B(웹 화면)]\n멈춰';
  expect(textsToA()).toEqual(['SLOW', delivery]);
  await e.interrupt(a.id);
  expect(e.hold(a.id)?.items.map((i) => [i.source, i.text])).toEqual([['relay', '멈춰']]);
  expect(e.messages({ to: a.id }).map((m) => m.state)).toEqual(['queued']);
  await until('쉼', () => e.status(a.id) === 'idle');
  await sleep(300);
  expect(textsToA()).toEqual(['SLOW', delivery]); // 그 메시지로 새 차례가 열리지 않았다
});

test('hold: 이어서 보내기 = 내 입력 먼저 그다음 메시지, 붙잡기 풀림', async () => {
  const e = await start();
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('/echo 둘째'));
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
  expect(textsToA()).toEqual(['SLOW', '/echo 둘째', delivery]);
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
  const [mine, msg] = await holdUp('/echo 둘째', '셋째');
  expect([mine.source, msg.source]).toEqual(['human', 'relay']);
  e.dropHoldItem(a.id, mine.id);
  expect(e.hold(a.id)!.items).toEqual([msg]);
  expect(e.heldInput(a.id)).toBe(0);
  e.dropHoldItem(a.id, msg.id);
  expect(e.hold(a.id)).toBeNull();
  expect(got.map((h) => h?.items.length ?? null)).toEqual([2, 1, null]);
  expect(e.messages({ to: a.id }).map((x) => x.state)).toEqual(['dismissed']);

  expect(await holdUp('/echo 넷째', '다섯째')).toHaveLength(2);
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
  await e.sendUser(a.id, text('/둘째'));
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
  await e.sendUser(a.id, text('/둘째'));
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
  // 줄에 서는 입력(계획 먼저) — 보통 말은 바로 끼어든다
  await e.sendUser(a.id, [{ type: 'text', text: `\n  ${'가'.repeat(250)}\n둘째 줄` }, { type: 'image', mediaType: 'image/png', base64: png }], { plan: true });
  await e.sendUser(a.id, [{ type: 'image', mediaType: 'image/png', base64: png }, { type: 'image', mediaType: 'image/png', base64: png }], { plan: true });
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

test('background: 뒤에서 도는 명령(BGRUN)의 목록 줄은 화면 사건·기록에 안 나가고, 끝난 뒤 스스로 연 차례는 그대로 온다', async () => {
  const e = await start();
  const { a } = setup(e);
  const seen: StreamEvent[] = [];
  e.on('agent-event', (x: AgentEvent) => {
    if (x.agentId === a.id) seen.push(x.event);
  });
  const started = resultTextIs(e, a.id, 'BG STARTED');
  await e.sendUser(a.id, text('BGRUN 300'));
  await started;
  await resultTextIs(e, a.id, 'BG DONE'); // 300ms 뒤 스스로 연 차례
  expect(seen.filter((ev) => ev.kind === 'background-tasks')).toEqual([]);
  expect(e.history(a.id).filter((x) => (x.kind as string) === 'background-tasks')).toEqual([]);
});

test("background: 뒤에서 명령이 돌면 'background' {running:true} · 끝나면 false — 바뀔 때만 · backgroundRunning 도 같다(화면의 '뒤에서 명령 도는 중')", async () => {
  const e = await start();
  const { a } = setup(e);
  const bg: boolean[] = [];
  e.on('background', (x: EngineEventMap['background']) => {
    if (x.agentId === a.id) bg.push(x.running);
  });
  expect(e.backgroundRunning(a.id)).toBe(false);
  const started = resultTextIs(e, a.id, 'BG STARTED');
  await e.sendUser(a.id, text('BGRUN 300'));
  await started;
  expect(e.status(a.id)).toBe('idle'); // 차례는 끝났다 — 명령만 돈다
  expect(e.backgroundRunning(a.id)).toBe(true);
  expect(bg).toEqual([true]);
  await resultTextIs(e, a.id, 'BG DONE');
  await vi.waitFor(() => expect(e.backgroundRunning(a.id)).toBe(false));
  expect(bg).toEqual([true, false]);
});

test("background: 뒤에서 도는 서브에이전트만이면 명령이 아니다 — 'background' 사건 없음(서브에이전트는 따로 보인다)", async () => {
  const e = await start();
  const { a } = setup(e);
  const bg: boolean[] = [];
  e.on('background', (x: EngineEventMap['background']) => {
    if (x.agentId === a.id) bg.push(x.running);
  });
  const launched = new Promise<void>((resolve) => {
    e.on('subagents', (x: { agentId: string; running: string[] }) => {
      if (x.agentId === a.id && x.running.length > 0) resolve();
    });
  });
  await e.sendUser(a.id, text('SUB 조사'));
  await launched;
  expect(e.backgroundRunning(a.id)).toBe(false);
  expect(bg).toEqual([]);
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

// ── 재우기 — 한동안 쉰 에이전트의 claude 를 내리고, 말을 걸면 --resume 으로 깨운다 ──
/** '1분' = 20ms(15분 = 300ms, 기본 30분 = 600ms), 훑기도 20ms 마다 */
const SLEEPY: Partial<EngineOptions> = { sleepMinuteMs: 20, sleepSweepMs: 20 };
interface SleepEvent {
  agentId: string;
  asleep: boolean;
  waking: boolean;
}
/** 그 에이전트의 'sleep' 사건을 모은다(부른 뒤부터) */
function sleepEvents(e: Engine, id: string): SleepEvent[] {
  const got: SleepEvent[] = [];
  e.on('sleep', (x: SleepEvent) => x.agentId === id && got.push(x));
  return got;
}
const asleepOf = (e: Engine, id: string, ms = 3000) => waitFor<SleepEvent>(e, 'sleep', (x) => x.agentId === id && x.asleep, ms);
/** 한 차례 주고받는다 — 시작한 에이전트의 쉬는 세션이 남는다 */
async function talk(e: Engine, id: string, t = '안녕'): Promise<void> {
  const done = resultOf(e, id);
  await e.sendUser(id, text(t));
  await done;
}
/**
 * 그 에이전트의 마지막 result 를 받은 시각(부른 뒤부터) — 엔진이 그 줄을 활동으로 적는 같은 동기 흐름에서 잰다.
 * 기다림이 끝난 뒤 Date.now() 를 재면 그 사이 틈(부하에서 수십 ms)만큼 하한 검사가 헐거워지거나 깨진다
 */
function resultClock(e: Engine, id: string): () => number {
  let at = NaN;
  e.on('agent-event', (x: AgentEvent) => {
    if (x.agentId === id && x.event.kind === 'result') at = Date.now();
  });
  return () => at;
}

test('재우기: 저절로 — 설정 시간만큼 쉬면 claude 를 내린다 · 상태는 그대로 idle, 잠듦 사건', async () => {
  const e = await start({}, false, SLEEPY);
  const { a, b } = setup(e);
  e.setSleepAfter(15); // 300ms
  const lastResult = resultClock(e, a.id);
  await talk(e, a.id);
  const pid = spawnsOf('A')[0].pid;
  const slept = asleepOf(e, a.id);
  e.setSelected(b.id);
  expect(await slept).toEqual({ agentId: a.id, asleep: true, waking: false });
  // 마지막 활동(차례 끝)에서 300ms 가 지나기 전엔 재우지 않는다 — 차례 끝을 그 자리에서 쟀으니 여유는 시계 눈금만큼
  expect(Date.now() - lastResult()).toBeGreaterThanOrEqual(290);
  await until('A 가 꺼짐', () => !isAlive(pid));
  expect(e.status(a.id)).toBe('idle');
  expect(e.sleepState(a.id)).toEqual({ asleep: true, waking: false });
  expect(e.sleepBlock(a.id)).toBe('no-session');
  expect(spawnsOf('A')).toHaveLength(1);
});

test('재우기: PC 시계를 뒤로 돌려도 잰다 — 쉰 시간은 벽시계가 아니라 흐른 시간', async () => {
  const e = await start({}, false, SLEEPY);
  const { a, b } = setup(e);
  e.setSleepAfter(15); // 300ms
  await talk(e, a.id);
  e.setSelected(b.id);
  const real = Date.now;
  const back = vi.spyOn(Date, 'now').mockImplementation(() => real() - 3 * 24 * 60 * 60 * 1000); // 3일 뒤로
  try {
    expect(await asleepOf(e, a.id)).toEqual({ agentId: a.id, asleep: true, waking: false });
  } finally {
    back.mockRestore();
  }
});

test('재우기: 고른 에이전트는 저절로 재우지 않는다 — 다른 에이전트로 옮긴 순간부터 잰다', async () => {
  const e = await start({}, false, SLEEPY);
  const { a, b } = setup(e);
  e.setSleepAfter(15);
  e.setSelected(a.id);
  await talk(e, a.id);
  const got = sleepEvents(e, a.id);
  await sleep(600);
  expect(isAlive(spawnsOf('A')[0].pid)).toBe(true);
  expect(got).toEqual([]);
  const t0 = Date.now();
  const slept = asleepOf(e, a.id);
  e.setSelected(b.id); // 고르지 않게 된 때가 마지막 활동 — 이미 600ms 쉬었어도 곧바로 재우지 않는다
  await slept;
  expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
});

test('깨우기: 재운 뒤 말을 걸면 --resume 으로 이어서 — 깨우는 중 → 깨어남, 그 사이 다시 잠듦으로 가지 않는다', async () => {
  const e = await start({}, false, SLEEPY);
  const { a, b } = setup(e);
  e.setSleepAfter(15);
  await talk(e, a.id, '처음');
  const slept = asleepOf(e, a.id);
  e.setSelected(b.id);
  await slept;
  const got = sleepEvents(e, a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('다시'));
  expect(await resultText(done)).toBe('받음: 다시');
  const seen = [...got]; // 차례가 끝난 그 자리까지(다시 300ms 쉬면 또 잠든다)
  expect(spawnsOf('A')).toHaveLength(2);
  expect(flagValue(spawnsOf('A')[1].argv, '--resume')).toBe(a.sessionId);
  expect(spawnsOf('A')[1].argv).not.toContain('--session-id');
  // 띄운 순간(줄을 쓰기 전)엔 깨우는 중이 아닐 수 있다 — 줄을 쓰면 깨우는 중, 첫 init 에 깨어남
  const wakingAt = seen.findIndex((x) => x.waking);
  expect(wakingAt).toBeGreaterThanOrEqual(0);
  expect(seen.slice(wakingAt + 1)).toContainEqual({ agentId: a.id, asleep: false, waking: false });
  expect(seen.every((x) => !x.asleep)).toBe(true);
  expect(e.sleepState(a.id)).toEqual({ asleep: false, waking: false });
});

test('깨우기: effort 를 고른 에이전트도 — /effort 뒤에 기다리는 입력이 있는 동안은 깨우는 중', async () => {
  const e = await start({}, false, SLEEPY);
  e.setSleepAfter(0);
  const { a } = setup(e);
  await e.setEffort(a.id, 'high');
  await talk(e, a.id, '처음');
  expect(await e.sleep(a.id)).toBe(true);
  const got = sleepEvents(e, a.id);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('다시'));
  expect(await resultText(done)).toBe('받음: 다시');
  const wakingAt = got.findIndex((x) => x.waking);
  expect(wakingAt).toBeGreaterThanOrEqual(0);
  expect(got.slice(wakingAt + 1)).toContainEqual({ agentId: a.id, asleep: false, waking: false });
  expect(e.sleepState(a.id)).toEqual({ asleep: false, waking: false });
});

test('깨우기: effort 를 고른 에이전트를 전달 메시지가 깨우면 — /effort 차례 동안에도 깨우는 중, 메시지를 받는 차례의 init 에 깨어남', async () => {
  const e = await start({}, false, SLEEPY);
  e.setSleepAfter(0);
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  await e.setEffort(a.id, 'high');
  await talk(e, a.id, '처음');
  expect(await e.sleep(a.id)).toBe(true);
  const got = sleepEvents(e, a.id);
  const aDone = resultOf(e, a.id);
  const bDone = resultOf(e, b.id);
  await e.sendUser(b.id, text('SEND A: 일해'));
  // 띄운 세션이 /effort 차례 중이라 메시지는 queued 로 남았다가 그 차례가 끝나면 나간다
  expect(await resultText(bDone)).toBe('A 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
  expect(await resultText(aDone)).toBe('받음: [두레 메시지 — 보낸 쪽: B(웹 화면)]\n일해');
  // 띄운 순간부터 깨우는 중 — /effort 의 init 에서 '쉬는 중'으로 내려가지 않고, 메시지를 받는 차례의 init 에서 깨어남
  expect(got).toEqual([
    { agentId: a.id, asleep: false, waking: true },
    { agentId: a.id, asleep: false, waking: false },
  ]);
  expect(e.messages({ to: a.id })).toMatchObject([{ text: '일해', state: 'delivered' }]);
});

test('깨우기: 고르기로만 깨우면(줄 없음) 깨우는 중이 아니다 — 쉬는 중', async () => {
  const e = await start({}, false, SLEEPY);
  e.setSleepAfter(0);
  const { a } = setup(e);
  await talk(e, a.id);
  expect(await e.sleep(a.id)).toBe(true);
  const got = sleepEvents(e, a.id);
  e.setSelected(a.id); // 고르지 않은 채 재웠다 — 고르면 미리 띄운다
  await until('A 가 다시 뜸', () => spawnsOf('A').length === 2);
  await sleep(150);
  expect(got).toEqual([{ agentId: a.id, asleep: false, waking: false }]);
});

test('재우기: 재우는 중에 온 입력도 깨워서 한 번만 나간다', async () => {
  const e = await start({}, false, SLEEPY);
  e.setSleepAfter(0);
  const { a } = setup(e);
  await talk(e, a.id, '처음');
  const results: string[] = [];
  e.on('agent-event', (x: AgentEvent) => x.agentId === a.id && x.event.kind === 'result' && results.push(x.event.text));
  const done = resultOf(e, a.id);
  const sleeping = e.sleep(a.id); // 기다리지 않는다 — 끄는 사이에 말을 건다
  await e.sendUser(a.id, text('끼어듦'));
  expect(await resultText(done)).toBe('받음: 끼어듦');
  expect(await sleeping).toBe(true);
  await sleep(200);
  expect(userTexts().filter((t) => t === '끼어듦')).toHaveLength(1);
  expect(results).toEqual(['받음: 끼어듦']);
  expect(spawnsOf('A')).toHaveLength(2);
  expect(e.sleepState(a.id)).toEqual({ asleep: false, waking: false }); // 새 세션이 받았다
});

test('깨우기: 전달 메시지가 잠든 에이전트를 깨운다 — --resume 으로 띄워 받고 delivered', async () => {
  const e = await start({}, false, SLEEPY);
  e.setSleepAfter(0);
  const { a, b } = setup(e);
  e.updateAgent(a.id, { auto: true });
  await talk(e, a.id, '처음');
  expect(await e.sleep(a.id)).toBe(true);
  const aDone = resultOf(e, a.id);
  const bDone = resultOf(e, b.id);
  await e.sendUser(b.id, text('SEND A: 일해'));
  expect(await resultText(bDone)).toBe('A 에게 전달했습니다.');
  expect(await resultText(aDone)).toBe('받음: [두레 메시지 — 보낸 쪽: B(웹 화면)]\n일해');
  expect(spawnsOf('A')).toHaveLength(2);
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(a.sessionId);
  expect(e.messages({ to: a.id })).toMatchObject([{ text: '일해', state: 'delivered' }]);
});

test('재우기: 뒤에서 명령이 돌면 재우지 않는다 — 끝나 그 차례가 끝난 뒤부터 다시 잰다', async () => {
  const e = await start({}, false, SLEEPY);
  const { a, b } = setup(e);
  e.setSleepAfter(15);
  const lastResult = resultClock(e, a.id);
  const started = resultTextIs(e, a.id, 'BG STARTED');
  await e.sendUser(a.id, text('BGRUN 1500'));
  await started;
  const bgDone = resultTextIs(e, a.id, 'BG DONE');
  e.setSelected(b.id);
  const got = sleepEvents(e, a.id);
  await sleep(700); // 300ms 를 넘게 쉬었지만 명령이 돈다
  expect(e.sleepBlock(a.id)).toBe('background');
  expect(isAlive(spawnsOf('A')[0].pid)).toBe(true);
  expect(got).toEqual([]);
  await bgDone;
  await asleepOf(e, a.id);
  expect(Date.now() - lastResult()).toBeGreaterThanOrEqual(290); // 'BG DONE' 차례 끝에서 300ms
  expect(spawnsOf('A')).toHaveLength(1);
});

test('재우기: 뒤에서 도는 일 목록이 바뀐 줄도 활동이다 — 목록이 비는 그 순간 재우지 않고 그 줄부터 잰다', async () => {
  // 끝 줄은 목록이 비는 줄 하나뿐(끝 알림·스스로 시작한 차례 없이) — 그 줄만으로 활동이 되는지 본다
  const e = await start({ FAKE_BGRUN_LIST_ONLY: '1' }, false, SLEEPY);
  const { a } = setup(e);
  e.setSleepAfter(30); // 600ms
  const lastResult = resultClock(e, a.id);
  const started = resultTextIs(e, a.id, 'BG STARTED');
  await e.sendUser(a.id, text('BGRUN 800'));
  await started;
  expect(e.sleepBlock(a.id)).toBe('background');
  await until('A 가 잠듦', () => e.sleepBlock(a.id) === 'no-session', 4000);
  // 목록이 빈 줄(차례 끝 + 800ms)을 활동으로 치면 그로부터 600ms(차례 끝 + 1400ms). 치지 않으면 비자마자(차례 끝 + 800ms 남짓) 잠든다
  expect(Date.now() - lastResult()).toBeGreaterThanOrEqual(1100);
  expect(spawnsOf('A')).toHaveLength(1);
});

test('재우기: 사용량 묻기 답은 활동이 아니다 — 일하는 에이전트가 있어 쉬는 에이전트에 주기마다 물어도 그 에이전트는 잠든다', async () => {
  // 주기 40ms — 일하는 에이전트가 있는 동안 떠 있는 첫 세션(먼저 띄운 A)에 get_usage 를 묻는다
  const e = await start({}, { startDelayMs: 60_000, pollMs: 40, minAgeMs: 60_000, timeoutMs: 2000 }, SLEEPY);
  const { a, b } = setup(e);
  e.setSleepAfter(15); // 300ms
  await talk(e, a.id);
  const aPid = spawnsOf('A')[0].pid;
  await slowTurn(e, b.id);
  await asleepOf(e, a.id);
  const askedA = readLog().filter((x) => x.type === 'control_request' && x.request?.subtype === 'get_usage' && x.pid === aPid);
  expect(askedA.length).toBeGreaterThanOrEqual(2); // 쉬는 동안 A 에게 물었다 — 그래도 잠들었다
  expect(spawnsOf('A')).toHaveLength(1);
  expect(e.status(b.id)).toBe('working');
});

test('재우기: sleepBlock — 일하는 중·답을 기다림·기다리는 입력·서브에이전트·세션 없음·쉬는 세션', async () => {
  const gate = path.join(dir, 'gate'); // 서브에이전트를 돌려 둔 채
  const e = await start({ FAKE_SUB_GATE: gate }, false, SLEEPY);
  e.setSleepAfter(0);
  const room = e.addRoom('방');
  const mk = (name: string) => e.addAgent({ roomId: room.id, name, role: '일', folder: folder(name.toLowerCase()) });
  const [a, b, c, d, f] = ['A', 'B', 'C', 'D', 'F'].map(mk);
  expect(e.sleepBlock(a.id)).toBe('no-session');
  await talk(e, a.id);
  expect(e.sleepBlock(a.id)).toBeNull();
  await slowTurn(e, b.id);
  expect(e.sleepBlock(b.id)).toBe('working');
  const asked = requestOf(e, c.id);
  await e.sendUser(c.id, text('ASK Bash'));
  await asked;
  expect(e.sleepBlock(c.id)).toBe('asking'); // 차례는 도는 중이지만 사람 답이 막고 있다
  const launched = resultTextIs(e, d.id, 'LAUNCHED');
  await e.sendUser(d.id, text('SUB 조사'));
  await launched;
  expect(e.sleepBlock(d.id)).toBe('subagents');
  // 일하는 중에 친 슬래시 명령을 멈춰서 붙잡았다 — 쉬지만 사람이 고를 때까지 기다린다
  await slowTurn(e, f.id);
  await e.sendUser(f.id, text('/둘째'));
  const stopped = resultOf(e, f.id);
  await e.interrupt(f.id);
  await stopped;
  expect(e.hold(f.id)).not.toBeNull();
  expect(e.sleepBlock(f.id)).toBe('waiting-input');
  expect(e.sleepableIn(room.id)).toBe(1); // A 만
  expect(() => e.sleepBlock('없는-에이전트')).toThrow();
});

test('재우기: 손으로 — 재웠으면 true · 세션이 없거나 일하는 중이면 false 이고 세션 그대로', async () => {
  const e = await start({}, false, SLEEPY);
  e.setSleepAfter(0);
  const { a, b } = setup(e);
  await talk(e, a.id);
  const pid = spawnsOf('A')[0].pid;
  expect(await e.sleep(a.id)).toBe(true);
  await until('A 가 꺼짐', () => !isAlive(pid));
  expect(e.sleepState(a.id)).toEqual({ asleep: true, waking: false });
  expect(await e.sleep(a.id)).toBe(false); // 세션 없음
  await slowTurn(e, b.id);
  expect(await e.sleep(b.id)).toBe(false); // 일하는 중
  expect(isAlive(spawnsOf('B')[0].pid)).toBe(true);
  expect(e.status(b.id)).toBe('working');
  expect(spawnsOf('B')).toHaveLength(1);
  await expect(e.sleep('없는-에이전트')).rejects.toThrow();
});

test('재우기: 손으로 재운 고른 에이전트는 같은 고르기로 다시 띄우지 않는다 — 다른 에이전트를 골랐다 오면 띄운다', async () => {
  const e = await start({}, false, SLEEPY);
  e.setSleepAfter(0);
  const { a, b } = setup(e);
  e.setSelected(a.id);
  await talk(e, a.id);
  expect(await e.sleep(a.id)).toBe(true);
  e.setSelected(a.id); // 고른 카드를 다시 눌러도 — 미리 띄우기는 그 자리에서(동기로) 띄우니 곧바로 본다
  expect(e.sleepBlock(a.id)).toBe('no-session');
  expect(e.sleepState(a.id).asleep).toBe(true);
  e.setSelected(b.id);
  e.setSelected(a.id);
  await until('A 가 다시 뜸', () => spawnsOf('A').length === 2);
});

test('재우기: 손으로 재운 고른 에이전트도 새 대화를 시작하면 미리 띄운다 — 새 대화는 손으로 재운 표를 푼다', async () => {
  const e = await start({}, false, SLEEPY);
  e.setSleepAfter(0);
  const { a } = setup(e);
  e.setSelected(a.id);
  await talk(e, a.id);
  expect(await e.sleep(a.id)).toBe(true);
  await e.newConversation(a.id);
  expect(e.sleepBlock(a.id)).not.toBe('no-session'); // 새 대화로 미리 띄운 세션
  await until('A 가 새 대화로 뜸', () => spawnsOf('A').length === 2);
  expect(flagValue(lastSpawnOf('A').argv, '--session-id')).toBe(agentOf(e, a.id).sessionId);
});

test('재우기: 방 모두 — 쉬는 에이전트만 재우고 일하는 에이전트는 그대로', async () => {
  const e = await start({}, false, SLEEPY);
  e.setSleepAfter(0);
  const { room, a, b } = setup(e);
  const c = e.addAgent({ roomId: room.id, name: 'C', role: '검토', folder: folder('c') });
  await talk(e, a.id);
  await talk(e, b.id);
  await slowTurn(e, c.id);
  e.setSelected(a.id); // 고른 에이전트도 재운다
  expect(e.sleepableIn(room.id)).toBe(2);
  expect(await e.sleepRoom(room.id)).toBe(2);
  expect(e.sleepState(a.id).asleep).toBe(true);
  expect(e.sleepState(b.id).asleep).toBe(true);
  expect(e.status(c.id)).toBe('working');
  expect(isAlive(spawnsOf('C')[0].pid)).toBe(true);
  expect(e.sleepableIn(room.id)).toBe(0);
  const other = e.addRoom('다른 방');
  expect(await e.sleepRoom(other.id)).toBe(0);
});

test('재우기: 설정 — 기본 30분 · 끔(0)이면 안 재우고, 바꾸면 다음 훑기부터 · 고를 수 없는 값은 던진다 · 다시 켜도 그대로', async () => {
  const e = await start({}, false, SLEEPY);
  expect(e.sleepAfter()).toBe(30);
  e.setSleepAfter(0);
  const { a, b } = setup(e);
  await talk(e, a.id);
  e.setSelected(b.id);
  const got = sleepEvents(e, a.id);
  await sleep(1000);
  expect(got).toEqual([]);
  expect(isAlive(spawnsOf('A')[0].pid)).toBe(true);
  const slept = asleepOf(e, a.id, 1000);
  e.setSleepAfter(15); // 이미 300ms 넘게 쉬었다 — 다음 훑기에
  await slept;
  expect(() => e.setSleepAfter(7)).toThrow('고를 수 없는 시간이에요');
  expect(() => e.setSleepAfter('15' as never)).toThrow('고를 수 없는 시간이에요');
  expect(e.sleepAfter()).toBe(15);
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))).toEqual({ sleepAfterMin: 15 });
  await e.shutdown();
  const e2 = await start({}, false, SLEEPY);
  expect(e2.sleepAfter()).toBe(15);
  await e2.shutdown();
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ sleepAfterMin: 7 }));
  const e3 = await start();
  expect(e3.sleepAfter()).toBe(30);
  await e3.shutdown();
  fs.rmSync(path.join(dataDir, 'settings.json'));
  expect((await start()).sleepAfter()).toBe(30);
});

test('잠듦: 시작한 적 있고 세션이 없을 때 — 새 에이전트·오류로 멈춤은 아니다 · 다시 켜면 시작한 에이전트는 잠듦, 말을 걸면 깨어남을 알린다', async () => {
  const e = await start({}, false, SLEEPY);
  e.setSleepAfter(0);
  const { room, a, b } = setup(e);
  expect(e.sleepState(a.id)).toEqual({ asleep: false, waking: false });
  await talk(e, a.id);
  expect(e.sleepState(a.id)).toEqual({ asleep: false, waking: false });
  const bEvents = sleepEvents(e, b.id);
  const crashed = waitFor<StatusEvent>(e, 'status', (s) => s.agentId === b.id && s.status === 'error');
  await e.sendUser(b.id, text('CRASH'));
  await crashed;
  expect(agentOf(e, b.id).started).toBe(true);
  expect(e.sleepState(b.id)).toEqual({ asleep: false, waking: false }); // 오류 — 잠듦이 아니다
  expect(bEvents.some((x) => x.asleep)).toBe(false);
  await e.shutdown();

  const e2 = await start({}, false, SLEEPY);
  expect(e2.sleepState(a.id)).toEqual({ asleep: true, waking: false }); // 앱을 막 켠 것도 잠듦
  const c = e2.addAgent({ roomId: room.id, name: 'C', role: '검토', folder: folder('c') });
  const aEvents = sleepEvents(e2, a.id);
  const cEvents = sleepEvents(e2, c.id);
  await talk(e2, a.id);
  expect(aEvents.at(-1)).toEqual({ agentId: a.id, asleep: false, waking: false });
  expect(aEvents.some((x) => x.waking)).toBe(true);
  await talk(e2, c.id); // 처음 띄우는 새 에이전트 — 이어 갈 대화가 없어 잠듦도 깨우는 중도 아니다
  expect(cEvents).toEqual([]);
});

// ── 지난 대화 목록 ──
const convUserTexts = (items: HistoryItem[]) => items.filter((x) => x.kind === 'user').map((x: any) => x.parts[0].text);

test('지난 대화 목록 — 새것부터, 지금 대화 표시, 이유', async () => {
  const claudeDir = path.join(dir, 'claude');
  const e = await start({ CLAUDE_CONFIG_DIR: claudeDir, FAKE_TRANSCRIPTS: '1' });
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 둘');
  const second = e.history(a.id, { all: true }).filter((x) => x.kind === 'boundary')[0] as any;
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 셋');
  const secondId = (e.history(a.id, { all: true }).filter((x) => x.kind === 'boundary')[1] as any).ended;
  expect(second.ended).not.toBe(secondId);
  fs.rmSync(path.join(claudeDir, 'projects', 'fake', `${secondId}.jsonl`));
  const list = (await e.conversations(a.id));
  expect(list.map((c) => c.title)).toEqual(['echo 셋', 'echo 둘', 'echo 하나']);
  expect(list.map((c) => c.current)).toEqual([true, false, false]);
  expect(list.map((c) => c.resumable)).toEqual([false, false, true]);
  expect(list.map((c) => c.why)).toEqual([null, 'gone', null]);
  expect(list.map((c) => c.turns)).toEqual([1, 1, 1]);
  expect(e.pastCount(a.id)).toBe(2);
});

test('conversation(key) — 그 대화의 줄만', async () => {
  const claudeDir = path.join(dir, 'claude');
  const e = await start({ CLAUDE_CONFIG_DIR: claudeDir, FAKE_TRANSCRIPTS: '1' });
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 둘');
  const first = (await e.conversations(a.id)).find((c) => !c.current)!;
  expect(convUserTexts(e.conversation(a.id, first.key))).toEqual(['echo 하나']);
  expect(e.conversation(a.id, 'nope')).toEqual([]);
  expect(e.conversation(a.id, first.key, { limit: 1 })).toHaveLength(1);
});

test('예전 경계(ended 없음) 앞 대화는 old', async () => {
  const e1 = await start();
  const { a } = setup(e1);
  await e1.shutdown();
  const lines = [
    { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '옛' }] },
    { t: 2, kind: 'boundary' },
  ];
  fs.mkdirSync(path.join(dataDir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'history', `${a.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const e2 = await start();
  const list = (await e2.conversations(a.id));
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ title: '옛', current: false, resumable: false, why: 'old' });
  expect(e2.pastCount(a.id)).toBe(1);
});

// ── 이 대화로 돌아가기 · 이어 가기 실패 ──
/** 지난 대화 시험용 — Claude 대화 파일을 시험 폴더에 남긴다. env 는 그 객체 그대로 엔진에 간다(시험 도중 고치면 다음 실행부터) */
async function startConv(): Promise<{ e: Engine; env: Record<string, string>; claudeDir: string }> {
  const claudeDir = path.join(dir, 'claude');
  const env: Record<string, string> = { FAKE_CLAUDE_LOG: logFile, CLAUDE_CONFIG_DIR: claudeDir, FAKE_TRANSCRIPTS: '1' };
  const e = await start({}, false, { env });
  return { e, env, claudeDir };
}
const RESUME_LOST = 'Claude 쪽 기록이 없어 이어 가지 못했어요 — 새 대화로 시작해요';
/** 그 에이전트의 'status' 사건을 모은다(부른 뒤부터) */
function statusEvents(e: Engine, id: string): StatusEvent[] {
  const got: StatusEvent[] = [];
  e.on('status', (x: StatusEvent) => x.agentId === id && got.push(x));
  return got;
}
/** 마지막 경계와 그 뒤 줄 */
function lastBoundary(items: HistoryItem[]): { bound: HistoryItem; next: HistoryItem | undefined } {
  const i = items.map((x) => x.kind).lastIndexOf('boundary');
  return { bound: items[i], next: items[i + 1] };
}

test('돌아가기 — 경계·알림·세션·--resume 대상', async () => {
  const { e } = await startConv();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 둘');
  const s2 = agentOf(e, a.id).sessionId;
  expect(e.pastCount(a.id)).toBe(1);
  expect((await e.conversations(a.id)).filter((c) => !c.current).map((c) => c.key)).toEqual([s1]);

  await e.resumeConversation(a.id, s1);

  const { bound, next } = lastBoundary(e.history(a.id, { all: true }));
  expect(bound).toMatchObject({ kind: 'boundary', ended: s2, resumed: s1 });
  expect(next).toMatchObject({ kind: 'notice', text: '이 대화로 돌아왔어요' });
  expect(agentOf(e, a.id)).toMatchObject({ sessionId: s1, started: true });
  expect(e.pastCount(a.id)).toBe(1); // 기억을 버렸다 — 이제 지난 대화는 S2
  expect((await e.conversations(a.id)).filter((c) => !c.current).map((c) => c.key)).toEqual([s2]);

  await talk(e, a.id, 'echo 셋');
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(s1);
  expect(convUserTexts(e.history(a.id))).toEqual(['echo 하나', 'echo 셋']);
});

test('돌아간 대화를 Claude 가 다른 세션 id 로 이어 가도 지금 대화다 — 대화 탭이 비지 않고 목록의 지금 표시도 그것', async () => {
  const { e, env } = await startConv();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 둘');
  const s2 = agentOf(e, a.id).sessionId;
  await e.resumeConversation(a.id, s1);
  expect(e.pastCount(a.id)).toBe(1); // 기억해 둔 수 — 세션 id 가 바뀌면 버려야 한다
  const other = crypto.randomUUID();
  env.FAKE_INIT_SESSION = other; // --resume 했는데 init 이 다른 세션을 알린다

  await talk(e, a.id, 'echo 셋');

  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(s1);
  expect(agentOf(e, a.id).sessionId).toBe(other);
  const h = e.history(a.id);
  expect(h[0]).toMatchObject({ kind: 'notice', text: '이 대화로 돌아왔어요' });
  expect(convUserTexts(h)).toEqual(['echo 셋']);
  const list = (await e.conversations(a.id));
  expect(list.filter((c) => c.current)).toMatchObject([{ key: other, title: 'echo 셋', why: null }]);
  expect(list.filter((c) => !c.current).map((c) => c.key)).toEqual([s2, s1]);
  expect(e.conversation(a.id, other)).toEqual(h);
  expect(e.pastCount(a.id)).toBe(2);
});

test('돌아가기 막힘 — 뒤에서 도는 명령이 있으면 끄지 않고 거절', async () => {
  const { e } = await startConv();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  const started = resultTextIs(e, a.id, 'BG STARTED');
  await e.sendUser(a.id, text('BGRUN 1000'));
  await started;
  const bgDone = resultTextIs(e, a.id, 'BG DONE');
  const s2 = agentOf(e, a.id).sessionId;
  expect(e.sleepBlock(a.id)).toBe('background');

  await expect(e.resumeConversation(a.id, s1)).rejects.toThrow('뒤에서 도는 명령이 끝나면 돌아갈 수 있어요');

  expect(agentOf(e, a.id).sessionId).toBe(s2);
  expect(isAlive(lastSpawnOf('A').pid)).toBe(true);
  await bgDone;
});

test('이어 갈 수 없는 이유 — Claude 기록이 없으면 30일이 넘은 대화만 30일이 지나서라고', async () => {
  const { e, env } = await startConv();
  const { a } = setup(e);
  await e.shutdown();
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const oldId = crypto.randomUUID();
  const newId = crypto.randomUUID();
  const lines = [
    { t: now - 31 * DAY, kind: 'user', source: 'human', parts: [{ type: 'text', text: '오래된' }] },
    { t: now - 31 * DAY + 1, kind: 'boundary', ended: oldId },
    { t: now - 2 * DAY, kind: 'user', source: 'human', parts: [{ type: 'text', text: '요즘' }] },
    { t: now - 2 * DAY + 1, kind: 'boundary', ended: newId },
  ];
  fs.mkdirSync(path.join(dataDir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'history', `${a.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const e2 = await start({}, false, { env });
  expect((await e2.conversations(a.id)).map((c) => [c.title, c.why])).toEqual([['요즘', 'gone'], ['오래된', 'gone']]);

  await expect(e2.resumeConversation(a.id, oldId)).rejects.toThrow('30일이 지나 이어 갈 수 없어요');
  await expect(e2.resumeConversation(a.id, newId)).rejects.toThrow('Claude 쪽 기록이 없어 이어 갈 수 없어요');
  const fork = (key: string) => e2.forkAgent({ from: a.id, key, name: 'A 2', role: '기획' });
  await expect(fork(oldId)).rejects.toThrow('30일이 지나 이어 갈 수 없어요');
  await expect(fork(newId)).rejects.toThrow('Claude 쪽 기록이 없어 이어 갈 수 없어요');
});

test('돌아가기 막힘 — 일하는 중·Claude 기록이 없는 대화·지금 대화·없는 대화는 거절하고 기록·세션 그대로', async () => {
  const { e, claudeDir } = await startConv();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 둘');
  const s2 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 셋');
  const s3 = agentOf(e, a.id).sessionId;
  fs.rmSync(path.join(claudeDir, 'projects', 'fake', `${s1}.jsonl`));
  const before = e.history(a.id, { all: true }).length;

  await expect(e.resumeConversation(a.id, s1)).rejects.toThrow('Claude 쪽 기록이 없어 이어 갈 수 없어요'); // 방금 대화 — 30일이 지나서가 아니다
  await expect(e.resumeConversation(a.id, s3)).rejects.toThrow('그 대화를 찾을 수 없어요');
  await expect(e.resumeConversation(a.id, 'nope')).rejects.toThrow('그 대화를 찾을 수 없어요');

  const init = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'init');
  await e.sendUser(a.id, text('SLOW'));
  await init;
  await expect(e.resumeConversation(a.id, s2)).rejects.toThrow('일이 끝나면 돌아갈 수 있어요');
  expect(agentOf(e, a.id)).toMatchObject({ sessionId: s3, started: true });
  expect(e.status(a.id)).toBe('working');
  const added = e.history(a.id, { all: true }).slice(before);
  expect(added.filter((x) => x.kind === 'boundary' || x.kind === 'notice')).toEqual([]);
});

test('이어 가기 실패: 돌아간 대화의 Claude 기록이 없으면 새 대화로', async () => {
  const { e, env } = await startConv();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 둘');
  const s2 = agentOf(e, a.id).sessionId;
  env.FAKE_MISSING_SESSIONS = s1; // 목록엔 이어 갈 수 있다고 나왔는데 Claude 쪽엔 없다
  await e.resumeConversation(a.id, s1);
  const statuses = statusEvents(e, a.id);

  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 넷'));
  expect(await resultText(done)).toBe('받음: echo 넷');

  const now = agentOf(e, a.id);
  expect([s1, s2]).not.toContain(now.sessionId);
  expect(now.started).toBe(true);
  expect(flagValue(spawnsOf('A').at(-2)!.argv, '--resume')).toBe(s1); // 이어 가 보고
  expect(flagValue(lastSpawnOf('A').argv, '--session-id')).toBe(now.sessionId); // 새 대화로
  expect(lastSpawnOf('A').argv).not.toContain('--resume');
  const all = e.history(a.id, { all: true });
  const { bound, next } = lastBoundary(all);
  expect(bound).toMatchObject({ kind: 'boundary', ended: s1 });
  expect(bound).not.toHaveProperty('resumed');
  expect(next).toMatchObject({ kind: 'notice', text: RESUME_LOST });
  expect(all.some((x) => x.kind === 'result' && x.subtype === 'error_during_execution')).toBe(false);
  expect(statuses.some((x) => x.status === 'error')).toBe(false);
  expect(e.status(a.id)).not.toBe('error');
  expect(e.errorText(a.id)).toBeNull();
  expect(convUserTexts(e.history(a.id))).toEqual(['echo 넷']);
});

test('이어 가기 실패: 평소 --resume 도 Claude 기록이 없으면 오류로 멈추지 않고 새 대화로(30일 넘게 쉰 에이전트)', async () => {
  const { e, env } = await startConv();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  env.FAKE_MISSING_SESSIONS = s1; // 쉬는 사이 Claude 쪽 기록이 지워졌다
  expect(await e.sleep(a.id)).toBe(true);
  const statuses = statusEvents(e, a.id);

  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 둘'));
  expect(await resultText(done)).toBe('받음: echo 둘');

  const now = agentOf(e, a.id);
  expect(now.sessionId).not.toBe(s1);
  expect(flagValue(spawnsOf('A').at(-2)!.argv, '--resume')).toBe(s1);
  expect(flagValue(lastSpawnOf('A').argv, '--session-id')).toBe(now.sessionId);
  const all = e.history(a.id, { all: true });
  const { bound, next } = lastBoundary(all);
  expect(bound).toMatchObject({ kind: 'boundary', ended: s1 });
  expect(bound).not.toHaveProperty('resumed');
  expect(next).toMatchObject({ kind: 'notice', text: RESUME_LOST });
  expect(all.some((x) => x.kind === 'result' && x.subtype === 'error_during_execution')).toBe(false);
  expect(statuses.some((x) => x.status === 'error')).toBe(false);
  expect(e.errorText(a.id)).toBeNull();
  expect(convUserTexts(e.history(a.id))).toEqual(['echo 둘']);
});

test('돌아가기 — 고른 에이전트면 돌아간 대화로 미리 띄운다(--resume <그 대화>)', async () => {
  const { e } = await startConv();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 둘');
  e.setSelected(a.id);
  const before = spawnsOf('A').length;

  await e.resumeConversation(a.id, s1);

  await until('A 가 돌아간 대화로 뜸', () => spawnsOf('A').length === before + 1);
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(s1);
  expect(lastSpawnOf('A').argv).not.toContain('--session-id');
  expect(convUserTexts(e.history(a.id))).toEqual(['echo 하나']);
});

test('이어 가기 실패: 고른 에이전트가 돌아간 대화를 미리 띄우다 Claude 기록이 없으면 새 대화로 다시 미리 띄운다', async () => {
  const { e, env } = await startConv();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 둘');
  const s2 = agentOf(e, a.id).sessionId;
  env.FAKE_MISSING_SESSIONS = s1;
  e.setSelected(a.id);
  const before = spawnsOf('A').length;
  const statuses = statusEvents(e, a.id);

  await e.resumeConversation(a.id, s1);

  await until('A 가 새 대화로 다시 뜸', () => spawnsOf('A').length === before + 2);
  const [tried, fresh] = spawnsOf('A').slice(-2);
  expect(flagValue(tried.argv, '--resume')).toBe(s1);
  const now = agentOf(e, a.id);
  expect([s1, s2]).not.toContain(now.sessionId);
  expect(now.started).toBe(false);
  expect(flagValue(fresh.argv, '--session-id')).toBe(now.sessionId);
  expect(fresh.argv).not.toContain('--resume');
  const { bound, next } = lastBoundary(e.history(a.id, { all: true }));
  expect(bound).toMatchObject({ kind: 'boundary', ended: s1 });
  expect(next).toMatchObject({ kind: 'notice', text: RESUME_LOST });
  expect(statuses.some((x) => x.status === 'error')).toBe(false);
  expect(e.errorText(a.id)).toBeNull();
  expect(userTexts()).toEqual(['echo 하나', 'echo 둘']); // 미리 띄우기는 줄을 쓰지 않는다
});

test('이어 가기: init 전에 멈춘 --resume 세션의 오류 result 는 기록이 없다는 뜻이 아니다 — 평소처럼 멈춤, 새 대화로 가지 않는다', async () => {
  const { e, env } = await startConv();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  expect(await e.sleep(a.id)).toBe(true);
  env.FAKE_INIT_DELAY_MS = '400'; // init 앞에서 멈추기가 먼저 닿는다 — init 없이 오류 result
  const before = spawnsOf('A').length;

  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 둘'));
  await e.interrupt(a.id);
  const { event } = await done;
  expect(event).toMatchObject({ kind: 'result', subtype: 'error_during_execution' });

  await talk(e, a.id, 'echo 셋'); // 같은 프로세스가 이어 받는다
  expect(spawnsOf('A')).toHaveLength(before + 1);
  expect(flagValue(lastSpawnOf('A').argv, '--resume')).toBe(s1);
  expect(agentOf(e, a.id)).toMatchObject({ sessionId: s1, started: true });
  const all = e.history(a.id, { all: true });
  expect(all.filter((x) => x.kind === 'boundary')).toEqual([]);
  expect(all.some((x) => x.kind === 'notice' && x.text === RESUME_LOST)).toBe(false);
  expect(all.some((x) => x.kind === 'notice' && x.text === '멈췄어요')).toBe(true);
  expect(e.status(a.id)).toBe('idle');
});

// ── 새 에이전트로 이어 가기(갈래) ──
const FORK_LOST = '그 대화를 이어 오지 못했어요 — 새 대화로 시작해요';
/** 갈래 알림 — 날짜는 그 대화의 at(로컬 시간) */
const forkNotice = (name: string, at: number) => {
  const d = new Date(at);
  return `${name}의 ${d.getMonth() + 1}월 ${d.getDate()}일 대화에서 이어 만들었어요`;
};
/** A 의 첫 대화(echo 하나)를 끝내고 새 대화로 — 그 첫 대화의 세션 */
async function pastOfA(e: Engine): Promise<{ a: Agent; s1: string }> {
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  return { a, s1 };
}

test('갈래 — 새 에이전트, 줄 복사·알림, 첫 실행만 --fork-session', async () => {
  const { e } = await startConv();
  const { a, s1 } = await pastOfA(e);
  await e.setModel(a.id, 'haiku');
  await e.setEffort(a.id, 'low'); // 갈래의 첫 실행은 /effort 부터 — 그 차례의 init 도 갈래 친 세션이다
  e.updateAgent(a.id, { auto: true });
  const first = (await e.conversations(a.id)).find((c) => c.key === s1)!;
  const src = agentOf(e, a.id);
  const aBefore = e.history(a.id, { all: true });

  const made = await e.forkAgent({ from: a.id, key: s1, name: 'A 2', role: '기획' });

  expect(made).toMatchObject({
    name: 'A 2', role: '기획', roomId: src.roomId, folder: src.folder, forkOf: s1, started: false,
    auto: false, bypassOn: false, alwaysAllow: [], model: 'haiku', effort: 'low',
  });
  expect(made.sessionId).not.toBe(s1);
  expect(agentOf(e, made.id).forkOf).toBe(s1);
  const copied = e.history(made.id, { all: true });
  expect(copied.filter((x) => x.kind === 'boundary')).toEqual([]);
  expect(convUserTexts(copied)).toEqual(['echo 하나']);
  expect(copied.at(-1)).toMatchObject({ kind: 'notice', text: forkNotice('A', first.at) });
  expect(copied.slice(0, -1)).toEqual(e.conversation(a.id, s1)); // 그 대화의 줄 그대로(시각도)

  const done = resultOf(e, made.id);
  await e.sendUser(made.id, text('echo 둘'));
  expect(await resultText(done)).toBe('받음: echo 둘');
  const firstRun = lastSpawnOf('A 2').argv;
  const i = firstRun.indexOf('--resume');
  expect(firstRun.slice(i, i + 5)).toEqual(['--resume', s1, '--fork-session', '--session-id', made.sessionId]);
  expect(flagValue(firstRun, '--model')).toBe('haiku');
  expect(agentOf(e, made.id)).toMatchObject({ forkOf: null, started: true, sessionId: made.sessionId });

  expect(await e.sleep(made.id)).toBe(true);
  await talk(e, made.id, 'echo 셋');
  const later = lastSpawnOf('A 2').argv;
  expect(flagValue(later, '--resume')).toBe(made.sessionId);
  expect(later).not.toContain('--fork-session');
  expect(convUserTexts(e.history(made.id))).toEqual(['echo 하나', 'echo 둘', 'echo 셋']);
  expect(e.history(a.id, { all: true })).toEqual(aBefore); // 원래 에이전트의 기록·세션은 그대로
  expect(agentOf(e, a.id).sessionId).toBe(src.sessionId);
});

test('갈래 — 첫 init 의 저장은 한 번에(started·forkOf 함께) — 뒤 저장만 실패해 다시 갈래 치는 일이 없게', async () => {
  const { e } = await startConv();
  const { a, s1 } = await pastOfA(e);
  const made = await e.forkAgent({ from: a.id, key: s1, name: 'A 2', role: '기획' });
  const store = (e as any).store;
  const realUpdate = store.updateAgent.bind(store);
  const patches: object[] = [];
  store.updateAgent = (id: string, patch: object) => {
    if (id === made.id) patches.push(patch);
    return realUpdate(id, patch);
  };
  await talk(e, made.id, 'echo 둘');
  expect(patches.filter((p) => 'started' in p || 'forkOf' in p || 'sessionId' in p)).toEqual([{ started: true, forkOf: null }]);
  expect(agentOf(e, made.id)).toMatchObject({ started: true, forkOf: null, sessionId: made.sessionId });
});

test('갈래 — 앱을 다시 켜도 첫 실행 전이면 --fork-session', async () => {
  const { e, env } = await startConv();
  const { a, s1 } = await pastOfA(e);
  const made = await e.forkAgent({ from: a.id, key: s1, name: 'A 2', role: '기획' });
  await e.shutdown();

  const e2 = await start({}, false, { env });
  expect(agentOf(e2, made.id)).toMatchObject({ forkOf: s1, started: false, sessionId: made.sessionId });
  await talk(e2, made.id, 'echo 둘');
  const argv = lastSpawnOf('A 2').argv;
  expect(argv).toContain('--fork-session');
  expect(flagValue(argv, '--resume')).toBe(s1);
  expect(flagValue(argv, '--session-id')).toBe(made.sessionId);
  expect(agentOf(e2, made.id).forkOf).toBeNull();
});

test('갈래 실패 — 새 대화로', async () => {
  const { e, env } = await startConv();
  const { a, s1 } = await pastOfA(e);
  const made = await e.forkAgent({ from: a.id, key: s1, name: 'A 2', role: '기획' });
  env.FAKE_MISSING_SESSIONS = s1; // 만든 사이 Claude 쪽 기록이 지워졌다
  const aBefore = e.history(a.id, { all: true });
  const statuses = statusEvents(e, made.id);

  const done = resultOf(e, made.id);
  await e.sendUser(made.id, text('echo 둘'));
  expect(await resultText(done)).toBe('받음: echo 둘');

  const now = agentOf(e, made.id);
  expect(now.forkOf).toBeNull();
  expect(now.started).toBe(true);
  expect([s1, made.sessionId]).not.toContain(now.sessionId);
  const [tried, fresh] = spawnsOf('A 2');
  expect(tried.argv).toContain('--fork-session');
  expect(fresh.argv).not.toContain('--resume');
  expect(fresh.argv).not.toContain('--fork-session');
  expect(flagValue(fresh.argv, '--session-id')).toBe(now.sessionId);
  const all = e.history(made.id, { all: true });
  const { bound, next } = lastBoundary(all);
  expect(bound).toEqual({ t: expect.any(Number), kind: 'boundary' }); // 이 에이전트의 대화가 아니다 — 세션을 남기지 않는다
  expect(next).toMatchObject({ kind: 'notice', text: FORK_LOST });
  expect(all.some((x) => x.kind === 'notice' && x.text === RESUME_LOST)).toBe(false);
  expect(all.some((x) => x.kind === 'result' && x.subtype === 'error_during_execution')).toBe(false);
  expect(statuses.some((x) => x.status === 'error')).toBe(false);
  expect(e.errorText(made.id)).toBeNull();
  expect(convUserTexts(e.history(made.id))).toEqual(['echo 둘']);
  expect((await e.conversations(made.id)).find((c) => !c.current)).toMatchObject({ title: 'echo 하나', resumable: false, why: 'old' });
  expect(e.history(a.id, { all: true })).toEqual(aBefore);
});

test('갈래 — 지난 대화가 아니거나 이어 갈 수 없거나 이름이 겹치면 만들지 않는다', async () => {
  const { e, claudeDir } = await startConv();
  const { a, s1 } = await pastOfA(e);
  await talk(e, a.id, 'echo 둘');
  const s2 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 셋');
  const s3 = agentOf(e, a.id).sessionId;
  fs.rmSync(path.join(claudeDir, 'projects', 'fake', `${s2}.jsonl`));
  const fork = (key: string, name = 'A 2') => e.forkAgent({ from: a.id, key, name, role: '기획' });

  await expect(fork(s2)).rejects.toThrow('Claude 쪽 기록이 없어 이어 갈 수 없어요');
  await expect(fork(s3)).rejects.toThrow('그 대화를 찾을 수 없어요');
  await expect(fork('nope')).rejects.toThrow('그 대화를 찾을 수 없어요');
  await expect(fork(s1, 'a')).rejects.toThrow('이미 있는 이름입니다');
  await expect(fork(s1, ' ')).rejects.toThrow('이름을 입력하세요');
  expect(e.agents().map((x) => x.name)).toEqual(['A', 'B']);
});

test('갈래 — 그림은 새 에이전트 칸으로 복사, 복사 못 한 그림은 file 없이', async () => {
  const { e } = await startConv();
  const { a } = setup(e);
  const one = Buffer.from('png-one').toString('base64');
  const two = Buffer.from('png-two').toString('base64');
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [
    { type: 'text', text: 'echo 그림' },
    { type: 'image', mediaType: 'image/png', base64: one },
    { type: 'image', mediaType: 'image/png', base64: two },
  ]);
  await done;
  const s1 = agentOf(e, a.id).sessionId;
  const [, p1, p2] = (e.history(a.id).find((x) => x.kind === 'user') as any).parts;
  fs.rmSync(path.join(dataDir, 'images', a.id, p2.file)); // 지워진 그림
  await e.newConversation(a.id);

  const made = await e.forkAgent({ from: a.id, key: s1, name: 'A 2', role: '기획' });

  const parts = (e.history(made.id).find((x) => x.kind === 'user') as any).parts;
  expect(parts[1]).toEqual(p1);
  expect(await e.image(made.id, p1.file)).toBe(`data:image/png;base64,${one}`);
  expect(parts[2]).toEqual({ type: 'image', mediaType: 'image/png', bytes: p2.bytes });
  expect(await e.image(a.id, p1.file)).toBe(`data:image/png;base64,${one}`); // 원래 것 그대로
});

// ── 서버(SSH) 방 ──
const FAKE_SSH = path.resolve('test/fakeSsh.mjs');
const NO_SSH = '윈도우 OpenSSH 를 찾지 못했어요';
const REMOTE_ABS = '서버 폴더는 / 로 시작하는 전체 경로로 적어 주세요';
const VERSION = '2.1.304';
/**
 * 가짜 ssh 로 띄운 엔진 — 서버 / = <dir>/srv, $HOME = /home/a 아래 web 만 있다. 모드는 modeFile 에 써서 도중에 바꾼다.
 * sshHome = 임시 홈(진짜 ~/.ssh 를 읽지 않게)
 */
async function startSsh(env: Record<string, string> = {}, extra: Partial<EngineOptions> = {}) {
  const root = path.join(dir, 'srv');
  fs.mkdirSync(path.join(root, 'home', 'a', 'web'), { recursive: true });
  const sshLog = path.join(dir, 'ssh.log');
  const modeFile = path.join(dir, 'ssh-mode');
  const home = path.join(dir, 'home');
  const e = await start({ FAKE_SSH_ROOT: root, FAKE_SSH_LOG: sshLog, FAKE_SSH_MODE_FILE: modeFile, ...env }, false, {
    ssh: { command: process.execPath, argsPrefix: [FAKE_SSH] },
    sshHome: home,
    ...extra,
  });
  const mode = (m: string) => fs.writeFileSync(modeFile, m);
  /** 가짜 ssh 기록 전부 — start·launch·cleanup·drop·exit 차례대로 */
  const events = (): any[] =>
    fs.existsSync(sshLog) ? fs.readFileSync(sshLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  /** 가짜 ssh 가 받은 호출들(시작 줄) */
  const calls = (): any[] => events().filter((x) => x.event === 'start');
  return { e, root, home, mode, calls, events, sshLog };
}

test('ssh: checkRemote — 접속됨 · claude 버전 · 확인 ssh 는 BatchMode·bash -lc 이고 -R 없음·전달 모두 지움·RemoteCommand=none · 포트는 -p', async () => {
  const { e, calls } = await startSsh();
  expect(await e.checkRemote('dev')).toEqual({ ok: true, claudeVersion: VERSION });
  expect(await e.checkRemote(' me@10.0.0.12:2222 ')).toEqual({ ok: true, claudeVersion: VERSION });
  const [a, b] = calls();
  expect(a).toMatchObject({ host: 'dev', kind: 'check', forwards: [] });
  expect(a.argv).toEqual(expect.arrayContaining(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'ClearAllForwardings=yes', 'RemoteCommand=none']));
  expect(a.argv).not.toContain('-R');
  expect(a.command).toMatch(/^bash -lc '/);
  expect(b).toMatchObject({ host: 'me@10.0.0.12', user: 'me', port: 2222, kind: 'check' });
}, 20_000);

test('ssh: 켜져 있으면 확인 전에 서버마다 한 번 update', async () => {
  const { e, calls } = await startSsh({}, { claudeAutoUpdate: () => true });
  expect(await e.checkRemote('dev')).toEqual({ ok: true, claudeVersion: VERSION });
  expect(await e.checkRemote('dev')).toEqual({ ok: true, claudeVersion: VERSION });
  expect(await e.checkRemote('other')).toEqual({ ok: true, claudeVersion: VERSION });
  expect(calls().map((c) => `${c.host}:${c.kind}`)).toEqual(['dev:update', 'dev:check', 'dev:check', 'other:update', 'other:check']);
}, 20_000);

test('ssh: 꺼져 있으면 update 없음 — 켜고 끄는 것은 그때그때 본다', async () => {
  let on = false;
  const { e, calls } = await startSsh({}, { claudeAutoUpdate: () => on });
  await e.checkRemote('dev');
  expect(calls().map((c) => c.kind)).toEqual(['check']);
  on = true;
  await e.checkRemote('dev');
  expect(calls().map((c) => c.kind)).toEqual(['check', 'update', 'check']);
}, 20_000);

test('ssh: update 실패해도 확인은 됨', async () => {
  const { e, calls } = await startSsh({ FAKE_SSH_UPDATE_CODE: '1' }, { claudeAutoUpdate: () => true });
  expect(await e.checkRemote('dev')).toEqual({ ok: true, claudeVersion: VERSION });
  expect(calls().map((c) => c.kind)).toEqual(['update', 'check']);
}, 20_000);

test('ssh: checkRemote 문제 — 키 거절·접속 안 됨(ssh 오류 첫 줄)·서버 키 바뀜·claude 없음', async () => {
  const { e, mode } = await startSsh();
  mode('denied');
  expect(await e.checkRemote('dev')).toEqual({ ok: false, kind: 'denied', detail: null });
  mode('refused');
  expect(await e.checkRemote('dev')).toEqual({ ok: false, kind: 'unreachable', detail: 'ssh: connect to host dev port 22: Connection refused' });
  mode('hostkey');
  expect(await e.checkRemote('dev')).toEqual({ ok: false, kind: 'hostkey', detail: null });
  mode('noclaude');
  expect(await e.checkRemote('dev')).toEqual({ ok: false, kind: 'no-claude', detail: null });
  mode('');
  expect(await e.checkRemote('dev')).toEqual({ ok: true, claudeVersion: VERSION });
}, 30_000);

test('ssh: checkRemote — 올바르지 않은 서버 이름은 ssh 를 띄우지 않고 던진다', async () => {
  const { e, calls } = await startSsh();
  for (const host of ['', 'a b', '-oProxyCommand=calc']) {
    await expect(e.checkRemote(host)).rejects.toThrow('서버 이름이 올바르지 않아요');
  }
  expect(calls()).toEqual([]);
});

test('ssh: checkRemoteFolder — 있는 폴더는 서버가 펼친 경로와 버전 · ~ 는 $HOME 으로 · 없는 폴더 no-folder · claude 없음·키 거절', async () => {
  const { e, mode, calls } = await startSsh();
  const room = e.addRoom('서버 실험', { host: 'dev' });
  const ok = (folder: string) => ({ ok: true, folder, claudeVersion: VERSION });
  expect(await e.checkRemoteFolder(room.id, '/home/a/web')).toEqual(ok('/home/a/web'));
  expect(await e.checkRemoteFolder(room.id, ' /home/a/x/../web/ ')).toEqual(ok('/home/a/web'));
  expect(await e.checkRemoteFolder(room.id, '~/web')).toEqual(ok('/home/a/web'));
  expect(await e.checkRemoteFolder(room.id, '~')).toEqual(ok('/home/a'));
  expect(await e.checkRemoteFolder(room.id, '/home/a/nope')).toEqual({ ok: false, kind: 'no-folder', detail: null });
  expect(calls().every((c) => c.host === 'dev' && c.kind === 'check' && c.forwards.length === 0)).toBe(true);
  mode('noclaude');
  expect(await e.checkRemoteFolder(room.id, '/home/a/web')).toEqual({ ok: false, kind: 'no-claude', detail: null });
  mode('denied');
  expect(await e.checkRemoteFolder(room.id, '/home/a/web')).toEqual({ ok: false, kind: 'denied', detail: null });
}, 30_000);

test('ssh: checkRemoteFolder — 상대·빈·~사용자·줄바꿈 경로는 ssh 없이 / 전체 경로 글로 던진다 · 이 PC 방·없는 방도 던진다', async () => {
  const { e, calls } = await startSsh();
  const room = e.addRoom('서버 실험', { host: 'dev' });
  for (const f of ['web', '', '  ', '~a/web', 'C:\\work', '/home/a\nweb']) {
    await expect(e.checkRemoteFolder(room.id, f)).rejects.toThrow(REMOTE_ABS);
  }
  const local = e.addRoom('이 PC');
  await expect(e.checkRemoteFolder(local.id, '/home/a/web')).rejects.toThrow('서버 방이 아니에요');
  await expect(e.checkRemoteFolder('ghost', '/home/a/web')).rejects.toThrow('방을 찾을 수 없습니다: ghost');
  expect(calls()).toEqual([]);
});

test('ssh: sshHosts — 엔진의 sshHome 아래 .ssh/config 를 읽는다(와일드카드 빼고) · 없으면 []', async () => {
  const { e, home } = await startSsh();
  expect(e.sshHosts()).toEqual([]);
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host gpu-box # 연구실\n  HostName 10.0.0.12\n  User me\nHost *\n  User x\n');
  expect(e.sshHosts()).toEqual([{ host: 'gpu-box', user: 'me', hostName: '10.0.0.12', port: null }]);
});

test('ssh: sshAvailable — 설정한 ssh 실행 파일이 있을 때만 · 없으면 서버 방 만들기·확인은 OpenSSH 글로 던진다 · 이 PC 방은 그대로', async () => {
  const { e } = await startSsh();
  expect(e.sshAvailable()).toBe(true);
  const missing = await start({}, false, { dataDir: path.join(dir, 'data2'), ssh: { command: path.join(dir, 'no', 'ssh.exe') } });
  expect(missing.sshAvailable()).toBe(false);
  expect(() => missing.addRoom('서버', { host: 'dev' })).toThrow(NO_SSH);
  expect(missing.rooms()).toEqual([]);
  await expect(missing.checkRemote('dev')).rejects.toThrow(NO_SSH);
  expect(missing.addRoom('이 PC').remote).toBeNull();
  const none = await start({}, false, { dataDir: path.join(dir, 'data3') }); // ssh 손잡이 없음
  expect(none.sshAvailable()).toBe(false);
  expect(() => none.addRoom('서버', { host: 'dev' })).toThrow(NO_SSH);
});

test('서버 방 — engine.addRoom 저장 · 에이전트 폴더는 서버 전체 경로(이 PC 에 없어도) · 상대 경로는 거절 · 올바르지 않은 host 거절', async () => {
  const { e } = await startSsh();
  const room = e.addRoom('서버 실험', { host: 'dev' });
  expect(room.remote).toEqual({ host: 'dev' });
  expect(e.rooms()).toEqual([room]);
  const a = e.addAgent({ roomId: room.id, name: 'web', role: '화면', folder: '/home/a/web' });
  expect(a).toMatchObject({ folder: '/home/a/web', remoteLaunch: null });
  expect(() => e.addAgent({ roomId: room.id, name: 'x', role: 'r', folder: 'web' })).toThrow(REMOTE_ABS);
  expect(() => e.addRoom('나쁜', { host: 'a b' })).toThrow('서버 이름이 올바르지 않아요');
  expect(e.addRoom('이 PC').remote).toBeNull();
});

test('서버 방 갈래 — 새 에이전트도 같은 방·같은 서버 폴더', async () => {
  const claudeDir = path.join(dir, 'claude');
  const s1 = '11111111-1111-4111-8111-111111111111';
  const s = openStore(dataDir);
  const room = s.addRoom('서버', { host: 'dev' });
  const a = s.addAgent({ roomId: room.id, name: 'A', role: '기획', folder: '/home/a/web' });
  const now = Date.now();
  fs.mkdirSync(path.join(dataDir, 'history'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'history', `${a.id}.jsonl`),
    [
      { t: now - 2000, kind: 'user', source: 'human', parts: [{ type: 'text', text: '하나' }] },
      { t: now - 1000, kind: 'boundary', ended: s1 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  fs.mkdirSync(path.join(claudeDir, 'projects', 'fake'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'projects', 'fake', `${s1}.jsonl`), '{}\n');
  const { e } = await startSsh({ CLAUDE_CONFIG_DIR: claudeDir });
  const made = await e.forkAgent({ from: a.id, key: s1, name: 'A 2', role: '기획' });
  expect(made).toMatchObject({ roomId: room.id, folder: '/home/a/web', forkOf: s1, remoteLaunch: null });
});

describe('서버 방 지난 대화', () => {
  afterEach(async () => {
    await Promise.all(engines.map((x) => x.shutdown()));
    engines = [];
    const root = path.join(dir, 'srv');
    if (fs.existsSync(root)) {
      execFileSync(process.execPath, [FAKE_SSH, '--fake-reap'], { env: { ...process.env, FAKE_SSH_ROOT: root }, timeout: 20_000 });
    }
  });

  /** 서버 방 에이전트가 두 대화를 한 뒤 — 첫 대화가 지난 대화. 서버 기록 폴더 = <dir>/srv-claude */
  async function twoConversations() {
    const claudeDir = path.join(dir, 'srv-claude');
    const t = await startSsh({ CLAUDE_CONFIG_DIR: claudeDir, FAKE_TRANSCRIPTS: '1' });
    const room = t.e.addRoom('서버 실험', { host: 'dev' });
    const web = t.e.addAgent({ roomId: room.id, name: 'web', role: '화면', folder: '/home/a/web' });
    let done = resultOf(t.e, web.id);
    await t.e.sendUser(web.id, text('echo 하나'));
    await done;
    const first = agentOf(t.e, web.id).sessionId;
    await t.e.newConversation(web.id);
    done = resultOf(t.e, web.id);
    await t.e.sendUser(web.id, text('echo 둘'));
    await done;
    return { ...t, web, first, claudeDir };
  }
  const pastOf = async (e: Engine, id: string) => (await e.conversations(id)).find((c) => !c.current)!;

  test('서버 기록 파일이 있으면 resumable · 지우면 gone · 확인은 ssh 한 번(접속 한도 5초)', async () => {
    const { e, web, first, claudeDir, calls } = await twoConversations();
    expect(fs.existsSync(path.join(claudeDir, 'projects', 'fake', `${first}.jsonl`))).toBe(true);
    const before = calls().length;
    expect(await pastOf(e, web.id)).toMatchObject({ resumable: true, why: null });
    const check = calls().slice(before);
    expect(check).toHaveLength(1);
    expect(check[0].argv).toEqual(expect.arrayContaining(['ConnectTimeout=5']));
    expect(check[0].argv).not.toContain('ConnectTimeout=10');
    fs.rmSync(path.join(claudeDir, 'projects', 'fake', `${first}.jsonl`));
    expect(await pastOf(e, web.id)).toMatchObject({ resumable: false, why: 'gone' });
  }, 30_000);

  test('접속이 안 되면 막지 않고 모두 resumable', async () => {
    const { e, web, mode } = await twoConversations();
    mode('refused');
    expect(await pastOf(e, web.id)).toMatchObject({ resumable: true, why: null });
  }, 30_000);
});

test('newAgentFolder — 서버 방은 부모 서버 폴더 기준 POSIX(../api → /home/a/api, Git Bash 꼴로 바꾸지 않음, ~ 는 그대로 — 저장 검사가 거절) · 이 PC 방은 지금 그대로', () => {
  expect(newAgentFolder(true, '/home/a/web', '../api')).toBe('/home/a/api');
  expect(newAgentFolder(true, '/home/a/web', '.')).toBe('/home/a/web');
  expect(newAgentFolder(true, '/home/a/web', 'sub/x')).toBe('/home/a/web/sub/x');
  expect(newAgentFolder(true, '/home/a/web', '/srv/x/../y')).toBe('/srv/y');
  expect(newAgentFolder(true, '/home/a/web', '/c/Users')).toBe('/c/Users');
  expect(newAgentFolder(true, '/home/a/web', '~/x')).toBe('~/x');
  expect(newAgentFolder(true, '/home/a/web', '~')).toBe('~');
  const base = folder('a');
  expect(newAgentFolder(false, base, 'sub')).toBe(path.join(base, 'sub'));
  expect(newAgentFolder(false, base, '/c/Users')).toBe(path.resolve('C:/Users'));
});

// ── 서버(SSH) 방 — 띄우기·정리·끊김·로그인 만료 ──
describe('서버 방 띄우기', () => {
  /** 가짜 ssh 가 남긴 지킴이·claude(끊김 흉내 등)를 끈다 — 엔진을 먼저 끄고(끄기 정리까지) 나서 */
  afterEach(async () => {
    await Promise.all(engines.map((x) => x.shutdown()));
    engines = [];
    const root = path.join(dir, 'srv');
    if (fs.existsSync(root)) {
      execFileSync(process.execPath, [FAKE_SSH, '--fake-reap'], { env: { ...process.env, FAKE_SSH_ROOT: root }, timeout: 20_000 });
    }
  });

  const LOGIN_TEXT = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  const launchesIn = (ev: any[]) => ev.filter((x) => x.event === 'launch');
  const cleanupsIn = (ev: any[]) => ev.filter((x) => x.event === 'cleanup');
  /** 서버 방 + 에이전트 web(/home/a/web) */
  async function remoteRoom(env: Record<string, string> = {}, extra: Partial<EngineOptions> = {}) {
    const t = await startSsh(env, extra);
    const room = t.e.addRoom('서버 실험', { host: 'dev' });
    const web = t.e.addAgent({ roomId: room.id, name: 'web', role: '화면', folder: '/home/a/web' });
    const statuses: any[] = [];
    t.e.on('status', (s) => statuses.push(s));
    const notices = (id: string) => t.e.history(id).flatMap((x) => (x.kind === 'notice' ? [x.text] : []));
    return { ...t, room, web, statuses, notices };
  }
  const runOf = (marker: string) => marker.slice(marker.indexOf('.') + 1);
  /** 띄우기 호출의 원격 포트 — -R 127.0.0.1:<원격>:127.0.0.1:<로컬> */
  const remotePortOf = (c: any) => Number(String(c.forwards[0]).split(':')[1]);
  const freePort = async () => {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as net.AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  };

  test('띄우기는 update 를 기다리지 않는다 — update 가 느려도 곧바로 띄운다', async () => {
    const { e, web, calls } = await remoteRoom({ FAKE_SSH_UPDATE_MS: '3000' }, { claudeAutoUpdate: () => true });
    const done = resultOf(e, web.id);
    const t0 = Date.now();
    await e.sendUser(web.id, text('안녕'));
    expect(await resultText(done)).toBe('받음: 안녕');
    expect(Date.now() - t0).toBeLessThan(2500);
    const kinds = calls().map((c) => c.kind);
    expect(kinds).toContain('update');
    expect(kinds.filter((k) => k === 'update')).toHaveLength(1);
    expect(kinds.indexOf('update')).toBeLessThan(kinds.indexOf('launch'));
  }, 30_000);

  test('서버 방 — ssh 로 띄워 대화 · -R·BatchMode·bash -lc · 토큰은 서버 파일에만 · 띄운 pid 저장', async () => {
    const { e, web, calls, events, sshLog } = await remoteRoom();
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    expect(await resultText(done)).toBe('받음: echo 하나');

    const start = calls().find((c) => c.kind === 'launch');
    expect(start.host).toBe('dev');
    expect(start.argv).toEqual(expect.arrayContaining(['-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', 'RemoteCommand=none', '-R']));
    expect(start.argv).not.toContain('ClearAllForwardings=yes');
    expect(start.command).toMatch(/^bash -lc '/);
    const fwd = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(start.forwards[0])!;
    const remotePort = Number(fwd[1]);
    expect(remotePort).toBeGreaterThanOrEqual(40000);
    expect(remotePort).toBeLessThanOrEqual(49999);

    const [launch] = launchesIn(events());
    expect(launch.folder).toBe('/home/a/web');
    expect(launch.marker.startsWith(`${web.id}.`)).toBe(true);
    // MCP 설정은 서버의 run 폴더 파일로 — url 은 서버 쪽 원격 포트(터널이 두레로 잇는다)
    const cfg = JSON.parse(fs.readFileSync(path.join(launch.runDir, 'mcp.json'), 'utf8')).mcpServers.dure;
    expect(cfg.url).toBe(`http://127.0.0.1:${remotePort}/mcp`);
    expect(cfg.headers['X-Dure-Agent']).toBe(web.id);
    const token = String(cfg.headers.Authorization).replace(/^Bearer /, '');
    expect(token.length).toBeGreaterThan(10);
    expect(fs.readFileSync(path.join(launch.runDir, 'prompt.md'), 'utf8')).toContain('web');
    // 토큰은 명령 인자 어디에도 없다 — ssh 인자·스크립트·서버 claude 인자
    expect(fs.readFileSync(sshLog, 'utf8')).not.toContain(token);
    const argv = lastSpawnOf('web').argv;
    expect(JSON.stringify(argv)).not.toContain(token);
    expect(flagValue(argv, '--mcp-config')).toBe(path.join(launch.runDir, 'mcp.json'));
    expect(flagValue(argv, '--append-system-prompt-file')).toBe(path.join(launch.runDir, 'prompt.md'));
    expect(argv).toEqual(expect.arrayContaining(['--disallowedTools', 'SendMessage', 'ListAgents', '--session-id', web.sessionId]));
    // 이 PC 의 claude 와 같은 도구 대기 시간 — ssh 는 환경을 넘기지 않으니 서버 명령이 넣는다
    expect(lastSpawnOf('web').mcpToolTimeout).toBe('86400000');
    expect(start.script).toContain("export MCP_TOOL_TIMEOUT='86400000'");
    // 이 PC 에는 MCP 설정을 쓰지 않는다
    expect(fs.existsSync(path.join(dataDir, 'run', web.id, 'mcp.json'))).toBe(false);
    // 정리에 쓸 서버 pid 와 띄우기 id
    expect(agentOf(e, web.id).remoteLaunch).toEqual({ pid: launch.pid, run: runOf(launch.marker) });
    expect(e.remoteIssue(web.id)).toBeNull();
  }, 30_000);

  test('두레 MCP 가 터널로 — 서버 방 에이전트의 send_message 가 다른 에이전트에게 간다', async () => {
    const { e, root, room, web } = await remoteRoom();
    fs.mkdirSync(path.join(root, 'home', 'a', 'api'), { recursive: true });
    const api = e.addAgent({ roomId: room.id, name: 'api', role: '서버', folder: '/home/a/api' });
    e.updateAgent(api.id, { auto: true });
    const aDone = resultOf(e, web.id);
    const bDone = resultOf(e, api.id);
    await e.sendUser(web.id, text('SEND api: 화면 만들어 줘'));
    expect(await resultText(aDone)).toBe('api 에게 전달했습니다.');
    expect(await resultText(bDone)).toBe('받음: [두레 메시지 — 보낸 쪽: web(화면)]\n화면 만들어 줘');
    expect(e.messages()).toMatchObject([{ from: web.id, to: api.id, state: 'delivered' }]);
  }, 30_000);

  test('멈추기(claude 를 내릴 때)·재우기·지우기 — ssh 를 끈 뒤 서버 정리 · 서버 claude 없음 · 저장된 pid 비움', async () => {
    const { e, root, room, web, events } = await remoteRoom();
    const cleaned = (marker: string) => cleanupsIn(events()).some((c) => c.marker === marker);

    // 재우기
    let done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    await done;
    const first = launchesIn(events())[0];
    expect(await e.sleep(web.id)).toBe(true);
    await until('재우기 정리', () => cleaned(first.marker), 10_000);
    await until('저장된 pid 비움', () => agentOf(e, web.id).remoteLaunch === null);
    expect(isAlive(first.pid)).toBe(false);
    expect(fs.existsSync(first.runDir)).toBe(false); // 토큰이 든 run 폴더도 지운다

    // 멈추기 — 끼운 말을 안 읽은 채 멈추면 claude 를 내려 돌려받고 --resume 으로 다시 띄운다
    const init = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === web.id && x.event.kind === 'init');
    await e.sendUser(web.id, text('SLOW'));
    await init;
    await e.sendUser(web.id, text('echo 끼움'));
    const second = launchesIn(events()).at(-1);
    expect(second.marker).not.toBe(first.marker);
    await e.interrupt(web.id);
    await until('멈추기 정리', () => cleaned(second.marker), 10_000);
    await until('다시 띄움', () => launchesIn(events()).length === 3, 10_000);
    const third = launchesIn(events())[2];
    expect(isAlive(second.pid)).toBe(false);
    expect(third.args).toContain('--resume');
    await until('새 띄우기 저장', () => agentOf(e, web.id).remoteLaunch?.run === runOf(third.marker));

    // 지우기
    fs.mkdirSync(path.join(root, 'home', 'a', 'api'), { recursive: true });
    const api = e.addAgent({ roomId: room.id, name: 'api', role: '서버', folder: '/home/a/api' });
    done = resultOf(e, api.id);
    await e.sendUser(api.id, text('echo 둘'));
    await done;
    const apiLaunch = launchesIn(events()).find((l) => l.marker.startsWith(`${api.id}.`));
    await e.removeAgent(api.id);
    await until('지우기 정리', () => cleaned(apiLaunch.marker), 10_000);
    expect(isAlive(apiLaunch.pid)).toBe(false);
  }, 60_000);

  test('앱 끄기 — 일하는 중이어도 서버 정리를 보내고 끝날 때까지 기다린다(Review Focus 1)', async () => {
    const { e, web, events } = await remoteRoom();
    const init = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === web.id && x.event.kind === 'init');
    await e.sendUser(web.id, text('SLOW'));
    await init;
    const [launch] = launchesIn(events());
    await e.shutdown();
    // shutdown 이 끝났을 땐 정리가 이미 서버에 갔다 왔다
    expect(cleanupsIn(events()).map((c) => c.marker)).toContain(launch.marker);
    expect(isAlive(launch.pid)).toBe(false);
    expect(openStore(dataDir).agent(web.id)!.remoteLaunch).toBeNull();
  }, 30_000);

  test('앱 끄기 — 정리가 상한을 넘으면 그만 기다린다 · 다음에 켤 때 저장된 띄우기를 먼저 정리한다', async () => {
    const { e, web, events } = await remoteRoom({ FAKE_SSH_CLEANUP_MS: '5000' }, { stopLimitMs: 1500 });
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    await done;
    const [launch] = launchesIn(events());
    const t0 = Date.now();
    await e.shutdown();
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(openStore(dataDir).agent(web.id)!.remoteLaunch).toEqual({ pid: launch.pid, run: runOf(launch.marker) }); // 다음에 다시
    engines = engines.filter((x) => x !== e);

    const { e: e2 } = await startSsh();
    await until('켤 때 정리', () => cleanupsIn(events()).some((c) => c.marker === launch.marker), 10_000);
    await until('저장된 pid 비움', () => e2.agents()[0].remoteLaunch === null, 10_000);
  }, 40_000);

  test('두 에이전트 동시 — 원격 포트가 겹치지 않는다(Review Focus 2)', async () => {
    const base = 40000 + Math.floor(Math.random() * 9000);
    // 고르기를 늘 범위 맨 앞에서 시작하게 — 피하기가 없으면 둘이 언제나 같은 포트를 고른다(겹침 → 다시 띄움 → 띄우기 셋)
    const { e, root, room, web, calls } = await remoteRoom({}, { remotePorts: { from: base, to: base + 1, random: () => 0 } });
    fs.mkdirSync(path.join(root, 'home', 'a', 'api'), { recursive: true });
    const api = e.addAgent({ roomId: room.id, name: 'api', role: '서버', folder: '/home/a/api' });
    const a = resultOf(e, web.id);
    const b = resultOf(e, api.id);
    await Promise.all([e.sendUser(web.id, text('echo 하나')), e.sendUser(api.id, text('echo 둘'))]);
    expect([await resultText(a), await resultText(b)]).toEqual(['받음: echo 하나', '받음: echo 둘']);
    const ports = calls().filter((c) => c.kind === 'launch').map(remotePortOf);
    expect(ports.sort()).toEqual([base, base + 1]);
  }, 30_000);

  test('포트 겹침 — ssh 가 명령 전에 끝나고(ExitOnForwardFailure=yes — 서버에서 아무것도 돌지 않는다) 다른 포트로 다시 띄운다(기다린 입력은 그대로 간다)', async () => {
    const { e, web, calls, events, mode, notices } = await remoteRoom();
    mode('portclash-once');
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    expect(await resultText(done)).toBe('받음: echo 하나');
    const tries = calls().filter((c) => c.kind === 'launch');
    expect(tries).toHaveLength(2);
    expect(remotePortOf(tries[0])).not.toBe(remotePortOf(tries[1]));
    expect(launchesIn(events())).toHaveLength(1); // 겹친 쪽은 서버 명령까지 가지 않았다(머리말·토큰이 서버에 안 닿는다)
    expect(e.remoteIssue(web.id)).toBeNull();
    expect(e.errorText(web.id)).toBeNull();
    expect(notices(web.id)).toEqual([]);
  }, 30_000);

  test('포트가 계속 겹치면 5번 다시 한 뒤 오류 — 보낸 말은 기다리는 줄로', async () => {
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
    const port = (busy.address() as net.AddressInfo).port;
    try {
      const { e, web, calls, notices } = await remoteRoom({}, { remotePorts: { from: port, to: port } });
      await e.sendUser(web.id, text('echo 하나'));
      await until('오류', () => e.status(web.id) === 'error', 20_000);
      expect(calls().filter((c) => c.kind === 'launch')).toHaveLength(6);
      // ssh 날글 대신 전용 안내 — 서버가 원격 포트 전달을 막았을 때도 이렇게 보인다
      const blocked = 'dev 에서 포트 전달이 막혀 있어요 — 서버의 sshd 설정(AllowTcpForwarding)을 확인해 주세요';
      expect(e.errorText(web.id)).toBe(blocked);
      expect(notices(web.id).at(-1)).toBe(blocked);
      expect(e.heldInput(web.id)).toBe(1);
      expect(e.remoteIssue(web.id)).toBeNull();
    } finally {
      busy.close();
    }
  }, 40_000);

  test('끊김 — 오류 아님·안내 한 줄 · 다시 보내면 옛 서버 claude 를 먼저 정리하고 --resume 으로(Review Focus 5)', async () => {
    const { e, web, mode, events, statuses, notices } = await remoteRoom();
    mode('drop:1500');
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    expect(await resultText(done)).toBe('받음: echo 하나');
    const [first] = launchesIn(events());
    await until('끊김', () => e.remoteIssue(web.id) !== null, 8000);
    expect(e.remoteIssue(web.id)).toEqual({ kind: 'disconnected', detail: null });
    expect(e.status(web.id)).toBe('idle');
    expect(e.errorText(web.id)).toBeNull();
    expect(notices(web.id)).toEqual(['dev 연결이 끊겼어요 — 다시 보내면 이어서 해요']);
    expect(statuses).toContainEqual({ agentId: web.id, status: 'idle', errorText: null, remoteIssue: { kind: 'disconnected', detail: null } });
    // 끊긴 쪽의 서버 claude 는 남아 있다 — 다음에 띄울 때 정리하려고 pid 를 기억한다
    expect(isAlive(first.pid)).toBe(true);
    expect(agentOf(e, web.id).remoteLaunch).toEqual({ pid: first.pid, run: runOf(first.marker) });

    mode('');
    const again = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 둘'));
    expect(await resultText(again)).toBe('받음: echo 둘');
    const ev = events();
    const firstAt = ev.findIndex((x) => x.event === 'launch' && x.marker === first.marker);
    const ci = ev.findIndex((x) => x.event === 'cleanup' && x.marker === first.marker);
    const si = ev.findIndex((x, i) => i > firstAt && x.event === 'start' && x.kind === 'launch');
    expect(ci).toBeGreaterThan(-1);
    expect(ci).toBeLessThan(si); // 정리가 끝난 뒤에 띄웠다
    expect(ev[ci].killed).toEqual([first.pid]);
    expect(isAlive(first.pid)).toBe(false);
    const second = launchesIn(ev)[1];
    expect(second.args).toContain('--resume');
    expect(e.remoteIssue(web.id)).toBeNull();
    expect(agentOf(e, web.id).remoteLaunch).toEqual({ pid: second.pid, run: runOf(second.marker) });
  }, 40_000);

  test('끊김(윈도우 ssh 는 -1 로 끝난다) — 끊김으로 가르고 곧바로 정리하지 않는다 · 서버가 내려가 있어도 정리 실패 알림이 없다', async () => {
    const { e, web, mode, calls, notices } = await remoteRoom();
    mode('drop:1500');
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    await done;
    mode('refused'); // 서버가 내려갔다 — 이제 맺는 ssh 는 모두 안 된다
    await until('끊김', () => e.remoteIssue(web.id) !== null, 8000);
    expect(e.remoteIssue(web.id)).toEqual({ kind: 'disconnected', detail: null });
    await sleep(1500);
    expect(calls().filter((c) => c.kind === 'cleanup')).toEqual([]);
    expect(notices(web.id)).toEqual(['dev 연결이 끊겼어요 — 다시 보내면 이어서 해요']);
    expect(e.status(web.id)).toBe('idle');
    expect(e.errorText(web.id)).toBeNull();
  }, 30_000);

  test('~/.ssh/config 의 RemoteForward 가 실패하면 — 확인은 되지만(전달을 지운다) 띄우기는 명령 전에 끝나 접속 실패(그 ssh 줄) · 다른 포트로 다시 띄우지 않는다', async () => {
    const cfgPort = await freePort();
    const { e, web, calls, events, notices } = await remoteRoom({ FAKE_SSH_CONFIG_RFWD: String(cfgPort) });
    expect(await e.checkRemote('dev')).toEqual({ ok: true, claudeVersion: VERSION });
    await e.sendUser(web.id, text('echo 하나'));
    await until('접속 실패', () => e.remoteIssue(web.id) !== null, 10_000);
    const issue = { kind: 'unreachable', detail: `Error: remote port forwarding failed for listen port ${cfgPort}` };
    expect(e.remoteIssue(web.id)).toEqual(issue);
    expect(notices(web.id)).toEqual([`dev 에 접속하지 못했어요 — ${issue.detail}`]);
    expect(calls().filter((c) => c.kind === 'launch')).toHaveLength(1);
    expect(launchesIn(events())).toEqual([]);
    expect(e.heldInput(web.id)).toBe(1);
  }, 30_000);

  test('~/.ssh/config 에 RemoteCommand 가 있어도 — 확인·띄우기·정리가 된다(모두 RemoteCommand=none)', async () => {
    const { e, web, calls, events, notices } = await remoteRoom({ FAKE_SSH_CONFIG_REMOTECOMMAND: '1' });
    expect(await e.checkRemote('dev')).toEqual({ ok: true, claudeVersion: VERSION });
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    expect(await resultText(done)).toBe('받음: echo 하나');
    expect(calls().filter((c) => c.kind === 'launch')).toHaveLength(1);
    expect(e.remoteIssue(web.id)).toBeNull();
    expect(notices(web.id)).toEqual([]);
    const [launch] = launchesIn(events());
    expect(await e.sleep(web.id)).toBe(true);
    await until('정리', () => cleanupsIn(events()).some((c) => c.marker === launch.marker), 10_000);
    const cl = calls().find((c) => c.kind === 'cleanup');
    expect(cl.argv).toEqual(expect.arrayContaining(['ClearAllForwardings=yes', 'RemoteCommand=none']));
    expect(cl.command).toMatch(/^bash -c '/); // 정리는 로그인 프로필을 읽지 않는다
    expect(isAlive(launch.pid)).toBe(false);
  }, 40_000);

  test('지운 에이전트의 서버 정리가 안 되면 기다리는 정리로 남겼다가(알림은 켤 때마다 한 번) 다음에 켤 때 끈다', async () => {
    const { e, web, mode, calls, events } = await remoteRoom();
    mode('drop:1500');
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    await done;
    const [first] = launchesIn(events());
    const launch = { pid: first.pid, run: runOf(first.marker) };
    await until('끊김', () => e.remoteIssue(web.id)?.kind === 'disconnected', 8000);
    mode('refused');
    const errors: any[] = [];
    e.on('engine-error', (x) => errors.push(x));
    await e.removeAgent(web.id);
    await until('정리 두 번 실패', () => calls().filter((c) => c.kind === 'cleanup').length === 2, 10_000);
    await until('알림', () => errors.length === 1, 5000);
    expect(errors[0]).toEqual({ agentId: web.id, message: '서버의 claude 를 끄지 못했어요 — 서버에서 직접 확인해 주세요' });
    expect(openStore(dataDir).pendingCleanups()).toEqual([{ host: 'dev', agentId: web.id, launch }]);
    expect(isAlive(first.pid)).toBe(true);
    await e.shutdown();
    engines = engines.filter((x) => x !== e);

    // 켰는데 아직 서버가 안 된다 — 다시 해 보고 실패해도 목록은 남는다 · 알림은 한 번
    const { e: e2 } = await startSsh();
    const errors2: any[] = [];
    e2.on('engine-error', (x) => errors2.push(x));
    await until('켤 때 다시', () => calls().filter((c) => c.kind === 'cleanup').length === 4, 10_000);
    const LAUNCH_LEFT = '서버의 claude 를 끄지 못했어요 — 서버에서 직접 확인해 주세요';
    await until('알림', () => errors2.some((x) => x.message === LAUNCH_LEFT), 5000);
    await sleep(300);
    // 띄우기 정리 알림은 한 번 · 서버 첨부 폴더도 켤 때 다시 해 봤다(기다리는 첨부 정리 — 그 알림도 한 번)
    expect(errors2.map((x) => x.message).sort()).toEqual([LAUNCH_LEFT, '서버의 첨부 폴더를 다 지우지 못했어요 — 두레를 다시 켜면 다시 지워요'].sort());
    expect(openStore(dataDir).pendingCleanups()).toEqual([{ host: 'dev', agentId: web.id, launch }]);
    await e2.shutdown();
    engines = engines.filter((x) => x !== e2);

    // 서버가 돌아왔다 — 켤 때 정리하고 목록에서 뺀다
    mode('');
    await startSsh();
    await until('켤 때 정리', () => cleanupsIn(events()).some((c) => c.marker === first.marker), 10_000);
    await until('목록 비움', () => openStore(dataDir).pendingCleanups().length === 0, 5000);
    await until('서버 claude 꺼짐', () => !isAlive(first.pid), 5000);
  }, 60_000);

  test('지우기 — 끊겨 세션은 없어도 서버에 남은 claude 를 정리한다 · 방 지우기도', async () => {
    const { e, root, room, web, mode, events } = await remoteRoom();
    const cleaned = (marker: string) => cleanupsIn(events()).some((c) => c.marker === marker);
    mode('drop:1500');
    let done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    await done;
    const [first] = launchesIn(events());
    await until('끊김', () => e.remoteIssue(web.id)?.kind === 'disconnected', 8000);
    expect(isAlive(first.pid)).toBe(true); // 세션은 없고 서버 claude 만 남았다
    await e.removeAgent(web.id);
    await until('지우기 정리', () => cleaned(first.marker), 10_000);
    await until('서버 claude 꺼짐', () => !isAlive(first.pid), 5000);

    fs.mkdirSync(path.join(root, 'home', 'a', 'api'), { recursive: true });
    const api = e.addAgent({ roomId: room.id, name: 'api', role: '서버', folder: '/home/a/api' });
    done = resultOf(e, api.id);
    await e.sendUser(api.id, text('echo 둘'));
    await done;
    const second = launchesIn(events()).find((l) => l.marker.startsWith(`${api.id}.`));
    await until('끊김', () => e.remoteIssue(api.id)?.kind === 'disconnected', 8000);
    await e.removeRoom(room.id);
    await until('방 지우기 정리', () => cleaned(second.marker), 10_000);
    await until('서버 claude 꺼짐', () => !isAlive(second.pid), 5000);
  }, 60_000);

  test('DURE_PID 뒤의 255 는 stderr 잡음이 무엇이든 끊김 — 아무 줄도 받기 전에 끊긴 미리 띄운 세션', async () => {
    const { e, web, mode, notices } = await remoteRoom({ FAKE_NO_CONTROL_REPLY: '1', FAKE_STDERR_START: 'me@dev: Permission denied (profile noise)' });
    mode('drop:800');
    e.setSelected(web.id); // 미리 띄움 — 제어 답이 없어 stdout 이 한 줄도 없다
    await until('끊김', () => e.remoteIssue(web.id) !== null, 10_000);
    expect(e.remoteIssue(web.id)).toEqual({ kind: 'disconnected', detail: null });
    expect(notices(web.id)).toEqual(['dev 연결이 끊겼어요 — 다시 보내면 이어서 해요']);
    e.setSelected(null);
  }, 30_000);

  test('포트 다시 시도 횟수는 첫 줄 전에 끝난 세션과 함께 접는다 — 다음 띄우기는 다시 5번을 다 쓴다', async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const { e, web, mode, calls, events } = await remoteRoom(
      { FAKE_NO_CONTROL_REPLY: '1' },
      { remotePorts: { from: port, to: port }, prewarmIdleMs: 200 },
    );
    const launchCalls = () => calls().filter((c) => c.kind === 'launch').length;
    // 첫 번은 겹치고(다시 1번) 둘째는 뜨지만 한 줄도 내지 않는다 → 고르지 않게 하면 곧 끈다(첫 줄 전에 끝남)
    mode('portclash-once');
    e.setSelected(web.id);
    await until('둘째가 뜸', () => launchesIn(events()).length === 1, 10_000);
    expect(launchCalls()).toBe(2);
    e.setSelected(null);
    await until('끄고 정리', () => cleanupsIn(events()).length === 1, 10_000);
    // 이제 그 포트를 막는다 — 다음 띄우기는 처음부터 다시 5번
    let busy: net.Server | null = null;
    for (let i = 0; i < 100 && !busy; i++) {
      const s = net.createServer();
      const ok = await new Promise<boolean>((r) => {
        s.once('error', () => r(false));
        s.listen(port, '127.0.0.1', () => r(true));
      });
      if (ok) busy = s;
      else await sleep(50); // 끈 ssh 의 중계가 아직 포트를 쥐고 있다
    }
    expect(busy).not.toBeNull();
    try {
      const before = launchCalls();
      e.setSelected(web.id);
      await until('오류', () => e.status(web.id) === 'error', 20_000);
      expect(launchCalls() - before).toBe(1 + 5);
    } finally {
      busy!.close();
      e.setSelected(null);
    }
  }, 60_000);

  test('create_agent — 서버 방의 ~/x 폴더는 서버가 펼친 경로로(직접 더하기와 같게)', async () => {
    const { e, root, web } = await remoteRoom();
    fs.mkdirSync(path.join(root, 'home', 'a', 'api'), { recursive: true });
    const req = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === web.id, 15_000);
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('MAKE api|백엔드|~/api|'));
    const r = await req;
    expect(r.input).toEqual({ name: 'api', role: '백엔드', folder: '/home/a/api', task: null });
    e.answerRequest(r.id, { type: 'allow' });
    expect(await resultText(done)).toContain('만들었어요');
    expect(e.agents().find((x) => x.name === 'api')?.folder).toBe('/home/a/api');
  }, 30_000);

  test('정리가 끝나야 같은 에이전트를 다시 띄운다 — 도는 옛 정리가 새 띄우기와 겹치지 않고 새 pid 를 지우지 않는다', async () => {
    const { e, web, events } = await remoteRoom({ FAKE_SSH_CLEANUP_MS: '1500' });
    let done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    await done;
    const [first] = launchesIn(events());
    expect(await e.sleep(web.id)).toBe(true);
    done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 둘')); // 정리가 도는 중
    expect(await resultText(done)).toBe('받음: echo 둘');
    const ev = events();
    const firstAt = ev.findIndex((x) => x.event === 'launch' && x.marker === first.marker);
    const ci = ev.findIndex((x) => x.event === 'cleanup' && x.marker === first.marker);
    const si = ev.findIndex((x, i) => i > firstAt && x.event === 'start' && x.kind === 'launch');
    expect(ci).toBeGreaterThan(-1);
    expect(ci).toBeLessThan(si);
    const second = launchesIn(ev)[1];
    await sleep(300);
    expect(agentOf(e, web.id).remoteLaunch).toEqual({ pid: second.pid, run: runOf(second.marker) });
  }, 30_000);

  test('정리가 두 번 다 안 되면 알림 한 줄 · pid 는 남겨 다음 띄우기 전에 다시 정리한다', async () => {
    const { e, web, mode, calls, events, notices } = await remoteRoom();
    let done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 하나'));
    await done;
    const [first] = launchesIn(events());
    mode('refused'); // 띄운 세션은 그대로 — 따로 맺는 정리 ssh 만 막힌다
    expect(await e.sleep(web.id)).toBe(true);
    await until('알림', () => notices(web.id).includes('서버의 claude 를 끄지 못했어요 — 서버에서 직접 확인해 주세요'), 10_000);
    expect(calls().filter((c) => c.kind === 'cleanup')).toHaveLength(2); // 한 번 더 해 봤다
    expect(agentOf(e, web.id).remoteLaunch).toEqual({ pid: first.pid, run: runOf(first.marker) });

    mode('');
    done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 둘'));
    expect(await resultText(done)).toBe('받음: echo 둘');
    expect(cleanupsIn(events()).map((c) => c.marker)).toEqual([first.marker]); // 띄우기 전에 정리했다
    expect(agentOf(e, web.id).remoteLaunch?.run).toBe(runOf(launchesIn(events())[1].marker));
  }, 40_000);

  test('로그인 만료 — remoteIssue login(답 줄은 대화에 그대로) · 다음 정상 답에서 지움', async () => {
    const { e, web, statuses } = await remoteRoom();
    let done = resultOf(e, web.id);
    await e.sendUser(web.id, text('LOGINFAIL'));
    expect(await resultText(done)).toBe(LOGIN_TEXT);
    expect(e.remoteIssue(web.id)).toEqual({ kind: 'login', detail: null });
    expect(e.history(web.id).some((x) => x.kind === 'assistant' && JSON.stringify(x.blocks).includes(LOGIN_TEXT))).toBe(true);
    expect(statuses.some((s) => s.agentId === web.id && s.remoteIssue?.kind === 'login')).toBe(true);
    done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 둘'));
    await done;
    expect(e.remoteIssue(web.id)).toBeNull();
    expect(statuses.at(-1)).toMatchObject({ agentId: web.id, remoteIssue: null });
  }, 30_000);

  test('키 거절·접속 안 됨·서버 키 바뀜·claude 없음·폴더 없음 — 종류별 안내 한 줄 · 오류 상태 아님 · 보낸 말은 기다린다', async () => {
    const { e, root, room, web, mode, events, notices } = await remoteRoom();
    const issue = async (m: string, kind: string) => {
      mode(m);
      await e.sendUser(web.id, text(`echo ${m}`));
      await until(kind, () => e.remoteIssue(web.id)?.kind === kind, 10_000);
      expect(e.status(web.id)).toBe('idle');
      expect(e.errorText(web.id)).toBeNull();
      return notices(web.id).at(-1);
    };
    expect(await issue('denied', 'denied')).toBe('dev 에 키로 접속할 수 없어요 — SSH 키를 등록해 주세요');
    expect(e.heldInput(web.id)).toBe(1);
    expect(await issue('refused', 'unreachable')).toBe('dev 에 접속하지 못했어요 — ssh: connect to host dev port 22: Connection refused');
    expect(e.remoteIssue(web.id)).toEqual({ kind: 'unreachable', detail: 'ssh: connect to host dev port 22: Connection refused' });
    expect(await issue('hostkey', 'hostkey')).toBe('dev 의 서버 키가 바뀌었어요 — 서버가 바뀐 게 맞는지 확인한 뒤 known_hosts 를 고쳐 주세요');
    expect(await issue('noclaude', 'no-claude')).toBe('dev 에 claude 가 없어요');
    // claude 를 run 폴더보다 먼저 찾는다 — 없으면 서버에 토큰이 든 파일도, 정리할 띄우기도 없다
    expect(agentOf(e, web.id).remoteLaunch).toBeNull();
    expect(fs.existsSync(path.join(root, 'home', 'a', '.dure', 'run', web.id))).toBe(false);
    expect(cleanupsIn(events())).toEqual([]);
    expect(notices(web.id)).toHaveLength(4);

    mode('');
    const gone = e.addAgent({ roomId: room.id, name: 'gone', role: 'r', folder: '/home/a/gone' });
    await e.sendUser(gone.id, text('echo 없음'));
    await until('no-folder', () => e.remoteIssue(gone.id)?.kind === 'no-folder', 10_000);
    expect(notices(gone.id)).toEqual(['서버에 그 폴더가 없어요']);
    expect(fs.existsSync(path.join(root, 'home', 'a', '.dure', 'run', gone.id))).toBe(false); // 토큰이 든 파일을 남기지 않는다

    // 고치고 다시 보내면 기다리던 말부터 간다 · 안내는 지운다
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 이제'));
    expect(await resultText(done)).toBe('받음: echo denied');
    expect(e.remoteIssue(web.id)).toBeNull();
  }, 60_000);

  test('create_agent — 서버 방은 승인 카드 전에 서버에서 폴더를 확인한다(../api → /home/a/api) · 없으면 카드 없이 도구 오류', async () => {
    const { e, root, web, calls } = await remoteRoom();
    fs.mkdirSync(path.join(root, 'home', 'a', 'api'), { recursive: true });
    const requests: PendingRequest[] = [];
    e.on('request', (r: PendingRequest) => requests.push(r));
    const req = waitFor<PendingRequest>(e, 'request', (r) => r.agentId === web.id, 15_000);
    let done = resultOf(e, web.id);
    await e.sendUser(web.id, text('MAKE api|백엔드|../api|'));
    const r = await req;
    expect(r.input).toEqual({ name: 'api', role: '백엔드', folder: '/home/a/api', task: null });
    expect(calls().some((c) => c.kind === 'check' && c.script.includes(`cd '/home/a/api'`))).toBe(true);
    e.answerRequest(r.id, { type: 'allow' });
    expect(await resultText(done)).toContain('만들었어요');
    expect(e.agents().find((x) => x.name === 'api')?.folder).toBe('/home/a/api');

    const seen = requests.length;
    done = resultOf(e, web.id);
    await e.sendUser(web.id, text('MAKE x|검사|../nope|'));
    expect(await resultText(done)).toBe('서버에 그 폴더가 없어요');
    expect(requests).toHaveLength(seen);
    expect(e.history(web.id).filter((h) => h.kind === 'tool-result').at(-1)).toMatchObject({ isError: true, text: '서버에 그 폴더가 없어요' });
  }, 40_000);

  test('이 PC 방은 그대로 — ssh 를 부르지 않고 이 PC 의 run 폴더 설정으로 · 상태 사건에 remoteIssue 칸 없음', async () => {
    const { e, calls } = await startSsh();
    const { a } = setup(e);
    const statuses: any[] = [];
    e.on('status', (s) => statuses.push(s));
    const done = resultOf(e, a.id);
    await e.sendUser(a.id, text('echo 하나'));
    expect(await resultText(done)).toBe('받음: echo 하나');
    expect(calls()).toEqual([]);
    const argv = lastSpawnOf('A').argv;
    expect(flagValue(argv, '--mcp-config')).toBe(path.join(dataDir, 'run', a.id, 'mcp.json'));
    expect(e.remoteIssue(a.id)).toBeNull();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => !('remoteIssue' in s))).toBe(true);
    expect(agentOf(e, a.id).remoteLaunch).toBeNull();
  }, 20_000);
});

// ── 파일 첨부(이 PC 방) ──
const ATTACH_FAIL = '파일을 보내지 못했어요 — ';
const attDir = (id: string) => path.join(dataDir, 'attachments', id);
const attFiles = (id: string): string[] => (fs.existsSync(attDir(id)) ? fs.readdirSync(attDir(id)) : []);
/** 사용자가 고른 원본 — 시험 폴더 안에만 만든다 */
function original(name: string, body: string | Buffer = '첨부 내용'): string {
  const d = path.join(dir, 'originals');
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, name);
  fs.writeFileSync(p, body);
  return p;
}
const fileOf = (p: string, name = path.basename(p)): UserPart => ({ type: 'file', path: p, name, bytes: fs.statSync(p).size });
/** 가짜 claude 가 받은 사용자 줄마다 내용 블록 */
const userContents = (): any[][] => readLog().filter((x) => x.type === 'user').map((x) => x.message.content);

test('파일 첨부 — 사본·경로 줄·기록 칩', async () => {
  const e = await start();
  const { a } = setup(e);
  const src = original('보고서 최종.txt', 'hello 첨부');
  const items: HistoryItem[] = [];
  e.on('history', (x: { agentId: string; item: HistoryItem }) => x.agentId === a.id && items.push(x.item));
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: '읽어 줘' }, { type: 'file', path: src, name: '보고서 최종.txt', bytes: 999 }]);
  await done;

  expect(attFiles(a.id)).toHaveLength(1);
  const [file] = attFiles(a.id);
  expect(file).toMatch(/^\d{8}-\d{6}-보고서 최종\.txt$/);
  const abs = path.join(attDir(a.id), file);
  expect(fs.readFileSync(abs, 'utf8')).toBe('hello 첨부');
  expect(fs.readFileSync(src, 'utf8')).toBe('hello 첨부'); // 원본은 그대로
  // 사람 글 뒤에 경로 줄 블록 하나 — 사본의 절대 경로, 따옴표 없이
  expect(userContents()).toEqual([[{ type: 'text', text: '읽어 줘' }, { type: 'text', text: `\n\n첨부 파일:\n- ${abs}` }]]);
  // 기록엔 칩에 쓸 것만 — 크기는 엔진이 잰 것(렌더러가 준 999 가 아니다), 원본·보낸 경로는 없다
  const part = { type: 'file', name: '보고서 최종.txt', bytes: Buffer.byteLength('hello 첨부'), file };
  expect(e.history(a.id)[0]).toEqual({ t: expect.any(Number), kind: 'user', source: 'human', parts: [{ type: 'text', text: '읽어 줘' }, part] });
  expect(items[0]).toEqual(e.history(a.id)[0]);
  expect(fs.readFileSync(path.join(dataDir, 'history', `${a.id}.jsonl`), 'utf8')).not.toContain(JSON.stringify(path.dirname(src)).slice(1, -1));
  expect(e.status(a.id)).toBe('idle');
});

test('원본 없음 — 오류, 아무것도 안 보냄', async () => {
  const e = await start();
  const { a } = setup(e);
  const gone = path.join(dir, 'originals', '없음.txt');
  await expect(e.sendUser(a.id, [{ type: 'text', text: '읽어 줘' }, { type: 'file', path: gone, name: '없음.txt', bytes: 3 }])).rejects.toThrow(
    `${ATTACH_FAIL}없음.txt: 찾을 수 없어요`,
  );
  // 폴더 · 상대 경로도 보내지 않는다
  await expect(e.sendUser(a.id, [{ type: 'file', path: folder('폴더'), name: '폴더', bytes: 0 }])).rejects.toThrow(`${ATTACH_FAIL}폴더: 폴더는 보낼 수 없어요`);
  await expect(e.sendUser(a.id, [{ type: 'file', path: 'rel.txt', name: 'rel.txt', bytes: 0 }])).rejects.toThrow(ATTACH_FAIL);
  // 자격 증명 파일 이름은 골라도 읽거나 옮기지 않는다(시험 폴더의 가짜 파일)
  await expect(e.sendUser(a.id, [fileOf(original('.credentials.json', '{}'))])).rejects.toThrow(`${ATTACH_FAIL}.credentials.json: 자격 증명 파일은 보낼 수 없어요`);
  expect(spawns()).toEqual([]); // 띄우지도 않았다
  expect(e.history(a.id)).toEqual([]);
  expect(e.heldInput(a.id)).toBe(0);
  expect(attFiles(a.id)).toEqual([]);
});

test('두 번째 파일 실패 — 첫 사본 되돌림, 오류', async () => {
  const e = await start();
  const { a } = setup(e);
  const one = original('하나.txt', '1');
  const gone = path.join(dir, 'originals', '둘.txt');
  await expect(
    e.sendUser(a.id, [{ type: 'text', text: 'echo 둘' }, fileOf(one), { type: 'file', path: gone, name: '둘.txt', bytes: 1 }]),
  ).rejects.toThrow(`${ATTACH_FAIL}둘.txt: 찾을 수 없어요`);
  expect(attFiles(a.id)).toEqual([]); // 이번에 만든 첫 사본은 지웠다
  expect(spawns()).toEqual([]);
  expect(e.history(a.id)).toEqual([]);
  expect(fs.readFileSync(one, 'utf8')).toBe('1');
  // 다시 보내면 새 사본으로
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 다시' }, fileOf(one)]);
  await done;
  expect(attFiles(a.id)).toHaveLength(1);
});

test('100MB+1 거절, 100MB 됨', async () => {
  const e = await start();
  const { a } = setup(e);
  const big = original('큰.bin', 'x');
  const edge = original('딱.bin', 'y');
  const realStat = fs.promises.stat.bind(fs.promises);
  // 진짜 큰 파일 대신 크기만 흉내 — 엔진은 렌더러가 준 bytes 가 아니라 fs.stat 으로 잰다
  const spy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike, o?: any) => {
    const st = await realStat(p, o);
    if (p === big) return Object.assign(st, { size: ATTACH_MAX_BYTES + 1 });
    if (p === edge) return Object.assign(st, { size: ATTACH_MAX_BYTES });
    return st;
  }) as any);
  try {
    await expect(e.sendUser(a.id, [{ type: 'file', path: big, name: '큰.bin', bytes: 1 }])).rejects.toThrow(
      `${ATTACH_FAIL}큰.bin: 100MB 보다 큰 파일은 보낼 수 없어요`,
    );
    expect(attFiles(a.id)).toEqual([]);
    const done = resultOf(e, a.id);
    await e.sendUser(a.id, [{ type: 'text', text: 'echo 딱' }, { type: 'file', path: edge, name: '딱.bin', bytes: ATTACH_MAX_BYTES }]);
    await done;
    expect(attFiles(a.id)).toHaveLength(1);
    expect(e.history(a.id)[0]).toMatchObject({ kind: 'user', parts: [{ type: 'text', text: 'echo 딱' }, { type: 'file', name: '딱.bin' }] });
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test('붙잡힌 입력도 준비된 꼴 — 원본을 지워도 나중에 그대로 감', async () => {
  const e = await start();
  const { a } = setup(e);
  const src = original('메모.txt', '붙잡힌 첨부');
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('/대기')); // 줄에 서는 입력 — 뒤의 첨부도 줄에 선다
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(src)]);
  expect(e.heldInput(a.id)).toBe(2);
  expect(attFiles(a.id)).toHaveLength(1); // 줄에 서기 전에 사본을 만들었다
  const [file] = attFiles(a.id);
  const abs = path.join(attDir(a.id), file);
  await e.interrupt(a.id);
  // 붙잡기 목록 — 그림 수에 첨부를 세지 않는다
  expect(e.hold(a.id)?.items.map((x) => [x.text, x.images, x.files ?? 0])).toEqual([['/대기', 0, 0], ['echo 첨부', 0, 1]]);
  fs.rmSync(src); // 원본이 사라져도
  const lines = `\n\n첨부 파일:\n- ${abs}`;
  const got = resultTextIs(e, a.id, `받음: echo 첨부\n${lines}`);
  e.resumeHold(a.id);
  await got;
  expect(userContents().at(-1)).toEqual([{ type: 'text', text: 'echo 첨부' }, { type: 'text', text: lines }]);
  expect(attFiles(a.id)).toEqual([file]); // 다시 만들지 않았다
  expect(fs.readFileSync(abs, 'utf8')).toBe('붙잡힌 첨부');
  expect(e.history(a.id).filter((x) => x.kind === 'user').at(-1)).toMatchObject({
    parts: [{ type: 'text', text: 'echo 첨부' }, { type: 'file', name: '메모.txt', file }],
  });
});

test('차례 도중 첨부 — 지금 차례에 끼우고, 되돌림으로 읽은 것을 맞춰 바로 쉰다', async () => {
  const e = await start({}, false, { midGraceMs: 60_000 }); // 되돌림을 못 맞추면 오래 작업 중으로 남는다
  const { a } = setup(e);
  const src = original('끼움.txt');
  const slow = resultOf(e, a.id);
  await e.sendUser(a.id, text('THINK 생각'));
  await e.sendUser(a.id, [{ type: 'text', text: '이것도' }, fileOf(src)]);
  expect(e.heldInput(a.id)).toBe(0); // 줄에 서지 않고 바로 나갔다
  await slow;
  await until('쉼', () => e.status(a.id) === 'idle', 2000);
  const [file] = attFiles(a.id);
  expect(userContents().at(-1)).toEqual([{ type: 'text', text: '이것도' }, { type: 'text', text: `\n\n첨부 파일:\n- ${path.join(attDir(a.id), file)}` }]);
});

// 진짜 claude 의 되돌림이 글 블록을 조금 다르게 이어 붙여도 읽은 것으로 맞춘다 — 못 맞추면 읽은 말을 안 읽었다고 보고, 멈출 때 돌려받아
// 다시 보낸다(두 번 감 · 기록 두 줄). crlf: 줄 끝 \r\n·끝 공백 · nosep: 구분 없이 한 블록 · para: 빈 줄로 한 블록 · lead: 앞에 그림 자리 표시
test.each(['crlf', 'nosep', 'para', 'lead'])('차례 도중 첨부 — 되돌림 꼴이 달라도(%s) 읽은 것으로 맞춰 바로 쉬고, 멈춰도 돌려받지 않는다', async (shape) => {
  const e = await start({ FAKE_REPLAY_SHAPE: shape }, false, { midGraceMs: 60_000 }); // 못 맞추면 오래 작업 중으로 남는다
  const { a } = setup(e);
  const slow = resultOf(e, a.id);
  await e.sendUser(a.id, text('THINK 생각'));
  await e.sendUser(a.id, [{ type: 'text', text: '이것도\n둘째 줄' }, fileOf(original('끼움.txt'))]);
  expect(e.heldInput(a.id)).toBe(0); // 차례 도중에 끼웠다
  await slow;
  await until('쉼', () => e.status(a.id) === 'idle', 2000);
  await e.interrupt(a.id);
  expect(e.hold(a.id)).toBeNull(); // 돌려받아 붙잡은 것이 없다
  expect(userContents()).toHaveLength(2); // 다시 보내지 않았다
  expect(e.history(a.id).filter((x) => x.kind === 'user')).toHaveLength(2);
});

// 글 없이 그림만 끼운 말(스크린숏 붙여 넣기) — 되돌림엔 글 블록이 없다(보낸 그대로 그림만). 못 맞추면 멈출 때 읽힌 그림을 돌려받아
// 다시 보낸다(두 번 감 · 기록 두 줄)
test('차례 도중 그림만 — 글 없는 되돌림으로 읽은 것을 맞춰 바로 쉬고, 멈춰도 돌려받지 않는다', async () => {
  const e = await start({}, false, { midGraceMs: 60_000 }); // 못 맞추면 오래 작업 중으로 남는다
  const { a } = setup(e);
  const png = Buffer.alloc(64, 3).toString('base64');
  const slow = resultOf(e, a.id);
  await e.sendUser(a.id, text('THINK 생각'));
  await e.sendUser(a.id, [{ type: 'image', mediaType: 'image/png', base64: png }]);
  expect(e.heldInput(a.id)).toBe(0); // 차례 도중에 끼웠다
  await slow;
  await until('쉼', () => e.status(a.id) === 'idle', 2000);
  await e.interrupt(a.id);
  expect(e.hold(a.id)).toBeNull(); // 돌려받아 붙잡은 것이 없다
  expect(userContents()).toHaveLength(2); // 다시 보내지 않았다
  expect(userContents()[1]).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }]);
  expect(e.history(a.id).filter((x) => x.kind === 'user')).toHaveLength(2);
});

// 쉴 때 보낸 줄은 init 으로 읽히지만 그 되돌림은 init 뒤에 온다(첫 말은 init 뒤) — 그 사이 끼운 말이 같은 되돌림 꼴이면(그림만 둘 — 둘 다 글 없는
// 되돌림) 앞 말의 되돌림을 끼운 말이 읽힌 것으로 치면 안 된다: 끼운 말은 안 읽힌 채라 멈추면 돌려받아 붙잡아야 한다(아니면 멈춘 뒤 그 말로 새 차례)
test('쉴 때 그림만 보내고 그 되돌림 전에 그림만 끼우면 — 앞 말의 되돌림은 앞 말의 몫, 끼운 말은 멈추면 돌려받는다', async () => {
  const e = await start({ FAKE_SLOW_BLANK: '1' }, false, { midGraceMs: 60_000 });
  const { a } = setup(e);
  const image = (n: number): UserPart[] => [{ type: 'image', mediaType: 'image/png', base64: Buffer.alloc(64, n).toString('base64') }];
  const said = waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === a.id && x.event.kind === 'assistant');
  await e.sendUser(a.id, image(1)); // 쉴 때 — 차례를 연다
  await e.sendUser(a.id, image(2)); // 그 되돌림이 오기 전에 끼운다
  expect(e.heldInput(a.id)).toBe(0); // 줄에 서지 않고 바로 나갔다
  await said; // init · 첫 말의 되돌림(글 없음)이 지나갔다 — 끼운 말은 가짜가 아직 안 읽었다
  expect(e.status(a.id)).toBe('working');
  const first = spawnsOf('A')[0].pid;
  await e.interrupt(a.id);
  expect(e.hold(a.id)?.items).toEqual([expect.objectContaining({ source: 'human', text: '', images: 1 })]); // 끼운 말을 돌려받아 붙잡았다
  expect(e.history(a.id).some((x) => x.kind === 'notice' && x.text === '멈췄어요 — Claude 가 아직 읽지 않은 말 1개는 붙잡았어요')).toBe(true);
  await until('A 가 꺼짐', () => !isAlive(first));
  await until('다시 띄움', () => spawnsOf('A').length === 2);
  await until('쉼', () => e.status(a.id) === 'idle');
  await sleep(300);
  expect(userContents()).toHaveLength(2); // 새 claude 엔 아무것도 안 갔다
  expect(e.history(a.id).filter((x) => x.kind === 'user')).toHaveLength(2);
});

// ── PDF 첨부 — 경로 줄에 더해 문서 블록(base64)으로도(설계 §4.5 · probe29) ──
const MiB = 1024 * 1024;
/**
 * 시험 PDF — 쪽마다 압축 안 한 `/Type /Page` 객체 · 쪽 나무 `/Count`. size 를 주면 끝에 주석 줄을 덧대 꼭 그 바이트로.
 * 가짜 claude 는 읽지 않는다(바이트·크기만 본다) — 진짜 확인은 따로
 */
function pdf(pages = 1, size?: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  let s = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n`;
  for (let i = 0; i < pages; i++) s += `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`;
  s += 'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
  if (size !== undefined) s += `%${'x'.repeat(size - s.length - 2)}\n`;
  const buf = Buffer.from(s, 'latin1');
  if (size !== undefined) expect(buf.length).toBe(size);
  return buf;
}
/** 가짜 claude 기록의 문서 블록 — 내용(base64) 없이 크기만 남긴다 */
const docOf = (body: Buffer) => ({ type: 'document', bytes: body.length });
const pathLines = (...abs: string[]) => ({ type: 'text', text: `\n\n첨부 파일:\n${abs.map((p) => `- ${p}`).join('\n')}` });
/** 보낸 줄마다 준비된 입력(ClaudeSession.send 에 들어간 것) — 문서 블록의 base64 가 그 사본의 바이트인지 본다 */
function sentParts(): { sent: ReadyPart[][]; restore: () => void } {
  const sent: ReadyPart[][] = [];
  const real = ClaudeSession.prototype.send;
  const spy = vi.spyOn(ClaudeSession.prototype, 'send').mockImplementation(function (this: ClaudeSession, parts: ReadyPart[], o?: { quiet?: boolean }) {
    sent.push(parts);
    return real.call(this, parts, o);
  });
  return { sent, restore: () => spy.mockRestore() };
}

test('PDF 첨부 — 문서 블록 + 경로 줄, 기록엔 칩만(base64 없음)', async () => {
  const e = await start();
  const { a } = setup(e);
  const body = pdf(2);
  const b64 = body.toString('base64');
  const src = original('보고서 최종.pdf', body);
  const items: HistoryItem[] = [];
  e.on('history', (x: { agentId: string; item: HistoryItem }) => x.agentId === a.id && items.push(x.item));
  const events: AgentEvent[] = [];
  e.on('agent-event', (x: AgentEvent) => events.push(x));
  const { sent, restore } = sentParts();
  try {
    const done = resultOf(e, a.id);
    await e.sendUser(a.id, [{ type: 'text', text: '읽어 줘' }, fileOf(src)]);
    expect(await resultText(done)).toBe(`받음: 읽어 줘\n\n\n첨부 파일:\n- ${path.join(attDir(a.id), attFiles(a.id)[0])}`);
  } finally {
    restore();
  }
  const [file] = attFiles(a.id);
  const abs = path.join(attDir(a.id), file);
  // 사람 글 → 문서 블록 → 경로 줄(문서 블록이 있어도 그대로 — Claude 가 그 파일을 자기 도구로도 다룬다)
  expect(userContents()).toEqual([[{ type: 'text', text: '읽어 줘' }, docOf(body), pathLines(abs)]]);
  // 문서 블록은 그 사본의 바이트 그대로(base64)
  expect(sent).toHaveLength(1);
  expect(sent[0][1]).toEqual({ type: 'file', name: '보고서 최종.pdf', bytes: body.length, file, sendPath: abs, inline: { mediaType: 'application/pdf', base64: b64 } });
  // 기록엔 칩만 — 이름·크기·사본 이름. base64 는 기록 파일·기록 사건·화면 사건·가짜 claude 기록 어디에도 없다
  const chip = { type: 'file', name: '보고서 최종.pdf', bytes: body.length, file };
  expect(e.history(a.id)[0]).toEqual({ t: expect.any(Number), kind: 'user', source: 'human', parts: [{ type: 'text', text: '읽어 줘' }, chip] });
  expect(items[0]).toEqual(e.history(a.id)[0]);
  expect(fs.readFileSync(path.join(dataDir, 'history', `${a.id}.jsonl`), 'utf8')).not.toContain(b64);
  expect(JSON.stringify(items)).not.toContain(b64);
  expect(JSON.stringify(events)).not.toContain(b64);
  expect(fs.readFileSync(logFile, 'utf8')).not.toContain(b64);
  expect(fs.readFileSync(abs)).toEqual(body); // 사본은 바이트 그대로
  expect(e.status(a.id)).toBe('idle');
});

test('%PDF- 아닌 .pdf — 경로 줄만', async () => {
  const e = await start();
  const { a } = setup(e);
  const body = pdf(1);
  const fake = original('가짜.pdf', '이름만 PDF');
  const late = original('늦은 머리.pdf', Buffer.concat([Buffer.from(' '), body])); // 머리가 맨 앞이 아니다
  const named = original('진짜지만.txt', body); // 바이트는 PDF 지만 이름이 .pdf 가 아니다
  const upper = original('대문자.PDF', body); // 확장자는 대소문자 없이
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 넷' }, fileOf(fake), fileOf(late), fileOf(named), fileOf(upper)]);
  await done;
  const abs = (name: string) => path.join(attDir(a.id), attFiles(a.id).find((f) => f.endsWith(name))!);
  expect(userContents()).toEqual([
    [{ type: 'text', text: 'echo 넷' }, docOf(body), pathLines(abs('가짜.pdf'), abs('늦은 머리.pdf'), abs('진짜지만.txt'), abs('대문자.PDF'))],
  ]);
});

test('10MiB 넘는 PDF·합이 넘는 둘째 PDF — 경로 줄만', async () => {
  expect(PDF_INLINE_MAX_BYTES).toBe(10 * MiB);
  const e = await start();
  const { a } = setup(e);
  // 하나: 10MiB+1 은 경로 줄만 · 딱 10MiB 는 문서 블록(넘는 것은 합에 치지 않는다)
  const over = pdf(1, 10 * MiB + 1);
  const edge = pdf(1, 10 * MiB);
  let done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 하나' }, fileOf(original('넘침.pdf', over)), fileOf(original('딱.pdf', edge))]);
  await done;
  const abs = (name: string) => path.join(attDir(a.id), attFiles(a.id).find((f) => f.endsWith(name))!);
  expect(userContents()[0]).toEqual([{ type: 'text', text: 'echo 하나' }, docOf(edge), pathLines(abs('넘침.pdf'), abs('딱.pdf'))]);
  // 합: 한 메시지의 그림·문서 블록 base64 합 MEDIA_INLINE_MAX_B64(13.5Mi 글자) 까지 — 앞에서부터, 넣으면 넘는 PDF 는 경로 줄만(뒤의 것이 남은 자리에 들면 들어간다)
  const six = pdf(1, 6 * MiB);
  const five = pdf(1, 5 * MiB);
  const four = pdf(1, 4 * MiB);
  done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 합' }, fileOf(original('육.pdf', six)), fileOf(original('오.pdf', five)), fileOf(original('사.pdf', four))]);
  await done;
  expect(userContents()[1]).toEqual([{ type: 'text', text: 'echo 합' }, docOf(six), docOf(four), pathLines(abs('육.pdf'), abs('오.pdf'), abs('사.pdf'))]);
  // 다음 메시지는 다시 10MiB 부터
  done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 다음' }, fileOf(original('오2.pdf', five))]);
  await done;
  expect(userContents()[2]).toEqual([{ type: 'text', text: 'echo 다음' }, docOf(five), pathLines(abs('오2.pdf'))]);
}, 30_000);

// 쪽수 세기 단위 시험은 test/pdf.test.ts — 여기는 엔진이 그 결과로 가르는 것
test('압축 객체 스트림 PDF — 풀어 세어 100쪽 넘으면 경로 줄만 · 못 세면(풀리지 않음·암호·모름) 경로 줄만', async () => {
  expect(PDF_INLINE_MAX_PAGES).toBe(100);
  const e = await start();
  const { a } = setup(e);
  const fifty = packedPdf(50);
  const files: [string, Buffer][] = [
    ['압축 150쪽.pdf', packedPdf(150)],
    ['압축 50쪽.pdf', fifty],
    ['보이는 1쪽 + 압축 499쪽.pdf', packedPdf(500, { plain: 1 })],
    ['풀리지 않음.pdf', packedPdf(30, { data: Buffer.from('zlib 이 아니다') })],
    ['암호.pdf', packedPdf(30, { encrypt: true })],
    ['모름.pdf', pdfOf('')],
  ];
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 압축' }, ...files.map(([n, b]) => fileOf(original(n, b)))]);
  await done;
  const abs = (name: string) => path.join(attDir(a.id), attFiles(a.id).find((f) => f.endsWith(name))!);
  expect(userContents()).toEqual([[{ type: 'text', text: 'echo 압축' }, docOf(fifty), pathLines(...files.map(([n]) => abs(n)))]]);
});

// probe29: CLI 는 요청마다 대화의 그림·문서 base64 합을 본다(24MiB) — 한 메시지의 상한도 그림을 함께 센다
test('한 메시지의 그림·문서 블록 base64 합 13.5MiB — 그림을 먼저 세고(그림은 그대로 간다) PDF 는 남은 자리에만', async () => {
  expect(MEDIA_INLINE_MAX_B64).toBe(13.5 * MiB);
  const e = await start();
  const { a } = setup(e);
  const img = Buffer.alloc(4 * MiB, 7).toString('base64'); // 5,592,408 자
  const seven = pdf(1, 7 * MiB); // base64 9,786,712 자 — 그림과 합하면 넘는다
  const three = pdf(1, 3 * MiB); // base64 4,194,304 자 — 남은 자리에 든다
  let done = resultOf(e, a.id);
  // 그림이 PDF 뒤에 있어도 먼저 센다
  await e.sendUser(a.id, [
    { type: 'text', text: 'echo 그림' },
    fileOf(original('칠.pdf', seven)),
    fileOf(original('삼.pdf', three)),
    { type: 'image', mediaType: 'image/png', base64: img },
  ]);
  await done;
  const abs = (name: string) => path.join(attDir(a.id), attFiles(a.id).find((f) => f.endsWith(name))!);
  expect(userContents()[0]).toEqual([
    { type: 'text', text: 'echo 그림' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } },
    docOf(three),
    pathLines(abs('칠.pdf'), abs('삼.pdf')),
  ]);
  // 그림이 없으면 같은 PDF 가 든다
  done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 그림 없이' }, fileOf(original('칠2.pdf', seven))]);
  await done;
  expect(userContents()[1]).toEqual([{ type: 'text', text: 'echo 그림 없이' }, docOf(seven), pathLines(abs('칠2.pdf'))]);
}, 30_000);

test('100쪽 넘는 PDF — 경로 줄만', async () => {
  const e = await start();
  const { a } = setup(e);
  const hundred = pdf(100);
  const over = pdf(101);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 쪽' }, fileOf(original('백한쪽.pdf', over)), fileOf(original('백쪽.pdf', hundred))]);
  await done;
  const abs = (name: string) => path.join(attDir(a.id), attFiles(a.id).find((f) => f.endsWith(name))!);
  expect(userContents()).toEqual([[{ type: 'text', text: 'echo 쪽' }, docOf(hundred), pathLines(abs('백한쪽.pdf'), abs('백쪽.pdf'))]]);
});

test('붙잡힌 PDF 입력도 문서 블록째 감', async () => {
  const e = await start();
  const { a } = setup(e);
  const body = pdf(3);
  const b64 = body.toString('base64');
  const src = original('붙잡힌.pdf', body);
  const holds: unknown[] = [];
  e.on('hold', (x: unknown) => holds.push(x));
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('/대기')); // 줄에 서는 입력 — 뒤의 PDF 도 줄에 선다
  await e.sendUser(a.id, [{ type: 'text', text: 'echo PDF' }, fileOf(src)]);
  expect(e.heldInput(a.id)).toBe(2);
  await e.interrupt(a.id);
  // 붙잡기 목록·그 사건엔 수만 — base64 는 화면에 가지 않는다
  expect(e.hold(a.id)?.items.map((x) => [x.text, x.images, x.files ?? 0])).toEqual([['/대기', 0, 0], ['echo PDF', 0, 1]]);
  expect(JSON.stringify(e.hold(a.id))).not.toContain(b64);
  expect(holds.length).toBeGreaterThan(0);
  expect(JSON.stringify(holds)).not.toContain(b64);
  fs.rmSync(src); // 원본이 사라져도 준비된 꼴(사본 + 문서 블록)로 간다
  const [file] = attFiles(a.id);
  const abs = path.join(attDir(a.id), file);
  const got = resultTextIs(e, a.id, `받음: echo PDF\n\n\n첨부 파일:\n- ${abs}`);
  e.resumeHold(a.id);
  await got;
  expect(userContents().at(-1)).toEqual([{ type: 'text', text: 'echo PDF' }, docOf(body), pathLines(abs)]);
  expect(e.history(a.id).filter((x) => x.kind === 'user').at(-1)).toEqual({
    t: expect.any(Number), kind: 'user', source: 'human', parts: [{ type: 'text', text: 'echo PDF' }, { type: 'file', name: '붙잡힌.pdf', bytes: body.length, file }],
  });
  expect(fs.readFileSync(path.join(dataDir, 'history', `${a.id}.jsonl`), 'utf8')).not.toContain(b64);
});

test('PDF 사본을 읽는 사이 멈추면 — 그 보내기는 실패하고 사본을 되돌린다(복사 중 멈춤과 같다) · 다음 말은 그대로', async () => {
  const e = await start();
  const { a } = setup(e);
  const src = original('읽는 중.pdf', pdf(1));
  const real = fs.promises.readFile.bind(fs.promises);
  let reached = false;
  // 첨부 폴더의 사본 읽기만 붙잡는다 — 끊길(signal) 때까지 끝나지 않는다
  const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (p: fs.PathLike, o?: any) => {
    if (typeof p === 'string' && p.startsWith(attDir(a.id))) {
      reached = true;
      return new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason), { once: true }));
    }
    return real(p, o);
  }) as any);
  try {
    const sending = e.sendUser(a.id, [{ type: 'text', text: 'echo PDF' }, fileOf(src)]);
    const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}읽는 중.pdf: ${COPY_STOPPED}`);
    await until('사본 읽는 중', () => reached);
    await e.interrupt(a.id);
    await failed;
  } finally {
    spy.mockRestore();
  }
  expect(attFiles(a.id)).toEqual([]); // 만든 사본은 되돌렸다
  expect(e.hold(a.id)).toBeNull(); // 붙잡지 않았다
  expect(e.history(a.id)).toEqual([]);
  expect(userContents()).toEqual([]);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, text('echo 다음'));
  expect(await resultText(done)).toBe('받음: echo 다음');
});

// probe29 P3 — 되돌림 줄엔 보낸 문서 블록이 data 째 실려 온다(10MiB PDF → ~14MB 한 줄). 그 줄도 읽어 끼운 말을 읽은 것으로 맞춰야
// 바로 쉬고, 멈춰도 돌려받아 두 번 보내지 않는다
test('큰 되돌림 줄(문서 블록 실림)도 끼운 말 맞추기 됨', async () => {
  const e = await start({ FAKE_THINK_MS: '150' }, false, { midGraceMs: 60_000 }); // 못 맞추면 오래 작업 중으로 남는다
  const { a } = setup(e);
  const body = pdf(1, PDF_INLINE_MAX_BYTES); // 문서 블록에 드는 가장 큰 PDF
  const slow = resultOf(e, a.id);
  await e.sendUser(a.id, text('THINK 생각'));
  await e.sendUser(a.id, [{ type: 'text', text: '이것도' }, fileOf(original('큰.pdf', body))]);
  expect(e.heldInput(a.id)).toBe(0); // 차례 도중에 끼웠다
  await slow;
  await until('쉼', () => e.status(a.id) === 'idle', 3000);
  const [file] = attFiles(a.id);
  expect(userContents().at(-1)).toEqual([{ type: 'text', text: '이것도' }, docOf(body), pathLines(path.join(attDir(a.id), file))]);
  // 같은 차례에서 읽었다(가짜는 끼운 말을 '이어서 받음' 으로 답한다)
  expect(e.history(a.id).some((x) => x.kind === 'assistant' && x.blocks.some((b) => b.type === 'text' && b.text.startsWith('이어서 받음: 이것도')))).toBe(true);
  await e.interrupt(a.id);
  expect(e.hold(a.id)).toBeNull(); // 돌려받아 붙잡은 것이 없다
  expect(userContents()).toHaveLength(2); // 다시 보내지 않았다
}, 30_000);

test('갈래 — 사본 복사·기록 file 새 이름', async () => {
  const { e } = await startConv();
  const { a } = setup(e);
  const src = original('설계.md', '# 설계');
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(src)]);
  await done;
  const s1 = agentOf(e, a.id).sessionId;
  const p = (e.history(a.id).find((x) => x.kind === 'user') as any).parts[1];
  await e.newConversation(a.id);

  const made = await e.forkAgent({ from: a.id, key: s1, name: 'A 2', role: '기획' });

  // 기록의 file 은 새 에이전트 첨부 폴더 안의 사본 — 복사는 같은 이름으로(copy)
  const q = (e.history(made.id).find((x) => x.kind === 'user') as any).parts[1];
  expect(q).toEqual({ type: 'file', name: '설계.md', bytes: p.bytes, file: p.file });
  expect(fs.readFileSync(path.join(attDir(made.id), q.file), 'utf8')).toBe('# 설계');
  expect(fs.readFileSync(path.join(attDir(a.id), p.file), 'utf8')).toBe('# 설계'); // 원래 것 그대로
});

// 갈래는 기록을 먼저 쓰고 첨부 사본은 그 뒤에 복사한다 — 복사하는 동안에도 갈래 카드에 기록이 있고, 그새 보낸 말은 옮긴 줄 뒤에 붙는다.
// 그새 갈래를 지우면 복사를 그만두고 되살아난 폴더를 지운다(기록도 다시 만들지 않는다)
test('갈래 — 기록 먼저, 첨부 사본은 그 뒤(그새 보낸 말은 옮긴 줄 뒤) · 복사 중에 지우면 그만두고 치운다', async () => {
  const { e } = await startConv();
  const { a } = setup(e);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(original('하나.md', '# 하나')), fileOf(original('둘.md', '# 둘'))]);
  await done;
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);

  /** 첨부 사본 복사를 붙잡는다 — open() 을 부를 때까지 */
  const gate = () => {
    let open!: () => void;
    const shut = new Promise<void>((r) => (open = r));
    const real = fs.promises.copyFile;
    const spy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args: Parameters<typeof real>) => {
      await shut;
      return real(...args);
    });
    return { open, spy };
  };

  // (1) 복사하는 동안에도 기록이 다 있다 · 그새 보낸 말은 옮긴 줄 뒤
  let g = gate();
  try {
    const before = e.agents().map((x) => x.id);
    const forking = e.forkAgent({ from: a.id, key: s1, name: 'A 2', role: '기획' });
    await until('갈래가 보임', () => e.agents().length > before.length && g.spy.mock.calls.length > 0);
    const made = e.agents().find((x) => !before.includes(x.id))!;
    const copied = e.conversation(a.id, s1);
    expect(e.history(made.id).slice(0, -1)).toEqual(copied); // 옮긴 줄이 벌써 다 있다
    expect(e.history(made.id).at(-1)).toMatchObject({ kind: 'notice' });
    expect(attFiles(made.id).filter((f) => !f.endsWith('.tmp'))).toEqual([]); // 칩은 잠깐 '찾을 수 없어요'
    const reply = resultOf(e, made.id);
    await e.sendUser(made.id, text('echo 갈래에서'));
    await reply;
    g.open();
    expect((await forking).id).toBe(made.id);
    const after = e.history(made.id);
    expect(after.slice(0, copied.length)).toEqual(copied);
    expect(after[copied.length]).toMatchObject({ kind: 'notice' });
    expect(after.slice(copied.length + 1).find((x) => x.kind === 'user')).toMatchObject({ parts: [{ type: 'text', text: 'echo 갈래에서' }] });
    expect(attFiles(made.id).sort()).toEqual(attFiles(a.id).sort()); // 복사가 끝나면 칩이 연다
  } finally {
    g.open();
    g.spy.mockRestore();
  }

  // (2) 복사하는 사이 갈래를 지우면 — 그만 복사하고, 되살아난 폴더를 치운다. 기록 파일도 다시 생기지 않는다
  g = gate();
  try {
    const before = e.agents().map((x) => x.id);
    const forking = e.forkAgent({ from: a.id, key: s1, name: 'A 3', role: '기획' });
    await until('갈래가 보임', () => e.agents().length > before.length && g.spy.mock.calls.length > 0);
    const made = e.agents().find((x) => !before.includes(x.id))!;
    const removing = e.removeAgent(made.id); // 지우기는 복사가 그만두고 치울 때까지 기다린다
    await sleep(100);
    g.open();
    await removing;
    await forking;
    expect(g.spy).toHaveBeenCalledTimes(1); // 둘째 첨부는 복사하지 않았다
    expect(fs.existsSync(attDir(made.id))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'history', `${made.id}.jsonl`))).toBe(false);
    expect(attFiles(a.id)).toHaveLength(2); // 원래 것 그대로
  } finally {
    g.open();
    g.spy.mockRestore();
  }
});

// 갈래 복사 중(CopyFileW 가 임시 파일을 혼자 연 채)에 지우면 폴더 지우기가 막힌다(EBUSY·EPERM) — 곧 복사가 끝나 forkAttachments 가 치우는데
// '첨부 폴더를 다 지우지 못했어요' 를 잘못 알리지 않게, 지우기는 그 복사를 기다렸다(상한 있음) 치운다
test.skipIf(process.platform !== 'win32')('갈래 복사 중에 지우면 — 복사를 기다렸다 치우고, 다 못 지웠다고 알리지 않는다', async () => {
  const { e } = await startConv();
  const { a } = setup(e);
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(original('하나.md', '# 하나'))]);
  await done;
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  const errors: string[] = [];
  e.on('engine-error', (x: { message: string }) => errors.push(x.message));

  // copyFile 안에서 붙잡는다 — CopyFileW 처럼 임시 파일을 혼자(나눠 쓰기 없이 — libuv UV_FS_O_EXLOCK) 연 채, open() 을 부를 때까지
  const EXLOCK = 0x10000000;
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  let inside = false;
  const real = fs.promises.copyFile;
  const spy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (src, dest, mode) => {
    const h = await fs.promises.open(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | EXLOCK);
    inside = true;
    try {
      await shut;
    } finally {
      await h.close();
    }
    return real(src, dest, mode);
  });
  try {
    const before = e.agents().map((x) => x.id);
    const forking = e.forkAgent({ from: a.id, key: s1, name: 'A 2', role: '기획' });
    await until('복사 중', () => inside);
    const made = e.agents().find((x) => !before.includes(x.id))!;
    expect(() => fs.rmSync(attDir(made.id), { recursive: true, force: true })).toThrow(); // 잠겨 지금은 못 지운다
    const removing = e.removeAgent(made.id);
    await sleep(300); // 지우기가 폴더를 지우려 들 틈
    open();
    await removing;
    await forking;
    expect(errors).toEqual([]);
    expect(fs.existsSync(attDir(made.id))).toBe(false);
    expect(attFiles(a.id)).toHaveLength(1); // 원래 것 그대로
  } finally {
    open();
    spy.mockRestore();
  }
});

test('에이전트 지우기 — 첨부 폴더 지움', async () => {
  const e = await start();
  const { a, b } = setup(e);
  const src = original('x.txt');
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo' }, fileOf(src)]);
  await done;
  await talk(e, b.id, 'echo b');
  expect(attFiles(a.id)).toHaveLength(1);
  await e.removeAgent(a.id);
  expect(fs.existsSync(attDir(a.id))).toBe(false);
  expect(fs.existsSync(attDir(b.id))).toBe(true); // 다른 에이전트 것은 그대로
  expect(fs.readFileSync(src, 'utf8')).toBe('첨부 내용'); // 원본은 그대로
});

test('attachmentPath — 기록의 사본 이름만 그 에이전트 첨부 폴더 안으로 푼다(밖·없음·다른 에이전트·없는 에이전트는 null)', async () => {
  const e = await start();
  const { a, b } = setup(e);
  const src = original('보고서.txt');
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo' }, fileOf(src)]);
  await done;
  const [file] = attFiles(a.id);
  const abs = path.join(attDir(a.id), file);
  const launched = spawns().length;
  expect(e.attachmentPath(a.id, file)).toBe(abs);
  // 다른 에이전트 폴더엔 없다 · 그 폴더에서 .. 로 넘어가지 못한다
  expect(e.attachmentPath(b.id, file)).toBeNull();
  for (const bad of [`..\\${a.id}\\${file}`, `../${a.id}/${file}`, abs, src, '', '20261104-120000-없음.txt', 5 as unknown as string]) {
    expect(e.attachmentPath(a.id, bad), String(bad)).toBeNull();
    expect(e.attachmentPath(b.id, bad), String(bad)).toBeNull();
  }
  // 등록되지 않은 에이전트(주인 없이 남은 폴더 포함)는 풀지 않는다
  fs.mkdirSync(attDir('ghost-1'), { recursive: true });
  fs.copyFileSync(abs, path.join(attDir('ghost-1'), file));
  expect(e.attachmentPath('ghost-1', file)).toBeNull();
  expect(e.attachmentPath(5 as unknown as string, file)).toBeNull();
  expect(spawns()).toHaveLength(launched); // claude 를 띄우지 않는다
  await e.removeAgent(a.id);
  expect(e.attachmentPath(a.id, file)).toBeNull();
});

test('모든 에이전트 띄우기에 첨부 폴더 --add-dir(폴더 생성)', async () => {
  const e1 = await start();
  const { a, b } = setup(e1);
  expect(fs.existsSync(attDir(a.id))).toBe(false); // 띄우기 전엔 없다
  await talk(e1, a.id, 'echo 하나');
  await talk(e1, b.id, 'echo 둘');
  await e1.newConversation(a.id);
  await talk(e1, a.id, 'echo 셋');
  await e1.shutdown();
  const e2 = await start(); // --resume 으로 다시 뜨는 경우도
  await talk(e2, a.id, 'echo 넷');

  const all = spawns();
  expect(all).toHaveLength(4);
  for (const { argv } of all) {
    const id = flagValue(argv, '-n') === 'A' ? a.id : b.id;
    const i = argv.indexOf('--add-dir');
    expect(argv.filter((x) => x === '--add-dir')).toHaveLength(1);
    expect(argv[i + 1]).toBe(attDir(id));
    expect(argv[i + 2].startsWith('-')).toBe(true);
  }
  expect(fs.statSync(attDir(a.id)).isDirectory()).toBe(true);
  expect(fs.statSync(attDir(b.id)).isDirectory()).toBe(true);
});

// ── 파일 첨부(서버 방) — ssh stdin 으로 올림 · --add-dir · 지울 때 정리 ──
describe('서버 방 첨부', () => {
  afterEach(async () => {
    await Promise.all(engines.map((x) => x.shutdown()));
    engines = [];
    const root = path.join(dir, 'srv');
    if (fs.existsSync(root)) {
      execFileSync(process.execPath, [FAKE_SSH, '--fake-reap'], { env: { ...process.env, FAKE_SSH_ROOT: root }, timeout: 20_000 });
    }
  });

  /** 서버 방 + 에이전트 web(/home/a/web) · 서버 첨부 폴더(이 PC 쪽 경로) · 가짜 ssh 기록의 그 사건만 */
  async function attachRoom(env: Record<string, string> = {}, extra: Partial<EngineOptions> = {}) {
    const t = await startSsh(env, extra);
    const room = t.e.addRoom('서버 실험', { host: 'dev' });
    const web = t.e.addAgent({ roomId: room.id, name: 'web', role: '화면', folder: '/home/a/web' });
    const servedDir = (id = web.id) => path.join(t.root, 'home', 'a', '.dure', 'attachments', id);
    const served = (file: string, id = web.id) => path.join(servedDir(id), file);
    const servedFiles = (id = web.id) => (fs.existsSync(servedDir(id)) ? fs.readdirSync(servedDir(id)) : []);
    const ofKind = (k: string) => t.events().filter((x) => x.event === k);
    return { ...t, room, web, servedDir, served, servedFiles, ofKind };
  }
  const BYTES = Buffer.from([0, 1, 2, 13, 10, 255, 0xea, 0xb0, 0x80, 0x27, 0x24, 0x3b, 0x26, 0, 10]);
  const STOPPED = '서버로 올리는 중에 그만뒀어요';

  test('서버 방 첨부 — 올라간 바이트 같음·경로 줄은 서버 경로·이 PC 사본도 있음', async () => {
    const { e, root, web, calls, served } = await attachRoom();
    const src = original('보고서 최종.bin');
    fs.writeFileSync(src, BYTES);
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(src)]);
    await done;

    const [file] = attFiles(web.id);
    expect(file).toMatch(/^\d{8}-\d{6}-보고서 최종\.bin$/);
    expect(fs.readFileSync(path.join(attDir(web.id), file))).toEqual(BYTES); // 이 PC 사본(칩이 연다)
    expect(fs.readFileSync(served(file))).toEqual(BYTES); // 서버에 올라간 것 — 바이트 그대로
    expect(fs.readFileSync(src)).toEqual(BYTES); // 원본은 그대로
    // Claude 에게는 서버의 절대 경로(DURE_HOME 으로 안 것)
    const remotePath = `/home/a/.dure/attachments/${web.id}/${file}`;
    expect(userContents().at(-1)).toEqual([{ type: 'text', text: 'echo 첨부' }, { type: 'text', text: `\n\n첨부 파일:\n- ${remotePath}` }]);
    expect(e.history(web.id).find((x) => x.kind === 'user')).toEqual({
      t: expect.any(Number), kind: 'user', source: 'human',
      parts: [{ type: 'text', text: 'echo 첨부' }, { type: 'file', name: '보고서 최종.bin', bytes: BYTES.length, file, remotePath }],
    });
    // 올리기 ssh — 확인·정리와 같은 옵션(전달 없음·BatchMode·RemoteCommand=none), bash -c, 띄우기보다 먼저
    const kinds = calls().map((c) => c.kind);
    expect(kinds.filter((k) => k === 'upload')).toHaveLength(1);
    expect(kinds.indexOf('upload')).toBeLessThan(kinds.indexOf('launch'));
    const up = calls().find((c) => c.kind === 'upload');
    expect(up.argv).toEqual(expect.arrayContaining(['-T', '-o', 'BatchMode=yes', 'ClearAllForwardings=yes', 'RemoteCommand=none']));
    expect(up.argv).not.toContain('-R');
    expect(up.command).toMatch(/^bash -c '/);
    expect(up.script).toBe(uploadScript(web.id, file));
    // 서버 claude 는 서버 첨부 폴더를 미리 허용 — 스크립트가 "$HOME/…" 로 펼친다(가짜 ssh 가 이 PC 경로로 바꿔 넘긴다)
    const launch = calls().find((c) => c.kind === 'launch');
    expect(launch.script).toContain(`'--add-dir' "$HOME/.dure/attachments/${web.id}"`);
    expect(flagValue(lastSpawnOf('web').argv, '--add-dir')).toBe(path.join(root, 'home', 'a', '.dure', 'attachments', web.id));
  }, 30_000);

  test('서버 방 PDF — 문서 블록 + 서버 경로', async () => {
    const { e, web, served } = await attachRoom();
    const body = pdf(2);
    const src = original('서버 보고서.pdf', body);
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, [{ type: 'text', text: 'echo PDF' }, fileOf(src)]);
    await done;
    const [file] = attFiles(web.id);
    const remotePath = `/home/a/.dure/attachments/${web.id}/${file}`;
    // 서버 claude 에도 같은 문서 블록(stdin 으로 간다) + 서버 경로 줄 — 올리기는 그대로
    expect(userContents().at(-1)).toEqual([{ type: 'text', text: 'echo PDF' }, docOf(body), pathLines(remotePath)]);
    expect(fs.readFileSync(served(file))).toEqual(body);
    expect(e.history(web.id).find((x) => x.kind === 'user')).toEqual({
      t: expect.any(Number), kind: 'user', source: 'human',
      parts: [{ type: 'text', text: 'echo PDF' }, { type: 'file', name: '서버 보고서.pdf', bytes: body.length, file, remotePath }],
    });
    expect(fs.readFileSync(path.join(dataDir, 'history', `${web.id}.jsonl`), 'utf8')).not.toContain(body.toString('base64'));
  }, 30_000);

  test('큰 파일인데 서버가 stdin 을 안 읽고 끝남 — 사본 읽기 실패가 아니라 진짜 까닭 · 접속 실패면 서버를 지우러 가지 않는다', async () => {
    const big = Buffer.alloc(1024 * 1024, 7); // 300KB 넘게 — stdin 쓰기가 EPIPE 로 깨져 그것이 읽는 쪽으로 번지던 크기
    // 접속 못 함(서버 내려감)
    const a = await attachRoom();
    const src = original('큰.bin');
    fs.writeFileSync(src, big);
    a.mode('refused');
    await expect(a.e.sendUser(a.web.id, [fileOf(src)])).rejects.toThrow(`${ATTACH_FAIL}큰.bin: dev 에 접속하지 못했어요 — ssh: connect to host dev port 22: Connection refused`);
    await sleep(500);
    expect(a.ofKind('attachment-remove')).toEqual([]);
    a.mode(''); // 모드 파일은 이 시험 안에서 같이 쓴다
    // 서버 명령이 stdin 을 안 읽고 실패(mkdir 권한 없음) — 쉬운 까닭
    const b = await attachRoom({ FAKE_SSH_UPLOAD_EARLY: '1' });
    const err = (await b.e.sendUser(b.web.id, [fileOf(src)]).catch((x: Error) => x)) as Error;
    expect(err.message).toBe(`${ATTACH_FAIL}큰.bin: 서버 첨부 폴더에 쓸 권한이 없어요`);
    expect(b.ofKind('upload-early')).toHaveLength(1);
  }, 40_000);

  test('올리기 실패 — 끊김 글, 아무것도 안 보냄, 사본 되돌림', async () => {
    const { e, web, calls, mode, ofKind, served } = await attachRoom({ FAKE_SSH_UPLOAD_CODE: '255' });
    const src = original('x.txt', 'hello');
    const send = () => e.sendUser(web.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(src)]);
    // 서버가 내려가 있다 — 서버 문제 글(접속 실패 첫 줄)
    mode('refused');
    await expect(send()).rejects.toThrow(`${ATTACH_FAIL}x.txt: dev 에 접속하지 못했어요 — ssh: connect to host dev port 22: Connection refused`);
    expect(attFiles(web.id)).toEqual([]);
    // 올리다 끊김 — 끊김 글 · 반쯤 올라간 서버 파일도 되돌린다
    mode('');
    await expect(send()).rejects.toThrow(`${ATTACH_FAIL}x.txt: dev 연결이 끊겼어요 — 다시 보내면 이어서 해요`);
    expect(attFiles(web.id)).toEqual([]);
    const partial = ofKind('upload').at(-1);
    expect(partial).toMatchObject({ partial: true });
    await until('서버 파일 되돌림', () => ofKind('attachment-remove').length === 1, 10_000);
    expect(ofKind('attachment-remove')[0]).toMatchObject({ agentId: web.id, files: [partial.file], removed: [partial.file] });
    expect(fs.existsSync(served(partial.file))).toBe(false);
    // 아무것도 안 보냈다 — 띄우지 않았고 기록·기다리는 줄·붙잡기 없음 · 서버 문제 띠도 세우지 않는다(입력창의 글이 알린다)
    expect(calls().filter((c) => c.kind === 'launch')).toEqual([]);
    expect(e.history(web.id)).toEqual([]);
    expect(e.heldInput(web.id)).toBe(0);
    expect(e.hold(web.id)).toBeNull();
    expect(e.status(web.id)).toBe('idle');
    expect(e.remoteIssue(web.id)).toBeNull();
    // 접속도 못 한 첫 번은 쓴 것이 없어 지우러 가지 않았다
    expect(calls().filter((c) => c.kind === 'attachment-remove')).toHaveLength(1);
    expect(fs.readFileSync(src, 'utf8')).toBe('hello');
  }, 30_000);

  test('두 번째 파일 실패 — 이미 올린 첫 파일도 서버에서 지운다', async () => {
    const { e, web, calls, ofKind, servedFiles } = await attachRoom();
    const one = original('하나.txt', '1');
    const gone = path.join(dir, 'originals', '둘.txt');
    await expect(e.sendUser(web.id, [fileOf(one), { type: 'file', path: gone, name: '둘.txt', bytes: 1 }])).rejects.toThrow(`${ATTACH_FAIL}둘.txt: 찾을 수 없어요`);
    expect(ofKind('upload')).toHaveLength(1);
    expect(attFiles(web.id)).toEqual([]);
    await until('서버 파일 되돌림', () => servedFiles().length === 0, 10_000);
    expect(ofKind('attachment-remove')).toHaveLength(1);
    expect(calls().filter((c) => c.kind === 'launch')).toEqual([]);
  }, 30_000);

  test('서버 방 에이전트 지우기 — 첨부 정리 스크립트', async () => {
    const { e, root, room, web, calls, mode, ofKind, servedDir, servedFiles } = await attachRoom();
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, [{ type: 'text', text: 'echo' }, fileOf(original('x.txt'))]);
    await done;
    expect(servedFiles()).toHaveLength(1);
    await e.removeAgent(web.id);
    await until('서버 첨부 정리', () => ofKind('attachments-cleanup').length === 1, 10_000);
    expect(fs.existsSync(servedDir())).toBe(false);
    expect(fs.existsSync(attDir(web.id))).toBe(false);
    const c = calls().find((x) => x.kind === 'attachments-cleanup');
    expect(c.script).toBe(attachmentsCleanupScript(web.id));
    expect(c.command).toMatch(/^bash -c '/);
    expect(c.argv).toEqual(expect.arrayContaining(['BatchMode=yes', 'ClearAllForwardings=yes']));
    // 서버가 내려가 있으면 — 한 번 해 보고 기록만(engine-error, 남는 건 그 사용자만 읽는 파일), 지우기는 끝난다
    fs.mkdirSync(path.join(root, 'home', 'a', 'api'), { recursive: true });
    const api = e.addAgent({ roomId: room.id, name: 'api', role: '서버', folder: '/home/a/api' });
    const errs: { agentId: string | null; message: string }[] = [];
    e.on('engine-error', (x: { agentId: string | null; message: string }) => errs.push(x));
    mode('refused');
    await e.removeAgent(api.id);
    expect(e.agents().map((x) => x.id)).toEqual([]);
    await until('정리 실패 기록', () => errs.length > 0, 10_000);
    await sleep(300);
    expect(errs).toEqual([{ agentId: api.id, message: '서버의 첨부 폴더를 다 지우지 못했어요 — 두레를 다시 켜면 다시 지워요' }]);
    expect(calls().filter((x) => x.kind === 'attachments-cleanup')).toHaveLength(2); // 지금은 다시 하지 않는다(다음에 켤 때 — 기다리는 정리)
    // 지워진 web 은 목록에서 빠졌고, 못 지운 api 만 남았다
    expect(openStore(dataDir).pendingAttachmentCleanups()).toEqual([{ host: 'dev', agentId: api.id }]);
  }, 40_000);

  test('위험한 이름 — 사본 이름·서버 스크립트', async () => {
    const { e, web, calls, served } = await attachRoom();
    // 공백·작은따옴표·$·;·& — 윈도에서 쓸 수 있는 글자 그대로(review focus 1). 화면이 준 이름의 금지 글자(")는 _ 로
    const src = original(`a b'$;&.txt`, '위험한 이름');
    const other = original('보통.txt', '보통');
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, [{ type: 'text', text: 'echo' }, fileOf(src), fileOf(other, `q"$(touch pwned).txt`)]);
    await done;
    const files = attFiles(web.id).sort();
    expect(files).toHaveLength(2);
    const odd = files.find((f) => f.endsWith(`a b'$;&.txt`))!;
    const quoted = files.find((f) => f.endsWith('pwned).txt'))!;
    expect(odd).toMatch(/^\d{8}-\d{6}-a b'\$;&\.txt$/);
    expect(quoted).toMatch(/^\d{8}-\d{6}-q_\$\(touch pwned\)\.txt$/);
    // 서버 파일은 그 이름 그대로 — 가짜 ssh 는 remote.ts 의 모양을 글자 하나까지 알아본다(따옴표가 깨져 명령이 끼어들면 모르는 모양 2)
    expect(fs.readFileSync(served(odd), 'utf8')).toBe('위험한 이름');
    expect(fs.readFileSync(served(quoted), 'utf8')).toBe('보통');
    const ups = calls().filter((c) => c.kind === 'upload');
    expect(ups.map((c) => c.script).sort()).toEqual([uploadScript(web.id, odd), uploadScript(web.id, quoted)].sort());
    expect(calls().some((c) => c.kind === 'unknown')).toBe(false);
    // 경로 줄은 서버의 실제 경로 그대로(따옴표 없이)
    const base = `/home/a/.dure/attachments/${web.id}`;
    expect(userContents().at(-1)).toEqual([{ type: 'text', text: 'echo' }, { type: 'text', text: `\n\n첨부 파일:\n- ${base}/${odd}\n- ${base}/${quoted}` }]);
  }, 30_000);

  test('서버 방 — 붙잡은 첨부 입력을 버리면 서버 파일도 지운다', async () => {
    const { e, web, ofKind, servedFiles } = await attachRoom();
    await slowTurn(e, web.id);
    await e.sendUser(web.id, text('/대기')); // 줄에 서는 입력 — 뒤의 첨부도 줄에 선다
    await e.sendUser(web.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(original('메모.txt'))]);
    expect(e.heldInput(web.id)).toBe(2);
    expect(servedFiles()).toHaveLength(1);
    await e.interrupt(web.id);
    expect(e.hold(web.id)?.items.map((x) => x.text)).toEqual(['/대기', 'echo 첨부']);
    e.dropHold(web.id);
    expect(attFiles(web.id)).toEqual([]);
    await until('서버 파일 되돌림', () => servedFiles().length === 0, 10_000);
    expect(ofKind('attachment-remove')).toHaveLength(1);
  }, 30_000);

  test('올리는 중 멈춤 — ssh 끔·되돌림·다음 말은 감', async () => {
    const { e, web, calls, ofKind, servedFiles } = await attachRoom({ FAKE_SSH_UPLOAD_HOLD: '느린' });
    const sending = e.sendUser(web.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(original('먼저.txt')), fileOf(original('느린.txt'))]);
    const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}느린.txt: ${STOPPED}`);
    await until('느린 것을 올리는 중', () => ofKind('upload').some((x) => x.file.endsWith('느린.txt')), 10_000);
    expect(servedFiles()).toHaveLength(2);
    const upPid = calls().filter((c) => c.kind === 'upload').at(-1).sshPid;
    const t0 = Date.now();
    await e.interrupt(web.id);
    await failed;
    expect(Date.now() - t0).toBeLessThan(5000); // 가짜 올리기는 60초를 버틴다 — 멈춤이 그것을 기다리지 않았다
    expect(isAlive(upPid)).toBe(false); // ssh 를 껐다
    expect(attFiles(web.id)).toEqual([]); // 이 PC 사본 되돌림
    await until('서버 파일 되돌림', () => servedFiles().length === 0, 10_000); // 다 올린 것·멈춘 것 둘 다
    // 붙잡지 않았다 — 실패로 끝났다(입력창에 글·칩이 남는다)
    expect(e.hold(web.id)).toBeNull();
    expect(e.heldInput(web.id)).toBe(0);
    expect(e.history(web.id)).toEqual([]);
    // 다음 말은 그대로 간다
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 뒤'));
    expect(await resultText(done)).toBe('받음: echo 뒤');
    expect(userTexts()).toEqual(['echo 뒤']);
  }, 40_000);

  test('올리는 중 새 대화 — 그 입력은 새 대화로 안 감', async () => {
    const { e, web, calls, ofKind, servedFiles } = await attachRoom({ FAKE_SSH_UPLOAD_HOLD: '느린' });
    await talk(e, web.id, 'echo 하나');
    const sending = e.sendUser(web.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(original('느린.txt'))]);
    const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}느린.txt: ${STOPPED}`);
    await until('올리는 중', () => ofKind('upload').length === 1, 10_000);
    const upPid = calls().find((c) => c.kind === 'upload').sshPid;
    await e.newConversation(web.id);
    await failed;
    expect(isAlive(upPid)).toBe(false);
    await sleep(300);
    expect(userTexts()).toEqual(['echo 하나']); // 새 대화로 흘러가지 않았다
    expect(e.heldInput(web.id)).toBe(0);
    expect(e.hold(web.id)).toBeNull();
    expect(attFiles(web.id)).toEqual([]);
    await until('서버 파일 되돌림', () => servedFiles().length === 0, 10_000);
    const done = resultOf(e, web.id);
    await e.sendUser(web.id, text('echo 새'));
    expect(await resultText(done)).toBe('받음: echo 새');
  }, 40_000);

  test('올리기 시간 상한 — 넘으면 ssh 를 끄고 실패·되돌림', async () => {
    const { e, web, calls, servedFiles } = await attachRoom({ FAKE_SSH_UPLOAD_HOLD: '느린' }, { uploadTimeoutMs: 800 });
    await expect(e.sendUser(web.id, [fileOf(original('느린.txt'))])).rejects.toThrow(`${ATTACH_FAIL}느린.txt: 서버로 올리는 데 너무 오래 걸려 그만뒀어요`);
    expect(isAlive(calls().find((c) => c.kind === 'upload').sshPid)).toBe(false);
    expect(attFiles(web.id)).toEqual([]);
    await until('서버 파일 되돌림', () => servedFiles().length === 0, 10_000);
    expect(calls().filter((c) => c.kind === 'launch')).toEqual([]);
  }, 30_000);

  /** 그 에이전트의 다음 result — 서버 방은 띄우기·올리기가 있어 넉넉히 */
  const resultSoon = (e: Engine, id: string) => waitFor<AgentEvent>(e, 'agent-event', (x) => x.agentId === id && x.event.kind === 'result', 20_000);

  test('올리는 중엔 지난 대화로 돌아가지 않는다 — 다 올리면 지금 대화로 가고, 그 뒤엔 돌아갈 수 있다', async () => {
    const release = path.join(dir, 'upload-release');
    const { e, web, ofKind } = await attachRoom({
      CLAUDE_CONFIG_DIR: path.join(dir, 'srv-claude'), FAKE_TRANSCRIPTS: '1', FAKE_SSH_UPLOAD_HOLD: '느린', FAKE_SSH_UPLOAD_RELEASE: release,
    });
    await talk(e, web.id, 'echo 하나');
    const first = agentOf(e, web.id).sessionId;
    await e.newConversation(web.id);
    await talk(e, web.id, 'echo 둘');
    const second = agentOf(e, web.id).sessionId;
    const sending = e.sendUser(web.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(original('느린.txt'))]);
    await until('올리는 중', () => ofKind('upload').length === 1, 10_000);
    await expect(e.resumeConversation(web.id, first)).rejects.toThrow('보내는 중인 입력이 끝나면 돌아갈 수 있어요');
    expect(agentOf(e, web.id).sessionId).toBe(second);
    const done = resultSoon(e, web.id);
    fs.writeFileSync(release, ''); // 올리기를 끝낸다
    await sending;
    await done;
    // 지금 대화로 갔다 — 돌아간 대화로 흘러가지 않았다
    expect(agentOf(e, web.id).sessionId).toBe(second);
    expect(convUserTexts(e.history(web.id))).toEqual(['echo 둘', 'echo 첨부']);
    await e.resumeConversation(web.id, first);
    expect(agentOf(e, web.id).sessionId).toBe(first);
  }, 60_000);

  test('서버 줄(앞선 정리)을 기다리는 동안 멈춤 — 줄을 기다리지 않고 바로 실패', async () => {
    const { e, web, calls, ofKind } = await attachRoom({ FAKE_SSH_CLEANUP_MS: '8000' });
    await talk(e, web.id, 'echo 하나');
    await e.newConversation(web.id); // 세션을 내린다 — 그 띄우기 정리가 서버 줄에 선다(8초)
    await until('정리 중', () => calls().some((c) => c.kind === 'cleanup'), 10_000);
    const sending = e.sendUser(web.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(original('x.txt'))]);
    const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}x.txt: ${STOPPED}`);
    await until('사본', () => attFiles(web.id).length === 1);
    await sleep(200); // 올리기 전 — 서버 줄을 기다리는 중
    const t0 = Date.now();
    await e.interrupt(web.id);
    await failed;
    expect(Date.now() - t0).toBeLessThan(3000); // 정리는 8초 — 멈춤이 그것을 기다리지 않았다
    expect(ofKind('upload')).toEqual([]);
    expect(calls().filter((c) => c.kind === 'upload')).toEqual([]);
    expect(attFiles(web.id)).toEqual([]);
    expect(e.heldInput(web.id)).toBe(0);
    expect(e.hold(web.id)).toBeNull();
  }, 40_000);

  test('서버 명령 실패 — 쉬운 까닭(영어 원문·서버 경로 없이) · 반쯤 쓴 서버 파일은 지운다', async () => {
    const { e, web, ofKind, servedFiles } = await attachRoom({
      FAKE_SSH_UPLOAD_CODE: '1', FAKE_SSH_UPLOAD_ERR: 'bash: line 1: /home/a/.dure/attachments/ag/20261104-101010-x.txt: Disk quota exceeded',
    });
    const err = (await e.sendUser(web.id, [fileOf(original('x.txt'))]).catch((x: Error) => x)) as Error;
    expect(err.message).toBe(`${ATTACH_FAIL}x.txt: 서버에서 쓸 수 있는 자리를 다 썼어요`);
    expect(err.message).not.toMatch(/Disk|quota|\/home/);
    expect(attFiles(web.id)).toEqual([]);
    await until('서버 파일 되돌림', () => ofKind('attachment-remove').length === 1 && servedFiles().length === 0, 10_000);
  }, 30_000);

  test('ssh 를 못 띄움 — 그 까닭(코드만, 내 PC 경로 없이) · 서버를 지우러 가지 않는다', async () => {
    const notExe = path.join(dir, 'ssh-not-exe.txt');
    fs.writeFileSync(notExe, 'x');
    const { e, web } = await attachRoom({}, { ssh: { command: notExe } });
    const errs: unknown[] = [];
    e.on('engine-error', (x) => errs.push(x));
    const err = (await e.sendUser(web.id, [fileOf(original('x.txt'))]).catch((x: Error) => x)) as Error;
    expect(err.message).toMatch(/^파일을 보내지 못했어요 — x\.txt: ssh 를 실행하지 못했어요\([A-Z0-9_]+\)$/);
    expect(attFiles(web.id)).toEqual([]);
    await sleep(500);
    expect(errs).toEqual([]); // 지우기를 세웠다면 그 ssh 도 못 띄워 engine-error 가 났다
  }, 30_000);

  test('이 PC 사본을 못 읽음 — 그 까닭(코드만) · 앞부분이 갔을 수 있어 서버 파일도 지운다', async () => {
    const { e, web, ofKind, servedFiles } = await attachRoom();
    const errs: unknown[] = [];
    e.on('engine-error', (x) => errs.push(x));
    const real = fs.createReadStream;
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(((p: fs.PathLike, o?: any) => {
      if (!String(p).startsWith(attDir(web.id))) return real(p, o);
      const r = new Readable({ read() {} });
      setImmediate(() => r.destroy(Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(p)}'`), { code: 'EBUSY' })));
      return r;
    }) as any);
    let err: Error;
    try {
      err = (await e.sendUser(web.id, [fileOf(original('x.txt'))]).catch((x: Error) => x)) as Error;
    } finally {
      spy.mockRestore();
    }
    expect(err.message).toBe(`${ATTACH_FAIL}x.txt: 이 PC 사본을 읽지 못했어요(EBUSY)`);
    expect(attFiles(web.id)).toEqual([]);
    await until('서버 파일 되돌림', () => ofKind('attachment-remove').length === 1 && servedFiles().length === 0, 10_000);
    expect(errs).toEqual([]);
  }, 30_000);

  test('올리는 중 멈춤 — ssh 를 나무째 끈다(ProxyJump 처럼 자식이 같은 파이프를 쥐어도 바로 끝난다)', async () => {
    const { e, web, ofKind } = await attachRoom({ FAKE_SSH_UPLOAD_HOLD: '느린', FAKE_SSH_UPLOAD_PROXY: '1' });
    const sending = e.sendUser(web.id, [fileOf(original('느린.txt'))]);
    const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}느린.txt: ${STOPPED}`);
    await until('자식', () => ofKind('upload-proxy').length === 1, 10_000);
    const proxy = ofKind('upload-proxy')[0].pid;
    expect(isAlive(proxy)).toBe(true);
    const t0 = Date.now();
    await e.interrupt(web.id);
    await failed;
    expect(Date.now() - t0).toBeLessThan(5000); // 자식은 30초를 버틴다 — 그 파이프가 닫히기를 기다리지 않았다
    await until('자식도 꺼짐', () => !isAlive(proxy), 5000);
  }, 60_000);

  test('큰 파일(여러 조각) — 서버에 바이트 그대로', async () => {
    const { e, web, served } = await attachRoom();
    const big = Buffer.alloc(1024 * 1024 + 4097);
    for (let i = 0; i < big.length; i++) big[i] = (i * 131 + 17) & 0xff;
    big.set([0, 0x1a, 13, 10, 0, 13, 10, 0x1a], 65_536 - 4); // NUL·^Z·CRLF 가 조각(64KB) 경계에 걸치게
    const src = original('큰.bin');
    fs.writeFileSync(src, big);
    const done = resultSoon(e, web.id);
    await e.sendUser(web.id, [{ type: 'text', text: 'echo 큰 것' }, fileOf(src)]);
    await done;
    const [file] = attFiles(web.id);
    expect(fs.readFileSync(path.join(attDir(web.id), file)).equals(big)).toBe(true);
    expect(fs.readFileSync(served(file)).equals(big)).toBe(true);
  }, 40_000);

  test('올리는 중 에이전트 지우기 · 앱 끄기 — ssh 를 끄고 아무것도 안 보내며, 떠도는 거절이 없다', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { e, root, room, web, calls, ofKind, servedDir } = await attachRoom({ FAKE_SSH_UPLOAD_HOLD: '느린' });
      // 지우기
      const sending = e.sendUser(web.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(original('느린.txt'))]);
      const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}느린.txt: ${STOPPED}`);
      await until('올리는 중', () => ofKind('upload').length === 1, 10_000);
      const upPid = calls().find((c) => c.kind === 'upload').sshPid;
      await e.removeAgent(web.id);
      await failed;
      await until('ssh 꺼짐', () => !isAlive(upPid), 5000);
      expect(fs.existsSync(attDir(web.id))).toBe(false);
      await until('서버 첨부 폴더째', () => ofKind('attachments-cleanup').length === 1 && !fs.existsSync(servedDir(web.id)), 10_000);
      // 끄기
      fs.mkdirSync(path.join(root, 'home', 'a', 'api'), { recursive: true });
      const api = e.addAgent({ roomId: room.id, name: 'api', role: '서버', folder: '/home/a/api' });
      const sending2 = e.sendUser(api.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(original('느린둘.txt'))]);
      const failed2 = expect(sending2).rejects.toThrow(`${ATTACH_FAIL}느린둘.txt: ${STOPPED}`);
      await until('올리는 중', () => ofKind('upload').length === 2, 10_000);
      const upPid2 = calls().filter((c) => c.kind === 'upload').at(-1).sshPid;
      const t0 = Date.now();
      await e.shutdown();
      await failed2;
      expect(Date.now() - t0).toBeLessThan(5000);
      await until('ssh 꺼짐', () => !isAlive(upPid2), 5000);
      expect(attFiles(api.id)).toEqual([]);
      // 아무것도 안 보냈다
      expect(calls().filter((c) => c.kind === 'launch')).toEqual([]);
      expect(userTexts()).toEqual([]);
      await sleep(200);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 60_000);

  test('지운 에이전트의 서버 첨부 폴더를 못 지우면 기다리는 정리로 남겼다가 다음에 켤 때 지운다', async () => {
    const { e, web, mode, ofKind, servedDir, servedFiles } = await attachRoom();
    const done = resultSoon(e, web.id);
    await e.sendUser(web.id, [{ type: 'text', text: 'echo' }, fileOf(original('x.txt'))]);
    await done;
    expect(servedFiles()).toHaveLength(1);
    mode('refused');
    const errs: { agentId: string | null; message: string }[] = [];
    e.on('engine-error', (x: { agentId: string | null; message: string }) => errs.push(x));
    await e.removeAgent(web.id);
    const LEFT = '서버의 첨부 폴더를 다 지우지 못했어요 — 두레를 다시 켜면 다시 지워요';
    await until('정리 실패 기록', () => errs.some((x) => x.message === LEFT), 10_000);
    expect(openStore(dataDir).pendingAttachmentCleanups()).toEqual([{ host: 'dev', agentId: web.id }]);
    expect(fs.existsSync(servedDir())).toBe(true);
    await e.shutdown();
    engines = engines.filter((x) => x !== e);

    // 서버가 돌아왔다 — 켤 때 지우고 목록에서 뺀다
    mode('');
    const { calls } = await startSsh();
    await until('켤 때 정리', () => ofKind('attachments-cleanup').length === 1, 10_000);
    await until('목록 비움', () => openStore(dataDir).pendingAttachmentCleanups().length === 0, 5000);
    expect(fs.existsSync(servedDir())).toBe(false);
    expect(calls().find((c) => c.kind === 'attachments-cleanup').script).toBe(attachmentsCleanupScript(web.id));
  }, 60_000);
});

test('멈춤과 보내기 차례가 겹쳐도 붙잡기 순서는 보낸 순서 — 준비하던 첨부 보내기는 실패, 그 뒤에서 기다리던 말은 돌려받은 말 다음에', async () => {
  const e = await start();
  const { a } = setup(e);
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('echo 끼움')); // 차례 도중 끼운 말 — Claude 가 아직 안 읽었다(멈추면 claude 를 내려 돌려받는다)
  const src = original('메모.txt');
  const gate = holdStat(src);
  // claude 를 내리는 동안(stopRetracting 의 endSession)을 붙잡아 둔다 — 그사이 뒤에서 기다리던 말이 차례를 받게
  let release!: () => void;
  const stopGate = new Promise<void>((r) => (release = r));
  let stopReached = false;
  const realStop = ClaudeSession.prototype.stop;
  const stopSpy = vi.spyOn(ClaudeSession.prototype, 'stop').mockImplementation(async function (this: ClaudeSession, o?: { now?: boolean }) {
    stopReached = true;
    await stopGate;
    return realStop.call(this, o);
  });
  try {
    const sending = e.sendUser(a.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(src)]);
    const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}메모.txt: ${COPY_STOPPED}`);
    await until('준비 중', gate.reached);
    const behind = e.sendUser(a.id, text('echo 둘')); // 앞 보내기(첨부 준비)를 기다리는 말
    const stopping = e.interrupt(a.id);
    await until('내리는 중', () => stopReached);
    await failed;
    await sleep(150); // 기다리던 말이 붙잡힐 틈 — 돌려받는 끝을 기다리지 않으면 여기서 돌려받은 말보다 먼저 붙잡힌다
    release();
    await stopping;
    await behind;
  } finally {
    gate.open();
    gate.restore();
    stopSpy.mockRestore();
  }
  expect(e.hold(a.id)?.items.map((x) => x.text)).toEqual(['echo 끼움', 'echo 둘']);
  expect(attFiles(a.id)).toEqual([]);
});

test('보내는 중(느린 복사)엔 지난 대화로 돌아가지 않는다 — 복사가 끝나면 지금 대화로 가고, 그 뒤엔 돌아갈 수 있다', async () => {
  const { e } = await startConv();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  await e.newConversation(a.id);
  await talk(e, a.id, 'echo 둘');
  const s2 = agentOf(e, a.id).sessionId;
  const src = original('메모.txt');
  const gate = holdStat(src);
  try {
    const sending = e.sendUser(a.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(src)]);
    await until('준비 중', gate.reached);
    await expect(e.resumeConversation(a.id, s1)).rejects.toThrow('보내는 중인 입력이 끝나면 돌아갈 수 있어요');
    expect(agentOf(e, a.id).sessionId).toBe(s2);
    const done = resultOf(e, a.id);
    gate.open();
    await sending;
    await done;
  } finally {
    gate.restore();
  }
  expect(agentOf(e, a.id).sessionId).toBe(s2);
  expect(convUserTexts(e.history(a.id))).toEqual(['echo 둘', 'echo 첨부']);
  await e.resumeConversation(a.id, s1);
  expect(agentOf(e, a.id).sessionId).toBe(s1);
});

/** 원본 재기(fs.promises.stat)를 그 경로에서 붙잡아 둔다 — 첨부를 준비하는 도중(느린 원본)을 흉내. open() 하면 놓는다 */
function holdStat(target: string) {
  const real = fs.promises.stat.bind(fs.promises);
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let reached = false;
  const spy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike, o?: any) => {
    if (p === target) {
      reached = true;
      await gate;
    }
    return real(p, o);
  }) as any);
  return { open, reached: () => reached, restore: () => spy.mockRestore() };
}

test('보내기 차례 — 첨부를 준비하는 동안 온 말·/compact 는 그 뒤에(순서 그대로) · 준비하는 것이 없으면 다시 그 자리에서', async () => {
  const e = await start();
  const { a } = setup(e);
  const src = original('큰 파일.txt', '느린 원본');
  const gate = holdStat(src);
  let sends: Promise<void>[] = [];
  try {
    sends = [e.sendUser(a.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(src)])];
    await until('준비 중', gate.reached);
    sends.push(e.sendUser(a.id, text('echo 둘')), e.sendUser(a.id, text('/compact')));
    await sleep(150);
    expect(spawns()).toEqual([]); // 앞 보내기가 준비하는 동안 뒤 말은 앞질러 나가지 않는다
    expect(e.heldInput(a.id)).toBe(0);
    gate.open();
    await Promise.all(sends);
  } finally {
    gate.restore();
  }
  await until('셋 다 감', () => userTexts().length === 3);
  expect(userTexts().map((t) => t.split('\n')[0])).toEqual(['echo 첨부', 'echo 둘', '/compact']);
  await until('쉼', () => e.status(a.id) === 'idle');
  // 준비하는 보내기가 없으면 기다림 없이 — 부른 그 자리에서 줄에 선다(첨부 전과 같다)
  await slowTurn(e, a.id);
  void e.sendUser(a.id, text('/대기'));
  expect(e.heldInput(a.id)).toBe(1);
});

test('첨부를 준비하는 사이(느린 원본 재기) 멈추면 기다리지 않고 그 보내기는 실패 — 붙잡지 않고 사본도 안 남긴다 · 멈춘 뒤에 친 말은 그대로 나간다', async () => {
  const e = await start();
  const { a } = setup(e);
  const src = original('메모.txt', '멈춘 첨부');
  await slowTurn(e, a.id);
  const gate = holdStat(src);
  try {
    const sending = e.sendUser(a.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(src)]);
    const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}메모.txt: ${COPY_STOPPED}`);
    await until('준비 중', gate.reached);
    await e.interrupt(a.id);
    await failed; // 붙잡힌 재기가 끝나길 기다리지 않았다
  } finally {
    gate.open();
    gate.restore();
  }
  expect(e.hold(a.id)).toBeNull();
  expect(e.heldInput(a.id)).toBe(0);
  await until('쉼', () => e.status(a.id) === 'idle');
  await sleep(200);
  expect(attFiles(a.id)).toEqual([]);
  expect(userTexts()).toEqual(['SLOW']); // 멈춘 뒤에 나가지 않았다
  // 멈춘 뒤에 친 말은 붙잡기를 거치지 않는다
  await talk(e, a.id, 'echo 뒤');
  expect(userTexts()).toEqual(['SLOW', 'echo 뒤']);
});

/** 이 PC 첨부 준비를 멈춤·지우기·끄기로 끊었다 — 그 보내기의 까닭 */
const COPY_STOPPED = '복사하는 중에 그만뒀어요';

/**
 * 원본 읽기(fs.createReadStream)를 그 경로에서 붙잡는다 — 앞 조각만 내고 끝나지 않는다(온라인 전용 OneDrive·끊긴 공유 폴더 흉내).
 * finish() 하면 나머지를 내고 끝낸다
 */
function stuckRead(target: string, head = '앞 조각 ', rest = '뒤 조각') {
  const real = fs.createReadStream;
  let stream: Readable | null = null;
  const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(((p: fs.PathLike, o?: any) => {
    if (p !== target) return real(p, o);
    stream = new Readable({ read() {} });
    stream.push(head);
    return stream;
  }) as any);
  return {
    reading: () => stream !== null,
    finish: () => {
      stream?.push(rest);
      stream?.push(null);
    },
    restore: () => spy.mockRestore(),
  };
}

test('이 PC 복사 중 멈춤 — 끝나지 않는 원본도 기다리지 않고 실패·반쯤 쓴 사본 되돌림, 붙잡지 않는다 · 다음 말은 그대로', async () => {
  const e = await start();
  const { a } = setup(e);
  const src = original('큰 영상.mp4', '원본');
  const read = stuckRead(src);
  try {
    const sending = e.sendUser(a.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(original('먼저.txt')), fileOf(src)]);
    const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}큰 영상.mp4: ${COPY_STOPPED}`);
    await until('복사 중', () => read.reading() && attFiles(a.id).length === 2);
    const t0 = Date.now();
    await e.interrupt(a.id);
    await failed;
    expect(Date.now() - t0).toBeLessThan(2000); // 원본은 영영 안 끝난다 — 멈춤이 그것을 기다리지 않았다
  } finally {
    read.restore();
  }
  expect(attFiles(a.id)).toEqual([]); // 반쯤 쓴 것·다 만든 것 둘 다 되돌림
  expect(e.hold(a.id)).toBeNull(); // 붙잡지 않았다 — 실패로 끝났다(입력창에 글·칩이 남는다)
  expect(e.heldInput(a.id)).toBe(0);
  expect(e.history(a.id)).toEqual([]);
  expect(spawns()).toEqual([]);
  expect(fs.readFileSync(src, 'utf8')).toBe('원본');
  await talk(e, a.id, 'echo 뒤');
  expect(userTexts()).toEqual(['echo 뒤']);
});

test('이 PC 준비 상한(copyTimeoutMs) — 복사·원본 재기가 넘으면 실패·되돌림', async () => {
  const e = await start({}, false, { copyTimeoutMs: 300 });
  const { a } = setup(e);
  const src = original('느린.bin', '원본');
  const read = stuckRead(src);
  try {
    await expect(e.sendUser(a.id, [fileOf(src)])).rejects.toThrow(`${ATTACH_FAIL}느린.bin: 파일을 복사하는 데 너무 오래 걸려요`);
  } finally {
    read.restore();
  }
  expect(attFiles(a.id)).toEqual([]);
  // 원본 재기에서 붙잡혀도(끊긴 공유 폴더) 같은 상한
  const gate = holdStat(src);
  try {
    await expect(e.sendUser(a.id, [fileOf(src)])).rejects.toThrow(`${ATTACH_FAIL}느린.bin: 파일을 복사하는 데 너무 오래 걸려요`);
  } finally {
    gate.open();
    gate.restore();
  }
  expect(attFiles(a.id)).toEqual([]);
  expect(spawns()).toEqual([]);
  expect(e.hold(a.id)).toBeNull();
  // 상한 안이면 그대로 간다
  const done = resultOf(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 됨' }, fileOf(src)]);
  await done;
  expect(attFiles(a.id)).toHaveLength(1);
});

test('이 PC 복사 중 새 대화 — 복사는 끊지 않고, 마치면 그 입력은 새 대화로 간다(기다리던 입력과 같은 규칙)', async () => {
  const e = await start();
  const { a } = setup(e);
  await talk(e, a.id, 'echo 하나');
  const s1 = agentOf(e, a.id).sessionId;
  const src = original('메모.txt', '원본');
  const read = stuckRead(src, '앞 ', '뒤');
  try {
    const sending = e.sendUser(a.id, [{ type: 'text', text: 'echo 첨부' }, fileOf(src)]);
    await until('복사 중', () => read.reading() && attFiles(a.id).length === 1);
    await e.newConversation(a.id);
    await sleep(200);
    expect(attFiles(a.id)).toHaveLength(1); // 끊지 않았다
    const done = resultOf(e, a.id);
    read.finish();
    await sending;
    await done;
  } finally {
    read.restore();
  }
  const s2 = agentOf(e, a.id).sessionId;
  expect(s2).not.toBe(s1);
  expect(flagValue(lastSpawnOf('A').argv, '--session-id')).toBe(s2); // 새 대화의 세션이 받았다
  const [file] = attFiles(a.id);
  expect(fs.readFileSync(path.join(attDir(a.id), file), 'utf8')).toBe('앞 뒤');
  expect(userTexts()).toEqual(['echo 하나', `echo 첨부\n\n\n첨부 파일:\n- ${path.join(attDir(a.id), file)}`]);
});

test('이 PC 복사 중 앱 끄기 — 복사를 끊어 기다리지 않고, 떠도는 거절이 없다', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (r: unknown) => unhandled.push(r);
  process.on('unhandledRejection', onUnhandled);
  try {
    const e = await start();
    const { a } = setup(e);
    const src = original('큰.bin', '원본');
    const read = stuckRead(src);
    try {
      const sending = e.sendUser(a.id, [fileOf(src)]);
      const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}큰.bin: ${COPY_STOPPED}`);
      await until('복사 중', () => read.reading() && attFiles(a.id).length === 1);
      const t0 = Date.now();
      await e.shutdown();
      await failed;
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      read.restore();
    }
    expect(attFiles(a.id)).toEqual([]);
    expect(spawns()).toEqual([]);
    await sleep(100);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('붙잡은 내 입력을 버리면 그 첨부 사본도 지운다 — 돌려받은 말(이미 기록에 있다)의 사본은 둔다', async () => {
  const e = await start();
  const { a } = setup(e);
  // 기록에 남은 말 — 차례 도중 끼운 첨부를 Claude 가 안 읽은 채 멈추면 돌려받아 붙잡는다
  await slowTurn(e, a.id);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 끼움' }, fileOf(original('끼움.txt'))]);
  expect(e.heldInput(a.id)).toBe(0);
  const [mid] = attFiles(a.id);
  await e.interrupt(a.id);
  expect(e.hold(a.id)?.items.map((x) => x.text)).toEqual(['echo 끼움']);
  e.dropHold(a.id);
  expect(attFiles(a.id)).toEqual([mid]); // 기록의 칩이 그 사본을 쓴다
  expect(e.history(a.id).filter((x) => x.kind === 'user').at(-1)).toMatchObject({ parts: [{ type: 'text', text: 'echo 끼움' }, { type: 'file', file: mid }] });

  // 한 번도 안 간 말 — 줄에 섰다가 멈춰 붙잡힌 것
  await until('쉼', () => e.status(a.id) === 'idle');
  await slowTurn(e, a.id);
  await e.sendUser(a.id, text('/대기'));
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 하나' }, fileOf(original('하나.txt'))]);
  await e.sendUser(a.id, [{ type: 'text', text: 'echo 둘' }, fileOf(original('둘.txt'))]);
  await e.interrupt(a.id);
  expect(attFiles(a.id)).toHaveLength(3);
  const one = e.hold(a.id)!.items.find((x) => x.text === 'echo 하나')!;
  e.dropHoldItem(a.id, one.id);
  expect(attFiles(a.id).filter((f) => f.endsWith('하나.txt'))).toEqual([]);
  expect(attFiles(a.id)).toHaveLength(2);
  e.dropHold(a.id);
  expect(attFiles(a.id)).toEqual([mid]);
});

test('에이전트 지우기 — 첨부 폴더가 잠겨 못 지우면 쉬운 말로 알리고(경로 없이), 다시 켤 때 주인 없는 첨부 폴더를 지운다', async () => {
  const e1 = await start();
  const { a, b } = setup(e1);
  const done = resultOf(e1, a.id);
  await e1.sendUser(a.id, [{ type: 'text', text: 'echo' }, fileOf(original('x.txt'))]);
  await done;
  await talk(e1, b.id, 'echo b');
  const errs: { agentId: string | null; message: string }[] = [];
  e1.on('engine-error', (x: { agentId: string | null; message: string }) => errs.push(x));
  const realRm = fs.rmSync;
  // 다른 프로그램이 연 채 잠근 첨부 — 영어 오류에 내 PC 경로가 실려 온다
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
    if (p === attDir(a.id)) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${p}'`), { code: 'EBUSY' });
    return realRm(p, o);
  }) as any);
  try {
    await e1.removeAgent(a.id);
  } finally {
    spy.mockRestore();
  }
  expect(errs).toEqual([{ agentId: a.id, message: '첨부 폴더를 다 지우지 못했어요 — 두레를 다시 켜면 다시 지워요' }]);
  expect(e1.agents().map((x) => x.id)).toEqual([b.id]); // 지우기는 끝났다
  expect(fs.existsSync(attDir(a.id))).toBe(true);
  fs.mkdirSync(path.join(dataDir, 'attachments', '모양 틀림'));
  await e1.shutdown();

  const e2 = await start();
  await until('남은 첨부 폴더를 지움', () => !fs.existsSync(attDir(a.id)));
  expect(attFiles(b.id)).toEqual([]); // b 는 첨부가 없지만 폴더는 그대로(띄울 때 만든 것)
  expect(fs.existsSync(attDir(b.id))).toBe(true);
  expect(fs.existsSync(path.join(dataDir, 'attachments', '모양 틀림'))).toBe(true);
  expect(e2.agents().map((x) => x.id)).toEqual([b.id]);
});

test('켤 때 state.json 이 깨져 빈 상태로 시작했으면 첨부 폴더를 지우지 않는다 — .broken 을 되살리면 그 에이전트들의 첨부가 있어야 한다', async () => {
  const e1 = await start();
  const { a } = setup(e1);
  const done = resultOf(e1, a.id);
  await e1.sendUser(a.id, [{ type: 'text', text: 'echo' }, fileOf(original('x.txt'))]);
  await done;
  await e1.shutdown();
  const [file] = attFiles(a.id);
  const stateFile = path.join(dataDir, 'state.json');
  const good = fs.readFileSync(stateFile, 'utf8');
  fs.writeFileSync(stateFile, good.slice(0, 40)); // 쓰다 끊긴 꼴

  const e2 = await start();
  expect(e2.agents()).toEqual([]); // 빈 상태로 시작했다
  expect(fs.readdirSync(dataDir).filter((f) => f.startsWith('state.json.broken-'))).toHaveLength(1);
  await (e2 as any).pruning; // 켤 때의 정리가 끝날 때까지
  expect(attFiles(a.id)).toEqual([file]);
  await e2.shutdown();

  // 사용자가 되살리면(백업 등) 그대로 — 칩이 그 사본을 연다
  fs.writeFileSync(stateFile, good);
  const e3 = await start();
  await (e3 as any).pruning;
  expect(e3.attachmentPath(a.id, file)).toBe(path.join(attDir(a.id), file));
});

test('깨진 상태 파일이 남아 있으면 다음 시작에도 첨부를 지우지 않는다 — 이름을 되돌려 되살리면 옛 에이전트와 그 첨부가 그대로', async () => {
  const e1 = await start();
  const { a } = setup(e1);
  const done = resultOf(e1, a.id);
  await e1.sendUser(a.id, [{ type: 'text', text: 'echo' }, fileOf(original('x.txt'))]);
  await done;
  await e1.shutdown();
  const [file] = attFiles(a.id);
  const stateFile = path.join(dataDir, 'state.json');
  // 켤 때 잠깐 못 읽었다(백신·동기화 프로그램이 잡음 — EBUSY) → 내용은 멀쩡한 채 state.json.broken-<시각> 으로 옮기고 빈 상태로 시작한다
  const realRead = fs.readFileSync;
  const busy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: any) => {
    if (p === stateFile) throw Object.assign(new Error('EBUSY: 가짜'), { code: 'EBUSY' });
    return realRead(p, o);
  }) as typeof fs.readFileSync);
  let e2: Engine;
  try {
    e2 = await start();
  } finally {
    busy.mockRestore();
  }
  expect(e2.agents()).toEqual([]);

  // 그 판에 에이전트를 새로 만들면 새 state.json 이 생긴다 — 다음 판은 깨짐에서 되살린 판이 아니다
  const fresh = setup(e2).a;
  const sent = resultOf(e2, fresh.id);
  await e2.sendUser(fresh.id, [{ type: 'text', text: 'echo' }, fileOf(original('y.txt'))]);
  await sent;
  await (e2 as any).pruning;
  await e2.shutdown();
  const broken = fs.readdirSync(dataDir).filter((f) => f.startsWith('state.json.broken-'));
  expect(broken).toHaveLength(1);

  // .broken-* 가 남아 있는 동안은 주인 없는 첨부 폴더도 지우지 않는다(사용자가 되살릴 수 있다)
  const e3 = await start();
  expect(e3.agents().map((x) => x.id)).toContain(fresh.id); // 보통 판 — 옛 에이전트(a)는 가게에 없다
  expect(e3.agents().map((x) => x.id)).not.toContain(a.id);
  await (e3 as any).pruning;
  expect(attFiles(a.id)).toEqual([file]);
  await e3.shutdown();

  // 사용자가 옮겨 둔 것을 되살리면(state.json 으로 이름을 되돌림) 옛 에이전트와 그 첨부가 그대로 — 칩이 그 사본을 연다
  fs.renameSync(path.join(dataDir, broken[0]), stateFile);
  // 이름 꼴이 다른 파일(사용자가 이름을 바꿈 등)은 치지 않는다 — 옮겨 둔 것이 없으니 다시 주인 없는 폴더를 지운다(그 판의 갈래 fresh)
  fs.writeFileSync(path.join(dataDir, `${broken[0]}.bak`), '{');
  const e4 = await start();
  expect(e4.agents().map((x) => x.id)).toContain(a.id);
  expect(e4.agents().map((x) => x.id)).not.toContain(fresh.id);
  await (e4 as any).pruning;
  expect(attFiles(a.id)).toEqual([file]);
  expect(e4.attachmentPath(a.id, file)).toBe(path.join(attDir(a.id), file));
  expect(fs.existsSync(attDir(fresh.id))).toBe(false);
});

test('자격 증명 파일은 다른 이름으로도 보내지 않는다 — 대체 데이터 스트림(:)·짧은 이름(8.3)', async () => {
  const e = await start();
  const { a } = setup(e);
  const cred = original('.credentials.json', '{}'); // 시험 폴더의 가짜 파일
  // 스트림 이름을 붙이면 이름 검사를 비껴가고 stat·복사는 된다 — 드라이브 글자 뒤의 ':' 는 거절
  await expect(e.sendUser(a.id, [{ type: 'file', path: `${cred}::$DATA`, name: 'notes.txt', bytes: 2 }])).rejects.toThrow(
    `${ATTACH_FAIL}notes.txt: 파일 경로가 올바르지 않아요`,
  );
  await expect(e.sendUser(a.id, [{ type: 'file', path: `${original('보통.txt')}:숨은`, name: '보통.txt', bytes: 2 }])).rejects.toThrow(
    `${ATTACH_FAIL}보통.txt: 파일 경로가 올바르지 않아요`,
  );
  // 짧은 이름(CREDEN~1.JSO)·링크 — 진짜 경로의 이름으로 다시 본다. 짧은 이름은 볼륨 설정에 따라 안 생겨 realpath 를 흉내
  const short = original('CREDEN~1.JSO', '{}');
  const real = fs.promises.realpath.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'realpath').mockImplementation((async (p: fs.PathLike, o?: any) => (p === short ? cred.toUpperCase() : real(p, o))) as any);
  try {
    await expect(e.sendUser(a.id, [fileOf(short)])).rejects.toThrow(`${ATTACH_FAIL}CREDEN~1.JSO: 자격 증명 파일은 보낼 수 없어요`);
    expect(spy).toHaveBeenCalledWith(short);
  } finally {
    spy.mockRestore();
  }
  expect(spawns()).toEqual([]);
  expect(attFiles(a.id)).toEqual([]);
  expect(e.history(a.id)).toEqual([]);
});

test('진짜 경로를 못 푸는 볼륨 — 이름 검사만으로 보낸다 · 모르는 오류는 원문 대신 코드만', async () => {
  const e = await start();
  const { a } = setup(e);
  const odd = original('램디스크.txt', 'ram');
  const gone = path.join(path.dirname(odd), '없는 곳', 'x.txt');
  const real = fs.promises.realpath.bind(fs.promises);
  const realStat = fs.promises.stat.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'realpath').mockImplementation((async (p: fs.PathLike, o?: any) => {
    if (p === odd || p === gone) throw Object.assign(new Error(`EINVAL: invalid argument, realpath '${String(p)}'`), { code: 'EINVAL' });
    return real(p, o);
  }) as any);
  const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike, o?: any) => {
    if (p === gone) throw Object.assign(new Error(`EIO: i/o error, stat '${String(p)}'`), { code: 'EIO' });
    return realStat(p, o);
  }) as any);
  try {
    const done = resultOf(e, a.id);
    await e.sendUser(a.id, [{ type: 'text', text: 'echo 램' }, fileOf(odd)]);
    await done;
    expect(attFiles(a.id)).toHaveLength(1);
    await expect(e.sendUser(a.id, [{ type: 'file', path: gone, name: 'x.txt', bytes: 1 }])).rejects.toThrow(`${ATTACH_FAIL}x.txt: 읽을 수 없어요(EIO)`);
  } finally {
    spy.mockRestore();
    statSpy.mockRestore();
  }
});

test('준비하는 사이 에이전트를 지우면 준비를 끊고 아무것도 안 보내며, 사본·첨부 폴더도 남기지 않는다', async () => {
  const e = await start();
  const { a } = setup(e);
  const src = original('x.txt');
  const gate = holdStat(src);
  try {
    const sending = e.sendUser(a.id, [{ type: 'text', text: 'echo' }, fileOf(src)]);
    const failed = expect(sending).rejects.toThrow(`${ATTACH_FAIL}x.txt: ${COPY_STOPPED}`);
    await until('준비 중', gate.reached);
    await e.removeAgent(a.id);
    await failed; // 붙잡힌 재기를 기다리지 않았다
    gate.open(); // 이제 재기가 끝난다 — 끊긴 준비는 복사하지 않는다(첨부 폴더를 다시 만들지 않는다)
    await sleep(100);
  } finally {
    gate.restore();
  }
  expect(fs.existsSync(attDir(a.id))).toBe(false);
  expect(spawns()).toEqual([]);
  expect(fs.readFileSync(src, 'utf8')).toBe('첨부 내용');
});

test('잰 뒤 복사하는 사이 원본이 100MB 를 넘게 커지면 — 사본을 다시 재서 거절', async () => {
  const e = await start();
  const { a } = setup(e);
  const src = original('자라는.log', 'x');
  const real = fs.promises.stat.bind(fs.promises);
  // 사본(첨부 폴더 안)은 잰 뒤 커진 원본을 복사한 것처럼
  const spy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike, o?: any) => {
    const st = await real(p, o);
    return String(p).startsWith(attDir(a.id)) ? Object.assign(st, { size: ATTACH_MAX_BYTES + 1 }) : st;
  }) as any);
  try {
    await expect(e.sendUser(a.id, [fileOf(src)])).rejects.toThrow(`${ATTACH_FAIL}자라는.log: 100MB 보다 큰 파일은 보낼 수 없어요`);
  } finally {
    spy.mockRestore();
  }
  expect(attFiles(a.id)).toEqual([]);
  expect(spawns()).toEqual([]);
});

test('첨부 폴더 --add-dir — 갈래의 첫 실행 · 권한 모드 때문에 다시 띄울 때도', async () => {
  const { e } = await startConv();
  const { a, s1 } = await pastOfA(e);
  const made = await e.forkAgent({ from: a.id, key: s1, name: 'A 2', role: '기획' });
  await talk(e, made.id, 'echo 둘');
  const fork = lastSpawnOf('A 2').argv;
  expect(fork).toContain('--fork-session');
  expect(flagValue(fork, '--add-dir')).toBe(attDir(made.id));
  // 옵션 없이 뜬 세션에서 묻지 않음을 켜면 옵션을 붙여 다시 띄운다(--resume)
  await talk(e, a.id, 'echo 셋');
  const before = spawnsOf('A').length;
  await e.setAllowBypass(true);
  await e.setBypass(a.id, true);
  expect(spawnsOf('A')).toHaveLength(before + 1);
  const restarted = lastSpawnOf('A').argv;
  expect(restarted).toContain(ALLOW_FLAG);
  expect(restarted).toContain('--resume');
  expect(flagValue(restarted, '--add-dir')).toBe(attDir(a.id));
});
