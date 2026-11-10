import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createEngine, type Engine, type HistoryItem } from '../src/engine';
import { splitConversations } from '../src/engine/conversations';
import { searchHistories, type SearchSource } from '../src/engine/search';
import { createDispatcher, type DispatchDeps } from '../src/main/dispatch';

const FAKE = path.resolve('test/fakeClaude.mjs');
let dir: string;
let dataDir: string;
let engines: Engine[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-search-'));
  dataDir = path.join(dir, 'data');
});
afterEach(async () => {
  await Promise.all(engines.map((e) => e.shutdown()));
  engines = [];
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const user = (t: number, text: string, source: 'human' | 'relay' = 'human', messageId?: string): HistoryItem => ({
  t, kind: 'user', source, parts: [{ type: 'text', text }], ...(messageId ? { messageId } : {}),
});
const said = (t: number, text: string, parent?: string): HistoryItem => ({
  t, kind: 'assistant', blocks: [{ type: 'text', text }], ...(parent ? { parent } : {}),
});
const jsonl = (lines: unknown[]) => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

/** 시험 폴더에 기록 파일 하나 — 찾기 출처(지금 세션 sid) */
function source(name: string, lines: unknown[], o: { roomId?: string; sessionId?: string } = {}): SearchSource {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, jsonl(lines));
  return { agentId: name, roomId: o.roomId ?? 'r1', file, sessionId: o.sessionId ?? `sid-${name}` };
}

// ── 맞는 곳 · 누가 · 대화 열쇠 · snippet · ranges ──

test('맞는 곳 · 누가(나 · Claude · 받은 메시지) · 받은 메시지의 보낸 쪽 이름', async () => {
  const src = source('a', [
    user(1, '배포 순서를 정리해 줘'),
    said(2, '배포는 금요일에 해요'),
    user(3, '배포 준비 부탁해요', 'relay', 'm1'),
    user(4, '배포 확인', 'relay', 'm-gone'),
    user(5, '상관없는 말'),
  ]);
  const r = await searchHistories([src], '배포', { senderName: (m) => (m === 'm1' ? '기획' : null) });
  expect(r.more).toBe(false);
  expect(r.hits.map((h) => [h.t, h.who, h.from])).toEqual([
    [4, 'message', undefined], // 보낸 쪽을 모르면 from 없음
    [3, 'message', '기획'],
    [2, 'claude', undefined],
    [1, 'me', undefined],
  ]);
  expect(r.hits[0]).not.toHaveProperty('from');
  expect(r.hits[3]).toMatchObject({ agentId: 'a', roomId: 'r1', snippet: '배포 순서를 정리해 줘', ranges: [[0, 2]] });
});

test('대화 열쇠 — 지금 대화는 null, 지난 대화는 conversation() 의 열쇠(splitConversations 와 같다) · startedAt 은 그 대화의 첫 줄', async () => {
  const lines: HistoryItem[] = [
    user(1, '옛 구간 찾기'), // 세션 모름 → seg:0
    { t: 2, kind: 'boundary' },
    { t: 3, kind: 'notice', text: '알림' },
    user(4, 'S1 찾기'), // 닫은 경계의 ended = S1 — 지금 세션이라 지금 대화
    { t: 5, kind: 'boundary', ended: 'S1' },
    user(6, 'S2 찾기'), // S2 로 닫힌 지난 대화
    { t: 7, kind: 'boundary', ended: 'S2', resumed: 'S1' },
    user(8, '돌아온 S1 찾기'), // 마지막 구간 = 지금 세션(S1)
  ];
  const src = source('a', lines, { sessionId: 'S1' });
  const r = await searchHistories([src], '찾기');
  expect(r.hits.map((h) => [h.t, h.conversation])).toEqual([
    [8, { key: null, startedAt: 3 }],
    [6, { key: 'S2', startedAt: 6 }],
    [4, { key: null, startedAt: 3 }],
    [1, { key: 'seg:0', startedAt: 1 }],
  ]);
  // 그 열쇠의 대화에 맞은 줄이 있다
  const convs = splitConversations(lines, 'S1');
  for (const h of r.hits) {
    const c = convs.find((x) => x.key === (h.conversation.key ?? 'S1'))!;
    expect(c.items.some((x) => x.t === h.t), String(h.t)).toBe(true);
  }
});

test('snippet — 맞은 곳 앞뒤 40자 · 잘렸으면 말줄임 · 줄바꿈은 빈칸 하나 · ranges 는 snippet 안의 모든 맞은 곳', async () => {
  const long = 'x'.repeat(100) + '찾을말' + 'y'.repeat(100);
  const emoji = '🎉'.repeat(50) + '찾을말';
  const src = source('a', [user(1, long), user(2, 'a 찾을말 b\n\n찾을말 c'), user(3, emoji), user(4, '\n  찾을말  \n')]);
  const r = await searchHistories([src], '찾을말');
  const by = (t: number) => r.hits.find((h) => h.t === t)!;
  expect(by(1).snippet).toBe('…' + 'x'.repeat(40) + '찾을말' + 'y'.repeat(40) + '…');
  expect(by(1).ranges).toEqual([[41, 44]]);
  expect(by(2).snippet).toBe('a 찾을말 b 찾을말 c');
  expect(by(2).ranges).toEqual([[2, 5], [8, 11]]);
  // 이모지(서로게이트 쌍)는 반으로 자르지 않는다 — 앞 40개
  expect(by(3).snippet).toBe('…' + '🎉'.repeat(40) + '찾을말');
  expect(by(3).ranges).toEqual([[81, 84]]);
  expect(by(4).snippet).toBe('찾을말');
  expect(by(4).ranges).toEqual([[0, 3]]);
  for (const h of r.hits) for (const [s, e] of h.ranges) expect(h.snippet.slice(s, e)).toBe('찾을말');

  // 아주 긴 글(언저리만 글자로 나눈다) · 견주기 꼴에서 길이가 바뀌는 글자(합자 ﬁ → fi)가 앞에 많아도 같은 꼴
  const huge = source('b', [user(1, 'x'.repeat(5000) + '찾을말' + 'y'.repeat(5000)), user(2, 'ﬁ'.repeat(3000) + '찾을말' + 'z'.repeat(10))]);
  const big = await searchHistories([huge], '찾을말');
  expect(big.hits.map((h) => [h.t, h.snippet, h.ranges])).toEqual([
    [2, '…' + 'ﬁ'.repeat(40) + '찾을말' + 'z'.repeat(10), [[41, 44]]],
    [1, '…' + 'x'.repeat(40) + '찾을말' + 'y'.repeat(40) + '…', [[41, 44]]],
  ]);
  // 합자 안의 맞은 곳은 그 글자를 통째로 감싼다 — 'ifi' 는 첫 ﬁ 의 i 와 둘째 ﬁ 에 걸친다
  const lig = (await searchHistories([huge], 'ifi')).hits[0];
  expect(lig.t).toBe(2);
  expect(lig.ranges[0]).toEqual([0, 2]);
  expect(lig.snippet.slice(0, 2)).toBe('ﬁﬁ');
});

test('대소문자·전각반각(NFKC) 무시 — ranges 는 원래 글자 자리', async () => {
  const src = source('a', [user(1, 'Ｄｕｒｅ 배포 Plan'), said(2, 'ｶﾀｶﾅ 글')]);
  expect((await searchHistories([src], 'dure')).hits).toMatchObject([{ t: 1, snippet: 'Ｄｕｒｅ 배포 Plan', ranges: [[0, 4]] }]);
  expect((await searchHistories([src], 'ＰＬＡＮ')).hits).toMatchObject([{ t: 1, ranges: [[8, 12]] }]);
  expect((await searchHistories([src], 'カタカナ')).hits).toMatchObject([{ t: 2, ranges: [[0, 4]] }]);
  expect((await searchHistories([src], ' DURE ')).hits).toHaveLength(1); // 앞뒤 빈칸은 뺀다
});

test('두 글자 미만이면 빈 결과', async () => {
  const src = source('a', [user(1, '배 배포 a ab')]);
  for (const q of ['', ' ', '배', ' 배 ', 'a', '\n', '🎉']) expect(await searchHistories([src], q), JSON.stringify(q)).toEqual({ hits: [], more: false });
  expect((await searchHistories([src], 'ab')).hits).toHaveLength(1);
  expect((await searchHistories([src], '배포')).hits).toHaveLength(1);
});

test('도구 결과·도구 입력·생각·서브에이전트 줄·알림·명령 출력은 찾지 않는다', async () => {
  const src = source('a', [
    { t: 1, kind: 'assistant', blocks: [{ type: 'thinking', thinking: '비밀단어 생각' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: '비밀단어 실행' } }] },
    { t: 2, kind: 'tool-result', toolUseId: 'tu1', isError: false, text: '비밀단어 출력', viaApproval: false },
    said(3, '서브 비밀단어', 'toolu_A'),
    { t: 4, kind: 'tool-result', toolUseId: 'tu2', isError: false, text: '비밀단어', viaApproval: false, parent: 'toolu_A' },
    { t: 5, kind: 'subagent-start', toolUseId: 'toolu_A', taskId: 'k', description: '비밀단어 일', subagentType: null, parentTaskId: null },
    { t: 6, kind: 'notice', text: '비밀단어 알림' },
    { t: 7, kind: 'local-output', text: '비밀단어 출력' },
    { t: 8, kind: 'user', source: 'human', parts: [{ type: 'image', mediaType: 'image/png', bytes: 1, file: '비밀단어.png' }, { type: 'file', name: '비밀단어.txt', bytes: 1, file: 'f' }] },
    { t: 9, kind: 'assistant', blocks: [{ type: 'text', text: '보이는 비밀단어' }, { type: 'tool_use', id: 'tu3', name: 'Read', input: { file_path: '비밀단어' } }] },
  ]);
  const r = await searchHistories([src], '비밀단어');
  expect(r.hits.map((h) => [h.t, h.snippet])).toEqual([[9, '보이는 비밀단어']]);
});

