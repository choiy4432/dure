import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capPatch, openHistory, patchFromInput, trimToolInput } from '../src/engine/history';
import { toolSummary } from '../src/renderer/lib/toolSummary';
import { buildTranscript } from '../src/renderer/state/transcript';
import type { HistoryItem } from '../src/engine/types';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-hist-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const note = (text: string, t = 1): HistoryItem => ({ t, kind: 'notice', text });

test('history: append·read·깨진 줄·boundary 이후만', () => {
  const h = openHistory(dir);
  h.append('a', note('1'));
  h.append('a', { t: 2, kind: 'boundary' });
  h.append('a', note('2', 3));
  h.append('a', note('3', 4));
  h.append('b', note('다른 에이전트'));

  expect(h.read('a').map((x) => (x.kind === 'notice' ? x.text : x.kind))).toEqual(['2', '3']);
  expect(h.read('a', { sinceBoundary: false }).map((x) => x.kind)).toEqual(['notice', 'boundary', 'notice', 'notice']);
  expect(h.read('a', { limit: 1 }).map((x) => (x.kind === 'notice' ? x.text : ''))).toEqual(['3']); // 마지막 N 개
  expect(h.read('없음')).toEqual([]);

  // 깨진 줄과 끊긴 마지막 줄 — 건너뛰고, 새로 여는 쪽의 다음 기록은 그 줄에 붙지 않는다
  const file = path.join(dir, 'history', 'a.jsonl');
  fs.appendFileSync(file, 'not json\n{"kind":"notice"}\n{"t":9,"kind":"notice","text":"끊');
  const h2 = openHistory(dir);
  h2.append('a', note('4', 10));
  expect(h2.read('a').map((x) => (x.kind === 'notice' ? x.text : x.kind))).toEqual(['2', '3', '4']);

  h2.remove('a');
  expect(fs.existsSync(file)).toBe(false);
  expect(h2.read('a')).toEqual([]);
});

test('history: limit 은 parent 없는 기록만 센다 — 서브에이전트 줄이 많아도 부모 대화가 잘리지 않고, 그 사이 서브에이전트 줄은 함께', () => {
  const h = openHistory(dir);
  const sub = (t: number): HistoryItem =>
    t % 2 === 0
      ? { t, kind: 'assistant', blocks: [{ type: 'text', text: `s${t}` }], parent: 'toolu_A' }
      : { t, kind: 'tool-result', toolUseId: `u${t}`, isError: false, text: `r${t}`, viaApproval: false, parent: 'toolu_A' };
  h.append('a', note('1', 1));
  h.append('a', sub(2)); // 첫 부모 줄과 함께 잘린다
  h.append('a', note('2', 3));
  for (let t = 4; t < 30; t++) h.append('a', sub(t));
  h.append('a', { t: 30, kind: 'subagent-end', toolUseId: 'toolu_A', taskId: 'task_1', status: 'completed', summary: '보고', toolUses: 26, durationMs: 9 });
  h.append('a', note('3', 31));
  h.append('a', sub(32));
  const got = h.read('a', { limit: 3 });
  expect(got.map((x) => x.t)).toEqual([3, ...Array.from({ length: 26 }, (_, i) => i + 4), 30, 31, 32]);
  expect(h.read('a', { limit: 1 }).map((x) => x.t)).toEqual([31, 32]);
  expect(h.read('a', { limit: 9 })).toHaveLength(32); // 부모 기록이 한도보다 적으면 전부
  expect(h.read('a')).toHaveLength(32);
});

