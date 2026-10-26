import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, type Store } from '../src/engine/store';
import { openMessageLog, type MessageLog } from '../src/engine/messageLog';
import { Router, formatDelivery, joinDeliveries, LATE_MS, type Delivery } from '../src/engine/router';
import type { Agent } from '../src/engine/types';

let dir: string;
let store: Store;
let log: MessageLog;
let deliver: Mock<(agentId: string, batch: Delivery[], mid: boolean) => void>;
let busy: Set<string>;
let interject: Set<string>;
let now: number;
let router: Router;
let a: Agent;
let b: Agent;
let roomId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-'));
  store = openStore(dir);
  log = openMessageLog(dir);
  deliver = vi.fn<(agentId: string, batch: Delivery[], mid: boolean) => void>();
  busy = new Set();
  interject = new Set();
  now = Date.now();
  router = new Router({ store, log, deliver, isBusy: (id) => busy.has(id), canInterject: (id) => interject.has(id), now: () => now });
  roomId = store.addRoom('방').id;
  a = store.addAgent({ roomId, name: 'Front', role: '화면', folder: dir });
  b = store.addAgent({ roomId, name: 'Backend', role: '서버', folder: dir });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const auto = (id: string) => store.updateAgent(id, { auto: true });
/** i 번째 전달의 글(묶음이면 메시지마다) · 메시지 id */
const texts = (i: number) => deliver.mock.calls[i][1].map((d) => d.text);
const ids = (i: number) => deliver.mock.calls[i][1].map((d) => d.messageId);
const one = (text: string, messageId: string): Delivery[] => [{ messageId, text }];

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
  expect(deliver).toHaveBeenCalledWith(b.id, one(formatDelivery(a, '안녕'), log.list()[0].id), false);
  expect(texts(0)).toEqual(['[두레 메시지 — 보낸 쪽: Front(화면)]\n안녕']);
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

test('queued 가 여럿이면 onIdle 한 번에 보낸 차례대로 묶어 — 하나씩 차례를 열지 않는다(뒤의 정정·취소를 같이 읽게)', () => {
  const c = store.addAgent({ roomId, name: 'Third', role: '셋째', folder: dir });
  auto(b.id);
  busy.add(b.id);
  router.send(a.id, 'Backend', '첫째');
  router.send(c.id, 'Backend', '둘째');
  router.send(a.id, 'Backend', '앞 메시지 취소');
  router.onIdle(b.id);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0][2]).toBe(false);
  expect(texts(0)).toEqual([formatDelivery(a, '첫째'), formatDelivery(c, '둘째'), formatDelivery(a, '앞 메시지 취소')]);
  expect(ids(0)).toEqual(log.list({ to: b.id }).map((m) => m.id));
  expect(log.list({ to: b.id }).every((m) => m.state === 'delivered')).toBe(true);
  router.onIdle(b.id);
  expect(deliver).toHaveBeenCalledTimes(1); // 다 갔다
});

test('joinDeliveries: 하나면 그 글 그대로, 여럿이면 "다 읽고 한 번에" 머리 + 보낸 차례대로', () => {
  expect(joinDeliveries(['하나'])).toBe('하나');
  const joined = joinDeliveries(['첫 본문', '둘째 본문']);
  expect(joined.startsWith('[두레 메시지 2개 — 기다리는 동안 쌓인 것을 보낸 차례대로 묶었다.')).toBe(true);
  expect(joined).toContain('다 읽은 뒤 한 번에 처리한다]');
  expect(joined.indexOf('첫 본문')).toBeLessThan(joined.indexOf('둘째 본문'));
});

test('바쁜 받는 쪽이 지금 차례에 끼워 넣을 수 있으면 바로 끼워 넣는다(mid) — 결과 글은 "지금 하는 일 사이에 읽습니다"', () => {
  auto(b.id);
  busy.add(b.id);
  interject.add(b.id);
  expect(router.send(a.id, 'Backend', '멈춰')).toBe('Backend 에게 전달했습니다. 지금 하는 일 사이에 읽습니다.');
  expect(deliver).toHaveBeenCalledWith(b.id, one(formatDelivery(a, '멈춰'), log.list()[0].id), true);
  expect(log.list()[0].state).toBe('delivered');
});

test('끼워 넣을 수 없던 동안 쌓인 것은 끼워 넣을 수 있게 되면 새 메시지와 함께 묶어서 — 차례를 앞지르지 않는다', () => {
  auto(b.id);
  busy.add(b.id);
  router.send(a.id, 'Backend', '먼저');
  expect(deliver).not.toHaveBeenCalled();
  interject.add(b.id);
  router.send(a.id, 'Backend', '나중');
  expect(texts(0)).toEqual([formatDelivery(a, '먼저'), formatDelivery(a, '나중')]);
  expect(deliver.mock.calls[0][2]).toBe(true);
});

test('사람이 풀어 준 메시지도 받는 쪽이 일하는 중이면 끼워 넣는다', () => {
  busy.add(b.id);
  interject.add(b.id);
  router.send(a.id, 'Backend', '확인 대기');
  router.approve(log.list()[0].id);
  expect(deliver.mock.calls[0][2]).toBe(true);
  expect(log.list()[0].state).toBe('delivered');
});

