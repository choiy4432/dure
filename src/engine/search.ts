import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { AgentId, RoomId, SearchHit, SearchResult, SearchWho } from './types';

/** 찾을 기록 하나 — 에이전트마다 한 파일(대화는 경계 줄로 나뉜다). sessionId = 지금 세션(그 대화가 지금 대화) */
export interface SearchSource {
  agentId: AgentId;
  roomId: RoomId;
  file: string;
  sessionId: string;
}

export interface SearchOptions {
  /** 돌려줄 줄 상한(기본 SEARCH_LIMIT) — 넘게 맞으면 more */
  limit?: number;
  /** 지금 방 — 그 방 줄이 먼저 */
  roomId?: RoomId;
  /** 끊기면 그만두고 그 사유(AbortError)로 거절한다 */
  signal?: AbortSignal;
  /** 받은 메시지를 보낸 에이전트의 지금 이름 — 모르면 null(from 칸 없음) */
  senderName?: (messageId: string) => string | null;
}

export const SEARCH_LIMIT = 50;
/** snippet 에 맞은 곳 앞뒤로 남기는 글자 수(글자 = 화면에 보이는 한 글자) */
const SNIPPET_SIDE = 40;
/** 이보다 짧은 찾을 말은 찾지 않는다(글자 수 — 코드 포인트) */
const QUERY_MIN = 2;
/** 한 번에 읽는 크기 — 읽기마다 이벤트 루프로 돌아가 main 이 굳지 않는다 */
const CHUNK_BYTES = 64 * 1024;
const LIMIT_BAD = '찾기 상한이 올바르지 않아요';

/** 견주기 꼴 — NFKC(전각·반각·호환 글자를 하나로) + 소문자 */
const fold = (s: string): string => s.normalize('NFKC').toLowerCase();
const SPACE = /^\s+$/u;

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
/** 화면에 보이는 글자 단위(이모지·결합 글자를 쪼개지 않는다) — Segmenter 가 없으면 코드 포인트 */
const graphemes = (s: string): string[] => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));

/** 한 대화 구간(경계 사이) — 닫힐 때 열쇠를 안다(splitConversations 와 같은 규칙) */
interface Segment {
  k: number;
  opened?: string;
  closed?: string;
  firstT: number | null;
  conv: SearchHit['conversation'] | null;
}

interface Candidate {
  agentId: AgentId;
  roomId: RoomId;
  t: number;
  who: SearchWho;
  text: string;
  messageId?: string;
  seg: Segment;
  /** 읽은 차례 — 같은 시각이면 나중 줄이 먼저 */
  n: number;
}

type Rec = Record<string, unknown> & { kind: string; t: number };

/** 기록 줄 하나 — 꼴이 틀리거나 깨진 줄은 null(history.read 와 같은 기준) */
function parseLine(line: string): Rec | null {
  try {
    const rec = JSON.parse(line);
    return rec && typeof rec === 'object' && typeof rec.kind === 'string' && typeof rec.t === 'number' ? (rec as Rec) : null;
  } catch {
    return null;
  }
}

const textsOf = (xs: unknown, field: string): string =>
  (Array.isArray(xs) ? xs : [])
    .filter((p): p is Record<string, string> => !!p && typeof p === 'object' && p.type === 'text' && typeof p[field] === 'string')
    .map((p) => p[field])
    .join('\n');

/**
 * 찾는 글 — 사람 글·받은 메시지(user 의 text 칸) · Claude 글(assistant 의 text 블록, 서브에이전트 줄 빼고).
 * 도구 입력·도구 결과·생각·알림·명령 출력·첨부 이름은 찾지 않는다(소음)
 */
function searchable(rec: Rec): { who: SearchWho; text: string; messageId?: string } | null {
  if (rec.kind === 'user') {
    const text = textsOf(rec.parts, 'text');
    if (!text) return null;
    if (rec.source !== 'relay') return { who: 'me', text };
    return typeof rec.messageId === 'string' ? { who: 'message', text, messageId: rec.messageId } : { who: 'message', text };
  }
  if (rec.kind === 'assistant' && typeof rec.parent !== 'string') {
    const text = textsOf(rec.blocks, 'text');
    return text ? { who: 'claude', text } : null;
  }
  return null;
}

/**
 * 파일을 비동기로 CHUNK_BYTES 씩 읽어 줄마다 onLine — 한 번에 다 읽어 굳히지 않는다. 끝 줄바꿈 없는 마지막 줄도 준다.
 * 없는 파일·폴더·읽기 오류는 그 파일만 건너뛴다. 읽기마다 signal 을 본다(끊겼으면 그 사유로 던진다)
 */
