import { describe, expect, it } from 'vitest'
import { AGENT_COLORS, pinnedAgent, roomView } from '../../src/renderer/power/roomView'

const ag = (id: string, roomId: string, over: object = {}) => ({ id, roomId, name: `${id}이름`, role: `${id}역`, status: 'idle', subagentsRunning: [], ...over })
const st = (over: object = {}): any => ({
  rooms: [{ id: 'r1', name: '첫 방' }],
  agents: [ag('a', 'r1'), ag('b', 'r1'), ag('c', 'r2')],
  requests: [],
  history: {},
  power: { on: true, roomId: 'r1', agentIds: ['a', 'b'] },
  ...over,
})

describe('pinnedAgent — 켤 때 굳힌 목록 안 + 지금도 그 방', () => {
  const power = { roomId: 'r1', agentIds: ['a', 'b'] }
  const agents = [ag('a', 'r1'), ag('b', 'r2'), ag('new', 'r1')]

  it('굳힌_목록에_있고_지금도_그_방이면_그_에이전트', () => {
    expect(pinnedAgent(power, agents, 'a')).toBe(agents[0])
  })

  it('켠_뒤_들어왔거나(목록_밖)_다른_방으로_옮겼거나_지워졌거나_꺼졌으면_없다', () => {
    expect(pinnedAgent(power, agents, 'new')).toBeUndefined()
    expect(pinnedAgent(power, agents, 'b')).toBeUndefined()
    expect(pinnedAgent(power, agents, 'gone')).toBeUndefined()
    expect(pinnedAgent({ roomId: null, agentIds: [] }, agents, 'a')).toBeUndefined()
  })
})

describe('roomView', () => {
  it('방이_없으면_agents_빈_배열_roomName_null', () => {
    expect(roomView(st({ power: { on: false, roomId: null, agentIds: [] } }))).toEqual({ roomId: null, roomName: null, agents: [], state: {}, subagents: [] })
    // 굳힌 방이 지워졌다
    expect(roomView(st({ rooms: [] }))).toEqual({ roomId: null, roomName: null, agents: [], state: {}, subagents: [] })
  })

  it('roomId_는_파워_모드의_방_—_방을_옮기면_그_방의_굳힌_에이전트', () => {
    const rooms = [{ id: 'r1', name: '첫 방' }, { id: 'r2', name: '둘째' }]
    expect(roomView(st({ rooms })).roomId).toBe('r1')
    const moved = roomView(st({ rooms, power: { on: true, roomId: 'r2', agentIds: ['c'] } }))
    expect(moved).toMatchObject({ roomId: 'r2', roomName: '둘째' })
    expect(moved.agents.map(a => a.id)).toEqual(['c'])
  })

  it('에이전트가_0명인_방은_방_이름과_빈_목록', () => {
    const v = roomView(st({ rooms: [{ id: 'r3', name: '빈 방' }], power: { on: true, roomId: 'r3', agentIds: [] } }))
    expect(v.roomName).toBe('빈 방')
    expect(v.agents).toEqual([])
  })

  it('가짜가_없다', () => {
    const v = roomView(st())
    expect(v.roomName).toBe('첫 방')
    expect(v.agents.map(a => [a.id, a.name, a.role])).toEqual([['a', 'a이름', 'a역'], ['b', 'b이름', 'b역']])
    expect(v.agents[0]).not.toHaveProperty('real')
    expect(v.subagents).toEqual([])
  })

  it('켠_뒤에_들어온_에이전트는_없고_지워진_에이전트는_빠지고_색은_그대로', () => {
    const before = roomView(st({ agents: [ag('a', 'r1'), ag('b', 'r1'), ag('d', 'r1')], power: { on: true, roomId: 'r1', agentIds: ['a', 'b', 'd'] } }))
    const after = roomView(st({ agents: [ag('a', 'r1'), ag('d', 'r1'), ag('new', 'r1')], power: { on: true, roomId: 'r1', agentIds: ['a', 'b', 'd'] } }))
    expect(after.agents.map(a => a.id)).toEqual(['a', 'd'])
    expect(after.agents[1].color).toBe(before.agents[2].color)
    expect(Object.keys(after.state)).toEqual(['a', 'd'])
  })

  it('색은_굳힌_차례대로_다섯_색을_돌려_쓴다(여섯째는_첫_색)', () => {
    const many = Array.from({ length: 7 }, (_, i) => ag(`x${i}`, 'r1'))
    const v = roomView(st({ agents: many, power: { on: true, roomId: 'r1', agentIds: many.map(a => a.id) } }))
    expect(v.agents.map(a => a.color)).toEqual([...AGENT_COLORS, AGENT_COLORS[0], AGENT_COLORS[1]])
  })

  it('state_가_스토어_상태를_따른다', () => {
    const v = roomView(st({
      agents: [
        ag('a', 'r1', { status: 'working' }),
        ag('b', 'r1', { status: 'working' }), // 승인 요청이 있으면 기다림이 먼저
        ag('e', 'r1', { status: 'awaiting' }),
        ag('f', 'r1', { status: 'idle', asleep: true }),
        ag('g', 'r1', { status: 'error' }),
        ag('h', 'r1', { status: 'stopped' }),
      ],
      requests: [{ id: 'q', agentId: 'b' }],
      power: { on: true, roomId: 'r1', agentIds: ['a', 'b', 'e', 'f', 'g', 'h'] },
    }))
    expect(v.state).toEqual({ a: 'working', b: 'awaiting', e: 'awaiting', f: 'resting', g: 'resting', h: 'resting' })
  })

  it('서브에이전트는_도는_진짜만_이름은_진짜_설명_없으면_서브에이전트', () => {
    const v = roomView(st({
      agents: [ag('a', 'r1', { subagentsRunning: ['t1', 't2'] }), ag('b', 'r1', { subagentsRunning: ['t3'] }), ag('c', 'r2', { subagentsRunning: ['t9'] })],
      history: {
        a: [
          { t: 1, kind: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: '입력의 설명', prompt: 'x' } }] },
          { t: 2, kind: 'subagent-start', toolUseId: 't1', taskId: 'k1', description: '결제 흐름 조사', subagentType: null, parentTaskId: null },
          { t: 3, kind: 'assistant', blocks: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { description: '테스트 빈틈 찾기' } }] },
        ],
      },
    }))
    expect(v.subagents).toEqual([
      { agentId: 'a', label: '결제 흐름 조사' },
      { agentId: 'a', label: '테스트 빈틈 찾기' },
      { agentId: 'b', label: '서브에이전트' },
    ])
  })

  it('설명_없는_서브에이전트의_이름은_앞의_것이_끝나도_바뀌지_않는다(번호로_다시_매기지_않는다)', () => {
    const agents = (running: string[]) => [ag('a', 'r1', { subagentsRunning: running }), ag('b', 'r1', { subagentsRunning: ['t3'] })]
    const before = roomView(st({ agents: agents(['t1', 't2']) }))
    const after = roomView(st({ agents: agents(['t2']) })) // t1 이 끝났다
    expect(before.subagents.at(-1)).toEqual({ agentId: 'b', label: '서브에이전트' })
    expect(after.subagents.at(-1)).toEqual(before.subagents.at(-1))
    expect(after.subagents.map(s => s.label)).toEqual(['서브에이전트', '서브에이전트'])
  })
})
