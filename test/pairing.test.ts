import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanDeviceName, createPairing, PAIR_FAIL_MAX, PAIR_LOCK_MS, PAIR_TOTAL_FAIL_MAX, TOUCH_MIN_MS,
} from '../src/main/phone/pairing';
import { openPhoneStore, type PhoneStore } from '../src/main/phone/phoneStore';
import { PAIR_TTL_MS, PHONE_IDLE_MS, PHONE_NAME_DEFAULT, PHONE_NAME_MAX, type PhoneDevice } from '../src/shared/phoneTypes';

let dir: string;
let t: number;
const now = () => t;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-pairing-'));
  t = 1_000_000;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 부를 때마다 다른 바이트(1, 2, 3 … 로 채움) — 짝 코드·숫자·토큰이 서로 겹치지 않게 */
function counterBytes() {
  let k = 1;
  return (n: number) => Buffer.alloc(n, k++);
}
const fileText = () => fs.readFileSync(path.join(dir, 'phone.json'), 'utf8');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const wrongPin = (pin: string) => (pin === '000000' ? '111111' : '000000');
/** 쓰기 수를 세는 store — 안은 진짜 store */
function counting(store: PhoneStore) {
  const c = { writes: 0, store: { read: () => store.read(), write: (patch) => { c.writes++; store.write(patch); } } as PhoneStore };
  return c;
}

function ok(r: ReturnType<ReturnType<typeof createPairing>['redeem']>): { token: string; device: PhoneDevice } {
  if ('error' in r) throw new Error(`redeem 실패: ${r.error}`);
  return r;
}

test('짝 코드·숫자 — 한 번만·5분 뒤 만료·새 start 면 앞 것 무효', () => {
  expect(PAIR_TTL_MS).toBe(5 * 60_000);
  const store = openPhoneStore(dir);
  const p = createPairing(store, { now, randomBytes: counterBytes() });

  // 꼴: code 32바이트 hex · pin 6자리 · expiresAt = 지금 + 5분
  const a = p.start();
  expect(a.code).toMatch(/^[0-9a-f]{64}$/);
  expect(a.pin).toMatch(/^\d{6}$/);
  expect(a.expiresAt).toBe(t + PAIR_TTL_MS);

  // 코드로 한 번 — 그 뒤 코드도 숫자도 죽음
  ok(p.redeem(a.code, '안드로이드', 'x'));
  expect(p.redeem(a.code, '또', 'x')).toEqual({ error: 'expired' });
  expect(p.redeem(a.pin, '또', 'x')).toEqual({ error: 'expired' });

  // 숫자로 한 번 — 그 뒤 코드도 죽음
  const b = p.start();
  ok(p.redeem(b.pin, '아이폰', 'x'));
  expect(p.redeem(b.code, '또', 'x')).toEqual({ error: 'expired' });

  // 5분 바로 앞은 되고, 5분이면 만료
  const c = p.start();
  t += PAIR_TTL_MS - 1;
  ok(p.redeem(c.pin, '셋째', 'x'));
  const d = p.start();
  t += PAIR_TTL_MS;
  expect(p.redeem(d.pin, '넷째', 'x')).toEqual({ error: 'expired' });
  expect(p.redeem(d.code, '넷째', 'x')).toEqual({ error: 'expired' });

  // 새 start 면 앞 것 무효(틀림) — 새것은 됨
  const e = p.start();
  const f = p.start();
  expect(f.code).not.toBe(e.code);
  expect(f.pin).not.toBe(e.pin);
  expect(p.redeem(e.code, '옛것', 'x')).toEqual({ error: 'wrong' });
  expect(p.redeem(e.pin, '옛것', 'x')).toEqual({ error: 'wrong' });
  ok(p.redeem(f.code, '새것', 'x'));

  // cancel — 그 코드 죽음
  const g = p.start();
  p.cancel();
  expect(p.redeem(g.pin, '취소', 'x')).toEqual({ error: 'expired' });
  // start 없이 부름도 expired
  expect(createPairing(store, { now }).redeem('123456', 'x', 'x')).toEqual({ error: 'expired' });

  expect(store.read().devices.map((x) => x.name)).toEqual(['안드로이드', '아이폰', '셋째', '새것']);
});

