import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
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

test('안전한 사본 이름 · 같은 이름 — 숫자 붙임', async () => {
  const s = open();
  const src = source('a.txt', '원본 내용');
  const one = await s.copyIn('a1', src, 'a.txt');
  expect(one).toEqual({ file: `${STAMP}-a.txt`, abs: path.join(dir, 'attachments', 'a1', `${STAMP}-a.txt`) });
  expect(fs.readFileSync(one.abs, 'utf8')).toBe('원본 내용');
  expect(fs.readFileSync(src, 'utf8')).toBe('원본 내용'); // 원본은 그대로
  // 같은 이름(같은 시각) — 확장자 앞에 -2 · -3
  expect((await s.copyIn('a1', src, 'a.txt')).file).toBe(`${STAMP}-a-2.txt`);
  expect((await s.copyIn('a1', src, 'a.txt')).file).toBe(`${STAMP}-a-3.txt`);
  expect(fs.readdirSync(path.join(dir, 'attachments', 'a1'))).toHaveLength(3);

  const name = async (n: string, id = 'a2') => (await s.copyIn(id, src, n)).file.slice(STAMP.length + 1);
  // 윈도 금지 글자·제어 글자 → _ · 공백·한글·따옴표·$;& 는 그대로
  expect(await name('x/y\\z:*?"<>|.md')).toBe(`x_y_z${'_'.repeat(7)}.md`);
  expect(await name('a\nb\tc\u0000d\u007f.txt')).toBe('a_b_c_d_.txt');
  expect(await name("a b'$;&.txt")).toBe("a b'$;&.txt");
  expect(await name('보고서 최종본.pdf')).toBe('보고서 최종본.pdf');
  // 앞 공백·뒤 공백·점 정리(앞 점은 그대로 — 시각 접두가 늘 앞이다), 점뿐이거나 비면 file
  expect(await name('  .env. ')).toBe('.env');
  expect(await name('.gitignore')).toBe('.gitignore');
  expect(await name('.env.local')).toBe('.env.local');
  expect(await name('...', 'b1')).toBe('file');
  expect(await name('. .', 'b3')).toBe('file');
  expect(await name('..', 'b4')).toBe('file');
  expect(await name('', 'b2')).toBe('file');
  expect(await name('   ', 'b2')).toBe('file-2'); // 겹치면 숫자
  // 아주 긴 이름은 줄이되(UTF-8 100 바이트 — 서버 이름 상한 255 바이트·윈도 경로 길이 안쪽) 확장자는 남기고 글자를 쪼개지 않는다
  const long = await name(`${'가'.repeat(300)}.pdf`);
  expect(long).toBe(`${'가'.repeat(32)}.pdf`);
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(100);
});

