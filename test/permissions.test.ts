import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, type Store } from '../src/engine/store';
import { DENY_DEFAULT, Permissions } from '../src/engine/permissions';
import type { PendingRequest } from '../src/engine/types';

let dir: string;
let store: Store;
let perms: Permissions;
let a1: string;
let a2: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-'));
  store = openStore(dir);
  const r = store.addRoom('R');
  a1 = store.addAgent({ roomId: r.id, name: 'a', role: 'r', folder: dir }).id;
  a2 = store.addAgent({ roomId: r.id, name: 'b', role: 'r', folder: dir }).id;
  perms = new Permissions(store);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const lastPending = () => perms.pending().at(-1)!;

test('항상 허용 목록에 있으면 바로 allow(updatedInput = input), request 이벤트 없음', async () => {
  store.updateAgent(a1, { alwaysAllow: ['Bash'] });
  const events: PendingRequest[] = [];
  perms.on('request', (r) => events.push(r));
  const input = { command: 'ls' };
  const res = await perms.request(a1, { tool_name: 'Bash', input, tool_use_id: 't1' });
  expect(res).toEqual({ behavior: 'allow', updatedInput: input });
  expect(events).toEqual([]);
  expect(perms.pending()).toEqual([]);
});

test('없으면 대기 → answer allow → allow', async () => {
  const events: PendingRequest[] = [];
  const resolved: unknown[] = [];
  perms.on('request', (r) => events.push(r));
  perms.on('resolved', (r) => resolved.push(r));
  const input = { command: 'ls' };
  const p = perms.request(a1, { tool_name: 'Bash', input, tool_use_id: 't1' });
  expect(perms.pending()).toHaveLength(1);
  const req = lastPending();
  expect(req).toMatchObject({ agentId: a1, toolName: 'Bash', input, toolUseId: 't1', kind: 'permission' });
  expect(typeof req.createdAt).toBe('number');
  expect(events).toEqual([req]);
  perms.answer(req.id, { type: 'allow' });
  expect(await p).toEqual({ behavior: 'allow', updatedInput: input });
  expect(perms.pending()).toEqual([]);
  expect(resolved).toEqual([{ id: req.id, agentId: a1 }]);
});

test('allow-always → allow + store 의 alwaysAllow 에 도구 이름 추가(중복 없이) · 더했을 때만 always-allow 사건', async () => {
  const always: unknown[] = [];
  perms.on('always-allow', (p) => always.push(p));
  const p1 = perms.request(a1, { tool_name: 'Bash', input: {} });
  perms.answer(lastPending().id, { type: 'allow-always' });
  expect((await p1).behavior).toBe('allow');
  expect(store.agent(a1)!.alwaysAllow).toEqual(['Bash']);
  expect(always).toEqual([{ agentId: a1, alwaysAllow: ['Bash'] }]);
  // 대기 중에 이미 목록에 들어간 경우에도 중복 없이 — 목록이 그대로라 사건도 없다
  const p2 = perms.request(a2, { tool_name: 'Edit', input: {} });
  store.updateAgent(a2, { alwaysAllow: ['Edit'] });
  perms.answer(lastPending().id, { type: 'allow-always' });
  await p2;
  expect(store.agent(a2)!.alwaysAllow).toEqual(['Edit']);
  expect(always).toHaveLength(1);
  // 듣는 쪽이 던져도 답은 간다
  perms.removeAllListeners('always-allow');
  perms.on('always-allow', () => {
    throw new Error('듣는 쪽 오류');
  });
  const p3 = perms.request(a1, { tool_name: 'Write', input: {} });
  perms.answer(lastPending().id, { type: 'allow-always' });
  expect((await p3).behavior).toBe('allow');
  expect(store.agent(a1)!.alwaysAllow).toEqual(['Bash', 'Write']);
});

test('deny → message 기본값 DENY_DEFAULT, 지정하면 그 글', async () => {
  const p1 = perms.request(a1, { tool_name: 'Bash', input: {} });
  perms.answer(lastPending().id, { type: 'deny' });
  expect(await p1).toEqual({ behavior: 'deny', message: DENY_DEFAULT });
  const p2 = perms.request(a1, { tool_name: 'Bash', input: {} });
  perms.answer(lastPending().id, { type: 'deny', message: '안 돼요' });
  expect(await p2).toEqual({ behavior: 'deny', message: '안 돼요' });
});