test('상한 limit(기본 50) — 넘으면 more · 새로운 순 · 지금 방 먼저', async () => {
  const many = Array.from({ length: 60 }, (_, i) => user(i + 1, `맞는 말 ${i + 1}`));
  const a = source('a', many);
  const r = await searchHistories([a], '맞는 말');
  expect(r.hits).toHaveLength(50);
  expect(r.more).toBe(true);
  expect(r.hits.map((h) => h.t)).toEqual(Array.from({ length: 50 }, (_, i) => 60 - i));
  expect(await searchHistories([a], '맞는 말', { limit: 3 })).toMatchObject({ more: true, hits: [{ t: 60 }, { t: 59 }, { t: 58 }] });
  expect((await searchHistories([a], '맞는 말', { limit: 60 })).more).toBe(false);

  // 지금 방(roomId)이 먼저 — 그 안에서 새로운 순, 그다음 다른 방도 새로운 순
  const b = source('b', [user(100, '맞는 말 b'), user(300, '맞는 말 b2')], { roomId: 'r2' });
  const c = source('c', [user(200, '맞는 말 c')], { roomId: 'r1' });
  const s = await searchHistories([a, b, c], '맞는 말', { roomId: 'r2', limit: 4 });
  expect(s.hits.map((h) => [h.agentId, h.t])).toEqual([['b', 300], ['b', 100], ['c', 200], ['a', 60]]);
  expect((await searchHistories([a, b, c], '맞는 말', { limit: 3 })).hits.map((h) => h.t)).toEqual([300, 200, 100]);
});

