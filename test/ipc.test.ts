import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { logEngineErrors, registerIpc } from '../src/main/ipc'
import { appPageMatcher } from '../src/main/window'
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
    agents: () => [{ ...agent, bypassOn: true }],
    status: () => 'idle',
    errorText: () => null,
    flags: () => ({ bypass: true, bySettings: false, pending: true }), // 서로 다른 값 — 칸이 뒤바뀌면 잡힌다
    allowBypass: () => true,
    heldInput: () => 2,
    messages: () => [],
    pendingRequests: () => [],
    autoChainLimit: () => 8,
    effortNow: () => 'high',
    modelNow: () => 'claude-opus-5-5',
    subagentsRunning: () => ['toolu_1', 'toolu_2'],
    planMode: () => true,
    hold: () => ({ since: 1, items: [] }),
    usage: () => ({ windows: [{ key: 'session', label: '5시간', percent: 40, resetsAt: null }], at: 1 }),
    setEffort: rec('setEffort', Promise.resolve()),
    refreshUsage: rec('refreshUsage'),
    addRoom: rec('addRoom', { id: 'r2' }),
    renameRoom: rec('renameRoom', { id: 'r1' }),
    removeRoom: rec('removeRoom', Promise.resolve()),
    addAgent: rec('addAgent', agent),
    updateAgent: rec('updateAgent', agent),
    removeAgent: rec('removeAgent', Promise.resolve()),
    setSelected: rec('setSelected'),
    sendUser: rec('sendUser', Promise.resolve()),
    interrupt: rec('interrupt', Promise.resolve()),
    newConversation: rec('newConversation', Promise.resolve()),
    setModel: rec('setModel', Promise.resolve()),
    describe: rec('describe', Promise.resolve({ commands: [], models: [], permissionMode: 'default' })),
    history: rec('history', []),
    image: rec('image', Promise.resolve(null)),
    approveMessage: rec('approveMessage'),
    dismissMessage: rec('dismissMessage'),
    continueHeld: rec('continueHeld'),
    answerRequest: rec('answerRequest'),
    setAutoChainLimit: rec('setAutoChainLimit'),
    notify: () => ({ asks: false, finished: true }), // 기본값과 다른 값 — 칸이 뒤바뀌면 잡힌다
    theme: () => 'dark',
    setTheme: rec('setTheme'),
    setNotify: rec('setNotify'),
    setAllowBypass: rec('setAllowBypass', Promise.resolve()),
    setBypass: rec('setBypass', Promise.resolve()),
    setPlanMode: rec('setPlanMode', Promise.resolve()),
    resumeHold: rec('resumeHold'),
    dropHoldItem: rec('dropHoldItem'),
    dropHold: rec('dropHold'),
    revokeAlwaysAllow: rec('revokeAlwaysAllow', agent),
  })
  return { engine: e as Engine & EventEmitter, calls }
}

/** 앱 화면의 주소 — 빌드된 out/renderer/index.html */
const INDEX = path.resolve('out/renderer/index.html')
const APP_URL = pathToFileURL(INDEX).href
const fromApp = { senderFrame: { url: APP_URL } }
const isAppPage = appPageMatcher({ indexFile: INDEX })

