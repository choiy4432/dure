import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, type Store } from '../src/engine/store';
import { openMessageLog, type MessageLog } from '../src/engine/messageLog';
import { Router, formatDelivery } from '../src/engine/router';
import type { Agent } from '../src/engine/types';

let dir: string;
let store: Store;
let log: MessageLog;
let deliver: Mock<(agentId: string, text: string, messageId: string) => void>;
let busy: Set<string>;
let router: Router;
let a: Agent;
let b: Agent;
let roomId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-'));
  store = openStore(dir);
  log = openMessageLog(dir);
  deliver = vi.fn<(agentId: string, text: string, messageId: string) => void>();
  busy = new Set();
  router = new Router({ store, log, deliver, isBusy: (id) => busy.has(id) });
  roomId = store.addRoom('방').id;
  a = store.addAgent({ roomId, name: 'Front', role: '화면', folder: dir });
  b = store.addAgent({ roomId, name: 'Backend', role: '서버', folder: dir });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const auto = (id: string) => store.updateAgent(id, { auto: true });

test('자동 꺼진 받는 쪽 → pending, deliver 안 함, 결과 글 확인 대기', () => {
  const r = router.send(a.id, 'Backend', 'x');
  expect(r).toBe('Backend 에게 보냈습니다. 사람이 확인하면 전달됩니다.');
  expect(deliver).not.toHaveBeenCalled();
  expect(log.list()[0].state).toBe('pending');
  expect(router.chain(roomId)).toBe(0);
});

test('자동 켜진 받는 쪽, 한가함 → deliver, delivered, 체인 1', () => {
  auto(b.id);
  const r = router.send(a.id, 'Backend', '안녕');
  expect(r).toBe('Backend 에게 전달했습니다.');
  expect(deliver).toHaveBeenCalledWith(b.id, formatDelivery(a, '안녕'), log.list()[0].id);
  expect(deliver.mock.calls[0][1]).toBe('[두레 메시지 — 보낸 쪽: Front(화면)]\n안녕');
  expect(log.list()[0].state).toBe('delivered');
  expect(router.chain(roomId)).toBe(1);
});

test('자동 켜짐인데 바쁨 → queued, onIdle 에 전달', () => {
  auto(b.id);
  busy.add(b.id);
  const r = router.send(a.id, 'Backend', 'x');
  expect(r).toBe('Backend 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
  expect(deliver).not.toHaveBeenCalled();
  expect(log.list()[0].state).toBe('queued');
  expect(router.chain(roomId)).toBe(1);
  busy.delete(b.id);
  router.onIdle(b.id);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(log.list()[0].state).toBe('delivered');
});

test('queued 가 둘이면 onIdle 마다 오래된 것부터 하나씩', () => {
  auto(b.id);
  busy.add(b.id);
  router.send(a.id, 'Backend', '첫째');
  router.send(a.id, 'Backend', '둘째');
  router.onIdle(b.id);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0][1]).toContain('첫째');
  expect(deliver.mock.calls[0][2]).toBe(log.list()[0].id);
  router.onIdle(b.id);
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(deliver.mock.calls[1][1]).toContain('둘째');
  expect(deliver.mock.calls[1][2]).toBe(log.list()[1].id);
});

test('자동 체인 3번 뒤 넷째는 held + held 이벤트, deliver 안 함', () => {
  auto(b.id);
  const held = vi.fn();
  router.on('held', held);
  for (let i = 0; i < 3; i++) router.send(a.id, 'Backend', `m${i}`);
  expect(deliver).toHaveBeenCalledTimes(3);
  const r = router.send(a.id, 'Backend', '넷째');
  expect(r).toBe('Backend 에게 보냈습니다. 자동 전달이 3번 이어져, 사람이 확인한 뒤 전달됩니다.');
  expect(deliver).toHaveBeenCalledTimes(3);
  expect(log.list({ states: ['held'] })).toHaveLength(1);
  expect(held).toHaveBeenCalledWith({ roomId });
});