test(`${LATE_MS / 60_000}분 넘게 늦게 가면 머리 끝에 "· N분 전에 보냄" — 그보다 빠르면 머리 그대로`, () => {
  auto(b.id);
  busy.add(b.id);
  router.send(a.id, 'Backend', '늦음');
  now += 34 * 60_000 + 20_000;
  router.onIdle(b.id);
  expect(texts(0)).toEqual(['[두레 메시지 — 보낸 쪽: Front(화면) · 34분 전에 보냄]\n늦음']);
  expect(formatDelivery(a, 'x', LATE_MS - 1)).toBe('[두레 메시지 — 보낸 쪽: Front(화면)]\nx');
  expect(formatDelivery(a, 'x', 65 * 60_000)).toBe('[두레 메시지 — 보낸 쪽: Front(화면) · 1시간 5분 전에 보냄]\nx');
  expect(formatDelivery(a, 'x', 120 * 60_000)).toBe('[두레 메시지 — 보낸 쪽: Front(화면) · 2시간 전에 보냄]\nx');
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
  expect(texts(2)[0]).toContain('확인용');
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
  const sent = texts(0)[0];
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
  expect(deliver).toHaveBeenCalledWith(b.id, one(formatDelivery(c, 'fromC'), mc.id), false);
});

test('flushAll: 보낸 쪽이 지워진 메시지는 dismissed, 다음 것을 전달', () => {
  const c = deadSenderSetup();
  busy.delete(b.id);
  router.flushAll();
  const [ma, mc] = log.list({ to: b.id });
  expect(ma.state).toBe('dismissed');
  expect(mc.state).toBe('delivered');
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledWith(b.id, one(formatDelivery(c, 'fromC'), mc.id), false);
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
  expect(deliver.mock.calls[1]).toEqual([b.id, one(formatDelivery(a, '다시'), m.id), false]);
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

test('setLimit: 바꾼 상한이 바로 적용되고 이미 센 연속 횟수는 그대로', () => {
  auto(b.id);
  busy.add(b.id);
  router.send(a.id, 'Backend', '1');
  router.send(a.id, 'Backend', '2');
  router.send(a.id, 'Backend', '3');
  expect(router.chain(roomId)).toBe(3);
  router.send(a.id, 'Backend', '4');
  expect(log.list({ states: ['held'] })).toHaveLength(1);
  router.setLimit(5);
  expect(router.chain(roomId)).toBe(3);
  router.send(a.id, 'Backend', '5');
  expect(router.chain(roomId)).toBe(4);
  expect(log.list({ states: ['held'] })).toHaveLength(1);
});

// ── sendApproved — 사람이 이미 허락한 메시지(새 에이전트를 만들 때 넘긴 첫 할 일) ──
test('sendApproved: 받는 쪽 자동이 꺼져 있어도 pending 이 아니라 바로 전달 · 자동 상한에 걸려 있어도 held 가 아니고 연속 횟수 0', () => {
  auto(b.id);
  for (let i = 0; i < 3; i++) router.send(a.id, 'Backend', `m${i}`);
  expect(router.chain(roomId)).toBe(3); // 상한 — 보통 send 면 held
  store.updateAgent(b.id, { auto: false }); // 보통 send 면 pending
  const held = vi.fn();
  router.on('held', held);
  const r = router.sendApproved(a.id, b.id, '첫 할 일');
  expect(r).toBe('Backend 에게 전달했습니다.');
  const m = log.list().at(-1)!;
  expect(m).toMatchObject({ roomId, from: a.id, to: b.id, text: '첫 할 일', state: 'delivered' });
  expect(deliver).toHaveBeenLastCalledWith(b.id, one(formatDelivery(a, '첫 할 일'), m.id), false);
  expect(router.chain(roomId)).toBe(0);
  expect(held).not.toHaveBeenCalled();
  // 다음 자동 전달은 처음부터 센다
  auto(b.id);
  expect(router.send(a.id, 'Backend', '다음')).toBe('Backend 에게 전달했습니다.');
  expect(router.chain(roomId)).toBe(1);
});

test('sendApproved: 받는 쪽이 바쁘면 queued 로 남고 send 와 같은 대기 글 — onIdle 에 전달', () => {
  busy.add(b.id);
  const events: string[] = [];
  router.on('message', (m) => events.push(m.state));
  expect(router.sendApproved(a.id, b.id, '첫 할 일')).toBe('Backend 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.');
  expect(deliver).not.toHaveBeenCalled();
  expect(log.list()[0].state).toBe('queued');
  expect(events).toEqual(['queued']);
  busy.delete(b.id);
  router.onIdle(b.id);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(events).toEqual(['queued', 'delivered']);
});

test('sendApproved: 자기 자신·빈 본문·없는 보낸 쪽·없는 받는 쪽·다른 방은 던지고 메시지를 만들지 않는다', () => {
  const other = store.addAgent({ roomId: store.addRoom('다른방').id, name: 'Outsider', role: '외부', folder: dir });
  expect(() => router.sendApproved(a.id, a.id, 'x')).toThrow('자기 자신에게는 보낼 수 없습니다.');
  expect(() => router.sendApproved(a.id, b.id, '  \n ')).toThrow('보낼 내용이 비어 있습니다.');
  expect(() => router.sendApproved('nope', b.id, 'x')).toThrow('보낸 에이전트를 찾을 수 없습니다.');
  expect(() => router.sendApproved(a.id, 'nope', 'x')).toThrow('받는 에이전트를 찾을 수 없습니다.');
  expect(() => router.sendApproved(a.id, other.id, 'x')).toThrow('받는 에이전트를 찾을 수 없습니다.');
  expect(log.list()).toEqual([]);
  expect(deliver).not.toHaveBeenCalled();
});