test('깨진 줄·끊긴 마지막 줄·꼴이 틀린 줄·없는 파일·폴더는 건너뛴다', async () => {
  const a = source('a', [
    'not json',
    '{"kind":"user","source":"human","parts":[{"type":"text","text":"시각 없는 찾기"}]}',
    { t: 1, kind: 'user', source: 'human', parts: '찾기' },
    { t: 2, kind: 'assistant', blocks: null },
    { t: 3, kind: 'user', source: 'human', parts: [null, { type: 'text', text: 5 }, { type: 'text', text: '멀쩡한 찾기' }] },
    '',
    '   ',
  ]);
  fs.appendFileSync(a.file, '{"t":9,"kind":"user","source":"human","parts":[{"type":"text","text":"끊긴 찾기');
  const gone: SearchSource = { agentId: 'g', roomId: 'r1', file: path.join(dir, 'none.jsonl'), sessionId: 's' };
  const folder: SearchSource = { agentId: 'f', roomId: 'r1', file: dir, sessionId: 's' };
  const r = await searchHistories([gone, folder, a], '찾기');
  expect(r.hits.map((h) => [h.agentId, h.t, h.snippet])).toEqual([['a', 3, '멀쩡한 찾기']]);
});

// ── 굳지 않기 · 그만두기 ──

