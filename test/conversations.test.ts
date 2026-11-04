import { expect, test } from 'vitest';
import { conversationFacts, splitConversations } from '../src/engine/conversations';
import type { HistoryItem } from '../src/engine/types';

const u = (t: number, text: string): HistoryItem => ({ t, kind: 'user', source: 'human', parts: [{ type: 'text', text }] });
const r = (t: number, text: string, messageId: string): HistoryItem => ({ t, kind: 'user', source: 'relay', parts: [{ type: 'text', text }], messageId });
const a = (t: number, text: string, parent?: string): HistoryItem => ({ t, kind: 'assistant', blocks: [{ type: 'text', text }], ...(parent ? { parent } : {}) });
const n = (t: number, text: string): HistoryItem => ({ t, kind: 'notice', text });
const b = (t: number, ended?: string, resumed?: string): HistoryItem => ({ t, kind: 'boundary', ...(ended ? { ended } : {}), ...(resumed ? { resumed } : {}) });

const none = () => null;

test('경계 없음 → 지금 세션 한 대화', () => {
  const u1 = u(1, '안녕');
  const a2 = a(2, '네');
  expect(splitConversations([u1, a2], 'S1')).toEqual([{ key: 'S1', sessionId: 'S1', items: [u1, a2] }]);
});

test('ended 로 닫힌 구간은 그 세션', () => {
  expect(splitConversations([u(1, 'a'), b(2, 'S1'), u(3, 'b')], 'S2').map((c) => c.key)).toEqual(['S1', 'S2']);
});

test('ended 없는 경계 앞 구간 = 세션 모름', () => {
  const cs = splitConversations([u(1, 'a'), b(2), u(3, 'b')], 'S2');
  expect(cs.map((c) => [c.key, c.sessionId])).toEqual([['seg:0', null], ['S2', 'S2']]);
});

test('resumed 경계 뒤 구간은 돌아간 세션 — 앞 구간과 한 대화', () => {
  const u1 = u(1, 'a'), u3 = u(3, 'b'), n5 = n(5, '이 대화로 돌아왔어요'), u6 = u(6, 'c');
  const cs = splitConversations([u1, b(2, 'S1'), u3, b(4, 'S2', 'S1'), n5, u6], 'S1');
  expect(cs.map((c) => c.key)).toEqual(['S1', 'S2']);
  expect(cs[0].items).toEqual([u1, n5, u6]);
  expect(cs[1].items).toEqual([u3]);
});

test('돌아갔다 다시 새 대화', () => {
  const u1 = u(1, 'a'), n5 = n(5, '이 대화로 돌아왔어요'), u6 = u(6, 'c');
  const cs = splitConversations([u1, b(2, 'S1'), u(3, 'b'), b(4, 'S2', 'S1'), n5, u6, b(7, 'S1'), u(8, 'd')], 'S3');
  expect(cs.map((c) => c.key)).toEqual(['S1', 'S2', 'S3']);
  expect(cs[0].items).toEqual([u1, n5, u6]);
});

test('돌아간 뒤 Claude 가 다른 세션 id 를 알렸다 — 마지막 구간은 지금 세션, 닫힌 구간은 닫은 경계의 ended', () => {
  const u1 = u(1, 'a'), u3 = u(3, 'b'), n5 = n(5, '이 대화로 돌아왔어요'), u6 = u(6, 'c'), u8 = u(8, 'd');
  const cs = splitConversations([u1, b(2, 'S1'), u3, b(4, 'S2', 'S1'), n5, u6], 'B');
  expect(cs.map((c) => [c.key, c.sessionId])).toEqual([['S1', 'S1'], ['S2', 'S2'], ['B', 'B']]);
  expect(cs[2].items).toEqual([n5, u6]);
  // 그 뒤 새 대화 — 돌아간 구간은 resumed(S1) 가 아니라 닫은 세션(B)
  const after = splitConversations([u1, b(2, 'S1'), u3, b(4, 'S2', 'S1'), n5, u6, b(7, 'B'), u8], 'S3');
  expect(after.map((c) => c.key)).toEqual(['S1', 'S2', 'B', 'S3']);
  expect(after[2].items).toEqual([n5, u6]);
});

