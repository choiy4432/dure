import { describe, it, expect } from 'vitest'
import { displayStatus, edges, label, nextAgent, pairMessages, summary, unreadFor, type EdgeView } from '../../src/renderer/state/selectors'
import type { PendingRequest, RelayMessage, MessageState } from '../../src/engine/types'
import type { AgentView } from '../../src/shared/ipcContract'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '', folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, hold: null, subagentsRunning: [], ...over,
})
let n = 0
const msg = (from: string, to: string, state: MessageState, over: Partial<RelayMessage> = {}): RelayMessage => ({
  id: `m${n++}`, roomId: 'r1', from, to, text: 't', createdAt: 100, state, updatedAt: 100, ...over,
})
const req = (agentId: string): PendingRequest => ({ id: `q${n++}`, agentId, toolName: 'Bash', input: {}, kind: 'permission', createdAt: 1 })

describe('displayStatus', () => {
  it('승인 요청이 있으면 awaiting, 아니면 에이전트 상태', () => {
    expect(displayStatus(agent('a', { status: 'working' }), [req('a')])).toBe('awaiting')
    expect(displayStatus(agent('a', { status: 'awaiting' }), [])).toBe('awaiting')
    expect(displayStatus(agent('a', { status: 'working' }), [req('b')])).toBe('working')
    expect(displayStatus(agent('a', { status: 'error' }), [])).toBe('error')
    expect(displayStatus(agent('a', { status: 'stopped' }), [])).toBe('stopped')
    expect(displayStatus(agent('a'), [])).toBe('idle')
  })
})

describe('unreadFor', () => {
  it('받는 쪽이 그 에이전트인 pending|held 만 센다', () => {
    const ms = [msg('a', 'b', 'pending'), msg('a', 'b', 'held'), msg('a', 'b', 'queued'), msg('a', 'b', 'delivered'), msg('b', 'a', 'pending')]
    expect(unreadFor('b', ms)).toBe(2)
    expect(unreadFor('a', ms)).toBe(1)
  })
})

describe('summary', () => {
  it('그 방의 작업 중·승인 대기·안 읽음을 센다', () => {
    const state = {
      agents: [agent('a', { status: 'working' }), agent('b', { status: 'working' }), agent('c'), agent('z', { roomId: 'r2', status: 'working' })],
      requests: [req('b')],
      messages: [msg('a', 'c', 'pending'), msg('a', 'c', 'held'), msg('a', 'c', 'queued'), msg('x', 'y', 'pending', { roomId: 'r2' })],
    }
    expect(summary(state, 'r1')).toEqual({ working: 1, awaiting: 1, unread: 2, fresh: 0 })
    expect(summary(state, 'r2')).toEqual({ working: 1, awaiting: 0, unread: 1, fresh: 0 })
  })
})

describe('summary.fresh / nextAgent', () => {
  const state = {
    agents: [agent('a', { status: 'working' }), agent('b'), agent('c'), agent('d'), agent('z', { roomId: 'r2' })],
    requests: [req('d')],
    messages: [] as RelayMessage[],
    fresh: { a: 1, b: 2, c: 3, d: 4, z: 5 },
  }
  it('summary.fresh', () => {
    expect(summary(state, 'r1').fresh).toBe(2) // b, c (a 는 작업 중, d 는 승인 기다림)
    expect(summary({ ...state, fresh: undefined }, 'r1').fresh).toBe(0)
  })
  it('nextAgent 는 고른 에이전트 다음으로 돌아간다 — 끝이면 처음', () => {
    expect(nextAgent('fresh', state, 'r1', 'b')).toBe('c')
    expect(nextAgent('fresh', state, 'r1', 'c')).toBe('b')
  })
  it('nextAgent: after 가 그 종류가 아니면 첫 에이전트, 없으면 null', () => {
    expect(nextAgent('fresh', state, 'r1', 'a')).toBe('b')
    expect(nextAgent('fresh', state, 'r1', null)).toBe('b')
    expect(nextAgent('unread', state, 'r1', null)).toBeNull()
    expect(nextAgent('awaiting', state, 'r1', 'd')).toBe('d')
  })
})

