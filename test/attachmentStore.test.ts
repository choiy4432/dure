import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachmentLines, openAttachmentStore } from '../src/engine/attachmentStore';
import { ATTACH_MAX_BYTES } from '../src/shared/attachments';

let dir: string;
let srcDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-att-'));
  srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** 2026-11-04 09:05:07(이 PC 시각) — 사본 이름의 시각 접두 */
const STAMP = '20261104-090507';
const now = () => new Date(2026, 10, 4, 9, 5, 7);
const open = () => openAttachmentStore(dir, { now });
function source(name: string, body = 'hello'): string {
  const p = path.join(srcDir, name);
  fs.writeFileSync(p, body);
  return p;
}

test('상한 — 파일 하나 100MB', () => {
  expect(ATTACH_MAX_BYTES).toBe(100 * 1024 * 1024);
});

test('안전한 사본 이름 · 같은 이름 — 숫자 붙임', () => {
  const s = open();
  const src = source('a.txt', '원본 내용');
  const one = s.copyIn('a1', src, 'a.txt');
  expect(one).toEqual({ file: `${STAMP}-a.txt`, abs: path.join(dir, 'attachments', 'a1', `${STAMP}-a.txt`) });
  expect(fs.readFileSync(one.abs, 'utf8')).toBe('원본 내용');
  expect(fs.readFileSync(src, 'utf8')).toBe('원본 내용'); // 원본은 그대로
  // 같은 이름(같은 시각) — 확장자 앞에 -2 · -3
  expect(s.copyIn('a1', src, 'a.txt').file).toBe(`${STAMP}-a-2.txt`);
  expect(s.copyIn('a1', src, 'a.txt').file).toBe(`${STAMP}-a-3.txt`);
  expect(fs.readdirSync(path.join(dir, 'attachments', 'a1'))).toHaveLength(3);

  const name = (n: string, id = 'a2') => s.copyIn(id, src, n).file.slice(STAMP.length + 1);
  // 윈도 금지 글자·제어 글자 → _ · 공백·한글·따옴표·$;& 는 그대로
  expect(name('x/y\\z:*?"<>|.md')).toBe(`x_y_z${'_'.repeat(7)}.md`);
  expect(name('a\nb\tc\u0000d\u007f.txt')).toBe('a_b_c_d_.txt');
  expect(name("a b'$;&.txt")).toBe("a b'$;&.txt");
  expect(name('보고서 최종본.pdf')).toBe('보고서 최종본.pdf');
  // 앞뒤 공백·점 정리, 비면 file
  expect(name('  .env. ')).toBe('env');
  expect(name('...', 'b1')).toBe('file');
  expect(name('', 'b2')).toBe('file');
  expect(name('   ', 'b2')).toBe('file-2'); // 겹치면 숫자
  // 아주 긴 이름은 줄이되(UTF-8 100 바이트 — 서버 이름 상한 255 바이트·윈도 경로 길이 안쪽) 확장자는 남기고 글자를 쪼개지 않는다
  const long = name(`${'가'.repeat(300)}.pdf`);
  expect(long).toBe(`${'가'.repeat(32)}.pdf`);
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(100);
});

test('resolve — 폴더 밖 거절', () => {
  const s = open();
  const { file, abs } = s.copyIn('a1', source('a.txt'), 'a.txt');
  expect(s.dir('a1')).toBe(path.join(dir, 'attachments', 'a1'));
  expect(() => s.dir('../a1')).toThrow();
  expect(s.resolve('a1', file)).toBe(abs);
  fs.writeFileSync(path.join(dir, 'attachments', 'secret.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'x');
  for (const bad of [
    '../secret.txt', '..\\secret.txt', '../../secret.txt', path.join(dir, 'secret.txt'), 'secret.txt', `${file}/x`, `${file}:stream`,
    '.', '..', '', `${STAMP}-없음.txt`, // 없는 사본
  ]) {
    expect(s.resolve('a1', bad), bad).toBeNull();
  }
  expect(s.resolve('a2', file)).toBeNull(); // 다른 에이전트 폴더엔 없다
  expect(s.resolve('../a1', file)).toBeNull();
  expect(s.resolve('a1', 5 as unknown as string)).toBeNull();

  // 하나 지우기 — 모양이 틀린 이름은 아무것도 지우지 않는다
  s.removeFile('a1', '../secret.txt');
  expect(fs.existsSync(path.join(dir, 'attachments', 'secret.txt'))).toBe(true);
  s.removeFile('a1', file);
  expect(fs.existsSync(abs)).toBe(false);
  s.removeFile('a1', file); // 없어도 조용히
});

test('copy — 다른 에이전트 폴더로 같은 이름, 없는 파일·틀린 이름·폴더는 false', () => {
  const s = open();
  const { file } = s.copyIn('a1', source('a.txt', '같은 내용'), 'a.txt');
  expect(s.copy('a1', 'a2', file)).toBe(true);
  expect(fs.readFileSync(s.resolve('a2', file)!, 'utf8')).toBe('같은 내용');
  expect(s.copy('a1', 'a2', file)).toBe(true); // 이미 있어도
  expect(fs.readFileSync(s.resolve('a1', file)!, 'utf8')).toBe('같은 내용'); // 원래 것 그대로
  expect(s.copy('a1', 'a3', `${STAMP}-없음.txt`)).toBe(false);
  for (const bad of ['../secret.txt', '..\\secret.txt', 'secret.txt', `${file}/x`, '']) expect(s.copy('a1', 'a3', bad), bad).toBe(false);
  expect(s.copy('../a1', 'a3', file)).toBe(false);
  expect(s.copy('a1', '../a3', file)).toBe(false);
  expect(fs.existsSync(path.join(dir, 'attachments', 'a3'))).toBe(false);
});

test('remove', () => {
  const s = open();
  const src = source('a.txt');
  const ro = source('읽기 전용.txt');
  fs.chmodSync(ro, 0o444); // 읽기 전용 원본의 사본도 지울 수 있어야 한다
  try {
    s.copyIn('a1', src, 'a.txt');
    s.copyIn('a1', ro, '읽기 전용.txt');
    const other = s.copyIn('a2', src, 'a.txt');
    s.remove('a1');
    expect(fs.existsSync(path.join(dir, 'attachments', 'a1'))).toBe(false);
    expect(fs.existsSync(other.abs)).toBe(true); // 다른 에이전트 것은 그대로
    expect(fs.existsSync(src) && fs.existsSync(ro)).toBe(true); // 원본은 그대로
    s.remove('a1'); // 없는 폴더도 조용히
    s.remove('../a2'); // 틀린 모양은 아무것도 지우지 않는다
    expect(fs.existsSync(other.abs)).toBe(true);
  } finally {
    fs.chmodSync(ro, 0o644);
  }
});

test('attachmentLines — 빈 줄 · 첨부 파일: · 줄마다 - <경로>(따옴표 없이)', () => {
  expect(attachmentLines([])).toBe('');
  expect(attachmentLines(['C:\\a b\\x.txt', '/srv/한글 y.pdf'])).toBe('\n\n첨부 파일:\n- C:\\a b\\x.txt\n- /srv/한글 y.pdf');
});
