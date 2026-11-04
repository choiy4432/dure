import { expect, test, vi } from 'vitest';
import zlib from 'node:zlib';
import { hasPdfHead, isPdfName, PDF_INFLATE_MAX, PDF_OBJSTM_MAX, pdfPageCount } from '../src/engine/pdf';
import { objStm, packedPdf, pageDict, pagesDict, pdfOf } from './pdfFixtures';

const of = (s: string | Buffer) => pdfPageCount(typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
const MiB = 1024 * 1024;

test('이름·머리 — .pdf(대소문자 없이) · 맨 앞 %PDF-', () => {
  expect(isPdfName('a.pdf') && isPdfName('A.PDF')).toBe(true);
  expect(isPdfName('a.pdf.txt') || isPdfName('pdf')).toBe(false);
  expect(hasPdfHead(Buffer.from('%PDF-1.7'))).toBe(true);
  expect(hasPdfHead(Buffer.from(' %PDF-1.7'))).toBe(false);
});

test('압축 안 한 /Type /Page 개수(/Pages·/PageLabel 아님) — 이름 토큰이 끝나야 /Page', async () => {
  expect(await of('%PDF-1.4\n<</Type /Pages /Kids [3 0 R] /Count 1>> <</Type /Page>>')).toBe(1);
  // 공백 없이 붙어도 · 줄바꿈·NUL 로 끝나도
  expect(await of('%PDF-1.7\n/Type/Page/Parent 2 0 R /Type /Pages /Type /PageLabel /Type /Page\n /Type\r\n/Page>> /Type /Page\0')).toBe(4);
  // 아무것도 안 보이면 못 센다(null — 엔진은 경로 줄만)
  expect(await of('%PDF-1.7\nstream x\x9c\x01\x02 endstream')).toBeNull();
  expect(await of('%PDF-1.7\n%%EOF\n')).toBeNull();
});

// I1 — 보이는 쪽 객체가 몇 개 있어도 쪽 나무의 /Count 가 더 크면 그것(압축 객체 스트림에 나머지 쪽이 숨은 PDF 를 1쪽으로 세지 않게)
test('쪽 나무의 /Count 와 보이는 쪽 수 중 큰 것 — /Count 는 /Kids 나 /Type /Pages 가 있는 사전 안의 것만(목차 /Outlines 는 아니다)', async () => {
  expect(await of('%PDF-1.7\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 500 >> endobj 3 0 obj << /Type /Page /Parent 2 0 R >> endobj')).toBe(500);
  // 목차·목차 항목의 /Count 는 치지 않는다 — 쪽 나무가 5쪽
  expect(
    await of('%PDF-1.7\n<< /Type /Outlines /First 4 0 R /Count 900 >> << /Title (장 1) /Parent 3 0 R /Count 700 >> << /Type /Pages /Kids [5 0 R] /Count 5 >>'),
  ).toBe(5);
  // /Type 없는 중간 마디(/Kids 만) · 사전 안의 사전(물려받는 /Resources) · /Count 가 /Kids 앞에 와도
  expect(await of('%PDF-1.7\n<< /Count 320 /Resources << /Font << /F1 9 0 R >> >> /Kids [7 0 R 8 0 R] /Parent 2 0 R >> << /Type /Page >>')).toBe(320);
  // 닫힌 목차(/Count 음수)·사전 밖의 /Count 는 치지 않는다
  expect(await of('%PDF-1.7\n/Count 999 << /Type /Pages /Kids [] /Count -3 >> << /Type /Page >>')).toBe(1);
  // 글(문자열)·주석 안의 글자는 치지 않는다 — 괄호 짝·\ 이스케이프
  expect(await of('%PDF-1.7\n<< /Title (a \\) (b /Type /Page) /Count 400 /Kids) /Type /Pages /Kids [3 0 R] /Count 2 >> % /Type /Page /Count 800\n<< /Type /Page >>')).toBe(2);
  // 압축 안 한 스트림의 바이트(내용 스트림)도 훑지 않는다 — /Length 를 믿지 않고 endstream 까지
  expect(await of('%PDF-1.7\n<< /Type /Pages /Kids [3 0 R] /Count 1 >> << /Length 999 >>stream\nBT (x) Tj /Type /Page /Type /Page << /Kids [] /Count 300 >> ET\nendstream << /Type /Page >>')).toBe(1);
});

// I2 — 압축 객체 스트림(PDF 1.5+ 의 흔한 꼴)을 풀어 그 안의 쪽 나무·쪽 객체를 센다
test('압축 객체 스트림 — FlateDecode 를 풀어 센다(150쪽·50쪽) · 보이는 1쪽 + 객체 스트림의 499쪽(쪽 나무 500)', async () => {
  expect(await of(packedPdf(150))).toBe(150);
  expect(await of(packedPdf(50))).toBe(50);
  expect(await of(packedPdf(500, { plain: 1 }))).toBe(500);
  // 압축 안 한 객체 스트림은 그대로 훑는다
  expect(await of(packedPdf(120, { filter: '' }))).toBe(120);
});

test('객체 스트림만 푼다 — 내용 스트림(글·그림)은 풀지 않는다', async () => {
  const inflate = vi.spyOn(zlib, 'inflate');
  try {
    // 내용 스트림 글 안의 '/Type /Page' 200개 — 풀어 세면 200
    expect(await of(packedPdf(40, { contentPages: 200 }))).toBe(40);
    expect(inflate).toHaveBeenCalledTimes(1); // 객체 스트림 하나만(내용 스트림·교차 참조 스트림은 아니다)
  } finally {
    inflate.mockRestore();
  }
});

test('못 풀거나 모르면 null(엔진은 경로 줄만) — 깨진 스트림 · 다른 필터 · 예측기 · 암호 · 풀어 쓸 상한', async () => {
  // 풀리지 않는 스트림 — 그 안에 쪽이 있을 수 있다(보이는 쪽이 있어도 모른다)
  expect(await of(packedPdf(30, { data: Buffer.from('이건 zlib 이 아니다') }))).toBeNull();
  expect(await of(packedPdf(30, { plain: 2, data: Buffer.from('이건 zlib 이 아니다') }))).toBeNull();
  // 다른 필터·필터 여럿·예측기 — 풀지 않는다
  expect(await of(packedPdf(30, { filter: '/Filter/LZWDecode' }))).toBeNull();
  expect(await of(packedPdf(30, { filter: '/Filter[/ASCII85Decode/FlateDecode]' }))).toBeNull();
  expect(await of(packedPdf(30, { filter: '/Filter/FlateDecode/DecodeParms<</Predictor 12/Columns 5>>' }))).toBeNull();
  expect(await of(packedPdf(30, { filter: '/Filter[/FlateDecode]' }))).toBe(30); // 하나뿐인 배열은 FlateDecode
  // 암호 건 PDF — 객체 스트림을 풀지 않고, 보이는 쪽이 있어도 null(Claude 의 문서 블록은 암호 건 PDF 를 못 읽는다)
  expect(await of(packedPdf(30, { encrypt: true }))).toBeNull();
  expect(await of('%PDF-1.4\n<< /Type /Pages /Kids [3 0 R] /Count 1 >> << /Type /Page >> trailer << /Root 1 0 R /Encrypt 9 0 R >>')).toBeNull();
  expect(await of('%PDF-1.4\n<< /Type /Pages /Kids [3 0 R] /Count 1 >> << /Type /Page >> << /EncryptMetadata false >>')).toBe(1); // 다른 이름
  // 풀어 쓸 상한(한 PDF 의 객체 스트림 합) — 넘으면 모른다
  expect(PDF_INFLATE_MAX).toBe(32 * MiB);
  const big = (pad: number) => zlib.deflateSync(Buffer.concat([Buffer.from(`${pagesDict(10)}\n`, 'latin1'), Buffer.alloc(pad, 0x20)]));
  expect(await of(packedPdf(10, { data: big(PDF_INFLATE_MAX + 1) }))).toBeNull();
  expect(await of(packedPdf(10, { data: big(PDF_INFLATE_MAX - 1024) }))).toBe(10);
  // 둘이면 합으로 — 20MiB + 20MiB
  const two = pdfOf(objStm(50, [], { data: big(20 * MiB) }), objStm(51, [], { data: big(20 * MiB) }));
  expect(await of(two)).toBeNull();
  // 잘린 스트림(끝이 없다)은 풀린 데까지 — 깨진 것이 아니다
  const whole = zlib.deflateSync(Buffer.from(`1 0\n${pagesDict(7)}\n${pageDict}\n${' '.repeat(4096)}`, 'latin1'));
  expect(await of(pdfOf(objStm(50, [], { data: whole.subarray(0, whole.length - 8) })))).toBe(7);
}, 30_000);

// 엔진은 PDF_INLINE_MAX_PAGES 를 넘는지만 본다 — 넘는 것을 알면 큰 PDF 를 끝까지 훑거나 풀지 않는다(main 에서 도는 일)
test('over — 그보다 많은 것을 알면 그만 훑는다(남은 객체 스트림도 풀지 않는다) · 돌려준 수는 over 보다 크다', async () => {
  const inflate = vi.spyOn(zlib, 'inflate');
  try {
    const plainTree = pdfOf('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 500 >>\nendobj\n', objStm(50, [pageDict]));
    expect(await pdfPageCount(plainTree, undefined, 100)).toBeGreaterThan(100);
    expect(inflate).not.toHaveBeenCalled();
    expect(await pdfPageCount(plainTree)).toBe(500);
    expect(inflate).toHaveBeenCalledTimes(1);
    // 객체 스트림 안에서 넘어도 · 안 넘으면 그대로
    expect(await pdfPageCount(packedPdf(150), undefined, 100)).toBeGreaterThan(100);
    expect(await pdfPageCount(packedPdf(50), undefined, 100)).toBe(50);
    expect(await pdfPageCount(packedPdf(100), undefined, 100)).toBe(100);
  } finally {
    inflate.mockRestore();
  }
});

// 닫히지 않는 사전 `<<` 이 끝없이 겹치면 훑는 데 메모리가 끝없이 든다(푼 객체 스트림엔 endobj 도 없다) — 64 겹을 넘으면 모른다
test('사전이 64 겹을 넘게 겹치면 모른다(null) — 날 바이트 10MiB · 객체 스트림 안 31MiB 의 `<` 도 금방, 메모리도 조금', async () => {
  const nest = (n: number) => `${'<< /A '.repeat(n)}1${' >>'.repeat(n)}`;
  const tree = (inner: string) => `%PDF-1.7\n<< /Type /Pages /Kids [3 0 R] /Count 3 /X ${inner} >> << /Type /Page >>`;
  expect(await of(tree(nest(63)))).toBe(3); // 쪽 나무 사전까지 64 겹
  expect(await of(tree(nest(64)))).toBeNull();
  const raw = pdfOf('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', Buffer.alloc(10 * MiB, 0x3c));
  const packed = pdfOf('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', objStm(50, [], { data: zlib.deflateSync(Buffer.alloc(31 * MiB, 0x3c)) }));
  const heap = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  expect(await of(raw)).toBeNull();
  expect(await of(packed)).toBeNull();
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(process.memoryUsage().heapUsed - heap).toBeLessThan(128 * MiB);
}, 30_000);

// 작은 객체 스트림 수만 개 — 하나씩 풀면(스레드 왕복) 보내기가 몇 초 늦는다. 4096 개를 넘으면 풀지 않고 모른다
test('객체 스트림이 PDF_OBJSTM_MAX(4096) 개를 넘으면 모른다(null) — 10만 개도 금방', async () => {
  const blank = zlib.deflateSync(Buffer.from('<< /Foo 1 >>\n', 'latin1'));
  const many = (n: number) => pdfOf('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 5 >>\nendobj\n', ...Array.from({ length: n }, (_, i) => objStm(1000 + i, [], { data: blank })));
  expect(await of(many(4096))).toBe(5);
  expect(await of(many(4097))).toBeNull();
  const lots = many(100_000);
  const inflate = vi.spyOn(zlib, 'inflate');
  try {
    const t0 = performance.now();
    expect(await of(lots)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(inflate).not.toHaveBeenCalled(); // 세다 넘은 것을 알면 하나도 풀지 않는다
  } finally {
    inflate.mockRestore();
  }
  expect(PDF_OBJSTM_MAX).toBe(4096);
}, 60_000);

// 객체 스트림 사전 뒤에 알아볼 stream 이 없으면 그 바이트를 못 찾는다 — 그 안에 쪽이 숨어 있을 수 있다(보이는 1쪽만 세면 문서 블록으로 간다)
test('객체 스트림 사전 뒤에 알아볼 stream 이 없으면 모른다(null) · 줄 끝 앞 빈칸·탭은 받는다', async () => {
  const visible = '3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n';
  const hidden = objStm(50, [pagesDict(300), ...Array.from({ length: 299 }, () => pageDict)]);
  const after = (eol: string) => Buffer.from(hidden.toString('latin1').replace('>>\nstream\r\n', `>>\n${eol}`), 'latin1');
  expect(await of(pdfOf(visible, hidden))).toBe(300);
  expect(await of(pdfOf(visible, after('stream \r\n')))).toBe(300);
  expect(await of(pdfOf(visible, after('stream\t \n')))).toBe(300);
  // 줄 끝이 아닌 것 · 주석 · 다른 낱말 · stream 없이 endobj · 파일 끝
  expect(await of(pdfOf(visible, after('stream x')))).toBeNull();
  expect(await of(pdfOf(visible, after('% note\nstream\r\n')))).toBeNull();
  expect(await of(pdfOf(visible, after('streams\r\n')))).toBeNull();
  expect(await of(pdfOf(visible, '50 0 obj\n<< /Type /ObjStm /N 1 /First 4 >>\nendobj\n'))).toBeNull();
  expect(await of(`%PDF-1.5\n${visible}50 0 obj\n<< /Type /ObjStm /N 1 /First 4 >>`)).toBeNull();
});

// 잘린 파일 — 객체 스트림이 endstream 없이 끝난다. 풀린 데까지 세면 적게 센다(백 쪽 안쪽으로 보이면 큰 PDF 가 문서 블록으로 간다)
test('객체 스트림에 endstream 이 없으면(잘린 파일) 모른다(null)', async () => {
  const pages = [...Array.from({ length: 300 }, () => pageDict), pagesDict(300)]; // 쪽 나무는 맨 뒤
  const head = Buffer.from('%PDF-1.5\n', 'latin1');
  const whole = objStm(50, pages);
  const at = whole.indexOf('stream\r\n') + 'stream\r\n'.length;
  const end = whole.indexOf('\r\nendstream');
  // 압축 — 90% 에서 자르면 풀린 데까지 240쪽이 보인다(쪽 나무는 잘려 없다)
  expect(await of(Buffer.concat([head, whole.subarray(0, at + Math.floor((end - at) * 0.9))]))).toBeNull();
  // 압축 안 한 객체 스트림 — 4KiB 에서 자르면 11쪽
  const plain = objStm(50, pages, { filter: '' });
  const plainAt = plain.indexOf('stream\r\n') + 'stream\r\n'.length;
  expect(await of(Buffer.concat([head, plain.subarray(0, plainAt + 4096)]))).toBeNull();
  // endstream 이 있으면 그대로 센다
  expect(await of(pdfOf(whole))).toBe(300);
});

test('끊으면(signal) AbortError — 객체 스트림을 푸는 사이에도', async () => {
  await expect(pdfPageCount(packedPdf(10), AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  const cut = new AbortController();
  const p = pdfPageCount(packedPdf(10), cut.signal);
  cut.abort();
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
});
