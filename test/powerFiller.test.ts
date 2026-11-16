import { expect, test } from 'vitest';
import fs from 'node:fs';
import { oneLine } from '../src/renderer/power/events';
import { createFiller } from '../src/renderer/power/filler';
import { fakeAgents } from '../src/renderer/power/fakeWorld';

const agents = fakeAgents();

function run(seed: number, n: number) {
  const f = createFiller({ agents, seed });
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(f.next(agents[i % agents.length].id, i * 10));
    out.push(f.handoff(i * 10));
  }
  return out;
}

test('같은_씨앗이면_같은_사건열', () => {
  expect(run(7, 100)).toEqual(run(7, 100));
  expect(run(7, 100)).not.toEqual(run(8, 100));
});

test('에이전트가_하나면_넘김은_null', () => {
  const f = createFiller({ agents: [agents[0]], seed: 1 });
  expect(f.handoff(0)).toBeNull();
});

test('모든_사건이_real_false', () => {
  for (const e of run(3, 100)) expect(e!.real).toBe(false);
});

test('넘김은_서로_다른_두_에이전트', () => {
  const f = createFiller({ agents, seed: 5 });
  for (let i = 0; i < 100; i++) {
    const h = f.handoff(i)!;
    if (h.kind !== 'handoff') throw new Error('kind');
    expect(h.from).not.toBe(h.to);
  }
});

test('oneLine 은 줄바꿈을 칸으로, 길면 …', () => {
  expect(oneLine('a\nb', 10)).toBe('a b');
  const s = oneLine('x'.repeat(2000), 60);
  expect(s.length).toBe(60);
  expect(s.endsWith('…')).toBe(true);
});

test('채움_경로는_window_dure_를_부르지_않는다', () => {
  for (const f of ['filler.ts', 'mixer.ts', 'fakeWorld.ts']) {
    const src = fs.readFileSync(`src/renderer/power/${f}`, 'utf8');
    expect(src).not.toContain('window.dure');
    expect(src).not.toContain('getStore');
  }
});
