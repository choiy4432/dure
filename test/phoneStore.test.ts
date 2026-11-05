import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPhoneStore, pickSubscription, publicDevice, type StoredPhoneDevice } from '../src/main/phone/phoneStore';
import { DEFAULT_PHONE_SETTINGS, PHONE_PORT_DEFAULT } from '../src/shared/phoneTypes';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-phonestore-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, 'phone.json');
const saved = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
const seed = (v: unknown) => fs.writeFileSync(file(), typeof v === 'string' ? v : JSON.stringify(v));
const HASH = 'a'.repeat(64);
const dev = (over: Partial<StoredPhoneDevice> = {}): StoredPhoneDevice => ({
  id: 'd1', name: '내 휴대폰', createdAt: 1000, lastSeen: null, push: false, tokenHash: HASH, ...over,
});
/** 브라우저가 주는 꼴 — p256dh 65바이트(87자) · auth 16바이트(22자) base64url */
const P256DH = Buffer.alloc(65, 4).toString('base64url');
const AUTH = Buffer.alloc(16, 7).toString('base64url');
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } };
const EMPTY = { settings: DEFAULT_PHONE_SETTINGS, devices: [] };

test('파일 없음 — 기본값(꺼짐·절전 막기 켬·자동 켜기 끔·승인 알림 켬·끝 알림 끔·포트 47615)', () => {
  expect(PHONE_PORT_DEFAULT).toBe(47615);
  expect(DEFAULT_PHONE_SETTINGS).toEqual({
    enabled: false, keepAwake: true, openAtLogin: false, notify: { asks: true, finished: false }, port: 47615,
  });
  expect(openPhoneStore(dir).read()).toEqual(EMPTY);
  expect(openPhoneStore(path.join(dir, '없는-폴더')).read()).toEqual(EMPTY);
});

test('깨진 phone.json — 기본값 · phone.json.broken-<시각> 으로 옮김(앞의 것은 안 덮음)', () => {
  const at = 1_700_000_000_000;
  const open = () => openPhoneStore(dir, { now: () => at });
  const broken = (n: number) => `${file()}.broken-${n}`;
  seed('{깨짐');
  expect(open().read()).toEqual(EMPTY);
  expect(fs.readFileSync(broken(at), 'utf8')).toBe('{깨짐');
  expect(fs.existsSync(file())).toBe(false);
  // 객체가 아닌 JSON(배열·null)도 깨진 것 — 같은 시각이어도 앞의 깨진 사본을 덮지 않는다
  seed([1, 2]);
  expect(open().read()).toEqual(EMPTY);
  seed('null');
  expect(open().read().devices).toEqual([]);
  expect(fs.readFileSync(broken(at), 'utf8')).toBe('{깨짐');
  expect(fs.readFileSync(broken(at + 1), 'utf8')).toBe('[1,2]');
  expect(fs.readFileSync(broken(at + 2), 'utf8')).toBe('null');
  expect(fs.existsSync(`${file()}.bad`)).toBe(false);
  // 시각을 안 주면 지금 시각
  seed('{또');
  expect(openPhoneStore(dir).read()).toEqual(EMPTY);
  expect(fs.readdirSync(dir).filter((f) => /^phone\.json\.broken-\d+$/.test(f))).toHaveLength(4);
  // 그 뒤 쓰기는 새 파일로
  open().write({ settings: { enabled: true } });
  expect(saved()).toEqual({ settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true }, devices: [] });
});

test('깨진 phone.json 을 옮기지 못하면 read·write 가 던진다 — 다음 쓰기가 원본을 덮지 않게', () => {
  seed('{깨짐');
  const realRename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).startsWith(`${file()}.`)) throw Object.assign(new Error('옮기지 못함'), { code: 'EIO' });
    realRename(from, to);
  });
  const store = openPhoneStore(dir);
  expect(() => store.read()).toThrow('옮기지 못함');
  expect(() => store.write({ settings: { enabled: true } })).toThrow('옮기지 못함');
  expect(fs.readFileSync(file(), 'utf8')).toBe('{깨짐');
});