async function scanLines(file: string, signal: AbortSignal | undefined, onLine: (line: string) => void): Promise<void> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, 'r');
  } catch {
    return;
  }
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    const pieces: string[] = []; // 아직 줄바꿈을 못 만난 줄 조각 — 긴 줄도 한 번만 잇는다
    for (;;) {
      signal?.throwIfAborted();
      let n: number;
      try {
        n = (await fh.read(buf, 0, CHUNK_BYTES, null)).bytesRead;
      } catch {
        return; // 폴더(EISDIR)·잠김 등 — 이 파일은 여기까지
      }
      signal?.throwIfAborted();
      if (n === 0) break;
      const s = decoder.write(buf.subarray(0, n));
      let from = 0;
      for (let nl = s.indexOf('\n'); nl !== -1; nl = s.indexOf('\n', from)) {
        pieces.push(s.slice(from, nl));
        onLine(pieces.length === 1 ? pieces[0] : pieces.join(''));
        pieces.length = 0;
        from = nl + 1;
      }
      if (from < s.length) pieces.push(s.slice(from));
    }
    pieces.push(decoder.end());
    const last = pieces.join('');
    if (last) onLine(last);
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * 맞은 곳 앞뒤 SNIPPET_SIDE 글자 — 잘렸으면 말줄임('…'), 빈칸·줄바꿈이 이어지면 빈칸 하나, 앞뒤 빈칸은 뺀다.
 * ranges = snippet 안의 맞은 곳 모두([시작, 끝) — JS 글자 자리). 맞춤은 견주기 꼴(fold)로, 범위는 원래 글자 단위로 —
 * 전각·합자처럼 견주기 꼴에서 길이가 바뀌어도 원래 글자를 감싼다. cutLeft·cutRight = 이 글이 긴 글의 가운데 조각이다
 */
function snippetIn(text: string, q: string, cutLeft: boolean, cutRight: boolean): { snippet: string; ranges: [number, number][] } | null {
  const gs = graphemes(text);
  const starts: number[] = [];
  let folded = '';
  for (const g of gs) {
    starts.push(folded.length);
    folded += fold(g);
  }
  // 견주기 꼴의 자리 → 그 자리를 품은 글자(앞에서부터 차례로)
  const matches: [number, number][] = [];
  let gi = 0;
  const graphemeAt = (pos: number) => {
    while (gi + 1 < gs.length && starts[gi + 1] <= pos) gi++;
    return gi;
  };
  for (let p = folded.indexOf(q); p !== -1; p = folded.indexOf(q, p + q.length)) {
    const a = graphemeAt(p);
    const b = graphemeAt(p + q.length - 1) + 1;
    matches.push([a, b]);
  }
  if (!matches.length) return null;
  const [a, b] = matches[0];
  const s = Math.max(0, a - SNIPPET_SIDE);
  const e = Math.min(gs.length, b + SNIPPET_SIDE);
  let out = s > 0 || cutLeft ? '…' : '';
  const head = out.length;
  const pos: number[] = []; // 글자 i(s 부터) 앞의 out 자리
  for (let i = s; i < e; i++) {
    pos.push(out.length);
    const g = gs[i];
    if (!SPACE.test(g)) out += g;
    else if (out.length > head && !out.endsWith(' ')) out += ' ';
  }
  pos.push(out.length);
  if (out.length > head && out.endsWith(' ')) out = out.slice(0, -1);
  const len = out.length;
  if (e < gs.length || cutRight) out += '…';
  const ranges = matches
    .filter(([ma, mb]) => ma >= s && mb <= e)
    .map(([ma, mb]): [number, number] => [Math.min(pos[ma - s], len), Math.min(pos[mb - s], len)])
    .filter(([x, y]) => y > x);
  return { snippet: out, ranges };
}

/**
 * snippet 만들기 — 긴 글은 맞은 곳 언저리만 글자로 나눈다(글 전체를 나누면 긴 답 50개에 main 이 굳는다).
 * 언저리에서 못 찾으면(견주기 꼴 길이가 크게 달라 어림이 빗나감) 글 전체로, 그래도 없으면 글 앞부분만(범위 없음)
 */
