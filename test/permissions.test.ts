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

test('allow-always → allow + store 의 alwaysAllow 에 도구 이름 추가(중복 없이)', async () => {
  const p1 = perms.request(a1, { tool_name: 'Bash', input: {} });
  perms.answer(lastPending().id, { type: 'allow-always' });
  expect((await p1).behavior).toBe('allow');
  expect(store.agent(a1)!.alwaysAllow).toEqual(['Bash']);
  // 대기 중에 이미 목록에 들어간 경우에도 중복 없이
  const p2 = perms.request(a2, { tool_name: 'Edit', input: {} });
  store.updateAgent(a2, { alwaysAllow: ['Edit'] });
  perms.answer(lastPending().id, { type: 'allow-always' });
  await p2;
  expect(store.agent(a2)!.alwaysAllow).toEqual(['Edit']);
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