test('phone.json 을 못 읽으면(폴더·잠김) read·write 가 던지고 기기는 그대로', () => {
  // 폴더(EISDIR) — 옮기지도, 새로 쓰지도, .tmp 를 남기지도 않음
  fs.mkdirSync(file());
  const a = openPhoneStore(dir);
  expect(() => a.read()).toThrow();
  expect(() => a.write({ settings: { enabled: true } })).toThrow();
  expect(fs.statSync(file()).isDirectory()).toBe(true);
  expect(fs.readdirSync(dir)).toEqual(['phone.json']);
  fs.rmdirSync(file());

  // 잠김(EBUSY) — 기기가 든 파일을 기본값으로 덮지 않음
  seed({ devices: [dev()] });
  const before = fs.readFileSync(file(), 'utf8');
  const realRead = fs.readFileSync;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: never[]) => {
    if (String(p) === file()) throw Object.assign(new Error('잠김'), { code: 'EBUSY' });
    return (realRead as (...x: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);
  const b = openPhoneStore(dir);
  expect(() => b.read()).toThrow('잠김');
  expect(() => b.write({ devices: [] })).toThrow('잠김');
  spy.mockRestore();
  expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  expect(b.read().devices).toEqual([dev()]); // 던진 것은 캐시하지 않아 다시 읽힘
});

test('write — 바꾼 칸만 합치고(notify 도 칸별로) 기기·VAPID 는 그대로 · .tmp 안 남음 · 폴더 없으면 만듦', () => {
  const sub = path.join(dir, 'Dure');
  const store = openPhoneStore(sub);
  store.write({ devices: [dev()], vapid: { publicKey: 'pub', privateKey: 'priv' } });
  store.write({ settings: { enabled: true, notify: { finished: true } } });
  store.write({ settings: { port: 47616 } });
  const want = {
    settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true, notify: { asks: true, finished: true }, port: 47616 },
    devices: [dev()],
    vapid: { publicKey: 'pub', privateKey: 'priv' },
  };
  expect(store.read()).toEqual(want);
  expect(openPhoneStore(sub).read()).toEqual(want); // 디스크에도
  expect(fs.existsSync(path.join(sub, 'phone.json.tmp'))).toBe(false);
  // devices 를 주면 통째로 바뀐다
  store.write({ devices: [] });
  expect(store.read().devices).toEqual([]);
  expect(store.read().vapid).toEqual({ publicKey: 'pub', privateKey: 'priv' });
});

test('write — 틀린 설정 값(포트 범위 밖·불리언 아님)은 무시하고 지금 값 그대로', () => {
  const store = openPhoneStore(dir);
  store.write({ settings: { port: 50000, keepAwake: false } });
  store.write({ settings: { port: 0, enabled: 'yes', keepAwake: 1, notify: { asks: null } } as never });
  store.write({ settings: { port: 70000 } });
  store.write({ settings: { port: 1.5 } });
  expect(store.read().settings).toEqual({ ...DEFAULT_PHONE_SETTINGS, port: 50000, keepAwake: false });
});

