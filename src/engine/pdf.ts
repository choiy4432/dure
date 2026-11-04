// PDF 첨부를 문서 블록으로도 넘길지 가르는 일(설계 §4.5) — 첨부 폴더의 사본 바이트만 본다(원본은 다시 읽지 않는다)

/** 이름이 PDF 인가 — 확장자 .pdf(대소문자 없이). 사본의 머리(hasPdfHead)와 둘 다 맞을 때만 문서 블록 */
export const isPdfName = (name: string): boolean => /\.pdf$/i.test(name);

const HEAD = Buffer.from('%PDF-', 'latin1');
/** 사본이 PDF 머리(`%PDF-`)로 시작하나 — 맨 앞 바이트부터 */
export const hasPdfHead = (buf: Buffer): boolean => buf.subarray(0, HEAD.length).equals(HEAD);

/** PDF 공백(NUL·탭·LF·FF·CR·빈칸) */
const SPACE: ReadonlySet<number> = new Set([0, 9, 10, 12, 13, 32]);
/** 이름 토큰을 끝내는 글자 — 공백과 구분 글자. 그 밖의 글자가 붙으면 다른 이름이다(/Page 뒤에 s 면 /Pages) */
const ENDS_NAME: ReadonlySet<number> = new Set([...SPACE, ...Buffer.from('()<>[]{}/%', 'latin1')]);
const TYPE = Buffer.from('/Type', 'latin1');
const PAGE = Buffer.from('/Page', 'latin1');
const COUNT = Buffer.from('/Count', 'latin1');
/** /Count 의 수로 읽을 자릿수 상한 — 그보다 긴 수는 쪽수로 보지 않는다 */
const COUNT_DIGITS = 9;

const at = (buf: Buffer, i: number, word: Buffer): boolean => buf.subarray(i, i + word.length).equals(word);
const skipSpace = (buf: Buffer, i: number): number => {
  while (i < buf.length && SPACE.has(buf[i])) i++;
  return i;
};

/**
 * 쪽수 — 최선 노력(정규식 없이 바이트를 훑는다 — 10MiB 사본도 금방). 압축 안 한 쪽 객체(`/Type /Page` — 뒤에 이름 글자가 붙은 `/Pages`·
 * `/PageLabel` 은 아님) 개수, 없으면 `/Count n` 중 가장 큰 값, 둘 다 없으면 null(못 셈 — 크기 상한만 본다).
 * 놓치는 것: 쪽 객체가 객체 스트림(PDF 1.5+)에 압축돼 있으면 안 보인다(그러면 /Count — 그것마저 압축돼 있으면 null) ·
 * 고쳐 저장한 PDF(덧붙인 갱신)는 같은 쪽을 두 번 셀 수 있다(더 많게 → 경로 줄만) · 글 줄(스트림·문자열) 안의 `/Type /Page` 도 센다 ·
 * /Count 로 셀 때 목차(/Outlines)의 수가 쪽 나무의 수보다 크면 그것을 쓴다
 */
export function pdfPageCount(buf: Buffer): number | null {
  let pages = 0;
  for (let i = buf.indexOf(TYPE); i >= 0; i = buf.indexOf(TYPE, i + TYPE.length)) {
    const j = skipSpace(buf, i + TYPE.length);
    if (at(buf, j, PAGE) && (j + PAGE.length >= buf.length || ENDS_NAME.has(buf[j + PAGE.length]))) pages++;
  }
  if (pages > 0) return pages;
  let max: number | null = null;
  for (let i = buf.indexOf(COUNT); i >= 0; i = buf.indexOf(COUNT, i + COUNT.length)) {
    const from = skipSpace(buf, i + COUNT.length);
    if (from === i + COUNT.length) continue; // /CountX 같은 다른 이름 · 공백 없이 붙은 것
    let end = from;
    while (end < buf.length && buf[end] >= 0x30 && buf[end] <= 0x39) end++;
    if (end === from || end - from > COUNT_DIGITS) continue;
    const n = Number(buf.toString('latin1', from, end));
    if (max === null || n > max) max = n;
  }
  return max;
}