test('토큰 — 파일엔 해시만, verify 됨', () => {
  const store = openPhoneStore(dir);
  const p = createPairing(store, { now });
  const s = p.start();
  const { token, device } = ok(p.redeem(` ${s.pin} `, '내 폰', '127.0.0.1'));

  // 토큰 32바이트 base64url · 기기 꼴
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(device).toEqual({ id: expect.any(String), name: '내 폰', createdAt: t, lastSeen: t, push: false });
  expect(Object.keys(device).sort()).toEqual(['createdAt', 'id', 'lastSeen', 'name', 'push']);

  // 파일엔 sha256 해시만 — 토큰·짝 코드·숫자는 없음
  const text = fileText();
  expect(text).not.toContain(token);
  expect(text).not.toContain(s.code);
  expect(text).not.toContain(`"${s.pin}"`);
  expect(text).not.toMatch(/"(token|code|pin)"/);
  expect(store.read().devices).toEqual([{ ...device, tokenHash: sha256(token) }]);

  // verify — 맞는 토큰이면 그 기기(해시 칸 없이), 아니면 null
  t += 5000;
  const again = createPairing(openPhoneStore(dir), { now }); // 다시 켜도(새 store) 된다
  expect(again.verify(token)).toEqual(device);
  expect(again.verify(`${token}x`)).toBeNull();
  expect(again.verify(token.slice(0, -1))).toBeNull();
  expect(again.verify('')).toBeNull();
  expect(again.verify(sha256(token))).toBeNull(); // 파일의 해시를 토큰으로 내도 안 됨
  expect(again.verify(123 as never)).toBeNull();
  expect(again.verify(undefined as never)).toBeNull();

  // touch — 마지막 접속만 바뀜
  again.touch(device.id);
  expect(again.verify(token)).toEqual({ ...device, lastSeen: t });
  again.touch('없는-id');
  expect(store.read().devices).toHaveLength(1);
});

test('틀림 5번 — 60초 막음', () => {
  expect(PAIR_FAIL_MAX).toBe(5);
  expect(PAIR_LOCK_MS).toBe(60_000);
  const p = createPairing(openPhoneStore(dir), { now });
  const s = p.start();
  const bad = wrongPin(s.pin);

  for (let i = 0; i < 5; i++) {
    expect(p.redeem(bad, '공격', 'evil')).toEqual({ error: 'wrong' });
    t += 1000;
  }
  // 막힌 동안엔 맞는 숫자도 locked(QR 코드는 막지 않는다 — 아래 시험)
  expect(p.redeem(s.pin, '공격', 'evil')).toEqual({ error: 'locked' });
  // 다른 곳(from)은 막히지 않음
  expect(p.redeem(bad, '남', 'other')).toEqual({ error: 'wrong' });

  // 막은 지 60초 바로 앞까지 locked, 60초면 풀림 — 짝 코드는 그대로 살아 있음
  t += PAIR_LOCK_MS - 1000 - 1;
  expect(p.redeem(s.pin, '공격', 'evil')).toEqual({ error: 'locked' });
  t += 1;
  ok(p.redeem(s.pin, '되찾음', 'evil'));
});

test('틀림은 1분 안의 것만 셈 — 띄엄띄엄 틀리면 안 막힘', () => {
  const p = createPairing(openPhoneStore(dir), { now });
  const s = p.start();
  const bad = wrongPin(s.pin);
  for (let i = 0; i < 4; i++) expect(p.redeem(bad, 'x', 'a')).toEqual({ error: 'wrong' });
  t += 60_000; // 앞의 4번은 1분 밖
  for (let i = 0; i < 4; i++) expect(p.redeem(bad, 'x', 'a')).toEqual({ error: 'wrong' });
  expect(p.redeem(bad, 'x', 'a')).toEqual({ error: 'wrong' }); // 1분 안의 5번째 — 여기서 막힘
  expect(p.redeem(bad, 'x', 'a')).toEqual({ error: 'locked' });
  expect(p.redeem(s.pin, 'x', 'a')).toEqual({ error: 'locked' });
});

test('막힘이 풀린 뒤엔 셈이 처음부터', () => {
  const p = createPairing(openPhoneStore(dir), { now });
  const s = p.start();
  const bad = wrongPin(s.pin);
  for (let i = 0; i < 5; i++) p.redeem(bad, 'x', 'a');
  expect(p.redeem(bad, 'x', 'a')).toEqual({ error: 'locked' });
  t += PAIR_LOCK_MS;
  for (let i = 0; i < 4; i++) expect(p.redeem(bad, 'x', 'a')).toEqual({ error: 'wrong' });
  ok(p.redeem(s.pin, 'x', 'a'));
});

