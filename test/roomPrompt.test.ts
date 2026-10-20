import { describe, expect, test } from 'vitest';
import { buildRoomPrompt } from '../src/engine/roomPrompt';
import type { Agent } from '../src/engine/types';

const mk = (name: string, role: string): Agent => ({
  id: name, roomId: 'R', name, role, folder: 'F', sessionId: 'S', started: false,
  auto: false, model: null, alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null,
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
  test('동료가 없으면 안내', () => {
    expect(buildRoomPrompt(mk('a', 'r'), [])).toContain('아직 같은 방에 다른 에이전트가 없습니다');
  });
});