test('history: 마지막 바이트만 보고 끊긴 줄을 닫는다 — 파일 전체를 읽지 않는다', () => {
  const file = path.join(dir, 'history', 'a.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 큰 기록 + 끊긴 마지막 줄(줄바꿈 없이 끝남, 마지막 글자는 여러 바이트 한글)
  fs.writeFileSync(file, `${JSON.stringify(note('x'.repeat(200_000)))}\n{"t":9,"kind":"notice","text":"끊`);
  fs.writeFileSync(path.join(dir, 'history', 'b.jsonl'), `${JSON.stringify(note('b'))}\n`);
  const h = openHistory(dir);
  const read = vi.spyOn(fs, 'readFileSync');
  try {
    h.append('a', note('다음', 10));
    h.append('a', note('또', 11));
    h.append('b', note('b2', 2));
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
  const a = fs.readFileSync(file, 'utf8');
  expect(a.endsWith(`"끊\n${JSON.stringify(note('다음', 10))}\n${JSON.stringify(note('또', 11))}\n`)).toBe(true);
  expect(h.read('a').map((x) => (x.kind === 'notice' ? x.text.slice(0, 2) : x.kind))).toEqual(['xx', '다음', '또']);
  // 줄바꿈으로 끝난 파일엔 빈 줄을 더하지 않는다
  expect(fs.readFileSync(path.join(dir, 'history', 'b.jsonl'), 'utf8')).toBe(`${JSON.stringify(note('b'))}\n${JSON.stringify(note('b2', 2))}\n`);
});

test('trimToolInput: 화면이 읽는 칸만 · 글은 500자까지 · 경로는 끝(파일 이름)을 남긴다', () => {
  expect(trimToolInput({ file_path: 'C:/w/a.ts', content: 'x'.repeat(10_000), old_string: 'a', new_string: 'b' })).toEqual({
    file_path: 'C:/w/a.ts',
  });
  expect(trimToolInput({ to: '웹 화면', text: '긴 본문'.repeat(1000) })).toEqual({ to: '웹 화면' });
  expect(trimToolInput({ skill: 'superpowers:brainstorming', args: '긴 인자'.repeat(1000) })).toEqual({ skill: 'superpowers:brainstorming' });
  // 새 에이전트 만들기 — 하는 일 줄의 대상(새 이름)만. 역할·폴더·첫 할 일은 카드가 승인 요청에서 읽는다
  expect(trimToolInput({ name: '테스트', role: '시험 담당', folder: 'C:/w/t', task: '긴 할 일'.repeat(1000) })).toEqual({ name: '테스트' });
  expect(trimToolInput({ command: 'npm run build', description: '빌드', timeout: 5000 })).toEqual({
    command: 'npm run build',
    description: '빌드',
  });
  expect(trimToolInput({ pattern: 'a', url: 'https://x', query: 'q', notebook_path: 'n.ipynb' })).toEqual({
    pattern: 'a', url: 'https://x', query: 'q', notebook_path: 'n.ipynb',
  });
  // 500자 상한 — 글은 앞을, 경로는 끝을
  const long = 'ㄱ'.repeat(800);
  expect(trimToolInput({ command: long })).toEqual({ command: long.slice(0, 500) });
  const deep = `C:/${'d/'.repeat(400)}Header.tsx`;
  const kept = (trimToolInput({ file_path: deep }) as { file_path: string }).file_path;
  expect(kept).toHaveLength(500);
  expect(kept.endsWith('/Header.tsx')).toBe(true);
  // 글이 아닌 값·객체가 아닌 입력은 남기지 않는다
  expect(trimToolInput({ file_path: 5, to: null })).toEqual({});
  expect(trimToolInput(null)).toEqual({});
  expect(trimToolInput('x')).toEqual({});
});

test('trimToolInput: 줄인 입력으로도 하는 일 요약(화면)은 그대로다', () => {
  const inputs: [string, Record<string, unknown>][] = [
    ['Read', { file_path: 'C:\\w\\src\\Header.tsx', offset: 1, limit: 2000 }],
    ['Write', { file_path: '/w/a.ts', content: 'x'.repeat(5000) }],
    ['Edit', { file_path: '/w/a.ts', old_string: 'a'.repeat(3000), new_string: 'b' }],
    ['MultiEdit', { file_path: '/w/b.ts', edits: [{ old_string: 'a', new_string: 'b' }] }],
    ['NotebookEdit', { notebook_path: '/w/n.ipynb', new_source: 'print(1)' }],
    ['Bash', { command: 'npm run build\nnpm test', description: '빌드', timeout: 1 }],
    ['PowerShell', { command: 'Get-ChildItem' }],
    ['Glob', { pattern: '**/*.ts', path: '/w' }],
    ['Grep', { pattern: 'foo', output_mode: 'content' }],
    ['WebFetch', { url: 'https://example.com', prompt: '요약' }],
    ['WebSearch', { query: '두레', allowed_domains: [] }],
    ['Task', { description: '조사', prompt: '긴 지시'.repeat(500) }],
    ['Agent', { description: '도우미', prompt: 'p' }],
    ['mcp__dure__send_message', { to: '기획', text: '긴 본문'.repeat(500) }],
    ['mcp__dure__list_agents', {}],
    ['mcp__dure__create_agent', { name: '테스트', role: '시험 담당', folder: 'C:/w/t', task: '긴 할 일'.repeat(500) }],
    ['TodoWrite', { todos: [{ content: 'a' }] }],
    ['AskUserQuestion', { questions: [{ question: '?' }] }],
    ['mcp__other__do_thing', { a: 1 }],
  ];
  for (const [name, input] of inputs) {
    expect(toolSummary(name, trimToolInput(input)), name).toEqual(toolSummary(name, input));
  }
});

test('history: 하는 일 입력을 통째로 담은 옛 기록 파일도 그대로 읽는다', () => {
  const file = path.join(dir, 'history', 'a.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old: HistoryItem = {
    t: 1,
    kind: 'assistant',
    blocks: [
      { type: 'text', text: '고칠게요' },
      { type: 'tool_use', id: 'u1', name: 'Write', input: { file_path: 'C:\\w\\big.ts', content: 'y'.repeat(300_000) } },
    ],
  };
  fs.writeFileSync(file, `${JSON.stringify(old)}\n${JSON.stringify({ t: 2, kind: 'tool-result', toolUseId: 'u1', isError: false, text: 'ok', viaApproval: false })}\n`);
  const h = openHistory(dir);
  const items = h.read('a');
  expect(items).toHaveLength(2);
  expect(items[0]).toEqual(old);
  h.append('a', note('뒤', 3));
  expect(h.read('a').map((x) => x.kind)).toEqual(['assistant', 'tool-result', 'notice']);
  const { lines } = buildTranscript(h.read('a'), undefined);
  expect(lines[0]).toMatchObject({ kind: 'claude', text: '고칠게요', actions: [{ verb: '만듦', target: 'big.ts', output: 'ok' }] });
});

test('capPatch: 모두 합쳐 앞 400줄 · 줄마다 500자 — 잘랐을 때만 cut', () => {
  const small = [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] }];
  expect(capPatch(small)).toEqual({ patch: small, cut: false });
  // 400줄 딱 — 자르지 않는다
  const plus = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `+줄 ${from + i}`);
  expect(capPatch([{ oldStart: 1, newStart: 1, lines: plus(400) }])).toEqual({ patch: [{ oldStart: 1, newStart: 1, lines: plus(400) }], cut: false });
  // 401줄 — 앞 400줄
  expect(capPatch([{ oldStart: 1, newStart: 1, lines: plus(401) }])).toEqual({ patch: [{ oldStart: 1, newStart: 1, lines: plus(400) }], cut: true });
  // 묶음을 넘어 센다 — 넘친 묶음은 앞만, 그 뒤 묶음은 버린다
  const capped = capPatch([
    { oldStart: 1, newStart: 1, lines: plus(300) },
    { oldStart: 500, newStart: 600, lines: plus(150, 300) },
    { oldStart: 900, newStart: 900, lines: ['-z'] },
  ]);
  expect(capped.cut).toBe(true);
  expect(capped.patch.map((h) => [h.oldStart, h.lines.length])).toEqual([[1, 300], [500, 100]]);
  expect(capped.patch[1].lines.at(-1)).toBe('+줄 399');
  // 줄당 500자(앞 기호 포함)
  const long = `+${'ㄱ'.repeat(800)}`;
  expect(capPatch([{ oldStart: null, newStart: null, lines: [' a', long] }])).toEqual({
    patch: [{ oldStart: null, newStart: null, lines: [' a', long.slice(0, 500)] }], cut: true,
  });
  // 빈 묶음은 남기지 않는다
  expect(capPatch([{ oldStart: 1, newStart: 1, lines: [] }])).toEqual({ patch: [], cut: false });
});

