import { describe, it, expect } from 'vitest'
import { todoCounts, roomTotal } from '../../src/renderer/state/attention'
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

describe('todoCounts', () => {
  it('방마다 asks·messages·held(방에 하나) — total·asksTotal', () => {
    const agents = [agent('a'), agent('b'), agent('z', { roomId: 'r2' })]
    const t = todoCounts({
      agents,
      requests: [req('a'), req('b'), req('z')],
      messages: [msg('a', 'b', 'pending'), msg('a', 'b', 'held'), msg('a', 'b', 'held'), msg('a', 'z', 'pending', { roomId: 'r2' })],
    })
    expect(t.rooms.r1).toEqual({ asks: 2, messages: 1, held: 1 })
    expect(t.rooms.r2).toEqual({ asks: 1, messages: 1, held: 0 })
    expect(t.asksTotal).toBe(3)
    expect(t.total).toBe(4 + 2)
  })
  it('없는 에이전트의 요청·메시지는 세지 않는다', () => {
    const t = todoCounts({ agents: [agent('a')], requests: [req('ghost')], messages: [msg('a', 'ghost', 'pending'), msg('a', 'ghost', 'held')] })
    expect(t).toEqual({ total: 0, asksTotal: 0, rooms: {} })
  })
  it('delivered·queued·dismissed 는 세지 않는다', () => {
    const t = todoCounts({ agents: [agent('a'), agent('b')], requests: [], messages: [msg('a', 'b', 'delivered'), msg('a', 'b', 'queued'), msg('a', 'b', 'dismissed')] })
    expect(t.total).toBe(0)
  })
  it('roomTotal(undefined) = 0', () => {
    expect(roomTotal(undefined)).toBe(0)
    expect(roomTotal({ asks: 1, messages: 2, held: 1 })).toBe(4)
  })
})
