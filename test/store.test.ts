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

test('forkOf — 새 에이전트는 null, 저장하면 다시 열어도 남고, 칸이 없거나 글이 아닌 옛 state.json 은 null', () => {
  const s = openStore(dir);
  const r = s.addRoom('A');
  const a = s.addAgent({ roomId: r.id, name: 'x', role: 'r', folder: dir });
  const b = s.addAgent({ roomId: r.id, name: 'y', role: 'r', folder: dir });
  const c = s.addAgent({ roomId: r.id, name: 'z', role: 'r', folder: dir });
  expect(a.forkOf).toBeNull();
  s.updateAgent(a.id, { forkOf: 'OLD' });
  expect(openStore(dir).agent(a.id)!.forkOf).toBe('OLD');
  const file = path.join(dir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const ag of raw.agents) {
    if (ag.id === b.id) delete ag.forkOf;
    if (ag.id === c.id) ag.forkOf = 3;
  }
  fs.writeFileSync(file, JSON.stringify(raw));
  const back = openStore(dir);
  expect(back.agent(a.id)!.forkOf).toBe('OLD');
  expect(back.agent(b.id)!.forkOf).toBeNull();
  expect(back.agent(c.id)!.forkOf).toBeNull();
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

test('bypassOn 이 없는 옛 에이전트 기록은 false 로 읽힌다 · updateAgent 로 바꾸면 남는다', () => {
  const s = openStore(dir);
  const r = s.addRoom('A');
  const a = s.addAgent({ roomId: r.id, name: 'x', role: 'r', folder: dir });
  expect(a.bypassOn).toBe(false);
  const file = path.join(dir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const ag of raw.agents) delete ag.bypassOn;
  fs.writeFileSync(file, JSON.stringify(raw));
  const old = openStore(dir);
  expect(old.agent(a.id)!.bypassOn).toBe(false);
  old.updateAgent(a.id, { bypassOn: true });
  expect(openStore(dir).agent(a.id)!.bypassOn).toBe(true);
});

test('bypassNoticeClosed — 새 에이전트·옛 기록은 false · 닫으면 남는다', () => {
  const s = openStore(dir);
  const r = s.addRoom('A');
  const a = s.addAgent({ roomId: r.id, name: 'x', role: 'r', folder: dir });
  expect(a.bypassNoticeClosed).toBe(false);
  const file = path.join(dir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const ag of raw.agents) delete ag.bypassNoticeClosed;
  fs.writeFileSync(file, JSON.stringify(raw));
  const old = openStore(dir);
  expect(old.agent(a.id)!.bypassNoticeClosed).toBe(false);
  old.updateAgent(a.id, { bypassNoticeClosed: true });
  expect(openStore(dir).agent(a.id)!.bypassNoticeClosed).toBe(true);
});

test('checkAgent: addAgent 와 같은 검사·문구(방·이름 빔·이름 겹침·폴더) — 통과하면 아무것도 더하지 않는다', () => {
  const s = openStore(dir);
  const r = s.addRoom('R');
  s.addAgent({ roomId: r.id, name: 'world', role: 'r', folder: dir });
  const missing = path.join(dir, 'nope');
  expect(() => s.checkAgent({ roomId: 'ghost', name: 'n', folder: dir })).toThrow('방을 찾을 수 없습니다: ghost');
  expect(() => s.checkAgent({ roomId: r.id, name: '  ', folder: dir })).toThrow('이름을 입력하세요');
  expect(() => s.checkAgent({ roomId: r.id, name: ' World', folder: dir })).toThrow('이미 있는 이름입니다: World');
  expect(() => s.checkAgent({ roomId: r.id, name: 'n', folder: missing })).toThrow(`폴더를 찾을 수 없습니다: ${missing}`);
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, '');
  expect(() => s.checkAgent({ roomId: r.id, name: 'n', folder: file })).toThrow(`폴더를 찾을 수 없습니다: ${file}`);
  expect(() => s.checkAgent({ roomId: r.id, name: 'n', folder: dir })).not.toThrow();
  expect(s.agents().map((a) => a.name)).toEqual(['world']);
});

// ── 서버(SSH) 방 ──
test('서버 방 — addRoom(이름, { host }) 를 저장하고 다시 열어도 남는다 · 이 PC 방은 remote null', () => {
  const s = openStore(dir);
  const local = s.addRoom('이 PC');
  const remote = s.addRoom('서버 실험', { host: 'dev' });
  const port = s.addRoom('포트', { host: ' me@10.0.0.12:2222 ' });
  expect(local.remote).toBeNull();
  expect(remote).toMatchObject({ name: '서버 실험', remote: { host: 'dev' } });
  expect(port.remote).toEqual({ host: 'me@10.0.0.12:2222' }); // 앞뒤 빈칸만 자른다
  expect(s.addRoom('n', null).remote).toBeNull();
  expect(openStore(dir).rooms()).toEqual([local, remote, port, expect.objectContaining({ name: 'n', remote: null })]);
});

test('서버 방 — host 가 빔·공백 포함·- 시작이면 거절하고 저장하지 않는다', () => {
  const s = openStore(dir);
  for (const host of ['', '  ', 'a b', '-oProxyCommand=x', 'a\tb']) {
    expect(() => s.addRoom('R', { host })).toThrow('서버 이름이 올바르지 않아요');
  }
  expect(s.rooms()).toEqual([]);
  expect(openStore(dir).rooms()).toEqual([]);
});

test('옛 state.json — 방 remote·에이전트 remoteLaunch 칸이 없거나 깨졌으면 null · 맞으면 그대로', () => {
  const s = openStore(dir);
  const r = s.addRoom('A');
  const ids = ['none', 'num', 'neg', 'run', 'dot', 'ok'].map((name) => s.addAgent({ roomId: r.id, name, role: 'r', folder: dir }).id);
  expect(s.agent(ids[0])!.remoteLaunch).toBeNull();
  const file = path.join(dir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.rooms[0].remote;
  raw.rooms.push({ id: 'bad', name: '깨진 방', createdAt: 1, remote: { host: 3 } }, { id: 'srv', name: '서버', createdAt: 2, remote: { host: 'dev', x: 1 } });
  const launch: Record<string, unknown> = {
    num: 7,
    neg: { pid: -1, run: 'abcd1234' },
    run: { pid: 12, run: '../x' },
    dot: { pid: 13, run: '.' },
    ok: { pid: 4242, run: 'abcd1234' },
  };
  for (const ag of raw.agents) {
    if (ag.name === 'none') delete ag.remoteLaunch;
    else ag.remoteLaunch = launch[ag.name];
  }
  fs.writeFileSync(file, JSON.stringify(raw));
  const back = openStore(dir);
  expect(back.rooms().map((x) => x.remote)).toEqual([null, null, { host: 'dev' }]);
  expect(ids.map((id) => back.agent(id)!.remoteLaunch)).toEqual([null, null, null, null, null, { pid: 4242, run: 'abcd1234' }]);
  expect(fs.readdirSync(dir).filter((f) => f.includes('.broken-'))).toEqual([]);
});

test('remoteLaunch — updateAgent 로 저장하면 다시 열어도 남고 null 로 지운다', () => {
  const s = openStore(dir);
  const r = s.addRoom('서버', { host: 'dev' });
  const a = s.addAgent({ roomId: r.id, name: 'x', role: 'r', folder: '/home/a/web' });
  s.updateAgent(a.id, { remoteLaunch: { pid: 99, run: 'k3j2h1g0' } });
  expect(openStore(dir).agent(a.id)!.remoteLaunch).toEqual({ pid: 99, run: 'k3j2h1g0' });
  s.updateAgent(a.id, { remoteLaunch: null });
  expect(openStore(dir).agent(a.id)!.remoteLaunch).toBeNull();
});

test('서버 방 에이전트 폴더 — / 로 시작하는 전체 경로면 이 PC 에 없어도 된다 · 상대·~·빈 경로는 거절 · 이 PC 방은 지금 그대로', () => {
  const s = openStore(dir);
  const r = s.addRoom('서버 실험', { host: 'dev' });
  const a = s.addAgent({ roomId: r.id, name: 'web', role: 'r', folder: '/home/a/web' });
  expect(a.folder).toBe('/home/a/web');
  expect(openStore(dir).agent(a.id)!.folder).toBe('/home/a/web');
  const msg = '서버 폴더는 / 로 시작하는 전체 경로로 적어 주세요';
  for (const folder of ['web', '~/web', '~', '', 'C:\\work', './web', '/home/a\nweb', '/home/a\u2028x', '/home/a\tweb']) {
    expect(() => s.addAgent({ roomId: r.id, name: `n${folder}`, role: 'r', folder })).toThrow(msg);
    expect(() => s.checkAgent({ roomId: r.id, name: `n${folder}`, folder })).toThrow(msg);
  }
  expect(() => s.checkAgent({ roomId: r.id, name: 'WEB', folder: '/srv' })).toThrow('이미 있는 이름입니다: WEB'); // 이름 검사는 그대로 먼저
  expect(s.agents(r.id)).toHaveLength(1);
  const local = s.addRoom('이 PC');
  expect(() => s.addAgent({ roomId: local.id, name: 'x', role: 'r', folder: '/home/a/web' })).toThrow('폴더를 찾을 수 없습니다: /home/a/web');
});

test('기다리는 정리 — 서버 방 에이전트를 지우면 저장된 띄우기를 목록으로 옮긴다(방 지우기도) · 이 PC 방·띄우기 없음은 없다 · 다시 열어도 남는다', () => {
  const s = openStore(dir);
  const srv = s.addRoom('서버', { host: 'me@h:2222' });
  const a = s.addAgent({ roomId: srv.id, name: 'a', role: 'r', folder: '/home/a/web' });
  const b = s.addAgent({ roomId: srv.id, name: 'b', role: 'r', folder: '/home/a/api' });
  const c = s.addAgent({ roomId: srv.id, name: 'c', role: 'r', folder: '/home/a/c' }); // 띄우기 없음
  const local = s.addRoom('이 PC');
  const d = s.addAgent({ roomId: local.id, name: 'd', role: 'r', folder: dir });
  s.updateAgent(a.id, { remoteLaunch: { pid: 11, run: 'aaaa1111' } });
  s.updateAgent(b.id, { remoteLaunch: { pid: 22, run: 'bbbb2222' } });
  expect(s.pendingCleanups()).toEqual([]);
  s.removeAgent(a.id);
  s.removeAgent(c.id);
  s.removeAgent(d.id);
  expect(s.pendingCleanups()).toEqual([{ host: 'me@h:2222', agentId: a.id, launch: { pid: 11, run: 'aaaa1111' } }]);
  s.removeRoom(srv.id);
  const want = [
    { host: 'me@h:2222', agentId: a.id, launch: { pid: 11, run: 'aaaa1111' } },
    { host: 'me@h:2222', agentId: b.id, launch: { pid: 22, run: 'bbbb2222' } },
  ];
  expect(s.pendingCleanups()).toEqual(want);
  expect(openStore(dir).pendingCleanups()).toEqual(want);
});

test('기다리는 정리 — 정리가 되면 그 띄우기만 뺀다(다른 띄우기·없는 것은 그대로)', () => {
  const s = openStore(dir);
  const srv = s.addRoom('서버', { host: 'dev' });
  const a = s.addAgent({ roomId: srv.id, name: 'a', role: 'r', folder: '/home/a/web' });
  s.updateAgent(a.id, { remoteLaunch: { pid: 11, run: 'aaaa1111' } });
  s.removeAgent(a.id);
  s.dropPendingCleanup(a.id, { pid: 11, run: 'other999' });
  s.dropPendingCleanup('ghost', { pid: 11, run: 'aaaa1111' });
  expect(s.pendingCleanups()).toHaveLength(1);
  s.dropPendingCleanup(a.id, { pid: 11, run: 'aaaa1111' });
  expect(s.pendingCleanups()).toEqual([]);
  expect(openStore(dir).pendingCleanups()).toEqual([]);
});

test('기다리는 첨부 정리 — 서버 방 에이전트를 지우면 그 서버 첨부 폴더를 목록에(띄우기와 상관없이, 방 지우기도) · 이 PC 방은 없다 · 다시 열어도 남는다 · 되면 뺀다', () => {
  const s = openStore(dir);
  const srv = s.addRoom('서버', { host: 'me@h:2222' });
  const a = s.addAgent({ roomId: srv.id, name: 'a', role: 'r', folder: '/home/a/web' });
  const b = s.addAgent({ roomId: srv.id, name: 'b', role: 'r', folder: '/home/a/api' });
  s.updateAgent(a.id, { remoteLaunch: { pid: 11, run: 'aaaa1111' } });
  const local = s.addRoom('이 PC');
  const d = s.addAgent({ roomId: local.id, name: 'd', role: 'r', folder: dir });
  expect(s.pendingAttachmentCleanups()).toEqual([]);
  s.removeAgent(a.id);
  s.removeAgent(d.id);
  expect(s.pendingAttachmentCleanups()).toEqual([{ host: 'me@h:2222', agentId: a.id }]);
  expect(s.pendingCleanups()).toEqual([{ host: 'me@h:2222', agentId: a.id, launch: { pid: 11, run: 'aaaa1111' } }]); // 띄우기 정리는 따로 그대로
  s.removeRoom(srv.id);
  const want = [{ host: 'me@h:2222', agentId: a.id }, { host: 'me@h:2222', agentId: b.id }];
  expect(s.pendingAttachmentCleanups()).toEqual(want);
  expect(openStore(dir).pendingAttachmentCleanups()).toEqual(want);
  s.dropPendingAttachmentCleanup('ghost');
  expect(s.pendingAttachmentCleanups()).toHaveLength(2);
  s.dropPendingAttachmentCleanup(a.id);
  expect(s.pendingAttachmentCleanups()).toEqual([{ host: 'me@h:2222', agentId: b.id }]);
  expect(openStore(dir).pendingAttachmentCleanups()).toEqual([{ host: 'me@h:2222', agentId: b.id }]);
});

test('기다리는 첨부 정리 — 옛 state.json 에 칸이 없으면 빈 목록 · 깨진 줄은 버린다', () => {
  const s = openStore(dir);
  s.addRoom('A');
  const file = path.join(dir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.pendingAttachmentCleanups;
  fs.writeFileSync(file, JSON.stringify(raw));
  expect(openStore(dir).pendingAttachmentCleanups()).toEqual([]);
  raw.pendingAttachmentCleanups = [{ host: 'dev', agentId: 'ag1' }, { host: 'a b', agentId: 'ag1' }, { host: 'dev', agentId: '../x' }, { host: 'dev' }, 7];
  fs.writeFileSync(file, JSON.stringify(raw));
  expect(openStore(dir).pendingAttachmentCleanups()).toEqual([{ host: 'dev', agentId: 'ag1' }]);
  raw.pendingAttachmentCleanups = 'nope';
  fs.writeFileSync(file, JSON.stringify(raw));
  expect(openStore(dir).pendingAttachmentCleanups()).toEqual([]);
  expect(fs.readdirSync(dir).filter((f) => f.includes('.broken-'))).toEqual([]);
});

test('기다리는 정리 — 옛 state.json 에 칸이 없으면 빈 목록 · 깨진 줄은 버린다', () => {
  const s = openStore(dir);
  s.addRoom('A');
  const file = path.join(dir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.pendingCleanups;
  fs.writeFileSync(file, JSON.stringify(raw));
  expect(openStore(dir).pendingCleanups()).toEqual([]);
  raw.pendingCleanups = [
    { host: 'dev', agentId: 'ag1', launch: { pid: 4242, run: 'abcd1234' } },
    { host: 'a b', agentId: 'ag1', launch: { pid: 1, run: 'x' } },
    { host: 'dev', agentId: '../x', launch: { pid: 1, run: 'x' } },
    { host: 'dev', agentId: 'ag1', launch: { pid: -1, run: 'x' } },
    { host: 'dev', agentId: 'ag1' },
    7,
  ];
  fs.writeFileSync(file, JSON.stringify(raw));
  expect(openStore(dir).pendingCleanups()).toEqual([{ host: 'dev', agentId: 'ag1', launch: { pid: 4242, run: 'abcd1234' } }]);
  raw.pendingCleanups = 'nope';
  fs.writeFileSync(file, JSON.stringify(raw));
  expect(openStore(dir).pendingCleanups()).toEqual([]);
  expect(fs.readdirSync(dir).filter((f) => f.includes('.broken-'))).toEqual([]);
});
