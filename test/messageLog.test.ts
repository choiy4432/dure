import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMessageLog } from '../src/engine/messageLog';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('만들고 상태 바꾼 기록이 다시 열면 그대로', () => {
  const l = openMessageLog(dir);
  const m = l.create({ roomId: 'r', from: 'a', to: 'b', text: '줄1\n"따옴표" \ 백슬래시 🎉 한글', state: 'pending' });
  l.setState(m.id, 'queued');
  const l2 = openMessageLog(dir);
  expect(l2.get(m.id)).toMatchObject({ state: 'queued', text: '줄1\n"따옴표" \ 백슬래시 🎉 한글' });
});

test('list 는 방·받는 쪽·상태로 거르고 오래된 순', () => {
  const l = openMessageLog(dir);
  const m1 = l.create({ roomId: 'r1', from: 'a', to: 'b', text: '1', state: 'pending' });
  const m2 = l.create({ roomId: 'r1', from: 'b', to: 'a', text: '2', state: 'queued' });
  const m3 = l.create({ roomId: 'r2', from: 'a', to: 'b', text: '3', state: 'queued' });
  expect(l.list().map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
  expect(l.list({ roomId: 'r1' }).map((m) => m.id)).toEqual([m1.id, m2.id]);
  expect(l.list({ to: 'b' }).map((m) => m.id)).toEqual([m1.id, m3.id]);
  expect(l.list({ from: 'b' }).map((m) => m.id)).toEqual([m2.id]);
  expect(l.list({ states: ['queued'] }).map((m) => m.id)).toEqual([m2.id, m3.id]);
  expect(l.list({ roomId: 'r1', to: 'b', states: ['pending', 'held'] }).map((m) => m.id)).toEqual([m1.id]);
});

test('마지막 줄이 반쯤 쓰다 끊겨도(깨진 JSON) 나머지는 복원', () => {
  const l = openMessageLog(dir);
  const m = l.create({ roomId: 'r', from: 'a', to: 'b', text: 'hi', state: 'pending' });
  fs.appendFileSync(path.join(dir, 'messages.jsonl'), '{"op":"cre');
  const l2 = openMessageLog(dir);
  expect(l2.get(m.id)).toMatchObject({ text: 'hi' });
  const m2 = l2.create({ roomId: 'r', from: 'a', to: 'b', text: 'after', state: 'pending' });
  expect(openMessageLog(dir).list().map((x) => x.id)).toEqual([m.id, m2.id]);
});

test('없는 id setState 는 throw', () => {
  const l = openMessageLog(dir);
  expect(() => l.setState('nope', 'queued')).toThrow();
});

test('updatedAt: 만들 때는 createdAt, 상태 바꾸면 그 시각', () => {
  const l = openMessageLog(dir);
  const m = l.create({ roomId: 'r', from: 'a', to: 'b', text: 'x', state: 'pending' });
  expect(m.updatedAt).toBe(m.createdAt);
  const s = l.setState(m.id, 'delivered');
  expect(s.updatedAt).toBeGreaterThanOrEqual(m.createdAt);
  expect(openMessageLog(dir).get(m.id)!.updatedAt).toBe(s.updatedAt);
});

test('list·get 은 복사본을 돌려준다', () => {
  const l = openMessageLog(dir);
  const m = l.create({ roomId: 'r', from: 'a', to: 'b', text: 'x', state: 'pending' });
  l.list()[0].state = 'dismissed';
  l.get(m.id)!.text = 'changed';
  expect(l.get(m.id)).toMatchObject({ state: 'pending', text: 'x' });
});