test('AskUserQuestion 은 kind question, 항상 허용 목록에 있어도 묻는다', async () => {
  store.updateAgent(a1, { alwaysAllow: ['AskUserQuestion'] });
  const p = perms.request(a1, { tool_name: 'AskUserQuestion', input: { questions: [] }, tool_use_id: 'q1' });
  expect(perms.pending()).toHaveLength(1);
  expect(lastPending().kind).toBe('question');
  perms.answer(lastPending().id, { type: 'deny' });
  await p;
});

test('answer type answer → {behavior:allow, updatedInput:{...input, answers}}', async () => {
  const input = { questions: [{ question: '무엇?', header: 'h', options: [{ label: '가', description: 'd' }], multiSelect: false }] };
  const p = perms.request(a1, { tool_name: 'AskUserQuestion', input });
  perms.answer(lastPending().id, { type: 'answer', answers: { '무엇?': '가' } });
  expect(await p).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { '무엇?': '가' } } });
});

test('종류가 안 맞는 결정은 throw 하고 요청은 대기 그대로', async () => {
  const p1 = perms.request(a1, { tool_name: 'Bash', input: {} });
  const id1 = lastPending().id;
  expect(() => perms.answer(id1, { type: 'answer', answers: {} })).toThrow();
  expect(perms.pending()).toHaveLength(1);
  perms.answer(id1, { type: 'deny' });
  await p1;
  const p2 = perms.request(a1, { tool_name: 'AskUserQuestion', input: {} });
  const id2 = lastPending().id;
  expect(() => perms.answer(id2, { type: 'allow' })).toThrow();
  expect(() => perms.answer(id2, { type: 'allow-always' })).toThrow();
  expect(perms.pending()).toHaveLength(1);
  perms.answer(id2, { type: 'deny' });
  await p2;
});

test('cancelForAgent → 그 에이전트 대기만 deny(message), 다른 에이전트는 그대로', async () => {
  const resolved: unknown[] = [];
  const p1 = perms.request(a1, { tool_name: 'Bash', input: {} });
  const p2 = perms.request(a2, { tool_name: 'Bash', input: {} });
  const id1 = perms.pending(a1)[0].id;
  perms.on('resolved', (r) => resolved.push(r));
  perms.cancelForAgent(a1, '중단됨');
  expect(await p1).toEqual({ behavior: 'deny', message: '중단됨' });
  expect(resolved).toEqual([{ id: id1, agentId: a1 }]);
  expect(perms.pending()).toHaveLength(1);
  expect(perms.pending(a2)).toHaveLength(1);
  perms.answer(perms.pending(a2)[0].id, { type: 'allow' });
  expect((await p2).behavior).toBe('allow');
});

test('fromSubagent: 서브에이전트가 물은 요청엔 fromSubagent true — 아니면 칸이 없다', async () => {
  const p1 = perms.request(a1, { tool_name: 'Write', input: {}, tool_use_id: 's1' }, undefined, { fromSubagent: true });
  const p2 = perms.request(a1, { tool_name: 'Edit', input: {}, tool_use_id: 'p1' }, undefined, { fromSubagent: false });
  const p3 = perms.request(a1, { tool_name: 'Bash', input: {} });
  const [sub, parent, plain] = perms.pending(a1);
  expect(sub).toMatchObject({ toolName: 'Write', fromSubagent: true });
  expect(parent).not.toHaveProperty('fromSubagent');
  expect(plain).not.toHaveProperty('fromSubagent');
  for (const r of perms.pending(a1)) perms.answer(r.id, { type: 'deny' });
  await Promise.all([p1, p2, p3]);
});

test('cancelForAgent keep — keep 이 true 인 요청은 남기고 나머지만 deny', async () => {
  const resolved: unknown[] = [];
  const pSub = perms.request(a1, { tool_name: 'Write', input: {}, tool_use_id: 's1' }, undefined, { fromSubagent: true });
  const pParent = perms.request(a1, { tool_name: 'Edit', input: {}, tool_use_id: 'p1' });
  const [sub, parent] = perms.pending(a1);
  perms.on('resolved', (r) => resolved.push(r));
  const seen: PendingRequest[] = [];
  perms.cancelForAgent(a1, '차례 끝', (r) => {
    seen.push(r);
    return !!r.fromSubagent;
  });
  expect(await pParent).toEqual({ behavior: 'deny', message: '차례 끝' });
  expect(resolved).toEqual([{ id: parent.id, agentId: a1 }]);
  expect(seen.map((r) => r.id).sort()).toEqual([sub.id, parent.id].sort());
  expect(perms.pending(a1).map((r) => r.id)).toEqual([sub.id]);
  // keep 없이 부르면 지금처럼 모두
  perms.cancelForAgent(a1, '종료');
  expect(await pSub).toEqual({ behavior: 'deny', message: '종료' });
  expect(perms.pending()).toEqual([]);
});

