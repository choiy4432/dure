import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/engine/store';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const fsError = (code: string) => Object.assign(new Error(`가짜 ${code}`), { code });

/** 처음 failures 번은 code 로 실패하고 그 뒤엔 진짜로 이름을 바꾸는 renameSync */
function flakyRename(failures: number, code: string) {
  const real = fs.renameSync;
  let left = failures;
  return vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (left-- > 0) throw fsError(code);
    real(from, to);
  });
}

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

test('윈도우 잠금(EPERM·EACCES·EBUSY)으로 이름 바꾸기가 두 번 실패해도 다시 시도해 저장한다', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const s = openStore(dir);
    const rename = flakyRename(2, code);
    s.addRoom(code);
    expect(rename).toHaveBeenCalledTimes(3);
    rename.mockRestore();
    expect(openStore(dir).rooms().map((r) => r.name)).toContain(code);
    expect(fs.readdirSync(dir)).not.toContain('state.json.tmp');
  }
});

test('잠금이 풀리지 않으면 다섯 번 더 시도한 뒤 던진다 · 다른 오류는 바로 던진다', () => {
  const s = openStore(dir);
  const busy = flakyRename(Infinity, 'EBUSY');
  expect(() => s.addRoom('R')).toThrow('가짜 EBUSY');
  expect(busy).toHaveBeenCalledTimes(6);
  busy.mockRestore();

  const missing = flakyRename(Infinity, 'ENOENT');
  expect(() => s.addRoom('R2')).toThrow('가짜 ENOENT');
  expect(missing).toHaveBeenCalledTimes(1);
});

test('깨진 state.json 을 옮길 때도 잠금이면 다시 시도한다', () => {
  fs.writeFileSync(path.join(dir, 'state.json'), '{ not json');
  const rename = flakyRename(1, 'EPERM');
  expect(openStore(dir).rooms()).toEqual([]);
  expect(rename).toHaveBeenCalledTimes(2);
  expect(fs.readdirSync(dir).filter((f) => f.startsWith('state.json.broken-'))).toHaveLength(1);
});

test('updateAgent 는 undefined 값을 무시한다 — 다시 열어도 pos·name 그대로', () => {
  const s = openStore(dir);
  const r = s.addRoom('R');
  const a = s.addAgent({ roomId: r.id, name: 'a', role: 'r', folder: dir });
  s.updateAgent(a.id, { pos: undefined, name: undefined });
  expect(s.agent(a.id)).toMatchObject({ name: 'a', pos: { x: 0, y: 0 } });
  expect(openStore(dir).agent(a.id)).toMatchObject({ name: 'a', pos: { x: 0, y: 0 } });
});

test('effort·lastContext 칸이 없는 옛 state.json 은 null 로 열린다', () => {
  const s = openStore(dir);
  const r = s.addRoom('A');
  const a = s.addAgent({ roomId: r.id, name: 'x', role: 'r', folder: dir });
  expect(a).toMatchObject({ effort: null, lastContext: null });
  const file = path.join(dir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const ag of raw.agents) {
    delete ag.effort;
    delete ag.lastContext;
  }
  fs.writeFileSync(file, JSON.stringify(raw));
  const old = openStore(dir).agent(a.id)!;
  expect(old.effort).toBeNull();
  expect(old.lastContext).toBeNull();
});

test('깨지거나 손댄 state.json 의 effort·lastContext 는 null 로 열린다 — 다른 칸은 그대로', () => {
  const s = openStore(dir);
  const r = s.addRoom('A');
  const ids = ['turbo', 'num', 'str', 'ctx', 'maxless', 'ok'].map((name) => s.addAgent({ roomId: r.id, name, role: 'r', folder: dir }).id);
  const file = path.join(dir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const good = { total: 12000, max: 200000, percent: 6, autoCompactAt: 167000, at: 5 };
  const bad: Record<string, { effort: unknown; lastContext: unknown }> = {
    turbo: { effort: 'turbo', lastContext: 'big' },
    num: { effort: 3, lastContext: { total: '12000', max: 200000, percent: 6, autoCompactAt: null, at: 1 } },
    str: { effort: 'HIGH', lastContext: [1, 2] },
    ctx: { effort: 'max', lastContext: { total: Number.NaN, max: 200000, percent: 6, autoCompactAt: null, at: 1 } },
    maxless: { effort: null, lastContext: { total: 1, percent: 6, autoCompactAt: null, at: 1 } },
    ok: { effort: 'xhigh', lastContext: good },
  };
  for (const ag of raw.agents) Object.assign(ag, bad[ag.name]);
  fs.writeFileSync(file, JSON.stringify(raw));
  const back = openStore(dir);
  const [turbo, num, str, ctx, maxless, ok] = ids.map((id) => back.agent(id)!);
  expect([turbo.effort, turbo.lastContext]).toEqual([null, null]);
  expect([num.effort, num.lastContext]).toEqual([null, null]);
  expect([str.effort, str.lastContext]).toEqual([null, null]);
  expect([ctx.effort, ctx.lastContext]).toEqual(['max', null]);
  expect([maxless.effort, maxless.lastContext]).toEqual([null, null]);
  expect([ok.effort, ok.lastContext]).toEqual(['xhigh', good]);
  expect(turbo).toMatchObject({ name: 'turbo', role: 'r', roomId: r.id });
  expect(fs.readdirSync(dir).filter((f) => f.includes('.broken-'))).toEqual([]); // 칸 하나가 깨졌다고 파일 전체를 버리지 않는다
});

test('updateAgent 로 effort·lastContext 를 저장하면 다시 열어도 남는다', () => {
  const s = openStore(dir);
  const r = s.addRoom('A');
  const a = s.addAgent({ roomId: r.id, name: 'x', role: 'r', folder: dir });
  const ctx = { total: 1, max: 2, percent: 50, autoCompactAt: null, at: 3 };
  s.updateAgent(a.id, { effort: 'low', lastContext: ctx });
  expect(openStore(dir).agent(a.id)).toMatchObject({ effort: 'low', lastContext: ctx });
});
