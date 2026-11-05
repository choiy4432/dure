import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initAppPrefs, initAppPrefsSafe, readAppPrefs, writeAppPrefs } from '../src/main/appPrefs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-appprefs-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, 'settings.json');
const saved = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
const seed = (v: unknown) => fs.writeFileSync(file(), typeof v === 'string' ? v : JSON.stringify(v));

test('빈 폴더 — 기본값(투어 안 함 · 승인 안내 안 봄 · claude 최신으로 켬)', () => {
  expect(readAppPrefs(dir)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
  expect(readAppPrefs(path.join(dir, '없는-폴더'))).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
});

test('settings.json 이 깨졌거나 배열이면 기본값', () => {
  seed('{깨짐');
  expect(readAppPrefs(dir)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
  seed([1, 2]);
  expect(readAppPrefs(dir)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
});

test('write 는 엔진 칸(autoChainLimit 등)을 지우지 않고 바꾼 칸만 더한다', () => {
  seed({ autoChainLimit: 5, theme: 'dark', approvalTipSeen: true });
  expect(writeAppPrefs(dir, { tourDone: true })).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true, trayTipSeen: false });
  expect(saved()).toEqual({ autoChainLimit: 5, theme: 'dark', approvalTipSeen: true, tourDone: true });
  expect(writeAppPrefs(dir, { claudeAutoUpdate: false })).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: false, trayTipSeen: false });
  expect(saved()).toEqual({ autoChainLimit: 5, theme: 'dark', approvalTipSeen: true, tourDone: true, claudeAutoUpdate: false });
  expect(readAppPrefs(dir)).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: false, trayTipSeen: false });
  expect(fs.existsSync(`${file()}.tmp`)).toBe(false);
});

test('write 는 폴더가 없으면 만든다', () => {
  const sub = path.join(dir, 'Dure');
  expect(writeAppPrefs(sub, { tourDone: true }).tourDone).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(sub, 'settings.json'), 'utf8'))).toEqual({ tourDone: true });
});

test("불리언이 아닌 칸('yes' 등)·모르는 칸은 무시", () => {
  seed({ autoChainLimit: 5 });
  expect(writeAppPrefs(dir, { tourDone: 'yes', approvalTipSeen: 1, claudeAutoUpdate: null, theme: 'light' } as never))
    .toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
  expect(saved()).toEqual({ autoChainLimit: 5 });
  // 파일에 손으로 넣은 'yes' 도 기본값으로 읽는다
  seed({ tourDone: 'yes', claudeAutoUpdate: 0 });
  expect(readAppPrefs(dir)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
});

test('initAppPrefs(dir, true) — tourDone 칸이 없으면(업데이트로 받은 사람) tourDone·approvalTipSeen 을 true 로 써 둔다', () => {
  seed({ autoChainLimit: 5 });
  expect(initAppPrefs(dir, true)).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true, trayTipSeen: false });
  expect(saved()).toEqual({ autoChainLimit: 5, tourDone: true, approvalTipSeen: true });
});

test('initAppPrefs(dir, true) — settings.json 이 아예 없어도 써 둔다', () => {
  expect(initAppPrefs(dir, true)).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true, trayTipSeen: false });
  expect(saved()).toEqual({ tourDone: true, approvalTipSeen: true });
});

test('initAppPrefs — 이미 tourDone:false 칸이 있으면 그대로(투어를 아직 안 끝낸 사람)', () => {
  seed({ tourDone: false, autoChainLimit: 5 });
  expect(initAppPrefs(dir, true)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
  expect(saved()).toEqual({ tourDone: false, autoChainLimit: 5 });
});

test('initAppPrefs(dir, false) — 방이 없으면(새 사용자) tourDone:false 를 써 둔다 — 투어 도중 방을 만들고 꺼도 다음에 업데이트로 받은 사람으로 치지 않게', () => {
  seed({ autoChainLimit: 5 });
  expect(initAppPrefs(dir, false)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
  expect(saved()).toEqual({ autoChainLimit: 5, tourDone: false });
  // 다음에 켤 때 방이 있어도 칸이 있으니 그대로 — 투어를 아직 안 끝낸 새 사용자
  expect(initAppPrefs(dir, true)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
  expect(saved()).toEqual({ autoChainLimit: 5, tourDone: false });
});

test('initAppPrefs(dir, false) — settings.json 이 아예 없어도 tourDone:false 를 써 둔다', () => {
  expect(initAppPrefs(dir, false)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
  expect(saved()).toEqual({ tourDone: false });
});

test('initAppPrefs(dir, false) — 이미 tourDone 칸이 있으면 그대로', () => {
  seed({ tourDone: true, approvalTipSeen: true });
  expect(initAppPrefs(dir, false)).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true, trayTipSeen: false });
  expect(saved()).toEqual({ tourDone: true, approvalTipSeen: true });
});

test('initAppPrefs(dir, null) — 방 수를 모르면(엔진 없음 · claude 없음) 쓰지 않고 지금 값', () => {
  expect(initAppPrefs(dir, null)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true, trayTipSeen: false });
  expect(fs.existsSync(file())).toBe(false);
  seed({ autoChainLimit: 5, claudeAutoUpdate: false });
  expect(initAppPrefs(dir, null)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: false, trayTipSeen: false });
  expect(saved()).toEqual({ autoChainLimit: 5, claudeAutoUpdate: false });
});

test('initAppPrefsSafe — 쓰기가 실패하면 던지지 않고 지금 파일을 읽은 값(투어 칸 하나로 시작을 막지 않는다)', () => {
  seed({ autoChainLimit: 5, claudeAutoUpdate: false });
  fs.mkdirSync(`${file()}.tmp`); // 임시 파일 자리를 폴더가 막는다 — 쓰기가 실패한다
  expect(() => initAppPrefs(dir, true)).toThrow();
  const log: unknown[][] = [];
  expect(initAppPrefsSafe(dir, true, (...a) => log.push(a))).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: false, trayTipSeen: false });
  expect(saved()).toEqual({ autoChainLimit: 5, claudeAutoUpdate: false });
  expect(log).toHaveLength(1);
});

test('initAppPrefsSafe — 쓸 수 있으면 initAppPrefs 그대로', () => {
  seed({ autoChainLimit: 5 });
  expect(initAppPrefsSafe(dir, true, () => {})).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true, trayTipSeen: false });
  expect(saved()).toEqual({ autoChainLimit: 5, tourDone: true, approvalTipSeen: true });
});

test('trayTipSeen — 기본 false(트레이 첫 안내 안 봄) · 써 두면 남고 엔진 칸은 그대로 · 업데이트로 받은 사람도 안 본 것으로', () => {
  seed({ autoChainLimit: 5 });
  // 업데이트로 받은 사람(방 있음)도 트레이 안내는 새 기능이라 본 적이 없다
  expect(initAppPrefs(dir, true).trayTipSeen).toBe(false);
  expect(writeAppPrefs(dir, { trayTipSeen: true })).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true, trayTipSeen: true });
  expect(saved()).toEqual({ autoChainLimit: 5, tourDone: true, approvalTipSeen: true, trayTipSeen: true });
  expect(readAppPrefs(dir).trayTipSeen).toBe(true);
  // 다른 칸을 바꿔도 남는다(읽고 합쳐 쓰기)
  expect(writeAppPrefs(dir, { claudeAutoUpdate: false }).trayTipSeen).toBe(true);
  // 불리언이 아니면 기본값
  seed({ trayTipSeen: 'yes' });
  expect(readAppPrefs(dir).trayTipSeen).toBe(false);
});