test('from 을 바꿔도 짝 하나당 10번', () => {
  const p = createPairing(openPhoneStore(dir), { now });
  // 9번까지는 짝 코드가 살아 있다
  const a = p.start();
  for (let i = 0; i < 9; i++) expect(p.redeem(wrongPin(a.pin), 'x', `from-${i}`)).toEqual({ error: 'wrong' });
  ok(p.redeem(a.pin, '살아 있음', 'other'));

  // 10번째 틀림에서 닫힌다 — 그 뒤엔 맞는 숫자·코드도 expired(다시 start 해야 함)
  const b = p.start();
  for (let i = 0; i < 10; i++) expect(p.redeem(wrongPin(b.pin), 'x', `from-${i}`)).toEqual({ error: 'wrong' });
  expect(p.redeem(b.pin, 'x', 'fresh')).toEqual({ error: 'expired' });
  expect(p.redeem(b.code, 'x', 'fresh')).toEqual({ error: 'expired' });

  // 새 start 면 셈이 처음부터
  const c = p.start();
  ok(p.redeem(c.pin, '새 짝', 'from-0'));
  expect(PAIR_TOTAL_FAIL_MAX).toBe(10);
});

test('QR 코드 꼴·숫자 아닌 글은 셈에 안 듦 · 막혀도 맞는 QR 코드는 됨 · start 하면 셈 지움', () => {
  const p = createPairing(openPhoneStore(dir), { now });
  const s = p.start();
  const otherCode = (s.code[0] === 'a' ? 'b' : 'a') + s.code.slice(1);
  // 틀린 QR 코드(64 hex — 256비트라 맞혀 볼 수 없다)·6자리 숫자가 아닌 글은 몇 번이든 셈에 안 든다
  for (let i = 0; i < 30; i++) expect(p.redeem(otherCode, 'x', 'a')).toEqual({ error: 'wrong' });
  for (const junk of ['', 'abc', '12345', '1234567', '12345a', '１２３４５６', s.code.toUpperCase()]) {
    for (let i = 0; i < 3; i++) expect(p.redeem(junk, 'x', 'a')).toEqual({ error: 'wrong' });
  }
  // 6자리 숫자 틀림만 센다 — 5번째에 막힘
  for (let i = 0; i < 5; i++) expect(p.redeem(wrongPin(s.pin), 'x', 'a')).toEqual({ error: 'wrong' });
  expect(p.redeem(s.pin, 'x', 'a')).toEqual({ error: 'locked' });
  // 막힌 곳이라도 QR 코드는 막지 않는다 — 틀리면 wrong, 맞으면 짝이 맺힘
  expect(p.redeem(otherCode, 'x', 'a')).toEqual({ error: 'wrong' });
  ok(p.redeem(` ${s.code} `, 'QR', 'a'));

  // 새 start 면 앞 짝의 셈·막힘이 지워진다
  const s2 = p.start();
  for (let i = 0; i < 5; i++) p.redeem(wrongPin(s2.pin), 'x', 'b');
  expect(p.redeem(s2.pin, 'x', 'b')).toEqual({ error: 'locked' });
  const s3 = p.start();
  ok(p.redeem(s3.pin, '새 짝', 'b'));
});

test('짝 코드가 없거나 지났거나 취소됐을 때 낸 것은 셈에 안 듦', () => {
  const p = createPairing(openPhoneStore(dir), { now });
  // 셈에 들었다면 5번째 뒤로 locked 가 나왔을 것
  for (let i = 0; i < 12; i++) expect(p.redeem('000000', 'x', 'a')).toEqual({ error: 'expired' });
  const s = p.start();
  t += PAIR_TTL_MS;
  for (let i = 0; i < 12; i++) expect(p.redeem(wrongPin(s.pin), 'x', 'a')).toEqual({ error: 'expired' });
  const s2 = p.start();
  p.cancel();
  for (let i = 0; i < 12; i++) expect(p.redeem(wrongPin(s2.pin), 'x', 'a')).toEqual({ error: 'expired' });
  const s3 = p.start();
  for (let i = 0; i < 4; i++) expect(p.redeem(wrongPin(s3.pin), 'x', 'a')).toEqual({ error: 'wrong' });
  ok(p.redeem(s3.pin, '됨', 'a'));
});