test('resolve — 링크를 따라가지 않는다(에이전트 폴더 자리의 junction)', async () => {
  const s = open();
  const { file } = await s.copyIn('a1', source('a.txt'), 'a.txt');
  // 다른 곳에 같은 이름의 파일을 두고, 에이전트 폴더 자리를 그곳을 가리키는 junction 으로 바꾼다
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-outside-'));
  try {
    fs.writeFileSync(path.join(outside, file), '밖');
    fs.symlinkSync(outside, path.join(dir, 'attachments', 'a2'), 'junction');
    expect(s.resolve('a2', file)).toBeNull();
    expect(s.resolve('a1', file)).not.toBeNull(); // 진짜 폴더는 그대로
  } finally {
    fs.rmSync(path.join(dir, 'attachments', 'a2'), { force: true, recursive: false });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('resolve — 진짜 경로를 못 푸는 볼륨(RAM 디스크 등의 EISDIR·EINVAL·UNKNOWN)이면 보통 파일·폴더 안·링크 아님만 본다', async () => {
  const s = open();
  const { file, abs } = await s.copyIn('a1', source('a.txt'), 'a.txt');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-outside-'));
  fs.writeFileSync(path.join(outside, file), '밖');
  fs.symlinkSync(outside, path.join(dir, 'attachments', 'a2'), 'junction');
  let code = 'EISDIR';
  const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike) => {
    throw Object.assign(new Error(`${code}: illegal operation on a directory, realpath '${String(p)}'`), { code });
  }) as any);
  try {
    for (const c of ['EISDIR', 'EINVAL', 'UNKNOWN']) {
      code = c;
      expect(s.resolve('a1', file), c).toBe(abs); // 보낼 때 받아들인 볼륨 — 칩이 열린다
      expect(s.resolve('a2', file), c).toBeNull(); // 폴더 자리의 junction 은 그대로 막는다
      expect(s.resolve('a1', `${STAMP}-없음.txt`), c).toBeNull();
      expect(s.resolve('a1', '../secret.txt'), c).toBeNull();
    }
    // 없음·권한·잠김은 그대로 null
    for (const c of ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOTDIR']) {
      code = c;
      expect(s.resolve('a1', file), c).toBeNull();
    }
  } finally {
    spy.mockRestore();
    fs.rmSync(path.join(dir, 'attachments', 'a2'), { force: true, recursive: false });
    fs.rmSync(outside, { recursive: true, force: true });
  }
  expect(s.resolve('a1', file)).toBe(abs);
});

test('resolve — 폴더 밖 거절', async () => {
  const s = open();
  const { file, abs } = await s.copyIn('a1', source('a.txt'), 'a.txt');
  expect(s.dir('a1')).toBe(path.join(dir, 'attachments', 'a1'));
  expect(() => s.dir('../a1')).toThrow();
  expect(s.resolve('a1', file)).toBe(abs);
  // 앞 점 이름의 사본도 푼다
  const dot = await s.copyIn('a1', source('.env'), '.env');
  expect(dot.file).toBe(`${STAMP}-.env`);
  expect(s.resolve('a1', dot.file)).toBe(dot.abs);
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

test('copy — 다른 에이전트 폴더로 같은 이름, 없는 파일·틀린 이름·폴더는 false', async () => {
  const s = open();
  const { file } = await s.copyIn('a1', source('a.txt', '같은 내용'), 'a.txt');
  expect(await s.copy('a1', 'a2', file)).toBe(true);
  expect(fs.readFileSync(s.resolve('a2', file)!, 'utf8')).toBe('같은 내용');
  expect(await s.copy('a1', 'a2', file)).toBe(true); // 이미 있어도
  expect(fs.readFileSync(s.resolve('a1', file)!, 'utf8')).toBe('같은 내용'); // 원래 것 그대로
  expect(await s.copy('a1', 'a3', `${STAMP}-없음.txt`)).toBe(false);
  for (const bad of ['../secret.txt', '..\\secret.txt', 'secret.txt', `${file}/x`, '']) expect(await s.copy('a1', 'a3', bad), bad).toBe(false);
  expect(await s.copy('../a1', 'a3', file)).toBe(false);
  expect(await s.copy('a1', '../a3', file)).toBe(false);
  expect(fs.existsSync(path.join(dir, 'attachments', 'a3'))).toBe(false);
});

test('copy — 비동기 복사(갈래 칠 때 큰 첨부가 많아도 main 을 막지 않는다)', async () => {
  const s = open();
  const { file } = await s.copyIn('a1', source('a.txt', '갈래'), 'a.txt');
  const sync = vi.spyOn(fs, 'copyFileSync');
  const async = vi.spyOn(fs.promises, 'copyFile');
  try {
    const p = s.copy('a1', 'a2', file);
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'attachments', 'a2', file), 'utf8')).toBe('갈래');
    expect(sync).not.toHaveBeenCalled();
    expect(async).toHaveBeenCalledTimes(1);
  } finally {
    sync.mockRestore();
    async.mockRestore();
  }
});

