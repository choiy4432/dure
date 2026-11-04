// PDF 첨부를 문서 블록으로도 넘길지 가르는 일(설계 §4.5) — 첨부 폴더의 사본 바이트만 본다(원본은 다시 읽지 않는다)
import zlib from 'node:zlib';

/** 이름이 PDF 인가 — 확장자 .pdf(대소문자 없이). 사본의 머리(hasPdfHead)와 둘 다 맞을 때만 문서 블록 */
export const isPdfName = (name: string): boolean => /\.pdf$/i.test(name);

const HEAD = Buffer.from('%PDF-', 'latin1');
/** 사본이 PDF 머리(`%PDF-`)로 시작하나 — 맨 앞 바이트부터 */
export const hasPdfHead = (buf: Buffer): boolean => buf.subarray(0, HEAD.length).equals(HEAD);

/**
 * 객체 스트림을 풀어 쓸 바이트 상한 — 한 PDF 의 객체 스트림을 푼 것의 합. 넘으면 쪽수를 모른다(null — 경로 줄만).
 * 문서 블록에 드는 PDF 는 10MiB 까지라 보통 PDF 의 객체 스트림(쪽·글꼴 사전 등 뼈대)은 이보다 한참 작다 — 압축 폭탄은 여기서 멈춘다
 */
export const PDF_INFLATE_MAX = 32 * 1024 * 1024;

/** 바이트 표(0~255) — 그 바이트가 고른 글자 가운데 하나인가(Set 보다 빠르다 — 바이트마다 본다) */
const table = (bytes: number[]): Uint8Array => {
  const t = new Uint8Array(256);
  for (const b of bytes) t[b] = 1;
  return t;
};
const SPACE_BYTES = [0, 9, 10, 12, 13, 32];
/** PDF 공백(NUL·탭·LF·FF·CR·빈칸) */
const SPACE = table(SPACE_BYTES);
/** 이름·낱말을 끝내는 글자 — 공백과 구분 글자. 그 밖의 글자가 붙으면 다른 이름이다(/Page 뒤에 s 면 /Pages) */
const ENDS_NAME = table([...SPACE_BYTES, ...Buffer.from('()<>[]{}/%', 'latin1')]);
const word = (s: string) => Buffer.from(s, 'latin1');
const STREAM = word('stream');
const ENDSTREAM = word('endstream');
const ENDOBJ = word('endobj');
// 알아볼 이름(/ 다음) — 바이트로 견준다(이름마다 글을 만들지 않게)
const [TYPE, PAGE, PAGES, OBJSTM, KIDS, COUNT, FILTER, FLATE, PARMS, ENCRYPT] = ['Type', 'Page', 'Pages', 'ObjStm', 'Kids', 'Count', 'Filter', 'FlateDecode', 'DecodeParms', 'Encrypt'].map(word);
/** /Count 의 수로 읽을 자릿수 상한 — 그보다 긴 수는 쪽수로 보지 않는다 */
const COUNT_DIGITS = 9;
const [LT, GT, LPAREN, RPAREN, BACKSLASH, SLASH, PERCENT, LBRACKET, RBRACKET, CR, LF] = [...'<>()\\/%[]\r\n'].map((c) => c.charCodeAt(0));

/** 사전(<< … >>) 하나 — 닫힐 때 쪽 나무 마디(/Kids 나 /Type /Pages)면 그 /Count 를 쓴다 */
interface Dict {
  kids: boolean;
  pages: boolean;
  objStm: boolean;
  /** /Filter — 없음 · FlateDecode 하나 · 그 밖(못 푼다) */
  filter: 'none' | 'flate' | 'other';
  /** /DecodeParms 가 있다(예측기 등) — 풀어도 그대로 읽을 수 없다 */
  parms: boolean;
  count: number | null;
}
/** 객체 스트림의 바이트 자리(stream 줄 끝 다음 ~ endstream 앞) */
interface ObjStm {
  start: number;
  end: number;
  filter: Dict['filter'];
}
/** 훑은 결과 — 보이는 쪽 객체 수 · 쪽 나무의 가장 큰 /Count · 암호 · 풀 객체 스트림 · 넘으면 그만 훑을 쪽수(over)와 넘었나(full) */
interface Tally {
  pages: number;
  tree: number | null;
  encrypted: boolean;
  objStms: ObjStm[];
  over: number;
  full: boolean;
}

/** i 부터 w 바이트 그대로인가 */
const at = (buf: Buffer, i: number, w: Buffer): boolean => {
  if (i + w.length > buf.length) return false;
  for (let k = 0; k < w.length; k++) if (buf[i + k] !== w[k]) return false;
  return true;
};
const skipSpace = (buf: Buffer, i: number): number => {
  while (i < buf.length && SPACE[buf[i]]) i++;
  return i;
};
/** i 의 낱말(w)이 앞뒤로 끊겨 있나 — 앞은 처음이거나 구분 글자, 뒤는 끝이거나 구분 글자 */
const wordAt = (buf: Buffer, i: number, w: Buffer): boolean =>
  (i === 0 || ENDS_NAME[buf[i - 1]] === 1) && (i + w.length >= buf.length || ENDS_NAME[buf[i + w.length]] === 1) && at(buf, i, w);
