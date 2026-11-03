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
  expect(readAppPrefs(dir)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true });
  expect(readAppPrefs(path.join(dir, '없는-폴더'))).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true });
});

test('settings.json 이 깨졌거나 배열이면 기본값', () => {
  seed('{깨짐');
  expect(readAppPrefs(dir)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true });
  seed([1, 2]);
  expect(readAppPrefs(dir)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true });
});

test('write 는 엔진 칸(autoChainLimit 등)을 지우지 않고 바꾼 칸만 더한다', () => {
  seed({ autoChainLimit: 5, theme: 'dark', approvalTipSeen: true });
  expect(writeAppPrefs(dir, { tourDone: true })).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true });
  expect(saved()).toEqual({ autoChainLimit: 5, theme: 'dark', approvalTipSeen: true, tourDone: true });
  expect(writeAppPrefs(dir, { claudeAutoUpdate: false })).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: false });
  expect(saved()).toEqual({ autoChainLimit: 5, theme: 'dark', approvalTipSeen: true, tourDone: true, claudeAutoUpdate: false });
  expect(readAppPrefs(dir)).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: false });
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
    .toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true });
  expect(saved()).toEqual({ autoChainLimit: 5 });
  // 파일에 손으로 넣은 'yes' 도 기본값으로 읽는다
  seed({ tourDone: 'yes', claudeAutoUpdate: 0 });
  expect(readAppPrefs(dir)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true });
});

test('initAppPrefs(dir, true) — tourDone 칸이 없으면(업데이트로 받은 사람) tourDone·approvalTipSeen 을 true 로 써 둔다', () => {
  seed({ autoChainLimit: 5 });
  expect(initAppPrefs(dir, true)).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true });
  expect(saved()).toEqual({ autoChainLimit: 5, tourDone: true, approvalTipSeen: true });
});

test('initAppPrefs(dir, true) — settings.json 이 아예 없어도 써 둔다', () => {
  expect(initAppPrefs(dir, true)).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true });
  expect(saved()).toEqual({ tourDone: true, approvalTipSeen: true });
});

test('initAppPrefs — 이미 tourDone:false 칸이 있으면 그대로(투어를 아직 안 끝낸 사람)', () => {
  seed({ tourDone: false, autoChainLimit: 5 });
  expect(initAppPrefs(dir, true)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true });
  expect(saved()).toEqual({ tourDone: false, autoChainLimit: 5 });
});

test('initAppPrefs(dir, false) — 방이 없으면(새 사용자) 쓰지 않고 기본값', () => {
  expect(initAppPrefs(dir, false)).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: true });
  expect(fs.existsSync(file())).toBe(false);
});

test('initAppPrefsSafe — 쓰기가 실패하면 던지지 않고 지금 파일을 읽은 값(투어 칸 하나로 시작을 막지 않는다)', () => {
  seed({ autoChainLimit: 5, claudeAutoUpdate: false });
  fs.mkdirSync(`${file()}.tmp`); // 임시 파일 자리를 폴더가 막는다 — 쓰기가 실패한다
  expect(() => initAppPrefs(dir, true)).toThrow();
  const log: unknown[][] = [];
  expect(initAppPrefsSafe(dir, true, (...a) => log.push(a))).toEqual({ tourDone: false, approvalTipSeen: false, claudeAutoUpdate: false });
  expect(saved()).toEqual({ autoChainLimit: 5, claudeAutoUpdate: false });
  expect(log).toHaveLength(1);
});

test('initAppPrefsSafe — 쓸 수 있으면 initAppPrefs 그대로', () => {
  seed({ autoChainLimit: 5 });
  expect(initAppPrefsSafe(dir, true, () => {})).toEqual({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true });
  expect(saved()).toEqual({ autoChainLimit: 5, tourDone: true, approvalTipSeen: true });
});