test('remove', async () => {
  const s = open();
  const src = source('a.txt');
  const ro = source('읽기 전용.txt');
  fs.chmodSync(ro, 0o444); // 읽기 전용 원본의 사본도 지울 수 있어야 한다
  try {
    await s.copyIn('a1', src, 'a.txt');
    await s.copyIn('a1', ro, '읽기 전용.txt');
    const other = await s.copyIn('a2', src, 'a.txt');
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

test('copyIn — 비동기 스트림 복사(큰 파일·느린 디스크에서도 main 을 막지 않고, 끊을 수 있다) · 원본은 읽기로만 연다', async () => {
  const s = open();
  const sync = vi.spyOn(fs, 'copyFileSync');
  const read = vi.spyOn(fs, 'createReadStream');
  const body = Buffer.alloc(3 * 1024 * 1024 + 7, 0xab); // 여러 조각
  try {
    const p = s.copyIn('a1', source('a.bin', body as unknown as string), 'a.bin');
    expect(p).toBeInstanceOf(Promise);
    const { abs } = await p;
    expect(fs.readFileSync(abs).equals(body)).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toBe(path.join(srcDir, 'a.bin'));
    expect((read.mock.calls[0][1] as { flags?: string } | undefined)?.flags ?? 'r').toBe('r');
  } finally {
    sync.mockRestore();
    read.mockRestore();
  }
});

/** 원본 읽기 흉내 — chunks 를 내고, end 면 끝내고 아니면 영영 더 내지 않는다(온라인 전용 OneDrive·끊긴 공유 폴더). err 면 그 오류로 */
function fakeSource(chunks: string[], o: { end?: boolean; err?: string } = {}) {
  const r = new Readable({ read() {} });
  for (const c of chunks) r.push(c);
  if (o.err) setTimeout(() => r.destroy(Object.assign(new Error(`${o.err}: 가짜`), { code: o.err })), 10);
  else if (o.end) r.push(null);
  return r;
}

test('copyIn — 복사가 끊기면 반쯤 쓴 사본을 지우고(잠김엔 다시 시도) 그 까닭을 던진다', async () => {
  const s = open();
  const src = source('a.txt');
  // 반쯤 읽고 끊긴 원본 흉내
  const read = vi.spyOn(fs, 'createReadStream').mockImplementationOnce((() => fakeSource(['hal'], { err: 'EIO' })) as any);
  const rm = vi.spyOn(fs.promises, 'rm');
  try {
    await expect(s.copyIn('a1', src, 'a.txt')).rejects.toThrow('EIO');
    expect(fs.readdirSync(path.join(dir, 'attachments', 'a1'))).toEqual([]);
    const half = path.join(dir, 'attachments', 'a1', `${STAMP}-a.txt`);
    expect(rm).toHaveBeenCalledWith(half, expect.objectContaining({ force: true, recursive: true, maxRetries: 3 }));
    // 다음 복사는 그대로 된다
    read.mockRestore();
    expect((await s.copyIn('a1', src, 'a.txt')).file).toBe(`${STAMP}-a.txt`);
  } finally {
    read.mockRestore();
    rm.mockRestore();
  }
});

test('copyIn — 끊으면(signal) 끝나지 않는 원본을 기다리지 않고 바로 던지고 반쯤 쓴 사본을 지운다 · 이미 끊겼으면 폴더도 만들지 않는다', async () => {
  const s = open();
  const src = source('a.txt', '원본');
  const stuck = fakeSource(['반쯤 '], { end: false });
  const read = vi.spyOn(fs, 'createReadStream').mockImplementationOnce((() => stuck) as any);
  const cut = new AbortController();
  try {
    const p = s.copyIn('a1', src, 'a.txt', cut.signal);
    await until(() => fs.existsSync(path.join(dir, 'attachments', 'a1', `${STAMP}-a.txt`)));
    await new Promise((r) => setTimeout(r, 50)); // 앞 조각을 쓸 틈
    const t0 = Date.now();
    cut.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fs.readdirSync(path.join(dir, 'attachments', 'a1'))).toEqual([]);
    expect(fs.readFileSync(src, 'utf8')).toBe('원본'); // 원본은 그대로
  } finally {
    read.mockRestore();
  }
  // 이미 끊긴 signal — 아무것도 만들지 않는다
  await expect(s.copyIn('a9', src, 'a.txt', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  expect(fs.existsSync(path.join(dir, 'attachments', 'a9'))).toBe(false);
  // 끊지 않으면 보통처럼
  const ok = await s.copyIn('a1', src, 'a.txt', new AbortController().signal);
  expect(fs.readFileSync(ok.abs, 'utf8')).toBe('원본');
});

async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('기다린 일이 일어나지 않음');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('removeFile — 막 만든 파일을 다른 프로그램(백신 등)이 잠깐 잡아도 다시 시도한다', async () => {
  const s = open();
  const { file, abs } = await s.copyIn('a1', source('a.txt'), 'a.txt');
  const rm = vi.spyOn(fs, 'rmSync');
  try {
    s.removeFile('a1', file);
    expect(fs.existsSync(abs)).toBe(false);
    expect(rm).toHaveBeenCalledWith(abs, expect.objectContaining({ force: true, recursive: true, maxRetries: 3 }));
  } finally {
    rm.mockRestore();
  }
});

test('copy — 쓰다 끊기면 임시 파일을 남기지 않고 던진다', async () => {
  const s = open();
  const { file } = await s.copyIn('a1', source('a.txt'), 'a.txt');
  const cp = vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce((async (_from: fs.PathLike, to: fs.PathLike) => {
    fs.writeFileSync(to, 'hal');
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  }) as any);
  try {
    await expect(s.copy('a1', 'a2', file)).rejects.toThrow('ENOSPC');
    expect(fs.readdirSync(path.join(dir, 'attachments', 'a2'))).toEqual([]);
    expect(await s.copy('a1', 'a2', file)).toBe(true); // 다음엔 된다
    expect(fs.readdirSync(path.join(dir, 'attachments', 'a2'))).toEqual([file]);
  } finally {
    cp.mockRestore();
  }
});

test('prune — 주인 없는 에이전트 폴더만 지운다(링크는 따라가지 않는다, 던지지 않는다)', async () => {
  const s = open();
  const root = path.join(dir, 'attachments');
  const kept = await s.copyIn('agent-1', source('a.txt'), 'a.txt');
  const gone = await s.copyIn('gone-2', source('b.txt'), 'b.txt');
  fs.mkdirSync(path.join(root, '모양이 틀림'));
  fs.writeFileSync(path.join(root, 'stray-file'), 'x'); // 폴더가 아닌 것
  // 폴더 밖을 가리키는 링크(윈도는 junction) — 따라가 지우지 않는다
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), '밖');
  fs.symlinkSync(outside, path.join(root, 'link-3'), 'junction');

  await s.prune((id) => id === 'agent-1');

  expect(fs.existsSync(kept.abs)).toBe(true);
  expect(fs.existsSync(path.dirname(gone.abs))).toBe(false);
  expect(fs.existsSync(path.join(root, '모양이 틀림'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'stray-file'))).toBe(true);
  expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('밖');
  // 첨부 폴더가 없어도 · 첨부 폴더 자체가 링크여도 조용히(따라가지 않는다)
  await openAttachmentStore(path.join(dir, 'none')).prune(() => false);
  const linked = path.join(dir, 'linked');
  fs.mkdirSync(linked);
  fs.mkdirSync(path.join(outside, 'orphan-4'));
  fs.symlinkSync(outside, path.join(linked, 'attachments'), 'junction');
  await openAttachmentStore(linked).prune(() => false);
  expect(fs.existsSync(path.join(outside, 'orphan-4'))).toBe(true);
});