/** '/' 다음 이름의 끝 자리 — 이름은 i + 1 ~ 끝 */
const nameEnd = (buf: Buffer, i: number): number => {
  let j = i + 1;
  while (j < buf.length && !ENDS_NAME[buf[j]]) j++;
  return j;
};
/** '/' 가 i 에 있고 끝이 j 인 이름이 w 인가 */
const isName = (buf: Buffer, i: number, j: number, w: Buffer): boolean => j - i - 1 === w.length && at(buf, i + 1, w);

/**
 * 바이트를 한 번 훑는다(정규식 없이 — 10MiB 도 금방). 글(문자열 `(…)`·`<…>`)·주석·스트림 바이트는 건너뛰고(그 안의 글자는 PDF 뼈대가
 * 아니다 — /Length 를 믿지 않고 endstream 까지), 사전을 짝지어 연다·닫는다:
 * - `/Type /Page`(뒤가 이름 끝 — /Pages·/PageLabel 아님) 수
 * - 쪽 나무 마디(/Kids 나 /Type /Pages 가 있는 사전)의 /Count — 목차(/Outlines·목차 항목)의 /Count 는 치지 않는다
 * - /Encrypt(끝 사전·교차 참조 스트림) · 객체 스트림(/Type /ObjStm)의 바이트 자리(objStms 가 있을 때만 — 푼 바이트 안엔 스트림이 없다)
 */
function scan(buf: Buffer, t: Tally, objStms: ObjStm[] | null): void {
  const stack: Dict[] = [];
  let closed: Dict | null = null; // 방금 닫힌 사전 — 바로 뒤에 stream 이 오면 그 스트림의 사전
  let closedAt = -1;
  const close = (d: Dict) => {
    if ((d.kids || d.pages) && d.count !== null) t.tree = Math.max(t.tree ?? 0, d.count);
    if ((t.tree ?? 0) > t.over) t.full = true;
  };
  let i = 0;
  while (i < buf.length && !t.full) {
    const c = buf[i];
    if (c === PERCENT) {
      // 주석 — 줄 끝까지
      while (i < buf.length && buf[i] !== CR && buf[i] !== LF) i++;
    } else if (c === LPAREN) {
      // 글 — 괄호 짝(안의 괄호는 짝지어 들어간다) · \ 다음 글자는 건너뛴다
      let depth = 1;
      i++;
      while (i < buf.length && depth > 0) {
        const d = buf[i];
        if (d === BACKSLASH) i++;
        else if (d === LPAREN) depth++;
        else if (d === RPAREN) depth--;
        i++;
      }
    } else if (c === LT) {
      if (buf[i + 1] === LT) {
        stack.push({ kids: false, pages: false, objStm: false, filter: 'none', parms: false, count: null });
        i += 2;
      } else {
        // 16진 글 <…>
        const e = buf.indexOf(GT, i + 1);
        i = e < 0 ? buf.length : e + 1;
      }
    } else if (c === GT) {
      if (buf[i + 1] === GT) {
        const d = stack.pop();
        if (d) {
          close(d);
          closed = d;
          closedAt = i + 2;
        }
        i += 2;
      } else i++;
    } else if (c === SLASH) {
      const j = nameEnd(buf, i);
      const name = i;
      i = j;
      const top = stack.at(-1);
      if (isName(buf, name, j, TYPE)) {
        const v = skipSpace(buf, j);
        if (buf[v] !== SLASH) continue;
        const w = nameEnd(buf, v);
        i = w;
        if (isName(buf, v, w, PAGE)) {
          if (++t.pages > t.over) t.full = true;
        } else if (top && isName(buf, v, w, PAGES)) top.pages = true;
        else if (top && isName(buf, v, w, OBJSTM)) top.objStm = true;
      } else if (isName(buf, name, j, KIDS)) {
        if (top) top.kids = true;
      } else if (isName(buf, name, j, COUNT)) {
        const from = skipSpace(buf, j);
        let end = from;
        while (end < buf.length && buf[end] >= 0x30 && buf[end] <= 0x39) end++;
        i = end;
        // 음수(닫힌 목차)·자리 없는 수·너무 긴 수·사전 밖은 치지 않는다
        if (!top || end === from || end - from > COUNT_DIGITS || (end < buf.length && !ENDS_NAME[buf[end]])) continue;
        const n = Number(buf.toString('latin1', from, end));
        top.count = Math.max(top.count ?? 0, n);
      } else if (isName(buf, name, j, FILTER)) {
        if (!top) continue;
        // 필터 이름들 — FlateDecode 하나뿐이면 flate, 없으면 none, 그 밖(다른 필터·여럿·이름 아닌 것)은 other
        const v = skipSpace(buf, j);
        let n = 0;
        let flate = false;
        let odd = false;
        if (buf[v] === SLASH) {
          const w = nameEnd(buf, v);
          n = 1;
          flate = isName(buf, v, w, FLATE);
          i = w;
        } else if (buf[v] === LBRACKET) {
          let k = skipSpace(buf, v + 1);
          while (buf[k] === SLASH) {
            const w = nameEnd(buf, k);
            n++;
            flate = isName(buf, k, w, FLATE);
            k = skipSpace(buf, w);
          }
          if (buf[k] === RBRACKET) k++;
          else odd = true; // 이름이 아닌 것이 섞였다
          i = k;
        } else odd = true;
        top.filter = odd || n > 1 || (n === 1 && !flate) ? 'other' : n === 1 ? 'flate' : 'none';
      } else if (isName(buf, name, j, PARMS)) {
        if (top) top.parms = true;
      } else if (isName(buf, name, j, ENCRYPT)) {
        t.encrypted = true;
      }
    } else if (c === 0x73 /* s */ && wordAt(buf, i, STREAM) && (buf[i + STREAM.length] === CR || buf[i + STREAM.length] === LF)) {
      // 스트림 — 줄 끝(\r\n·\n·\r) 다음부터 endstream 앞까지. 그 사전이 객체 스트림이면 자리를 적고, 아니면(내용·그림·글꼴) 건너뛴다
      let start = i + STREAM.length;
      if (buf[start] === CR) start++;
      if (buf[start] === LF) start++;
      const e = buf.indexOf(ENDSTREAM, start);
      const end = e < 0 ? buf.length : e;
      const own = closed && skipSpace(buf, closedAt) === i ? closed : null;
      if (objStms && own?.objStm) objStms.push({ start, end, filter: own.parms ? 'other' : own.filter });
      i = e < 0 ? buf.length : e + ENDSTREAM.length;
    } else if (c === 0x65 /* e */ && wordAt(buf, i, ENDOBJ)) {
      // 객체 끝 — 짝이 안 맞은 사전이 다음 객체로 번지지 않게
      while (stack.length) close(stack.pop()!);
      i += ENDOBJ.length;
    } else i++;
  }
  while (stack.length) close(stack.pop()!);
}