test('continueHeld → 체인 0, held 전달', () => {
  auto(b.id);
  for (let i = 0; i < 4; i++) router.send(a.id, 'Backend', `m${i}`);
  router.continueHeld(roomId);
  expect(router.chain(roomId)).toBe(0);
  expect(deliver).toHaveBeenCalledTimes(4);
  expect(log.list({ states: ['held'] })).toHaveLength(0);
  expect(log.list().every((m) => m.state === 'delivered')).toBe(true);
});

test('humanInput → 체인 0 (다음 자동 전달 가능)', () => {
  auto(b.id);
  for (let i = 0; i < 3; i++) router.send(a.id, 'Backend', `m${i}`);
  router.humanInput(roomId);
  expect(router.chain(roomId)).toBe(0);
  expect(router.send(a.id, 'Backend', '또')).toBe('Backend 에게 전달했습니다.');
  expect(deliver).toHaveBeenCalledTimes(4);
});

test('approve(pending) → 전달 + 체인 0', () => {
  auto(b.id);
  for (let i = 0; i < 2; i++) router.send(a.id, 'Backend', `m${i}`);
  store.updateAgent(b.id, { auto: false });
  router.send(a.id, 'Backend', '확인용');
  expect(router.chain(roomId)).toBe(2);
  const p = log.list({ states: ['pending'] })[0];
  router.approve(p.id);
  expect(deliver).toHaveBeenCalledTimes(3);
  expect(deliver.mock.calls[2][1]).toContain('확인용');
  expect(log.get(p.id)!.state).toBe('delivered');
  expect(router.chain(roomId)).toBe(0);
  expect(() => router.approve(p.id)).toThrow('이미 처리된 메시지입니다.');
});

test('이름: 대소문자·앞뒤 공백 무시, 한글 이름', () => {
  const k = store.addAgent({ roomId, name: '기획', role: '기획자', folder: dir });
  router.send(a.id, ' backend ', 'x');
  router.send(a.id, '기획', 'x');
  expect(log.list().map((m) => m.to)).toEqual([b.id, k.id]);
  expect(router.send(a.id, ' BACKEND', 'y')).toContain('Backend 에게');
});

test('다른 방 에이전트 이름이면 없는 이름 오류', () => {
  const r2 = store.addRoom('다른방').id;
  store.addAgent({ roomId: r2, name: 'Outsider', role: '외부', folder: dir });
  expect(() => router.send(a.id, 'Outsider', 'x')).toThrow(
    "이 방에 'Outsider' 에이전트가 없습니다. 있는 에이전트: Backend",
  );
});

test('없는 이름 오류에서 다른 에이전트가 없으면 (없음)', () => {
  store.removeAgent(b.id);
  expect(() => router.send(a.id, 'Zed', 'x')).toThrow('있는 에이전트: (없음)');
});

test('자기 자신·빈 본문·없는 보낸 쪽 오류', () => {
  expect(() => router.send(a.id, 'front', 'x')).toThrow('자기 자신에게는 보낼 수 없습니다.');
  expect(() => router.send(a.id, 'Backend', '  \n ')).toThrow('보낼 내용이 비어 있습니다.');
  expect(() => router.send('nope', 'Backend', 'x')).toThrow('보낸 에이전트를 찾을 수 없습니다.');
});

test('본문 특수문자 그대로 deliver 까지', () => {
  auto(b.id);
  const text = '줄1\n"따옴표" \\ 백슬래시 🎉 한글';
  router.send(a.id, 'Backend', text);
  const sent = deliver.mock.calls[0][1] as string;
  expect(sent).toBe(`[두레 메시지 — 보낸 쪽: Front(화면)]\n${text}`);
  expect(sent.includes('\\')).toBe(true);
});

