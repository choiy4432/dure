import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/engine/store';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('저장한 방·에이전트가 다시 열어도 남는다', () => {
  const s = openStore(dir);
  const r = s.addRoom('CSI');
  const a = s.addAgent({ roomId: r.id, name: 'world', role: '학생 화면', folder: dir });
  s.updateAgent(a.id, { auto: true, pos: { x: 10, y: 20 } });
  const s2 = openStore(dir);
  expect(s2.rooms()).toEqual([r]);
  expect(s2.agent(a.id)).toMatchObject({
    name: 'world', auto: true, pos: { x: 10, y: 20 }, started: false, model: null, alwaysAllow: [],
  });
});

test('새 에이전트 기본값', () => {
  const s = openStore(dir);
  const r = s.addRoom('A');
  const a = s.addAgent({ roomId: r.id, name: ' x ', role: 'r', folder: dir });
  expect(a.name).toBe('x');
  expect(a.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(a).toMatchObject({ started: false, auto: false, model: null, alwaysAllow: [], pos: { x: 0, y: 0 }, color: null });
});

test('같은 방에 같은 이름(대소문자·앞뒤 공백 무시)은 거절', () => {
  const s = openStore(dir);
  const r = s.addRoom('R');
  s.addAgent({ roomId: r.id, name: 'world', role: 'r', folder: dir });
  expect(() => s.addAgent({ roomId: r.id, name: 'World ', role: 'r', folder: dir })).toThrow(/이미 있는 이름/);
});

test('다른 방이면 같은 이름 허용, 같은 폴더 두 번 허용', () => {
  const s = openStore(dir);
  const r1 = s.addRoom('R1');
  const r2 = s.addRoom('R2');
  s.addAgent({ roomId: r1.id, name: 'world', role: 'r', folder: dir });
  s.addAgent({ roomId: r2.id, name: 'world', role: 'r', folder: dir });
  s.addAgent({ roomId: r1.id, name: 'other', role: 'r', folder: dir });
  expect(s.agents()).toHaveLength(3);
  expect(s.agents(r1.id)).toHaveLength(2);
});

test('없는 폴더면 거절', () => {
  const s = openStore(dir);
  const r = s.addRoom('R');
  expect(() => s.addAgent({ roomId: r.id, name: 'a', role: 'r', folder: 'C:/nope/xyz' })).toThrow(/폴더를 찾을 수 없습니다/);
});

test('방을 지우면 그 방 에이전트도 지워진다', () => {
  const s = openStore(dir);
  const r1 = s.addRoom('R1');
  const r2 = s.addRoom('R2');
  const a = s.addAgent({ roomId: r1.id, name: 'a', role: 'r', folder: dir });
  const b = s.addAgent({ roomId: r2.id, name: 'b', role: 'r', folder: dir });
  s.removeRoom(r1.id);
  expect(s.rooms()).toEqual([r2]);
  expect(s.agent(a.id)).toBeUndefined();
  expect(s.agent(b.id)).toBeDefined();
  expect(openStore(dir).agents()).toHaveLength(1);
});

test('쓰기는 임시 파일 후 이름 바꾸기 — state.json.tmp 가 남지 않는다', () => {
  const s = openStore(dir);
  const r = s.addRoom('R');
  s.renameRoom(r.id, 'R2');
  const a = s.addAgent({ roomId: r.id, name: 'a', role: 'r', folder: dir });
  s.removeAgent(a.id);
  const files = fs.readdirSync(dir);
  expect(files).toContain('state.json');
  expect(files).not.toContain('state.json.tmp');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).version).toBe(1);
});

test('state.json 이 깨져 있으면 state.json.broken-<시각> 으로 옮기고 빈 상태로 연다', () => {
  fs.writeFileSync(path.join(dir, 'state.json'), '{ not json');
  const s = openStore(dir);
  expect(s.rooms()).toEqual([]);
  expect(s.agents()).toEqual([]);
  const broken = fs.readdirSync(dir).filter((f) => /^state\.json\.broken-\d+$/.test(f));
  expect(broken).toHaveLength(1);
  expect(fs.readFileSync(path.join(dir, broken[0]), 'utf8')).toBe('{ not json');
  s.addRoom('new');
  expect(openStore(dir).rooms()).toHaveLength(1);
});
