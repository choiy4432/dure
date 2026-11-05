import { afterEach, beforeEach, expect, test } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanDeviceName, createPairing, PAIR_FAIL_MAX, PAIR_LOCK_MS } from '../src/main/phone/pairing';
import { openPhoneStore } from '../src/main/phone/phoneStore';
import { PAIR_TTL_MS, PHONE_NAME_DEFAULT, PHONE_NAME_MAX, type PhoneDevice } from '../src/shared/phoneTypes';

let dir: string;
let t: number;
const now = () => t;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-pairing-'));
  t = 1_000_000;
});
afterEach(() => {
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
  // 막힌 동안엔 맞는 숫자·코드도 locked
  expect(p.redeem(s.pin, '공격', 'evil')).toEqual({ error: 'locked' });
  expect(p.redeem(s.code, '공격', 'evil')).toEqual({ error: 'locked' });
  // 다른 곳(from)은 막히지 않음
  expect(p.redeem(bad, '남', 'other')).toEqual({ error: 'wrong' });

  // 막은 지 60초 바로 앞까지 locked, 60초면 풀림 — 짝 코드는 그대로 살아 있음
  t += PAIR_LOCK_MS - 1000 - 1;
  expect(p.redeem(s.pin, '공격', 'evil')).toEqual({ error: 'locked' });
  t += 1;
  ok(p.redeem(s.pin, '되찾음', 'evil'));
});

test('틀림은 1분 안의 것만 셈 — 띄엄띄엄 틀리면 안 막힘, 풀린 뒤엔 다시 5번', () => {
  const p = createPairing(openPhoneStore(dir), { now });
  const s = p.start();
  const bad = wrongPin(s.pin);
  for (let i = 0; i < 4; i++) expect(p.redeem(bad, 'x', 'a')).toEqual({ error: 'wrong' });
  t += 60_000; // 앞의 4번은 1분 밖
  for (let i = 0; i < 4; i++) expect(p.redeem(bad, 'x', 'a')).toEqual({ error: 'wrong' });
  expect(p.redeem('a'.repeat(64), 'x', 'a')).toEqual({ error: 'wrong' }); // 5번째(틀린 코드도 셈)
  expect(p.redeem(bad, 'x', 'a')).toEqual({ error: 'locked' });
  t += PAIR_LOCK_MS;
  for (let i = 0; i < 4; i++) expect(p.redeem(bad, 'x', 'a')).toEqual({ error: 'wrong' });
  // 맞으면 그 곳의 틀림 셈은 지워짐
  ok(p.redeem(s.pin, 'x', 'a'));
  const s2 = p.start();
  for (let i = 0; i < 4; i++) expect(p.redeem(wrongPin(s2.pin), 'x', 'a')).toEqual({ error: 'wrong' });
  ok(p.redeem(s2.code, 'y', 'a'));
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

  const p = createPairing(openPhoneStore(dir), { now });
  expect(ok(p.redeem(p.start().pin, ' \n ', 'x')).device.name).toBe('휴대폰');
});