/** 합성 기록 n 줄 — 사람·Claude·도구 결과가 돌아가며, 모든 사람·Claude 줄에 'lorem' 이 든다 */
function bigLines(n: number, tag: string): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = 1_000_000 + i;
    const body = `${tag} ${i} 번째 줄 — 기록을 길게 만들려고 넣은 문장이에요. lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod. `.repeat(2);
    const k = i % 3;
    const item =
      k === 0
        ? { t, kind: 'user', source: 'human', parts: [{ type: 'text', text: i % 1500 === 0 ? `드문낱말 ${body}` : body }] }
        : k === 1
          ? { t, kind: 'assistant', blocks: [{ type: 'text', text: body }, { type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: 'npm test' } }] }
          : { t, kind: 'tool-result', toolUseId: `tu${i - 1}`, isError: false, text: body, viaApproval: false };
    out.push(JSON.stringify(item));
  }
  return out.join('\n') + '\n';
}
function bigSources(): SearchSource[] {
  return ['a', 'b', 'c'].map((name, i) => {
    const file = path.join(dir, `big-${name}.jsonl`);
    fs.writeFileSync(file, bigLines(20_000, name));
    return { agentId: name, roomId: i === 0 ? 'r1' : 'r2', file, sessionId: `sid-${name}` };
  });
}

/** 그동안 10 ms 간격 타이머가 가장 크게 벌어진 틈(ms) */
async function maxTimerGap<T>(run: () => Promise<T>): Promise<{ gap: number; value: T; ticks: number }> {
  let last = performance.now();
  let gap = 0;
  let ticks = 0;
  const iv = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
    ticks++;
  }, 10);
  try {
    const value = await run();
    gap = Math.max(gap, performance.now() - last);
    return { gap, value, ticks };
  } finally {
    clearInterval(iv);
  }
}

test('searchDoesNotBlock — 합성 2만 줄 파일 셋을 찾는 동안 10 ms 타이머가 100 ms 넘게 벌어지지 않는다', async () => {
  const sources = bigSources();
  // 거의 모든 줄이 맞는 낱말(후보가 가장 많은 꼴) · 드문 낱말
  const common = await maxTimerGap(() => searchHistories(sources, 'LOREM ipsum', { roomId: 'r2' }));
  expect(common.value.more).toBe(true);
  expect(common.value.hits).toHaveLength(50);
  expect(common.value.hits.every((h) => h.roomId === 'r2')).toBe(true);
  expect(common.gap, `가장 큰 틈 ${common.gap.toFixed(1)} ms · 타이머 ${common.ticks}번`).toBeLessThan(100);

  const rare = await maxTimerGap(() => searchHistories(sources, '드문낱말'));
  expect(rare.value.hits).toHaveLength(3 * Math.ceil(20_000 / 1500));
  expect(rare.value.more).toBe(false);
  expect(rare.gap, `가장 큰 틈 ${rare.gap.toFixed(1)} ms · 타이머 ${rare.ticks}번`).toBeLessThan(100);
}, 60_000);

test('signal 이 끊기면 그만둔다 — AbortError 로 거절 · 처음부터 끊겨 있으면 읽지 않는다', async () => {
  const sources = bigSources();
  await expect(searchHistories(sources, 'lorem', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });

  const ac = new AbortController();
  const started = performance.now();
  const p = searchHistories(sources, 'lorem', { signal: ac.signal });
  setTimeout(() => ac.abort(), 5);
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  const whole = performance.now();
  await searchHistories(sources, 'lorem');
  // 끊긴 찾기는 다 읽는 찾기보다 빨리 끝난다(다 읽는 데 걸린 시간의 절반 안)
  expect(whole - started).toBeLessThan((performance.now() - whole) / 2 + 20);
}, 60_000);

test('newSearchCancelsOld — main 은 새 찾기가 오면 앞 찾기를 끊고, 끊긴 쪽은 { hits: [], more: false, cancelled: true }', async () => {
  const sources = bigSources();
  const seen: { query: string; roomId?: string; signal: AbortSignal; done: Promise<unknown> }[] = [];
  const engine = {
    search: (query: string, o: { roomId?: string; signal: AbortSignal; limit?: number }) => {
      const done = searchHistories(sources, query, o);
      seen.push({ query, roomId: o.roomId, signal: o.signal, done: done.catch((e) => e) });
      return done;
    },
  } as unknown as Engine;
  const dispatch = createDispatcher(engine, { engineReady: new Promise(() => {}) } as unknown as DispatchDeps); // 엔진 시작 전에도 된다
  const first = dispatch('search', ['lorem', { roomId: 'r2' }]);
  await new Promise((r) => setTimeout(r, 5));
  const second = dispatch('search', ['드문낱말']);
  expect(await first).toEqual({ ok: true, value: { hits: [], more: false, cancelled: true } });
  const got = await second;
  expect(got.ok && (got.value as { hits: unknown[] }).hits).toHaveLength(3 * Math.ceil(20_000 / 1500));
  expect(got.ok && got.value).not.toHaveProperty('cancelled');
  expect(seen.map((s) => [s.query, s.roomId, s.signal.aborted])).toEqual([['lorem', 'r2', true], ['드문낱말', undefined, false]]);
  expect(await seen[0].done).toMatchObject({ name: 'AbortError' }); // 앞 찾기는 실제로 그만뒀다

  // 앞 찾기가 끝난 뒤의 찾기는 끊지 않는다
  const third = await dispatch('search', ['드문낱말']);
  expect(third.ok && third.value).not.toHaveProperty('cancelled');
}, 60_000);

