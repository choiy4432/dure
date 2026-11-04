// 시험 PDF — 쪽수 세기(pdf.ts)·엔진 시험이 같이 쓴다. 가짜 claude 는 PDF 를 읽지 않는다(바이트·크기만) — 진짜 확인은 따로
import zlib from 'node:zlib';

const latin = (s: string) => Buffer.from(s, 'latin1');
const bytesOf = (c: string | Buffer) => (typeof c === 'string' ? latin(c) : c);

/** PDF 한 벌 — 머리(`%PDF-1.5` + 이진 표시 줄) · 주어진 조각들 · 끝(startxref · %%EOF) */
export function pdfOf(...chunks: (string | Buffer)[]): Buffer {
  return Buffer.concat([latin('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'), ...chunks.map(bytesOf), latin('startxref\n0\n%%EOF\n')]);
}

/** 스트림 객체 하나 — dict 는 `<<…>>` 안쪽(/Length 는 붙여 준다), data 는 스트림 바이트 그대로 */
export function streamObj(n: number, dict: string, data: Buffer): Buffer {
  return Buffer.concat([latin(`${n} 0 obj\n<<${dict}/Length ${data.length}>>\nstream\r\n`), data, latin('\r\nendstream\nendobj\n')]);
}

/** 객체 스트림의 내용 — 머리(객체 번호·자리 쌍) + 객체들. first: 머리 길이(/First) */
export function objStmBody(objs: string[], firstNum = 2): { body: Buffer; first: number } {
  const offs: number[] = [];
  let s = '';
  for (const o of objs) {
    offs.push(s.length);
    s += `${o}\n`;
  }
  const head = `${objs.map((_, i) => `${firstNum + i} ${offs[i]}`).join(' ')}\n`;
  return { body: latin(head + s), first: head.length };
}

/** 객체 스트림 객체(번호 n) — data 가 없으면 objs 를 FlateDecode 로 압축해 담는다. filter 를 '' 로 주면 압축 없이 */
export function objStm(n: number, objs: string[], o: { data?: Buffer; filter?: string } = {}): Buffer {
  const { body, first } = objStmBody(objs);
  const filter = o.filter ?? '/Filter/FlateDecode';
  const data = o.data ?? (filter ? zlib.deflateSync(body) : body);
  return streamObj(n, `/Type/ObjStm/N ${objs.length}/First ${first}${filter}`, data);
}

/** 쪽 나무의 뿌리(2 0 obj) — /Kids 와 /Count */
export const pagesDict = (pages: number) => `<</Type/Pages/Kids[${Array.from({ length: Math.min(pages, 50) }, (_, i) => `${i + 3} 0 R`).join(' ')}]/Count ${pages}>>`;
/** 쪽 객체 하나(pdfTeX 꼴 — 공백 없이) */
export const pageDict = '<</Type/Page/Contents 99 0 R/Resources<</Font<</F1 98 0 R>>/ProcSet[/PDF/Text]>>/MediaBox[0 0 612 792]/Parent 2 0 R>>';

/**
 * 압축 객체 스트림 PDF(pdfTeX·LuaTeX·XeTeX·Ghostscript·Acrobat 최적화·qpdf 기본 꼴) — 쪽 나무와 쪽 객체가 모두 FlateDecode 객체 스트림
 * (/Type /ObjStm) 안에 있어 압축을 풀지 않으면 쪽이 안 보인다. 내용 스트림(압축)·교차 참조 스트림(압축·예측기)도 붙인다.
 * plain: 그 가운데 몇 쪽은 객체 스트림 밖에 압축 없이 · encrypt: 끝(교차 참조 스트림)에 /Encrypt ·
 * contentPages: 압축된 내용 스트림 안의 글에 '/Type /Page' 를 그만큼(풀어 세면 안 된다 — 객체 스트림만 푼다) ·
 * data: 객체 스트림의 바이트를 이것으로(못 푸는 스트림 등)
 */
export function packedPdf(pages: number, o: { plain?: number; encrypt?: boolean; contentPages?: number; data?: Buffer; filter?: string } = {}): Buffer {
  const plain = o.plain ?? 0;
  const inside = [pagesDict(pages), ...Array.from({ length: pages - plain }, () => pageDict)];
  const plainPages = Array.from({ length: plain }, (_, i) => `${200000 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`);
  const content = zlib.deflateSync(latin(`BT /F1 12 Tf 72 720 Td ${'(/Type /Page) Tj '.repeat(o.contentPages ?? 0)}ET`));
  const xref = zlib.deflateSync(Buffer.alloc(64, 1));
  return pdfOf(
    '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n',
    ...plainPages,
    streamObj(99, '/Filter/FlateDecode', content),
    objStm(50, inside, { data: o.data, filter: o.filter }),
    streamObj(51, `/Type/XRef/Size 52/W[1 2 1]/Root 1 0 R${o.encrypt ? '/Encrypt 52 0 R/ID[<00ff><00ff>]' : ''}/Filter/FlateDecode/DecodeParms<</Columns 4/Predictor 12>>`, xref),
  );
}
