import { describe, expect, it } from 'vitest'
import { roomView } from '../../src/renderer/power/roomView'
import { AGENT_COLORS, FAKE_ROOM } from '../../src/renderer/power/fakeWorld'

const ag = (id: string, roomId: string, over: object = {}) => ({ id, roomId, name: id, role: `${id}역`, status: 'idle', subagentsRunning: [], ...over })
const st = (over: object = {}): any => ({
  rooms: [{ id: 'r1', name: '첫 방' }],
  agents: [ag('a', 'r1'), ag('b', 'r1'), ag('c', 'r2')],
  requests: [],
  power: { on: true, roomId: 'r1' },
  ...over,
})

describe('roomView', () => {
  it('방이_없으면_가짜_다섯', () => {
    const v = roomView(st({ power: { on: false, roomId: null } }))
    expect(v.roomName).toBe(FAKE_ROOM)
    expect(v.agents).toHaveLength(5)
    expect(v.agents.every(a => !a.real)).toBe(true)
  })

  it('에이전트_0명이면_가짜_다섯', () => {
    const v = roomView(st({ rooms: [{ id: 'r3', name: '빈 방' }], power: { on: true, roomId: 'r3' } }))
    expect(v.agents).toHaveLength(5)
    expect(v.roomName).toBe(FAKE_ROOM)
  })

  it('진짜_에이전트는_real_true_이고_색이_돌려_배정', () => {
    const many = Array.from({ length: 7 }, (_, i) => ag(`x${i}`, 'r1'))
    const v = roomView(st({ agents: many }))
    expect(v.roomName).toBe('첫 방')
    expect(v.agents.every(a => a.real)).toBe(true)
    expect(v.agents[5].color).toBe(AGENT_COLORS[0])
    expect(v.agents[6].color).toBe(AGENT_COLORS[1])
  })

  it('승인·질문 기다림과 서브에이전트 수', () => {
    const v = roomView(st({
      agents: [ag('a', 'r1', { status: 'awaiting', subagentsRunning: ['s1', 's2'] }), ag('b', 'r1'), ag('c', 'r1', { subagentsRunning: ['s3'] })],
      requests: [{ id: 'q', agentId: 'b' }],
    }))
    expect([...v.awaiting].sort()).toEqual(['a', 'b'])
    expect(v.subagents).toBe(3)
  })

  it('굳힌_방의_에이전트가_지워져도_던지지_않는다', () => {
    expect(() => roomView(st({ agents: [], rooms: [] }))).not.toThrow()
    expect(roomView(st({ agents: [], rooms: [] })).agents).toHaveLength(5)
  })
})