test('저장이 던지면 짝 코드는 살아 있고 셈에도 안 듦', () => {
  const store = openPhoneStore(dir);
  let failNext = true;
  const flaky: PhoneStore = {
    read: () => store.read(),
    write: (patch) => {
      if (failNext) {
        failNext = false;
        throw new Error('디스크 가득');
      }
      store.write(patch);
    },
  };
  const p = createPairing(flaky, { now });
  const s = p.start();
  expect(() => p.redeem(s.pin, '폰', 'a')).toThrow('디스크 가득');
  expect(store.read().devices).toEqual([]);
  const { token, device } = ok(p.redeem(s.pin, '폰', 'a'));
  expect(p.verify(token)).toEqual(device);
  expect(p.redeem(s.code, '또', 'a')).toEqual({ error: 'expired' });
});

test('단조 시계 — 벽시계가 바뀌어도 만료·막힘은 그대로(벽시계는 expiresAt·createdAt·lastSeen 만)', () => {
  let wall = 1_700_000_000_000;
  let mono = 5_000;
  const p = createPairing(openPhoneStore(dir), { now: () => wall, clock: () => mono });
  const a = p.start();
  expect(a.expiresAt).toBe(wall + PAIR_TTL_MS);
  wall += 3_600_000; // 벽시계가 1시간 앞으로 — 짝 코드는 살아 있음
  const { device } = ok(p.redeem(a.pin, 'x', 'z'));
  expect(device).toMatchObject({ createdAt: wall, lastSeen: wall });

  const b = p.start();
  wall -= 7_200_000; // 벽시계가 뒤로 — 그래도 단조 시계로 5분이면 만료
  mono += PAIR_TTL_MS;
  expect(p.redeem(b.pin, 'x', 'z')).toEqual({ error: 'expired' });

  const c = p.start();
  for (let i = 0; i < 5; i++) p.redeem(wrongPin(c.pin), 'x', 'z');
  wall += 10 * PAIR_LOCK_MS; // 벽시계가 앞으로 가도 막힘은 그대로
  expect(p.redeem(c.pin, 'x', 'z')).toEqual({ error: 'locked' });
  mono += PAIR_LOCK_MS;
  ok(p.redeem(c.pin, 'x', 'z'));
});

test('touch — 기기마다 60초에 한 번만 씀 · verify 는 디스크를 다시 읽지 않음', () => {
  const c = counting(openPhoneStore(dir));
  const p = createPairing(c.store, { now });
  const a = ok(p.redeem(p.start().pin, 'a', 'x'));
  expect(c.writes).toBe(1);
  p.touch(a.device.id); // 방금 짝 맺음(lastSeen = 지금) — 안 씀
  t += TOUCH_MIN_MS - 1;
  p.touch(a.device.id);
  expect(c.writes).toBe(1);
  t += 1;
  p.touch(a.device.id);
  expect(c.writes).toBe(2);
  expect(p.verify(a.token)?.lastSeen).toBe(t);
  p.touch(a.device.id);
  expect(c.writes).toBe(2);

  // 기기마다 따로 · 없는 id 는 안 씀
  const b = ok(p.redeem(p.start().pin, 'b', 'x'));
  expect(c.writes).toBe(3);
  t += TOUCH_MIN_MS;
  p.touch(a.device.id);
  p.touch(b.device.id);
  expect(c.writes).toBe(5);
  p.touch('없는-id');
  expect(c.writes).toBe(5);

  // verify 는 store 의 캐시를 본다 — 디스크를 다시 읽지 않음
  const readFile = vi.spyOn(fs, 'readFileSync');
  for (let i = 0; i < 20; i++) expect(p.verify(a.token)?.id).toBe(a.device.id);
  expect(readFile).not.toHaveBeenCalled();
  expect(TOUCH_MIN_MS).toBe(60_000);
});

