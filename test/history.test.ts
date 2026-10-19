import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openHistory } from '../src/engine/history';
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
