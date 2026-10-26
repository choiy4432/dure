import { describe, expect, test } from 'vitest';
import { buildRoomPrompt } from '../src/engine/roomPrompt';
import type { Agent } from '../src/engine/types';

const mk = (name: string, role: string): Agent => ({
  id: name, roomId: 'R', name, role, folder: 'F', sessionId: 'S', started: false,
  auto: false, model: null, alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null, bypassOn: false,
} as unknown as Agent);

describe('buildRoomPrompt', () => {
  test('자기 이름·역할, 동료, 도구 이름', () => {
    const p = buildRoomPrompt(mk('world', '월드'), [mk('back', '백엔드'), mk('ed', '에디터')]);
    expect(p).toContain('"world"');
    expect(p).toContain('"월드"');
    expect(p).toContain('back(백엔드), ed(에디터)');
    expect(p).toContain('mcp__dure__send_message');
    expect(p).toContain('mcp__dure__list_agents');
  });
  test('새 에이전트 만들기 안내 두 줄 — 오래 맡길 역할만, 짧은 일은 서브에이전트 · 첫 할 일은 그 메시지 하나로 시작할 수 있게', () => {
    const p = buildRoomPrompt(mk('a', 'r'), []);
    expect(p).toContain(
      '새 역할을 오래 맡길 에이전트가 필요하면 mcp__dure__create_agent 로 같은 방에 만들 수 있다(사람이 승인한다). 짧은 일회성 일은 새 에이전트가 아니라 서브에이전트(Agent 도구)로 한다.',
    );
    expect(p).toContain('만들 때 첫 할 일(task)을 같이 넘기면, 새 에이전트가 그 메시지 하나만 읽고 바로 시작할 수 있게 쓴다.');
  });
  test('메시지 주고받기 규칙 — 늦게 온 것은 지금 상태부터 · 여럿이면 다 읽고 한 번에 · 확인만 하는 답장 금지 · 정정은 첫 줄에', () => {
    const p = buildRoomPrompt(mk('a', 'r'), []);
    expect(p).toContain('네가 일하는 도중에 끼어들어 올 수도 있다');
    expect(p).toContain('"· 34분 전에 보냄"');
    expect(p).toContain('이미 끝난 일이면 다시 하지도 답하지도 않는다');
    expect(p).toContain('다 읽은 뒤 한 번에 처리한다');
    expect(p).toContain('뿐인 답장은 보내지 않는다');
    expect(p).toContain('앞 메시지 취소');
  });
  test('동료가 없으면 안내', () => {
    expect(buildRoomPrompt(mk('a', 'r'), [])).toContain('아직 같은 방에 다른 에이전트가 없습니다');
  });
});