test('끊기 — 그 토큰 verify null', () => {
  const store = openPhoneStore(dir);
  const p = createPairing(store, { now });
  const one = ok(p.redeem(p.start().pin, '하나', 'x'));
  const two = ok(p.redeem(p.start().code, '둘', 'x'));
  expect(one.device.id).not.toBe(two.device.id);
  expect(p.verify(one.token)?.id).toBe(one.device.id);

  p.unpair(one.device.id);
  expect(p.verify(one.token)).toBeNull();
  expect(p.verify(two.token)).toEqual(two.device);
  expect(store.read().devices.map((d) => d.id)).toEqual([two.device.id]);
  expect(fileText()).not.toContain(sha256(one.token));

  p.unpair('없는-id'); // 아무 일 없음
  expect(store.read().devices).toHaveLength(1);
});

test('짝 숫자 — 치우침 없이(범위 밖 4바이트는 버리고 다시 뽑음)', () => {
  const draws = [Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from([0, 0, 0, 7])];
  const rb = (n: number) => (n === 4 ? draws.shift()! : Buffer.alloc(n, 9));
  const s = createPairing(openPhoneStore(dir), { now, randomBytes: rb }).start();
  expect(s.pin).toBe('000007');
  expect(s.code).toBe('09'.repeat(32));
  expect(draws).toHaveLength(0);
});

test('기기 이름 — 앞뒤 빈칸·제어 문자 빼고 40자, 비면 휴대폰', () => {
  expect(PHONE_NAME_MAX).toBe(40);
  expect(PHONE_NAME_DEFAULT).toBe('휴대폰');
  expect(cleanDeviceName('  갤럭시  ')).toBe('갤럭시');
  expect(cleanDeviceName('가\n\t나\u0000다')).toBe('가 나 다');
  expect(cleanDeviceName('\u202E뒤집기\u2066')).toBe('뒤집기');
  expect(cleanDeviceName('   ')).toBe('휴대폰');
  expect(cleanDeviceName('')).toBe('휴대폰');
  expect(cleanDeviceName(undefined as never)).toBe('휴대폰');
  expect(cleanDeviceName('가'.repeat(50))).toBe('가'.repeat(40));
  expect(cleanDeviceName('😀'.repeat(41))).toBe('😀'.repeat(40)); // 서로게이트 쌍을 자르지 않음

  // 안 보이는 서식 문자(\p{Cf}) — 너비 없는 빈칸·단어 잇기·소프트 하이픈·BOM·태그 문자는 지움
  expect(cleanDeviceName('갤\u200B럭\u2060시\u00AD폰\uFEFF')).toBe('갤럭시폰');
  expect(cleanDeviceName('폰\u{E0041}\u{E0001}\u{E007F}')).toBe('폰');
  expect(cleanDeviceName('\u200B \u2060\u00AD')).toBe('휴대폰');
  // 짝 없는 서로게이트는 지움
  expect(cleanDeviceName('가\uD800나\uDC00다')).toBe('가나다');
  expect(cleanDeviceName('\uDBFF')).toBe('휴대폰');
  // ZWJ·변형 선택자는 남김(이어 붙인 이모지) — 앞뒤에 홀로 있는 ZWJ 는 지움
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  expect(cleanDeviceName(`내 ${family}`)).toBe(`내 ${family}`);
  expect(cleanDeviceName('❤\uFE0F 폰')).toBe('❤\uFE0F 폰');
  expect(cleanDeviceName('\u200D폰\u200D')).toBe('폰');
  expect(cleanDeviceName('\u200D')).toBe('휴대폰');
  // 40자는 글자(그래핌) 단위 — 이어 붙인 이모지·결합 문자를 자르지 않음
  expect(cleanDeviceName(`${'가'.repeat(39)}${family}나`)).toBe(`${'가'.repeat(39)}${family}`);
  expect(cleanDeviceName(`${'가'.repeat(40)}${family}`)).toBe('가'.repeat(40));
  expect(cleanDeviceName('e\u0301'.repeat(41))).toBe('e\u0301'.repeat(40));
  expect(cleanDeviceName(`${'가'.repeat(39)} \u200D나`)).toBe(`${'가'.repeat(39)}`); // 자른 끝의 빈칸·ZWJ 도 지움

  const p = createPairing(openPhoneStore(dir), { now });
  expect(ok(p.redeem(p.start().pin, ' \n ', 'x')).device.name).toBe('휴대폰');
});

