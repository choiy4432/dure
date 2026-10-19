import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { registerIpc } from '../src/main/ipc'
import { CHANNEL, EVENT_NAMES, METHODS } from '../src/shared/ipcContract'
import type { Engine } from '../src/engine'

type Fn = (event: unknown, req: unknown) => unknown

function fakeEngine() {
  const e = new EventEmitter() as any
  const agent = { id: 'a1', roomId: 'r1', name: '기획', role: '기획자', folder: 'C:/work/a' }
  const calls: [string, unknown[]][] = []
  const rec = (name: string, ret?: unknown) => (...args: unknown[]) => {
    calls.push([name, args])
    return ret
  }
  Object.assign(e, {
    rooms: () => [{ id: 'r1', name: '방', createdAt: 1 }],
    agents: () => [agent],
    status: () => 'idle',
    errorText: () => null,
    flags: () => ({ bypass: true }),
    heldInput: () => 2,
    messages: () => [],
    pendingRequests: () => [],
    autoChainLimit: () => 8,
    addRoom: rec('addRoom', { id: 'r2' }),
    renameRoom: rec('renameRoom', { id: 'r1' }),
    removeRoom: rec('removeRoom', Promise.resolve()),
    addAgent: rec('addAgent', agent),
    updateAgent: rec('updateAgent', agent),
    removeAgent: rec('removeAgent', Promise.resolve()),
    sendUser: rec('sendUser', Promise.resolve()),
    interrupt: rec('interrupt', Promise.resolve()),
    newConversation: rec('newConversation', Promise.resolve()),
    setModel: rec('setModel', Promise.resolve()),
    describe: rec('describe', Promise.resolve({ commands: [], models: [], permissionMode: 'default' })),
    history: rec('history', []),
    approveMessage: rec('approveMessage'),
    dismissMessage: rec('dismissMessage'),
    continueHeld: rec('continueHeld'),
    answerRequest: rec('answerRequest'),
    setAutoChainLimit: rec('setAutoChainLimit'),
  })
  return { engine: e as Engine & EventEmitter, calls }
}

function setup(withEngine = true) {
  const handlers = new Map<string, Fn>()
  const ipc = { handle: (ch: string, fn: Fn) => void handlers.set(ch, fn) }
  const sent: [string, any][] = []
  const deps = { pickFolder: vi.fn(async () => 'C:/picked'), openFolder: vi.fn(async () => {}) }
  const fe = fakeEngine()
  registerIpc(ipc, withEngine ? fe.engine : null, (ch, p) => sent.push([ch, p]), deps)
  const call = (method: string, ...args: unknown[]) =>
    handlers.get(CHANNEL.invoke)!(null, { method, args }) as Promise<any>
  return { call, sent, deps, ...fe }
}

describe('registerIpc', () => {
  it('rejects methods outside the whitelist', async () => {
    const { call } = setup()
    for (const m of ['shutdown', 'on', 'constructor', '__proto__', 'start']) {
      expect(await call(m)).toMatchObject({ ok: false })
    }
  })

  it('rejects a malformed request', async () => {
    const handlers = new Map<string, Fn>()
    registerIpc({ handle: (c, f) => void handlers.set(c, f) }, fakeEngine().engine, () => {}, {
      pickFolder: async () => null,
      openFolder: async () => {},
    })
    expect(await handlers.get(CHANNEL.invoke)!(null, null)).toMatchObject({ ok: false })
    expect(await handlers.get(CHANNEL.invoke)!(null, { method: 5 })).toMatchObject({ ok: false })
  })

  it('forwards each method to the same-named engine method with its args', async () => {
    const { call, calls } = setup()
    const args: Record<string, unknown[]> = {
      addRoom: ['방'], renameRoom: ['r1', '새'], removeRoom: ['r1'],
      addAgent: [{ roomId: 'r1', name: 'n', role: 'r', folder: 'f' }], updateAgent: ['a1', { auto: true }],
      removeAgent: ['a1'], sendUser: ['a1', [{ type: 'text', text: 'hi' }]], interrupt: ['a1'],
      newConversation: ['a1'], setModel: ['a1', null], describe: ['a1'], history: ['a1', { all: true }],
      approveMessage: ['m1'], dismissMessage: ['m1'], continueHeld: ['r1'],
      answerRequest: ['q1', { type: 'allow' }], setAutoChainLimit: [5],
    }
    for (const [m, a] of Object.entries(args)) {
      const r = await call(m, ...a)
      expect(r.ok, m).toBe(true)
    }
    expect(calls.map(([n, a]) => [n, a])).toEqual(Object.entries(args))
  })

  it('every whitelisted method is covered by a handler', async () => {
    const { call } = setup()
    for (const m of METHODS) {
      const r = await call(m, 'a1')
      expect(r.error ?? '').not.toBe('허용되지 않은 요청이에요')
    }
  })

  it('snapshot merges engine state into agent views', async () => {
    const { call } = setup()
    const r = await call('snapshot')
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({
      claudeMissing: false,
      autoChainLimit: 8,
      rooms: [{ id: 'r1' }],
      agents: [{ id: 'a1', status: 'idle', errorText: null, bypass: true, heldInput: 2 }],
    })
  })

  it('forwards every engine event as dure:event { name, payload }', () => {
    const { engine, sent } = setup()
    expect(EVENT_NAMES).toHaveLength(10)
    for (const name of EVENT_NAMES) engine.emit(name, { n: name })
    expect(sent).toEqual(EVENT_NAMES.map((name) => [CHANNEL.event, { name, payload: { n: name } }]))
  })

  it('does not break the engine when sending fails', () => {
    const e = fakeEngine()
    registerIpc({ handle: () => {} }, e.engine, () => {
      throw new Error('Object has been destroyed')
    }, { pickFolder: async () => null, openFolder: async () => {} })
    expect(() => e.engine.emit('held', { roomId: 'r1' })).not.toThrow()
  })

  it('with no engine: snapshot says claudeMissing, everything else is rejected in Korean', async () => {
    const { call, sent } = setup(false)
    const s = await call('snapshot')
    expect(s.value).toEqual({
      claudeMissing: true, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0,
    })
    expect(await call('addRoom', 'x')).toEqual({ ok: false, error: 'claude 를 찾을 수 없어요' })
    expect(await call('pickFolder')).toEqual({ ok: false, error: 'claude 를 찾을 수 없어요' })
    expect(sent).toEqual([])
  })

  it('openFolder only opens a registered agent folder', async () => {
    const { call, deps } = setup()
    expect(await call('openFolder', 'C:/Windows')).toMatchObject({ ok: false })
    expect(deps.openFolder).not.toHaveBeenCalled()
    expect((await call('openFolder', 'C:/work/a')).ok).toBe(true)
    expect(deps.openFolder).toHaveBeenCalledWith('C:/work/a')
  })

  it('pickFolder returns the dialog result', async () => {
    const { call } = setup()
    expect(await call('pickFolder')).toEqual({ ok: true, value: 'C:/picked' })
  })

  it('turns an engine throw (sync or async) into { error: message } without a stack', async () => {
    const { call, engine } = setup()
    ;(engine as any).renameRoom = () => {
      throw new Error('방 이름이 비었어요')
    }
    ;(engine as any).removeAgent = async () => {
      throw new Error('에이전트를 찾을 수 없습니다.')
    }
    expect(await call('renameRoom', 'r1', '')).toEqual({ ok: false, error: '방 이름이 비었어요' })
    expect(await call('removeAgent', 'zz')).toEqual({ ok: false, error: '에이전트를 찾을 수 없습니다.' })
  })
})