test('write — 틀린 기기 줄·VAPID 는 던지고 아무것도 쓰지 않음(오류 글에 값 없음)', () => {
  const store = openPhoneStore(dir);
  store.write({ devices: [dev()], vapid: { publicKey: 'pub', privateKey: 'priv' } });
  const before = fs.readFileSync(file(), 'utf8');
  const secretish = `${'b'.repeat(63)}X`;
  const bad: unknown[] = [
    { devices: 'x' },
    { devices: ['garbage'] },
    { devices: [dev({ id: '' })] },
    { devices: [{ ...dev(), tokenHash: secretish }] },
    { devices: [dev(), dev()] }, // 겹친 id
    { devices: [{ ...dev(), name: 3 }] },
    { devices: [{ ...dev(), createdAt: Number.NaN }] },
    { devices: [{ ...dev(), lastSeen: 'x' }] },
    { devices: [{ ...dev(), subscription: { ...SUB, endpoint: 'http://x' } }] },
    { settings: { enabled: true }, vapid: { publicKey: secretish } },
    { vapid: 'x' },
    { vapid: null },
  ];
  for (const patch of bad) {
    let err: unknown = null;
    try {
      store.write(patch as never);
    } catch (e) {
      err = e;
    }
    expect(err, JSON.stringify(patch)).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('bbbb');
  }
  expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  expect(store.read()).toEqual({ settings: DEFAULT_PHONE_SETTINGS, devices: [dev()], vapid: { publicKey: 'pub', privateKey: 'priv' } });
  // 맞는 줄은 됨(이름은 다듬어서)
  store.write({ devices: [dev(), { ...dev({ id: 'd2', name: '  둘\n' }), subscription: SUB }] });
  expect(store.read().devices.map((d) => d.name)).toEqual(['내 휴대폰', '둘']);
});

test('read 는 이 프로세스의 캐시 — 처음 한 번만 디스크를 읽고, 돌려준 값을 고쳐도 캐시는 그대로', () => {
  seed({ settings: { enabled: true }, devices: [dev()] });
  const store = openPhoneStore(dir);
  const first = store.read();
  const readFile = vi.spyOn(fs, 'readFileSync');
  for (let i = 0; i < 5; i++) store.read();
  store.write({ settings: { keepAwake: false } });
  expect(store.read().settings).toEqual({ ...DEFAULT_PHONE_SETTINGS, enabled: true, keepAwake: false });
  expect(readFile).not.toHaveBeenCalled();
  // 돌려준 값을 고쳐도
  first.devices.push(dev({ id: 'x' }));
  first.settings.notify.asks = false;
  store.read().devices[0].name = '바뀜';
  expect(store.read().devices).toEqual([dev()]);
  expect(store.read().settings.notify.asks).toBe(true);
});

test('read — 손댄 파일: 틀린 칸은 기본값, 깨진 기기 줄은 버림(옮기지 않음)', () => {
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
  expect(fs.readdirSync(dir)).toEqual(['phone.json']);
});

test('구독 — 꼴이 맞을 때만 남김(https 주소 · base64url p256dh 65바이트 · auth 16바이트)', () => {
  expect(P256DH).toHaveLength(87);
  expect(AUTH).toHaveLength(22);
  expect(pickSubscription(SUB)).toEqual(SUB);
  expect(pickSubscription({ endpoint: SUB.endpoint, keys: SUB.keys })).toEqual({ endpoint: SUB.endpoint, keys: SUB.keys });
  // 덧붙임(=)이 붙은 꼴도 됨
  expect(pickSubscription({ ...SUB, keys: { p256dh: `${P256DH}=`, auth: `${AUTH}==` } })).not.toBeNull();
  // 주소 — https 이고 호스트가 있어야 · 2048자까지 · 빈칸·제어 문자·ASCII 밖 없음
  const max = `https://a.com/${'x'.repeat(2048 - 'https://a.com/'.length)}`;
  expect(max).toHaveLength(2048);
  expect(pickSubscription({ ...SUB, endpoint: max })).not.toBeNull();
  for (const endpoint of [
    'http://x', 'https://', 'https:///', 'https:// x', 'https://ex ample.com/x', ` ${SUB.endpoint}`, `${SUB.endpoint}\n`,
    'https://가.com/x', 'javascript:alert(1)', 'nope', `${max}x`, 123, undefined,
  ]) {
    expect(pickSubscription({ ...SUB, endpoint }), String(endpoint)).toBeNull();
  }
  // 열쇠 — base64url · 길이
  for (const keys of [
    { p256dh: P256DH },
    { p256dh: P256DH, auth: '' },
    { p256dh: 'P', auth: 'A' },
    { p256dh: P256DH.slice(1), auth: AUTH },
    { p256dh: `${P256DH}A`, auth: AUTH },
    { p256dh: `${P256DH}==`, auth: AUTH },
    { p256dh: P256DH, auth: `${AUTH}A` },
    { p256dh: P256DH, auth: `${AUTH}=` },
    { p256dh: `+${P256DH.slice(1)}`, auth: AUTH },
    { p256dh: P256DH, auth: `${AUTH.slice(1)}/` },
    { p256dh: 7, auth: AUTH },
  ]) {
    expect(pickSubscription({ ...SUB, keys }), JSON.stringify(keys)).toBeNull();
  }
  expect(pickSubscription('x')).toBeNull();
  expect(pickSubscription(null)).toBeNull();
  // 저장된 기기 줄의 깨진 구독은 빠지고 기기는 남는다
  seed({ devices: [{ ...dev(), subscription: { endpoint: 'nope' } }, { ...dev({ id: 'd2' }), subscription: SUB }] });
  expect(openPhoneStore(dir).read().devices).toEqual([dev(), { ...dev({ id: 'd2', push: true }), subscription: SUB }]);
});