test('사람 말 없는 구간은 목록감이 아니다', () => {
  const n0 = n(0, '폴더를 찾을 수 없습니다');
  const cs = splitConversations([n0, b(1), u(2, 'x')], 'S2');
  expect(cs[0].key).toBe('seg:0');
  expect(cs[0].items).toEqual([n0]);
  expect(conversationFacts(cs[0], none)).toBeNull();
  expect(conversationFacts(cs[1], none)).not.toBeNull();
});

const conv = (items: HistoryItem[]) => ({ key: 'S', sessionId: 'S', items });

test('facts: 제목은 첫 user 의 첫 줄', () => {
  expect(conversationFacts(conv([u(1, '로그인 오류\n자세히')]), none)?.title).toBe('로그인 오류');
});

test('facts: 넘겨받은 말 제목', () => {
  const c = conv([r(1, '일해\n더', 'm1')]);
  expect(conversationFacts(c, (id) => (id === 'm1' ? '기획' : null))?.title).toBe('기획에게서 온 메시지: 일해');
  expect(conversationFacts(c, none)?.title).toBe('받은 메시지: 일해');
});

test('facts: 그림만이면 그림 N장', () => {
  const img = { type: 'image' as const, mediaType: 'image/png', bytes: 1 };
  const c = conv([{ t: 1, kind: 'user', source: 'human', parts: [img, img] }]);
  expect(conversationFacts(c, none)?.title).toBe('그림 2장');
});

test('facts: 첨부만이면 첨부 N개 · 그림도 있으면 그림 N장 · 첨부 N개', () => {
  const img = { type: 'image' as const, mediaType: 'image/png', bytes: 1 };
  const file = (n: number) => ({ type: 'file' as const, name: `${n}.txt`, bytes: 1, file: `20261104-090507-${n}.txt` });
  const human = (parts: any[]): HistoryItem => ({ t: 1, kind: 'user', source: 'human', parts });
  expect(conversationFacts(conv([human([file(1), file(2)])]), none)?.title).toBe('첨부 2개');
  expect(conversationFacts(conv([human([{ type: 'text', text: ' ' }, file(1)])]), none)?.title).toBe('첨부 1개');
  expect(conversationFacts(conv([human([img, file(1), file(2)])]), none)?.title).toBe('그림 1장 · 첨부 2개');
  expect(conversationFacts(conv([human([{ type: 'text', text: '읽어 줘' }, file(1)])]), none)?.title).toBe('읽어 줘'); // 글이 있으면 글
});

test('facts: turns·lastReply·at', () => {
  const c = conv([u(1, 'a'), a(2, '첫 답'), u(3, 'b'), a(4, '부모 답\n둘째 줄'), a(5, '서브', 'p1'), n(6, '끝')]);
  expect(conversationFacts(c, none)).toEqual({ title: 'a', at: 6, turns: 2, lastReply: '부모 답' });
  expect(conversationFacts(conv([u(1, 'a')]), none)?.lastReply).toBe('');
});

test('facts: 제목은 첫 줄이 비면 그다음 글 있는 줄 · 글이 없으면 그림 N장 · 둘 다 없으면 빈 칸', () => {
  expect(conversationFacts(conv([u(1, '\n  \n둘째 줄\n셋')]), none)?.title).toBe('둘째 줄');
  expect(conversationFacts(conv([r(1, '\n\n일해', 'm1')]), () => '기획')?.title).toBe('기획에게서 온 메시지: 일해');
  const img = { type: 'image' as const, mediaType: 'image/png', bytes: 3 };
  const withImg = (parts: any[]): HistoryItem => ({ t: 1, kind: 'user', source: 'human', parts });
  expect(conversationFacts(conv([withImg([{ type: 'text', text: ' \n' }, img, img])]), none)?.title).toBe('그림 2장');
  expect(conversationFacts(conv([withImg([{ type: 'text', text: '' }])]), none)?.title).toBe('');
});

test('facts: lastReply 는 글이 있는 마지막 부모 답 — 도구만 있는 답은 건너뛴다', () => {
  const tool: HistoryItem = { t: 3, kind: 'assistant', blocks: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} } as any] };
  expect(conversationFacts(conv([u(1, 'a'), a(2, '글 답'), tool]), none)?.lastReply).toBe('글 답');
  expect(conversationFacts(conv([u(1, 'a'), tool]), none)?.lastReply).toBe('');
});