function snippetOf(text: string, q: string): { snippet: string; ranges: [number, number][] } {
  const folded = fold(text);
  const at = Math.max(0, folded.indexOf(q));
  const guess = folded.length === text.length ? at : Math.floor((at * text.length) / Math.max(1, folded.length));
  const pad = SNIPPET_SIDE * 4 + q.length * 2 + 16;
  let ws = Math.max(0, guess - pad);
  let we = Math.min(text.length, guess + q.length + pad);
  // 서로게이트 쌍을 가르지 않게
  if (ws > 0 && /[\uDC00-\uDFFF]/.test(text[ws])) ws--;
  if (we < text.length && /[\uDC00-\uDFFF]/.test(text[we])) we++;
  if (ws > 0 || we < text.length) {
    const near = snippetIn(text.slice(ws, we), q, ws > 0, we < text.length);
    if (near) return near;
  }
  const whole = snippetIn(text, q, false, false);
  if (whole) return whole;
  const gs = graphemes(text.slice(0, SNIPPET_SIDE * 8));
  const head = gs.slice(0, SNIPPET_SIDE * 2).join('').replace(/\s+/gu, ' ').trim();
  return { snippet: head + (gs.length > SNIPPET_SIDE * 2 || text.length > SNIPPET_SIDE * 8 ? '…' : ''), ranges: [] };
}

/**
 * 모든 기록 파일에서 대화 찾기 — 파일을 차례로 비동기·줄 단위로 읽는다(한 번에 다 읽지 않는다). 사람 글·Claude 글(서브에이전트 줄 빼고)·
 * 받은 메시지를 대소문자·NFKC 무시로 찾는다(앞뒤 빈칸 뺀 찾을 말이 두 글자 미만이면 빈 결과). 한 기록 줄은 한 번(맞은 곳 모두 ranges).
 * 정렬 = 지금 방(roomId) 먼저 → 새로운 순, 상한 limit(기본 50) — 넘게 맞으면 more. 깨진 줄·없는 파일은 건너뛴다.
 * 대화 열쇠는 splitConversations 와 같다: 지금 세션의 대화는 null, 아니면 conversation(id, key) 의 열쇠(세션 id · 모르면 seg:<n>).
 * signal 이 끊기면 그만두고 그 사유(AbortError)로 거절한다
 */
export async function searchHistories(sources: SearchSource[], query: string, o: SearchOptions = {}): Promise<SearchResult> {
  const { signal } = o;
  const limit = o.limit ?? SEARCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(LIMIT_BAD);
  signal?.throwIfAborted();
  const q = fold(query).trim();
  if ([...q].length < QUERY_MIN) return { hits: [], more: false };

  const rank = (c: Candidate) => (o.roomId !== undefined && c.roomId === o.roomId ? 0 : 1);
  const order = (x: Candidate, y: Candidate) => rank(x) - rank(y) || y.t - x.t || y.n - x.n;
  let cands: Candidate[] = [];
  let total = 0;
  let n = 0;
  const keepAt = limit * 2 + 64; // 후보가 이만큼 쌓이면 위 limit 개만 남긴다(맞는 줄이 많아도 메모리·정렬이 작게)

  for (const src of sources) {
    const startOf = new Map<string, number>(); // 열쇠 → 그 대화의 첫 줄 시각(처음 나타난 구간)
    const close = (sg: Segment, last: boolean) => {
      if (sg.firstT === null) return; // 빈 구간은 대화가 아니다
      const sid = last ? src.sessionId : (sg.closed ?? sg.opened ?? null);
      const key = sid ?? `seg:${sg.k}`;
      if (!startOf.has(key)) startOf.set(key, sg.firstT);
      sg.conv = { key: key === src.sessionId ? null : key, startedAt: startOf.get(key) ?? null };
    };
    let seg: Segment = { k: 0, firstT: null, conv: null };
    await scanLines(src.file, signal, (line) => {
      const rec = parseLine(line);
      if (!rec) return;
      if (rec.kind === 'boundary') {
        seg.closed = typeof rec.ended === 'string' ? rec.ended : undefined;
        close(seg, false);
        seg = { k: seg.k + 1, opened: typeof rec.resumed === 'string' ? rec.resumed : undefined, firstT: null, conv: null };
        return;
      }
      if (seg.firstT === null) seg.firstT = rec.t;
      const found = searchable(rec);
      if (!found || !fold(found.text).includes(q)) return;
      total++;
      cands.push({ agentId: src.agentId, roomId: src.roomId, t: rec.t, ...found, seg, n: n++ });
      if (cands.length >= keepAt) cands = cands.sort(order).slice(0, limit);
    });
    close(seg, true);
  }

  signal?.throwIfAborted();
  const hits = cands.sort(order).slice(0, limit).map((c): SearchHit => {
    const from = c.who === 'message' && c.messageId ? (o.senderName?.(c.messageId) ?? null) : null;
    return {
      agentId: c.agentId,
      roomId: c.roomId,
      conversation: c.seg.conv ?? { key: null, startedAt: null },
      t: c.t,
      who: c.who,
      ...(from ? { from } : {}),
      ...snippetOf(c.text, q),
    };
  });
  return { hits, more: total > limit };
}
