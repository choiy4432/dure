import { describe, it, expect } from 'vitest'
import { inboxView } from '../../src/renderer/state/inbox'
import type { PendingRequest, RelayMessage, MessageState } from '../../src/engine/types'
import type { AgentView } from '../../src/shared/ipcContract'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '', folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], ...over,
})
let n = 0
const msg = (from: string, to: string, state: MessageState, over: Partial<RelayMessage> = {}): RelayMessage => ({
  id: `m${n++}`, roomId: 'r1', from, to, text: 't', createdAt: 100, state, updatedAt: 100, ...over,
})
const req = (agentId: string, createdAt = 1): PendingRequest => ({ id: `q${n++}`, agentId, toolName: 'Bash', input: {}, kind: 'permission', createdAt })

describe('inboxView', () => {
  it('asks·messages 는 오래된 것 먼저, 다른 방 것은 빼고 otherRooms 로', () => {
    const agents = [agent('a'), agent('b'), agent('z', { roomId: 'r2' })]
    const late = req('a', 50)
    const early = req('b', 10)
    const m1 = msg('a', 'b', 'pending', { createdAt: 30 })
    const m2 = msg('b', 'a', 'pending', { createdAt: 20 })
    const v = inboxView({
      agents, fresh: {},
      requests: [late, early, req('z', 5)],
      messages: [m1, m2, msg('a', 'b', 'held'), msg('a', 'z', 'pending', { roomId: 'r2' })],
    }, 'r1')
    expect(v.asks).toEqual([early, late])
    expect(v.messages).toEqual([m2, m1])
    expect(v.held).toBe(true)
    expect(v.otherRooms).toBe(2)
  })
  it('fresh 는 작업 중·승인 기다림이면 빠진다', () => {
    const agents = [agent('a'), agent('b', { status: 'working' }), agent('c'), agent('d'), agent('e', { roomId: 'r2' })]
    const v = inboxView({ agents, requests: [req('c')], messages: [], fresh: { a: 200, b: 100, c: 100, d: 150, e: 1 } }, 'r1')
    expect(v.fresh).toEqual([{ agentId: 'd', at: 150 }, { agentId: 'a', at: 200 }])
  })
  it('running 은 방 안 순서', () => {
    const agents = [agent('a', { status: 'working' }), agent('x', { roomId: 'r2', status: 'working' }), agent('b'), agent('c', { status: 'working' })]
    expect(inboxView({ agents, requests: [], messages: [], fresh: {} }, 'r1').running).toEqual(['a', 'c'])
  })
})
