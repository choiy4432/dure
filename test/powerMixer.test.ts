import { expect, test } from 'vitest';
import type { ScreenEvent } from '../src/renderer/power/events';
import { createMixer } from '../src/renderer/power/mixer';
import { fakeAgents } from '../src/renderer/power/fakeWorld';

const agents = fakeAgents();
const realTool = (agentId: string, at: number, target = 'a.ts'): ScreenEvent => ({
  kind: 'tool', agentId, tool: 'Read', target, real: true, at,
});

// 0 부터 end 까지 100ms 씩 tick 해 모은다.
function drive(m: ReturnType<typeof createMixer>, from: number, end: number) {
  const out: ScreenEvent[] = [];
  for (let t = from; t <= end; t += 100) out.push(...m.tick(t));
  return out;
}
const fillerTools = (evs: ScreenEvent[], id: string) =>
  evs.filter((e) => e.kind === 'tool' && !e.real && e.agentId === id);

test('진짜가_오면_그_에이전트_채움은_quietMs_동안_쉰다', () => {
  const m = createMixer({ agents, seed: 1, quietMs: 4000 });
  m.tick(0);
  m.real(realTool('impl', 100));
  const evs = drive(m, 100, 3900);
  expect(fillerTools(evs, 'impl')).toHaveLength(0);
  expect(fillerTools(evs, 'test').length).toBeGreaterThan(0);
});

test('quietMs_가_지나면_다시_채운다', () => {
  const m = createMixer({ agents, seed: 1, quietMs: 4000 });
  m.tick(0);
  m.real(realTool('impl', 100));
  const evs = drive(m, 100, 12000);
  const late = fillerTools(evs, 'impl');
  expect(late.length).toBeGreaterThan(0);
  for (const e of late) expect(e.at).toBeGreaterThanOrEqual(4100);
  expect(late.some((e) => e.at > 6000)).toBe(true);
});

test('진짜_사건은_그대로_나온다(real:true)', () => {
  const m = createMixer({ agents, seed: 1 });
  m.real(realTool('lead', 50));
  m.real({ kind: 'handoff', from: 'lead', to: 'impl', text: '해 줘', real: true, at: 60 });
  const out = m.tick(100);
  const reals = out.filter((e) => e.real);
  expect(reals).toHaveLength(2);
  expect(reals[0]).toMatchObject({ kind: 'tool', agentId: 'lead', target: 'a.ts', at: 50 });
  expect(reals[1]).toMatchObject({ kind: 'handoff', text: '해 줘', at: 60 });
});

test('진짜_넘김은_채움_넘김을_멈추지_않는다', () => {
  const m = createMixer({ agents, seed: 1 });
  m.tick(0);
  m.real({ kind: 'handoff', from: 'lead', to: 'impl', text: 'x', real: true, at: 10 });
  const evs = drive(m, 0, 3000);
  expect(evs.filter((e) => e.kind === 'handoff' && !e.real).length).toBeGreaterThan(0);
});

test('tick_은_at_순이고_사건을_한_번만_낸다', () => {
  const m = createMixer({ agents, seed: 2 });
  m.real(realTool('lead', 500));
  const a = m.tick(0);
  const b = drive(m, 100, 5000);
  const all = [...a, ...b];
  for (let i = 1; i < b.length; i++) expect(b[i].at).toBeGreaterThanOrEqual(b[i - 1].at);
  const key = (e: ScreenEvent) =>
    e.kind === 'tool' ? `t|${e.at}|${e.agentId}|${e.tool}|${e.target}` : `h|${e.at}|${e.from}|${e.to}|${e.text}`;
  expect(new Set(all.map(key)).size).toBe(all.length);
  expect(m.tick(5000)).toEqual([]);
});

test('첫_tick_은_밀린_사건을_쏟지_않는다', () => {
  const m = createMixer({ agents, seed: 3 });
  const first = m.tick(1_000_000);
  expect(first.length).toBe(0);
  for (const e of m.tick(1_002_300)) expect(e.at).toBeGreaterThan(1_000_000);
});

test('진짜_tool_의_target_은_80자로_자른다', () => {
  const m = createMixer({ agents, seed: 1 });
  m.real(realTool('lead', 1, 'y'.repeat(500)));
  const e = m.tick(2).find((x) => x.real)!;
  if (e.kind !== 'tool') throw new Error('kind');
  expect(e.target.length).toBe(80);
  expect(e.target.endsWith('…')).toBe(true);
});

test('진짜_넘김의_text_는_한_줄_80자로_만든다', () => {
  const m = createMixer({ agents, seed: 1 });
  m.real({ kind: 'handoff', from: 'lead', to: 'impl', text: '첫 줄\n둘째 줄\n' + 'z'.repeat(300), real: true, at: 5 });
  const e = m.tick(10).find((x) => x.real)!;
  if (e.kind !== 'handoff') throw new Error('kind');
  expect(e.text).not.toMatch(/[\r\n]/);
  expect(e.text.length).toBe(80);
  expect(e.text.startsWith('첫 줄 둘째 줄')).toBe(true);
});

test('tick_없이_진짜_사건이_쌓여도_가장_최근_100개만_남긴다', () => {
  const m = createMixer({ agents, seed: 1 });
  for (let i = 0; i < 1000; i++) m.real(realTool('lead', i, `f${i}.ts`));
  const reals = m.tick(1000).filter((e) => e.real);
  expect(reals).toHaveLength(100);
  expect(reals.map((e) => (e.kind === 'tool' ? e.target : ''))).toEqual(Array.from({ length: 100 }, (_, i) => `f${900 + i}.ts`));
});

test('긴_공백_뒤에도_쏟아지지_않는다', () => {
  const m = createMixer({ agents, seed: 4 });
  drive(m, 0, 5000);
  const burst = m.tick(5000 + 600_000);
  expect(burst.length).toBeLessThanOrEqual(agents.length + 1);
  // 이어지는 tick 은 평소 속도: 10초 동안 에이전트당 ~7회 + 넘김 ~15회 안팎
  const after = drive(m, 605_100, 615_000);
  expect(after.length).toBeGreaterThan(0);
  expect(after.length).toBeLessThan(agents.length * 15 + 40);
  for (const e of after) expect(e.at).toBeGreaterThan(600_000);
});