test('flushAll: 한가한 받는 쪽 queued 를 전달, 바쁜 쪽은 그대로', () => {
  const c = store.addAgent({ roomId, name: 'Third', role: '셋째', folder: dir });
  auto(b.id);
  auto(c.id);
  busy.add(b.id);
  busy.add(c.id);
  router.send(a.id, 'Backend', 'toB');
  router.send(a.id, 'Third', 'toC');
  busy.delete(c.id);
  router.flushAll();
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0][0]).toBe(c.id);
  expect(log.list({ to: b.id })[0].state).toBe('queued');
});

test('dismiss → dismissed, 이후 approve 하면 throw', () => {
  router.send(a.id, 'Backend', 'x');
  const m = log.list()[0];
  router.dismiss(m.id);
  expect(log.get(m.id)!.state).toBe('dismissed');
  expect(() => router.approve(m.id)).toThrow('이미 처리된 메시지입니다.');
  expect(() => router.dismiss(m.id)).toThrow('이미 처리된 메시지입니다.');
});

test('deliver 가 던지면 queued 로 남고 결과는 대기 글', () => {
  auto(b.id);
  deliver.mockImplementationOnce(() => {
    throw new Error('boom');
  });
  expect(router.send(a.id, 'Backend', 'x')).toBe('Backend 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
  expect(log.list()[0].state).toBe('queued');
  router.onIdle(b.id);
  expect(log.list()[0].state).toBe('delivered');
});

test('message 이벤트는 만들 때와 상태 바뀔 때마다', () => {
  const seen: string[] = [];
  router.on('message', (m) => seen.push(m.state));
  router.send(a.id, 'Backend', 'x');
  router.approve(log.list()[0].id);
  expect(seen).toEqual(['pending', 'queued', 'delivered']);
});

function deadSenderSetup() {
  const c = store.addAgent({ roomId, name: 'Third', role: '셋째', folder: dir });
  auto(b.id);
  busy.add(b.id);
  router.send(a.id, 'Backend', 'fromA');
  router.send(c.id, 'Backend', 'fromC');
  store.removeAgent(a.id);
  return c;
}

test('onIdle: 보낸 쪽이 지워진 메시지는 dismissed, 다음 것을 전달', () => {
  const c = deadSenderSetup();
  router.onIdle(b.id);
  const [ma, mc] = log.list({ to: b.id });
  expect(ma.state).toBe('dismissed');
  expect(mc.state).toBe('delivered');
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledWith(b.id, formatDelivery(c, 'fromC'), mc.id);
});

test('flushAll: 보낸 쪽이 지워진 메시지는 dismissed, 다음 것을 전달', () => {
  const c = deadSenderSetup();
  busy.delete(b.id);
  router.flushAll();
  const [ma, mc] = log.list({ to: b.id });
  expect(ma.state).toBe('dismissed');
  expect(mc.state).toBe('delivered');
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledWith(b.id, formatDelivery(c, 'fromC'), mc.id);
});

test('requeue: delivered 만 queued 로 되돌리고 message 이벤트, 다음 onIdle 에 같은 id 로 다시 전달', () => {
  auto(b.id);
  router.send(a.id, 'Backend', '다시');
  const m = log.list()[0];
  expect(m.state).toBe('delivered');
  const seen: string[] = [];
  router.on('message', (x) => seen.push(x.state));

  router.requeue(m.id);

  expect(log.get(m.id)!.state).toBe('queued');
  expect(seen).toEqual(['queued']);
  router.onIdle(b.id);
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(deliver.mock.calls[1]).toEqual([b.id, formatDelivery(a, '다시'), m.id]);
  expect(log.get(m.id)!.state).toBe('delivered');
});

test('requeue: delivered 가 아니거나 없는 메시지는 아무 일도 안 한다', () => {
  router.send(a.id, 'Backend', '확인 대기'); // pending
  const p = log.list()[0];
  const seen: string[] = [];
  router.on('message', (x) => seen.push(x.state));
  router.requeue(p.id);
  router.dismiss(p.id);
  router.requeue(p.id);
  router.requeue('없는-id');
  expect(log.get(p.id)!.state).toBe('dismissed');
  expect(seen).toEqual(['dismissed']);
  expect(deliver).not.toHaveBeenCalled();
});