test('open — 짝 코드가 살아 있는 동안만 true(썼음·취소·5분 지남·틀림 상한이면 false)', () => {
  const p = createPairing(openPhoneStore(dir), { now });
  expect(p.open()).toBe(false);
  const a = p.start();
  expect(p.open()).toBe(true);
  ok(p.redeem(a.pin, '폰', 'x'));
  expect(p.open()).toBe(false);

  p.start();
  p.cancel();
  expect(p.open()).toBe(false);

  p.start();
  t += PAIR_TTL_MS;
  expect(p.open()).toBe(false);

  const b = p.start();
  for (let i = 0; i < PAIR_TOTAL_FAIL_MAX - 1; i++) p.redeem(wrongPin(b.pin), 'x', `from-${i}`);
  expect(p.open()).toBe(true);
  p.redeem(wrongPin(b.pin), 'x', 'from-last');
  expect(p.open()).toBe(false);
});

test('idleDeviceExpires — 30일 + 1ms 안 쓴 기기는 verify 가 null 이고 저장소에서도 빠짐 · 29일째 쓰면 계속 통함', () => {
  const expired: string[] = [];
  const p = createPairing(openPhoneStore(dir), { now, randomBytes: counterBytes(), onExpire: (id) => expired.push(id) });
  const s = p.start();
  const a = ok(p.redeem(s.pin, 'A', 'x'));
  const s2 = p.start();
  const b = ok(p.redeem(s2.pin, 'B', 'x'));
  expect(PHONE_IDLE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  // 29일째 B 가 쓴다 → lastSeen 갱신
  t += 29 * 24 * 60 * 60 * 1000;
  expect(p.verify(b.token)?.id).toBe(b.device.id);
  p.touch(b.device.id);
  // A 는 짝 맺은 지 30일 + 1ms — 풀림
  t += 24 * 60 * 60 * 1000 + 1;
  expect(p.verify(a.token)).toBeNull();
  expect(expired).toEqual([a.device.id]);
  expect(openPhoneStore(dir).read().devices.map((d) => d.id)).toEqual([b.device.id]);
  // B 는 29일째 썼으니 아직 통하고, 또 쓰면 계속 통함
  expect(p.verify(b.token)?.id).toBe(b.device.id);
  p.touch(b.device.id);
  t += 29 * 24 * 60 * 60 * 1000;
  expect(p.verify(b.token)?.id).toBe(b.device.id);
  // 정확히 30일은 아직 통함
  const c = p.start();
  const d = ok(p.redeem(c.pin, 'C', 'x'));
  t += PHONE_IDLE_MS;
  expect(p.verify(d.token)?.id).toBe(d.device.id);
  t += 1;
  expect(p.verify(d.token)).toBeNull();
});

test('idleDeviceExpires — expireIdle 은 켤 때 낡은 기기를 한꺼번에 지우고 lastSeen 이 없으면 createdAt 으로 센다', () => {
  const expired: string[] = [];
  const store = openPhoneStore(dir);
  const p = createPairing(store, { now, randomBytes: counterBytes(), onExpire: (id) => expired.push(id) });
  const s = p.start();
  const a = ok(p.redeem(s.pin, 'A', 'x'));
  const f = store.read();
  store.write({ devices: f.devices.map((d) => ({ ...d, lastSeen: null })) });
  t += PHONE_IDLE_MS + 1;
  expect(p.expireIdle()).toEqual([a.device.id]);
  expect(expired).toEqual([a.device.id]);
  expect(store.read().devices).toEqual([]);
  expect(p.expireIdle()).toEqual([]);
});

test('newPairingClearsLock — 틀림 상한으로 막히고 짝이 닫힌 뒤에도 PC 가 새 짝 맺기를 시작하면 바로 낼 수 있음', () => {
  const p = createPairing(openPhoneStore(dir), { now, randomBytes: counterBytes() });
  const s = p.start();
  for (let i = 0; i < PAIR_FAIL_MAX; i++) p.redeem(wrongPin(s.pin), 'x', '127.0.0.1');
  expect(p.redeem(s.pin, 'x', '127.0.0.1')).toEqual({ error: 'locked' });
  const s2 = p.start();
  ok(p.redeem(s2.pin, '내 폰', '127.0.0.1'));
  // 총 상한으로 짝이 닫힌 경우도
  const s3 = p.start();
  for (let i = 0; i < PAIR_TOTAL_FAIL_MAX; i++) p.redeem(wrongPin(s3.pin), 'x', `h${i}`);
  expect(p.open()).toBe(false);
  const s4 = p.start();
  ok(p.redeem(s4.pin, '다시', 'h0'));
});