describe('edges', () => {
  const agents = [agent('a'), agent('b'), agent('c')]
  const NOW = 100 * 24 * 3_600_000
  const MIN = 60_000
  const recent = { now: NOW, mode: 'recent' as const }

  it('두 방향을 한 줄로 — 쌍 id 는 정렬한 두 id, 화살촉은 오간 방향에만', () => {
    const ms = [msg('b', 'a', 'delivered', { createdAt: NOW - 5 * MIN, updatedAt: NOW - 5 * MIN }), msg('a', 'b', 'delivered', { createdAt: NOW - 9 * MIN, updatedAt: NOW - 9 * MIN })]
    expect(edges('r1', agents, ms, recent)).toEqual([
      { id: 'a|b', a: 'a', b: 'b', ab: true, ba: true, from: 'b', to: 'a', state: 'delivered', at: NOW - 5 * MIN, count: 2, age: 'recent' },
    ])
    const one = edges('r1', agents, [msg('b', 'a', 'delivered', { createdAt: NOW, updatedAt: NOW })], recent)[0]
    expect(one).toMatchObject({ id: 'a|b', a: 'a', b: 'b', ab: false, ba: true })
  })

  it('알약은 가장 급한 것 — 내 확인 필요 → 자동 멈춤 → 끝나면 전달, 없으면 가장 최근 전달', () => {
    const ms = [
      msg('a', 'b', 'queued', { createdAt: NOW - 3 * MIN }),
      msg('b', 'a', 'delivered', { createdAt: NOW - MIN, updatedAt: NOW - MIN }),
      msg('a', 'b', 'pending', { createdAt: NOW - 50 * MIN, updatedAt: NOW - 50 * MIN }),
    ]
    expect(edges('r1', agents, ms, recent)[0]).toMatchObject({ from: 'a', to: 'b', state: 'pending', age: 'live', count: 3 })
    const noPending = ms.filter(m => m.state !== 'pending')
    expect(edges('r1', agents, noPending, recent)[0]).toMatchObject({ state: 'queued', age: 'live' })
  })

  it('전달된 선의 나이 — 30분 안 recent, 그 뒤 old(알약 없이 옅게), 24시간 넘으면 안 그림(할 일은 오래돼도 그림)', () => {
    const at = (ago: number) => msg('a', 'b', 'delivered', { createdAt: NOW - ago, updatedAt: NOW - ago })
    expect(edges('r1', agents, [at(29 * MIN)], recent)[0].age).toBe('recent')
    expect(edges('r1', agents, [at(31 * MIN)], recent)[0].age).toBe('old')
    expect(edges('r1', agents, [at(25 * 60 * MIN)], recent)).toEqual([])
    expect(edges('r1', agents, [msg('a', 'b', 'pending', { createdAt: NOW - 25 * 60 * MIN })], recent)[0].age).toBe('live')
  })

  it('24시간 넘은 전달은 방향·수에도 안 센다', () => {
    const ms = [
      msg('a', 'b', 'delivered', { createdAt: NOW - 25 * 60 * MIN, updatedAt: NOW - 25 * 60 * MIN }),
      msg('b', 'a', 'delivered', { createdAt: NOW - MIN, updatedAt: NOW - MIN }),
    ]
    expect(edges('r1', agents, ms, recent)[0]).toMatchObject({ ab: false, ba: true, count: 1 })
  })

  it("'전부'면 오래된 것도 옅게, '끔'이면 아무것도 안 그림", () => {
    const old = [msg('a', 'b', 'delivered', { createdAt: NOW - 25 * 60 * MIN, updatedAt: NOW - 25 * 60 * MIN })]
    expect(edges('r1', agents, old, { now: NOW, mode: 'all' })[0]).toMatchObject({ age: 'old' })
    expect(edges('r1', agents, [msg('a', 'b', 'pending')], { now: NOW, mode: 'off' })).toEqual([])
  })

  it('dismissed 만 있는 쌍은 빼고, 섞여 있으면 dismissed 는 세지 않는다', () => {
    const ms = [
      msg('a', 'b', 'dismissed'),
      msg('a', 'c', 'dismissed', { createdAt: 50 }),
      msg('a', 'c', 'queued', { createdAt: 40 }),
    ]
    const out = edges('r1', agents, ms, recent)
    expect(out.map(e => e.id)).toEqual(['a|c'])
    expect(out[0]).toMatchObject({ state: 'queued', count: 1 })
  })

  it('지워진 에이전트가 낀 쌍과 다른 방 메시지는 뺀다', () => {
    const ms = [msg('a', 'gone', 'pending'), msg('gone', 'b', 'pending'), msg('a', 'b', 'pending', { roomId: 'r2' })]
    expect(edges('r1', agents, ms, recent)).toEqual([])
  })
})

describe('label', () => {
  const e = (state: MessageState, at = 0): EdgeView => ({ id: 'a|b', a: 'a', b: 'b', ab: true, ba: false, from: 'a', to: 'b', state, at, count: 1, age: 'recent' })

  it('전달됨은 60초 경계에서 방금 → N분 전', () => {
    expect(label(e('delivered', 0), 59_000)).toBe('전달됨 · 방금')
    expect(label(e('delivered', 0), 60_000)).toBe('전달됨 · 1분 전')
    expect(label(e('delivered', 0), 5 * 60_000 + 30_000)).toBe('전달됨 · 5분 전')
  })

  it('대기 상태 문구', () => {
    expect(label(e('pending'), 0)).toBe('내 확인 필요')
    expect(label(e('held'), 0)).toBe('자동 멈춤')
    expect(label(e('queued'), 0)).toBe('끝나면 전달')
  })
})

describe('pairMessages', () => {
  it('두 에이전트 사이 양방향 메시지를 최신 먼저, 버린 것도 넣는다', () => {
    const ms = [
      msg('a', 'b', 'delivered', { id: 'x1', createdAt: 10, updatedAt: 12 }),
      msg('b', 'a', 'pending', { id: 'x2', createdAt: 30, updatedAt: 30 }),
      msg('a', 'c', 'pending', { id: 'x3', createdAt: 40 }),
      msg('c', 'b', 'pending', { id: 'x4', createdAt: 50 }),
      msg('a', 'b', 'dismissed', { id: 'x5', createdAt: 20, updatedAt: 25 }),
    ]
    expect(pairMessages('a', 'b', ms).map(m => m.id)).toEqual(['x2', 'x5', 'x1'])
    expect(pairMessages('b', 'a', ms).map(m => m.id)).toEqual(['x2', 'x5', 'x1'])
  })

  it('같은 시각이면 나중에 바뀐 것이 먼저, 원본 배열은 그대로', () => {
    const ms = [
      msg('a', 'b', 'queued', { id: 'y1', createdAt: 10, updatedAt: 10 }),
      msg('a', 'b', 'delivered', { id: 'y2', createdAt: 10, updatedAt: 15 }),
    ]
    expect(pairMessages('a', 'b', ms).map(m => m.id)).toEqual(['y2', 'y1'])
    expect(ms.map(m => m.id)).toEqual(['y1', 'y2'])
  })

  it('오간 메시지가 없으면 빈 목록', () => {
    expect(pairMessages('a', 'b', [msg('a', 'c', 'pending')])).toEqual([])
  })
})
