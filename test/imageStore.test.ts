import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openImageStore } from '../src/engine/imageStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-img-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const png = Buffer.from('89504e470d0a1a0a-fake-png', 'utf8').toString('base64');

test('그림을 에이전트 칸에 내용 이름으로 저장하고 그대로 다시 읽는다', () => {
  const s = openImageStore(dir);
  const file = s.save('a1', 'image/png', png);
  expect(file).toMatch(/^[0-9a-f]{32}\.png$/);
  expect(fs.existsSync(path.join(dir, 'images', 'a1', file!))).toBe(true);
  expect(s.read('a1', file!)).toEqual({ mediaType: 'image/png', base64: png });
});

test('같은 그림은 한 파일 — 다시 보내도 늘지 않는다', () => {
  const s = openImageStore(dir);
  const one = s.save('a1', 'image/png', png);
  const two = s.save('a1', 'image/png', png);
  expect(two).toBe(one);
  expect(fs.readdirSync(path.join(dir, 'images', 'a1'))).toHaveLength(1);
});

test('형식마다 확장자 — JPEG 는 jpg, 읽을 때 형식을 되살린다', () => {
  const s = openImageStore(dir);
  for (const [type, ext] of [['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']] as const) {
    const file = s.save('a1', type, Buffer.from(type).toString('base64'));
    expect(file!.endsWith(`.${ext}`)).toBe(true);
    expect(s.read('a1', file!)?.mediaType).toBe(type);
  }
});

test('모르는 형식은 저장하지 않는다', () => {
  const s = openImageStore(dir);
  expect(s.save('a1', 'image/svg+xml', png)).toBeNull();
  expect(fs.existsSync(path.join(dir, 'images', 'a1'))).toBe(false);
});

test('저장한 모양이 아닌 이름은 읽지 않는다 — 칸 밖으로 나갈 길이 없다', () => {
  const s = openImageStore(dir);
  const file = s.save('a1', 'image/png', png)!;
  fs.writeFileSync(path.join(dir, 'secret.png'), 'x');
  for (const bad of ['../secret.png', '..\\secret.png', 'secret.png', file.toUpperCase(), file.replace('.png', '.exe'), `${file}/x`, '']) {
    expect(s.read('a1', bad), bad).toBeNull();
  }
  expect(s.read('a2', file)).toBeNull(); // 다른 에이전트 칸엔 없다
  expect(s.read('../a1', file)).toBeNull();
});

test('없는 파일은 null', () => {
  const s = openImageStore(dir);
  expect(s.read('a1', `${'0'.repeat(32)}.png`)).toBeNull();
});

test('에이전트를 지우면 그 칸의 그림도 지운다 — 다른 에이전트 것은 그대로', () => {
  const s = openImageStore(dir);
  const mine = s.save('a1', 'image/png', png)!;
  const other = s.save('a2', 'image/png', png)!;
  s.remove('a1');
  expect(fs.existsSync(path.join(dir, 'images', 'a1'))).toBe(false);
  expect(s.read('a1', mine)).toBeNull();
  expect(s.read('a2', other)).not.toBeNull();
  s.remove('a1'); // 없는 칸도 조용히
});