function setup(withEngine = true) {
  const handlers = new Map<string, Fn>()
  const ipc = { handle: (ch: string, fn: Fn) => void handlers.set(ch, fn) }
  const sent: [string, any][] = []
  const deps = {
    pickFolder: vi.fn(async () => 'C:/picked'), openFolder: vi.fn(async () => {}), isAppPage,
    setTaskbar: vi.fn(async () => {}), flashWindow: vi.fn(async () => {}), focusWindow: vi.fn(async () => {}),
    applyTheme: vi.fn(),
  }
  const fe = fakeEngine()
  registerIpc(ipc, withEngine ? fe.engine : null, (ch, p) => sent.push([ch, p]), deps)
  const callFrom = (event: unknown, method: string, ...args: unknown[]) =>
    handlers.get(CHANNEL.invoke)!(event, { method, args }) as Promise<any>
  const call = (method: string, ...args: unknown[]) => callFrom(fromApp, method, ...args)
  return { call, callFrom, sent, deps, ...fe }
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
      isAppPage,
      setTaskbar: async () => {}, flashWindow: async () => {}, focusWindow: async () => {}, applyTheme: () => {},
    })
    expect(await handlers.get(CHANNEL.invoke)!(fromApp, null)).toMatchObject({ ok: false })
    expect(await handlers.get(CHANNEL.invoke)!(fromApp, { method: 5 })).toMatchObject({ ok: false })
  })

  it('forwards each method to the same-named engine method with its args', async () => {
    const { call, calls } = setup()
    const args: Record<string, unknown[]> = {
      addRoom: ['방'], renameRoom: ['r1', '새'], removeRoom: ['r1'],
      addAgent: [{ roomId: 'r1', name: 'n', role: 'r', folder: 'f' }], updateAgent: ['a1', { auto: true }],
      removeAgent: ['a1'], setSelected: ['a1'], sendUser: ['a1', [{ type: 'text', text: 'hi' }], { plan: true }], interrupt: ['a1'],
      newConversation: ['a1'], setModel: ['a1', null], describe: ['a1'], history: ['a1', { all: true }], image: ['a1', 'f.png'],
      approveMessage: ['m1'], dismissMessage: ['m1'], continueHeld: ['r1'],
      answerRequest: ['q1', { type: 'allow' }], setAutoChainLimit: [5],
      setEffort: ['a1', 'high'], refreshUsage: [], setAllowBypass: [true], setNotify: [{ finished: true }], setTheme: ['dark'], setBypass: ['a1', false],
      setPlanMode: ['a1', true], resumeHold: ['a1'], dropHoldItem: ['a1', 'i1'], dropHold: ['a1'], revokeAlwaysAllow: ['a1', 'Bash'],
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
      allowBypass: true,
      notify: { asks: false, finished: true },
      theme: 'dark',
      rooms: [{ id: 'r1' }],
      agents: [{ id: 'a1', status: 'idle', errorText: null, bypassOn: true, bypass: true, bypassBySettings: false, bypassPending: true, heldInput: 2, effortNow: 'high', modelNow: 'claude-opus-5-5', subagentsRunning: ['toolu_1', 'toolu_2'], planMode: true, hold: { since: 1, items: [] } }],
      usage: { windows: [{ key: 'session', percent: 40 }] },
    })
  })

  it('forwards every engine event as dure:event { name, payload }', () => {
    const { engine, sent } = setup()
    expect(EVENT_NAMES).toHaveLength(19)
    expect(EVENT_NAMES).toContain('always-allow')
    expect(EVENT_NAMES).toContain('subagents')
    expect(EVENT_NAMES).toContain('agent-added')
    for (const name of EVENT_NAMES) engine.emit(name, { n: name })
    expect(sent).toEqual(EVENT_NAMES.map((name) => [CHANNEL.event, { name, payload: { n: name } }]))
  })

  it('does not break the engine when sending fails', () => {
    const e = fakeEngine()
    registerIpc({ handle: () => {} }, e.engine, () => {
      throw new Error('Object has been destroyed')
    }, {
      pickFolder: async () => null, openFolder: async () => {}, isAppPage,
      setTaskbar: async () => {}, flashWindow: async () => {}, focusWindow: async () => {}, applyTheme: () => {},
    })
    expect(() => e.engine.emit('held', { roomId: 'r1' })).not.toThrow()
  })

  it('with no engine: snapshot says claudeMissing, everything else is rejected in Korean', async () => {
    const { call, sent } = setup(false)
    const s = await call('snapshot')
    expect(s.value).toEqual({
      claudeMissing: true, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0, allowBypass: false, notify: { asks: true, finished: false }, theme: 'system', usage: null,
    })
    expect(await call('addRoom', 'x')).toEqual({ ok: false, error: 'claude 를 찾을 수 없어요' })
    expect(await call('pickFolder')).toEqual({ ok: false, error: 'claude 를 찾을 수 없어요' })
    expect(sent).toEqual([])
  })

  it('setTheme 은 엔진에 저장한 뒤 창 테마를 바꾼다 — 엔진이 거절하면 창은 그대로', async () => {
    const { call, deps, engine } = setup()
    expect(await call('setTheme', 'light')).toMatchObject({ ok: true })
    expect(deps.applyTheme).toHaveBeenCalledWith('light')
    ;(engine as any).setTheme = () => { throw new Error('화면 테마는 라이트·다크·Windows 따라감 중 하나예요') }
    expect(await call('setTheme', 'blue')).toEqual({ ok: false, error: '화면 테마는 라이트·다크·Windows 따라감 중 하나예요' })
    expect(deps.applyTheme).toHaveBeenCalledTimes(1)
  })

  it('openFolder only opens a registered agent folder', async () => {
    const { call, deps } = setup()
    expect(await call('openFolder', 'C:/Windows')).toMatchObject({ ok: false })
    expect(deps.openFolder).not.toHaveBeenCalled()
    expect((await call('openFolder', 'C:/work/a')).ok).toBe(true)
    expect(deps.openFolder).toHaveBeenCalledWith('C:/work/a')
  })

  it('setAllowBypass · setBypass 는 인자 그대로 엔진으로 가고 엔진 오류 문구가 그대로 돌아온다', async () => {
    const { call, calls, engine } = setup()
    expect(await call('setAllowBypass', false)).toEqual({ ok: true, value: null })
    expect(await call('setBypass', 'a1', true)).toEqual({ ok: true, value: null })
    expect(calls).toEqual([['setAllowBypass', [false]], ['setBypass', ['a1', true]]])
    ;(engine as any).setBypass = async () => { throw new Error('먼저 허용을 켜 주세요') }
    expect(await call('setBypass', 'a1', true)).toEqual({ ok: false, error: '먼저 허용을 켜 주세요' })
  })

  it('setTaskbar·flashWindow·focusWindow 는 deps 로 간다(엔진 아님)', async () => {
    const { call, deps } = setup()
    expect((await call('setTaskbar', 3, 'data:image/png;base64,AAAA')).ok).toBe(true)
    expect(deps.setTaskbar).toHaveBeenCalledWith(3, 'data:image/png;base64,AAAA')
    expect((await call('flashWindow')).ok).toBe(true)
    expect(deps.flashWindow).toHaveBeenCalledTimes(1)
    expect((await call('focusWindow')).ok).toBe(true)
    expect(deps.focusWindow).toHaveBeenCalledTimes(1)
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

  it('앱 화면이 아닌 곳(다른 주소·프레임 없음)에서 온 요청은 거절 — 엔진에 닿지 않고 스택도 없다', async () => {
    const { callFrom, calls, deps } = setup()
    const foreign = [
      { senderFrame: { url: 'https://evil.example/index.html' } },
      { senderFrame: { url: pathToFileURL(path.resolve('out/renderer/other.html')).href } },
      { senderFrame: { url: 'file:///C:/Windows/index.html' } },
      { senderFrame: null },
      {},
      null,
    ]
    for (const ev of foreign) {
      expect(await callFrom(ev, 'addRoom', 'x')).toEqual({ ok: false, error: '허용되지 않은 요청이에요' })
      expect(await callFrom(ev, 'snapshot')).toEqual({ ok: false, error: '허용되지 않은 요청이에요' })
      expect(await callFrom(ev, 'pickFolder')).toEqual({ ok: false, error: '허용되지 않은 요청이에요' })
    }
    expect(calls).toEqual([])
    expect(deps.pickFolder).not.toHaveBeenCalled()
  })

  it('앱 화면에서 온 요청은 통과 — 주소 뒤 #·? 가 붙어도', async () => {
    const { callFrom } = setup()
    expect(await callFrom(fromApp, 'addRoom', 'x')).toEqual({ ok: true, value: { id: 'r2' } })
    expect((await callFrom({ senderFrame: { url: `${APP_URL}#/x` } }, 'snapshot')).ok).toBe(true)
    expect((await callFrom({ senderFrame: { url: `${APP_URL}?a=1` } }, 'snapshot')).ok).toBe(true)
  })
})

describe('logEngineErrors', () => {
  it('엔진 오류는 main 기록에 종류와 문구만 남긴다', () => {
    const { engine } = fakeEngine()
    const log = vi.fn()
    logEngineErrors(engine, log)
    engine.emit('engine-error', { agentId: 'a1', message: 'EPERM: 기록을 쓰지 못했어요' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[두레] engine-error:', 'EPERM: 기록을 쓰지 못했어요')
  })
})