test('wasAsked: 물어본 toolUseId 만 true', async () => {
  store.updateAgent(a1, { alwaysAllow: ['Read'] });
  await perms.request(a1, { tool_name: 'Read', input: {}, tool_use_id: 'auto' });
  const p = perms.request(a1, { tool_name: 'Bash', input: {}, tool_use_id: 'asked' });
  expect(perms.wasAsked(a1, 'asked')).toBe(true);
  perms.answer(lastPending().id, { type: 'allow' });
  await p;
  expect(perms.wasAsked(a1, 'asked')).toBe(true);
  expect(perms.wasAsked(a1, 'auto')).toBe(false);
  expect(perms.wasAsked(a2, 'asked')).toBe(false);
});

test('없는 requestId answer → throw', () => {
  expect(() => perms.answer('nope', { type: 'allow' })).toThrow();
});

test('request 듣는 쪽이 던져도 요청은 대기로 남아 답할 수 있다 — request() 는 던지지 않는다', async () => {
  perms.on('request', () => {
    throw new Error('듣는 쪽 고장');
  });
  let p!: Promise<unknown>;
  expect(() => {
    p = perms.request(a1, { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' });
  }).not.toThrow();
  expect(perms.pending()).toHaveLength(1);
  perms.answer(lastPending().id, { type: 'allow' });
  expect(await p).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  expect(perms.pending()).toEqual([]);
});

test('signal abort(부른 쪽이 끊김) → 대기에서 빠지고 deny 요청이 취소되었습니다, resolved 이벤트', async () => {
  const resolved: unknown[] = [];
  perms.on('resolved', (r) => resolved.push(r));
  const ac = new AbortController();
  const p = perms.request(a1, { tool_name: 'Bash', input: {} }, ac.signal);
  const id = lastPending().id;
  ac.abort();
  expect(await p).toEqual({ behavior: 'deny', message: '요청이 취소되었습니다.' });
  expect(perms.pending()).toEqual([]);
  expect(resolved).toEqual([{ id, agentId: a1 }]);
  // 늦게 온 allow-always 는 항상 허용 목록을 늘리지 않는다
  expect(() => perms.answer(id, { type: 'allow-always' })).toThrow('대기 중인 요청이 없습니다');
  expect(store.agent(a1)!.alwaysAllow).toEqual([]);
});

test('이미 abort 된 signal → 대기·이벤트 없이 바로 deny', async () => {
  const events: unknown[] = [];
  perms.on('request', (r) => events.push(r));
  const ac = new AbortController();
  ac.abort();
  expect(await perms.request(a1, { tool_name: 'Bash', input: {} }, ac.signal)).toEqual({
    behavior: 'deny',
    message: '요청이 취소되었습니다.',
  });
  expect(events).toEqual([]);
  expect(perms.pending()).toEqual([]);
});

test('답한 뒤의 abort 는 아무 일도 하지 않는다', async () => {
  const resolved: unknown[] = [];
  perms.on('resolved', (r) => resolved.push(r));
  const ac = new AbortController();
  const p = perms.request(a1, { tool_name: 'Bash', input: {} }, ac.signal);
  perms.answer(lastPending().id, { type: 'allow' });
  ac.abort();
  expect((await p).behavior).toBe('allow');
  expect(resolved).toHaveLength(1);
});

test('없는 에이전트는 즉시 deny, 대기·이벤트 없음', async () => {
  const events: unknown[] = [];
  perms.on('request', (r) => events.push(r));
  expect(await perms.request('ghost', { tool_name: 'Bash', input: {} })).toEqual({
    behavior: 'deny',
    message: '에이전트를 찾을 수 없습니다.',
  });
  expect(events).toEqual([]);
  expect(perms.pending()).toEqual([]);
});

// ── 새 에이전트 만들기(create-agent) — 두레 도구 create_agent 의 승인 카드 ──
const MAKE = 'mcp__dure__create_agent';
const makeInput = { name: '테스트', role: '검사', folder: '/x', task: null };

test('create-agent: kind create-agent 로 대기 — 늘 허용 목록에 그 이름이 있어도 묻는다 · allow 면 입력 그대로 allow', async () => {
  store.updateAgent(a1, { alwaysAllow: [MAKE] }); // 손으로 고친 파일 등 — 그래도 묻는다
  const events: PendingRequest[] = [];
  perms.on('request', (r) => events.push(r));
  const p = perms.request(a1, { tool_name: MAKE, input: makeInput, tool_use_id: 'm1' }, undefined, { kind: 'create-agent' });
  expect(perms.pending()).toHaveLength(1);
  const req = lastPending();
  expect(req).toMatchObject({ agentId: a1, toolName: MAKE, input: makeInput, toolUseId: 'm1', kind: 'create-agent' });
  expect(req).not.toHaveProperty('fromSubagent');
  expect(events).toEqual([req]);
  expect(perms.wasAsked(a1, 'm1')).toBe(true);
  perms.answer(req.id, { type: 'allow' });
  expect(await p).toEqual({ behavior: 'allow', updatedInput: makeInput });
});

test('create-agent: allow-always·answer 는 던지고 요청은 대기 그대로 — 늘 허용 목록도 늘지 않는다', async () => {
  const p = perms.request(a1, { tool_name: MAKE, input: makeInput }, undefined, { kind: 'create-agent' });
  const id = lastPending().id;
  expect(() => perms.answer(id, { type: 'allow-always' })).toThrow('새 에이전트 만들기에는 allow 나 deny 로만 답할 수 있습니다.');
  expect(() => perms.answer(id, { type: 'answer', answers: {} })).toThrow('새 에이전트 만들기에는 allow 나 deny 로만 답할 수 있습니다.');
  expect(perms.pending()).toHaveLength(1);
  expect(store.agent(a1)!.alwaysAllow).toEqual([]);
  perms.answer(id, { type: 'deny' });
  await p;
});

test('create-agent: deny 기본 글은 새 에이전트 만들기를 거절했어요 — 지정하면 그 글 · 끊김·cancelForAgent 는 지금처럼', async () => {
  const p1 = perms.request(a1, { tool_name: MAKE, input: makeInput }, undefined, { kind: 'create-agent' });
  perms.answer(lastPending().id, { type: 'deny' });
  expect(await p1).toEqual({ behavior: 'deny', message: '사용자가 새 에이전트 만들기를 거절했어요.' });
  const p2 = perms.request(a1, { tool_name: MAKE, input: makeInput }, undefined, { kind: 'create-agent' });
  perms.answer(lastPending().id, { type: 'deny', message: '안 돼요' });
  expect(await p2).toEqual({ behavior: 'deny', message: '안 돼요' });
  const ac = new AbortController();
  const p3 = perms.request(a1, { tool_name: MAKE, input: makeInput }, ac.signal, { kind: 'create-agent' });
  ac.abort();
  expect(await p3).toEqual({ behavior: 'deny', message: '요청이 취소되었습니다.' });
  const p4 = perms.request(a1, { tool_name: MAKE, input: makeInput }, undefined, { kind: 'create-agent' });
  perms.cancelForAgent(a1, 'Claude 가 종료되었습니다.');
  expect(await p4).toEqual({ behavior: 'deny', message: 'Claude 가 종료되었습니다.' });
  expect(perms.pending()).toEqual([]);
});

test('ExitPlanMode 는 plan 종류 — 허용·거절만, 늘 묻는다', async () => {
  store.updateAgent(a1, { alwaysAllow: ['ExitPlanMode'] });
  expect(perms.allowsAlways(a1, 'ExitPlanMode')).toBe(false);
  const input = { plan: '# 계획\n1. 하나\n', planFilePath: '/tmp/plan.md' };
  const p = perms.request(a1, { tool_name: 'ExitPlanMode', input, tool_use_id: 'p1' });
  const id = lastPending().id;
  expect(lastPending().kind).toBe('plan');
  expect(() => perms.answer(id, { type: 'allow-always' })).toThrow('계획에는 진행이나 고쳐 달라고 하기로만 답할 수 있습니다.');
  expect(() => perms.answer(id, { type: 'answer', answers: {} })).toThrow('계획에는 진행이나 고쳐 달라고 하기로만 답할 수 있습니다.');
  expect(perms.pending()).toHaveLength(1);
  perms.answer(id, { type: 'allow' });
  expect(await p).toEqual({ behavior: 'allow', updatedInput: input });
});