test('push 는 구독이 있는지로 — 따로 저장하지 않음', () => {
  const store = openPhoneStore(dir);
  store.write({ devices: [dev({ id: 'a', push: true }), { ...dev({ id: 'b', push: false }), subscription: SUB }] });
  expect(store.read().devices.map((d) => [d.id, d.push])).toEqual([['a', false], ['b', true]]);
  expect(openPhoneStore(dir).read().devices.map((d) => [d.id, d.push])).toEqual([['a', false], ['b', true]]);
  expect(saved().devices.map((d: object) => 'push' in d)).toEqual([false, false]);
  // 손댄 파일의 push 도 안 봄
  seed({ devices: [dev({ id: 'c', push: true })] });
  expect(openPhoneStore(dir).read().devices[0].push).toBe(false);
  // 화면용 칸도
  expect(publicDevice(dev({ push: true })).push).toBe(false);
  expect(publicDevice({ ...dev(), subscription: SUB }).push).toBe(true);
  expect(publicDevice({ ...dev(), subscription: SUB })).not.toHaveProperty('subscription');
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

test('serve 길 기록 · https 포트 — 쓰고 다시 읽힘 · serve:null 이면 지움(포트는 남음) · 꼴이 틀리면 write 가 던짐 · 손댄 칸은 버림', () => {
  const s = openPhoneStore(dir);
  const rec = { httpsPort: 443, localPort: 47616, dnsName: 'pc.tail0000.ts.net' };
  s.write({ serve: rec, httpsPort: 443 });
  expect(saved().serve).toEqual(rec);
  expect(saved().httpsPort).toBe(443);
  expect(openPhoneStore(dir).read()).toMatchObject({ serve: rec, httpsPort: 443 });
  s.write({ serve: { httpsPort: 443, localPort: 47615 } }); // 이름 없이 — https 켜기 링크를 받으려고 열어 본 것
  expect(saved().serve).toEqual({ httpsPort: 443, localPort: 47615 });
  s.write({ devices: [] }); // 다른 칸을 써도 그대로
  expect(saved().serve).toEqual({ httpsPort: 443, localPort: 47615 });
  s.write({ serve: null });
  expect(saved().serve).toBeUndefined();
  expect(saved().httpsPort).toBe(443);

  for (const bad of [{ httpsPort: 0, localPort: 1 }, { httpsPort: 443, localPort: '1' }, { httpsPort: 443, localPort: 1, dnsName: 'Bad Name' }, 'x']) {
    expect(() => s.write({ serve: bad as never }), JSON.stringify(bad)).toThrow('serve 길 기록 꼴이 틀렸어요');
  }
  expect(() => s.write({ httpsPort: 70000 })).toThrow('https 포트 꼴이 틀렸어요');
  expect(saved().serve).toBeUndefined();

  seed({ settings: {}, devices: [], serve: { httpsPort: 443, localPort: 1, dnsName: '../x' }, httpsPort: 'x' });
  const f = openPhoneStore(dir).read();
  expect(f.serve).toBeUndefined();
  expect(f.httpsPort).toBeUndefined();
});
