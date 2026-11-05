import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPhoneStore, pickSubscription, type StoredPhoneDevice } from '../src/main/phone/phoneStore';
import { DEFAULT_PHONE_SETTINGS, PHONE_PORT_DEFAULT } from '../src/shared/phoneTypes';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-phonestore-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, 'phone.json');
const saved = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
const seed = (v: unknown) => fs.writeFileSync(file(), typeof v === 'string' ? v : JSON.stringify(v));
const HASH = 'a'.repeat(64);
const dev = (over: Partial<StoredPhoneDevice> = {}): StoredPhoneDevice => ({
  id: 'd1', name: '내 휴대폰', createdAt: 1000, lastSeen: null, push: false, tokenHash: HASH, ...over,
});

test('파일 없음 — 기본값(꺼짐·절전 막기 켬·자동 켜기 끔·승인 알림 켬·끝 알림 끔·포트 47615)', () => {
  expect(PHONE_PORT_DEFAULT).toBe(47615);
  expect(DEFAULT_PHONE_SETTINGS).toEqual({
    enabled: false, keepAwake: true, openAtLogin: false, notify: { asks: true, finished: false }, port: 47615,
  });
  expect(openPhoneStore(dir).read()).toEqual({ settings: DEFAULT_PHONE_SETTINGS, devices: [] });
  expect(openPhoneStore(path.join(dir, '없는-폴더')).read()).toEqual({ settings: DEFAULT_PHONE_SETTINGS, devices: [] });
});

test('깨진 phone.json — 기본값·.bad 남김', () => {
  seed('{깨짐');
  const store = openPhoneStore(dir);
  expect(store.read()).toEqual({ settings: DEFAULT_PHONE_SETTINGS, devices: [] });
  expect(fs.readFileSync(`${file()}.bad`, 'utf8')).toBe('{깨짐');
  expect(fs.existsSync(file())).toBe(false);
  // 객체가 아닌 JSON(배열·null)도 깨진 것 — 앞의 .bad 는 새것으로 바뀐다
  seed([1, 2]);
  expect(store.read()).toEqual({ settings: DEFAULT_PHONE_SETTINGS, devices: [] });
  expect(fs.readFileSync(`${file()}.bad`, 'utf8')).toBe('[1,2]');
  seed('null');
  expect(store.read().devices).toEqual([]);
  expect(fs.readFileSync(`${file()}.bad`, 'utf8')).toBe('null');
  // 그 뒤 쓰기는 새 파일로
  store.write({ settings: { enabled: true } });
  expect(saved()).toEqual({ settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true }, devices: [] });
});

test('write — 바꾼 칸만 합치고(notify 도 칸별로) 기기·VAPID 는 그대로 · .tmp 안 남음 · 폴더 없으면 만듦', () => {
  const sub = path.join(dir, 'Dure');
  const store = openPhoneStore(sub);
  store.write({ devices: [dev()], vapid: { publicKey: 'pub', privateKey: 'priv' } });
  store.write({ settings: { enabled: true, notify: { finished: true } } });
  store.write({ settings: { port: 47616 } });
  expect(store.read()).toEqual({
    settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true, notify: { asks: true, finished: true }, port: 47616 },
    devices: [dev()],
    vapid: { publicKey: 'pub', privateKey: 'priv' },
  });
  expect(fs.existsSync(path.join(sub, 'phone.json.tmp'))).toBe(false);
  // devices 를 주면 통째로 바뀐다
  store.write({ devices: [] });
  expect(store.read().devices).toEqual([]);
  expect(store.read().vapid).toEqual({ publicKey: 'pub', privateKey: 'priv' });
});

test('write — 틀린 값(포트 범위 밖·불리언 아님)은 무시하고 지금 값 그대로', () => {
  const store = openPhoneStore(dir);
  store.write({ settings: { port: 50000, keepAwake: false } });
  store.write({ settings: { port: 0, enabled: 'yes', keepAwake: 1, notify: { asks: null } } as never });
  store.write({ settings: { port: 70000 } });
  store.write({ settings: { port: 1.5 } });
  expect(store.read().settings).toEqual({ ...DEFAULT_PHONE_SETTINGS, port: 50000, keepAwake: false });
});

test('read — 손댄 파일: 틀린 칸은 기본값, 깨진 기기 줄은 버림(.bad 아님)', () => {
  seed({
    settings: { enabled: true, keepAwake: 'no', notify: { asks: false, finished: 'x' }, port: -1 },
    devices: [
      dev({ id: 'ok' }),
      { ...dev({ id: 'bad-hash' }), tokenHash: 'xyz' },
      { ...dev(), id: '' },
      'garbage',
      dev({ id: 'ok' }), // 겹친 id 는 앞 것만
      { id: 'loose', tokenHash: HASH, name: '  가\n나  ', createdAt: 'x', lastSeen: 'y', push: 'z' },
    ],
    vapid: { publicKey: 'pub' },
  });
  expect(openPhoneStore(dir).read()).toEqual({
    settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true, notify: { asks: false, finished: false } },
    devices: [dev({ id: 'ok' }), { id: 'loose', name: '가 나', createdAt: 0, lastSeen: null, push: false, tokenHash: HASH }],
  });
  expect(fs.existsSync(`${file()}.bad`)).toBe(false);
});

test('구독 — 꼴이 맞을 때만 남김(https endpoint · p256dh · auth)', () => {
  const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'P', auth: 'A' } };
  expect(pickSubscription(good)).toEqual(good);
  expect(pickSubscription({ endpoint: good.endpoint, keys: good.keys })).toEqual({ endpoint: good.endpoint, keys: good.keys });
  expect(pickSubscription({ ...good, endpoint: 'http://x' })).toBeNull();
  expect(pickSubscription({ ...good, keys: { p256dh: 'P' } })).toBeNull();
  expect(pickSubscription({ ...good, keys: { p256dh: 'P', auth: '' } })).toBeNull();
  expect(pickSubscription('x')).toBeNull();
  expect(pickSubscription(null)).toBeNull();
  // 저장된 기기 줄의 깨진 구독은 빠지고 기기는 남는다
  seed({ devices: [{ ...dev(), subscription: { endpoint: 'nope' } }, { ...dev({ id: 'd2', push: true }), subscription: good }] });
  expect(openPhoneStore(dir).read().devices).toEqual([dev(), { ...dev({ id: 'd2', push: true }), subscription: good }]);
});

test('BOM 붙은 파일도 읽는다 · 남은 .tmp 는 무시하고 덮어 쓴다', () => {
  seed(`\uFEFF${JSON.stringify({ settings: { enabled: true } })}`);
  fs.writeFileSync(`${file()}.tmp`, '{반쯤');
  const store = openPhoneStore(dir);
  expect(store.read().settings.enabled).toBe(true);
  store.write({ settings: { keepAwake: false } });
  expect(saved().settings).toEqual({ ...DEFAULT_PHONE_SETTINGS, enabled: true, keepAwake: false });
  expect(fs.existsSync(`${file()}.tmp`)).toBe(false);
});