// ── 엔진 ──

async function start(): Promise<Engine> {
  const e = await createEngine({ dataDir, claude: { command: process.execPath, argsPrefix: [FAKE] }, env: {}, usage: false });
  engines.push(e);
  return e;
}

test('engine.search — 모든 방·에이전트의 지금·지난 대화 · 받은 메시지의 보낸 쪽 이름 · 지금 방 먼저 · 열쇠로 그 줄을 다시 연다', async () => {
  const e1 = await start();
  const room = e1.addRoom('방');
  const other = e1.addRoom('다른 방');
  const mk = (roomId: string, name: string) => {
    const f = path.join(dir, name);
    fs.mkdirSync(f, { recursive: true });
    return e1.addAgent({ roomId, name, role: '', folder: f });
  };
  const a = mk(room.id, '기획');
  const b = mk(room.id, '웹');
  const c = mk(other.id, '서버');
  await e1.shutdown();
  engines = [];
  fs.appendFileSync(
    path.join(dataDir, 'messages.jsonl'),
    jsonl([{ op: 'create', msg: { id: 'm1', roomId: room.id, from: a.id, to: b.id, text: '배포 준비 부탁', createdAt: 10, state: 'read', updatedAt: 10 } }]),
  );
  const hist = (id: string, lines: unknown[]) => {
    fs.mkdirSync(path.join(dataDir, 'history'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'history', `${id}.jsonl`), jsonl(lines));
  };
  hist(a.id, [
    user(100, '배포 순서를 정리해 줘'),
    { t: 101, kind: 'assistant', blocks: [{ type: 'text', text: '배포는 금요일에 해요' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: '배포.sh' } }] },
    { t: 102, kind: 'tool-result', toolUseId: 'tu1', isError: false, text: '배포 로그', viaApproval: false },
    said(103, '서브 배포', 'tu9'),
    { t: 104, kind: 'boundary', ended: 'old-session' },
    user(200, '새 대화 — 배포 다시'),
  ]);
  hist(b.id, [user(150, '배포 준비 부탁', 'relay', 'm1'), { t: 151, kind: 'notice', text: '배포' }]);
  hist(c.id, [user(300, '배포 끝났나요?')]);

  const e = await start();
  const r = await e.search('배포', { roomId: room.id });
  expect(r.more).toBe(false);
  expect(r.hits.map((h) => [h.agentId, h.roomId, h.t, h.who, h.conversation.key, h.from])).toEqual([
    [a.id, room.id, 200, 'me', null, undefined],
    [b.id, room.id, 150, 'message', null, '기획'],
    [a.id, room.id, 101, 'claude', 'old-session', undefined],
    [a.id, room.id, 100, 'me', 'old-session', undefined],
    [c.id, other.id, 300, 'me', null, undefined],
  ]);
  expect(r.hits[2].conversation.startedAt).toBe(100);
  // 열쇠 — null 은 지금 대화(history), 아니면 conversation(id, key) 에 그 줄이 있다
  for (const h of r.hits) {
    const items = h.conversation.key === null ? e.history(h.agentId) : e.conversation(h.agentId, h.conversation.key);
    expect(items.some((x) => x.t === h.t), `${h.agentId} ${h.t}`).toBe(true);
  }
  expect((await e.search('배포')).hits.map((h) => h.t)).toEqual([300, 200, 150, 101, 100]);
  expect((await e.search('배포', { limit: 2 })).more).toBe(true);
  // 지운 에이전트의 기록은 찾지 않는다
  await e.removeAgent(c.id);
  expect((await e.search('배포')).hits.map((h) => h.t)).toEqual([200, 150, 101, 100]);
});