test('patchFromInput: Edit 은 옛 줄 전부 - · 새 줄 전부 + 한 묶음, MultiEdit 은 edits 마다 — 줄 번호는 모른다(null)', () => {
  expect(patchFromInput('Edit', { file_path: 'a.ts', old_string: 'old 1\nold 2', new_string: 'new 1\r\nnew 2\nnew 3' })).toEqual([
    { oldStart: null, newStart: null, lines: ['-old 1', '-old 2', '+new 1', '+new 2', '+new 3'] },
  ]);
  // 끝 줄바꿈은 빈 줄이 아니다 · 빈 글은 줄이 없다(넣기만·지우기만)
  expect(patchFromInput('Edit', { old_string: 'a\n', new_string: '' })).toEqual([{ oldStart: null, newStart: null, lines: ['-a'] }]);
  expect(patchFromInput('Edit', { old_string: '', new_string: 'b\n\n' })).toEqual([{ oldStart: null, newStart: null, lines: ['+b', '+'] }]);
  expect(patchFromInput('MultiEdit', { file_path: 'b.ts', edits: [{ old_string: 'a', new_string: 'A' }, null, { old_string: 'b\nc', new_string: 'B' }] })).toEqual([
    { oldStart: null, newStart: null, lines: ['-a', '+A'] },
    { oldStart: null, newStart: null, lines: ['-b', '-c', '+B'] },
  ]);
  // 만들 수 없으면 null — 고치는 일이 아니거나, 글이 아니거나, 바뀐 줄이 없거나
  expect(patchFromInput('Write', { file_path: 'a.ts', content: 'x' })).toBeNull();
  expect(patchFromInput('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'x' })).toBeNull();
  expect(patchFromInput('Edit', { old_string: 5, new_string: 'x' })).toBeNull();
  expect(patchFromInput('Edit', { old_string: '', new_string: '' })).toBeNull();
  expect(patchFromInput('Edit', null)).toBeNull();
  expect(patchFromInput('MultiEdit', { edits: 'x' })).toBeNull();
  expect(patchFromInput('MultiEdit', { edits: [{ old_string: 1 }] })).toBeNull();
});