/** 압축을 푼다(libuv 스레드에서 — main 을 막지 않는다). 잘린 끝은 풀린 데까지(Z_SYNC_FLUSH) · max 를 넘으면 던진다 */
function inflate(data: Buffer, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.inflate(data, { maxOutputLength: max, finishFlush: zlib.constants.Z_SYNC_FLUSH }, (e, out) => (e ? reject(e) : resolve(out)));
  });
}

/**
 * 쪽수 — 최선 노력. `/Type /Page` 객체 수와 쪽 나무(/Kids·/Type /Pages 사전)의 가장 큰 /Count 중 큰 것.
 * 쪽 객체·쪽 나무가 압축된 객체 스트림(/Type /ObjStm — PDF 1.5+ 의 흔한 꼴: pdfTeX·LuaTeX·XeTeX·Ghostscript·Acrobat 최적화·qpdf)에
 * 있으면 그 스트림만 풀어(FlateDecode, 합 PDF_INFLATE_MAX 까지) 같이 센다 — 내용·그림 스트림은 풀지 않는다.
 * 모르면 null(엔진은 경로 줄만 — 큰 PDF 가 문서 블록으로 가지 않게): 아무것도 안 보임 · 객체 스트림을 못 풂(깨짐·다른 필터·예측기·상한) ·
 * 암호(/Encrypt — 객체 스트림도 암호라 못 풀고, Claude 의 문서 블록은 암호 건 PDF 를 읽지 못한다).
 * 더 많게 세는 일(고쳐 저장한 PDF 의 옛 쪽·옛 쪽 나무)은 그대로 둔다 — 경로 줄만 갈 뿐이다. signal 이 끊기면 그 까닭(AbortError)으로 던진다.
 * over: 그보다 많은 것을 알면 거기서 그만 훑고 그 수를 돌려준다(정확한 쪽수가 아니라 'over 보다 많다' — 큰 PDF 를 끝까지 훑지 않게)
 */
export async function pdfPageCount(buf: Buffer, signal?: AbortSignal, over = Infinity): Promise<number | null> {
  signal?.throwIfAborted();
  const t: Tally = { pages: 0, tree: null, encrypted: false, objStms: [], over, full: false };
  const known = () => Math.max(t.pages, t.tree ?? 0);
  scan(buf, t, t.objStms);
  if (t.full) return known();
  if (t.encrypted) return null;
  let room = PDF_INFLATE_MAX;
  for (const s of t.objStms) {
    if (s.filter === 'other') return null; // 그 안에 쪽이 있을 수 있다 — 모른다
    let data = buf.subarray(s.start, s.end);
    if (s.filter === 'flate') {
      if (room <= 0) return null;
      try {
        data = await inflate(data, room);
      } catch {
        signal?.throwIfAborted();
        return null; // 깨졌거나 상한을 넘었다
      }
      signal?.throwIfAborted();
      room -= data.length;
    }
    scan(data, t, null);
    if (t.full) return known();
  }
  if (t.encrypted) return null;
  const n = known();
  return n > 0 ? n : null;
}
