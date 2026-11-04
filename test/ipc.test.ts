import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { logEngineErrors, registerIpc, type AppHost, type IpcDeps } from '../src/main/ipc'
import { appPageMatcher } from '../src/main/window'
import { APP_EVENT_NAMES, APP_METHODS, BEFORE_START, CHANNEL, EVENT_NAMES, METHODS } from '../src/shared/ipcContract'
import type { AppEventMap } from '../src/shared/appTypes'
import type { Engine } from '../src/engine'
import { openAttachmentStore } from '../src/engine/attachmentStore'

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
    folderTarget: (_id: string) => ({ kind: 'local', path: agent.folder }),
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
    sleepState: () => ({ asleep: true, waking: false }),
    sleepAfter: () => 60,
    sleep: rec('sleep', Promise.resolve(true)),
    sleepRoom: rec('sleepRoom', Promise.resolve(2)),
    sleepBlock: rec('sleepBlock', 'working'),
    sleepableIn: rec('sleepableIn', 3),
    setSleepAfter: rec('setSleepAfter'),
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
    conversations: rec('conversations', []),
    conversation: rec('conversation', []),
    pastCount: () => 4,
    remoteIssue: (id: string) => (id === 'a1' ? { kind: 'denied', detail: null } : null),
    sshAvailable: () => true,
    sshHosts: () => [{ host: 'dev', user: null, hostName: null, port: null }],
    checkRemote: rec('checkRemote', Promise.resolve({ ok: true, claudeVersion: '2.1' })),
    checkRemoteFolder: rec('checkRemoteFolder', Promise.resolve({ ok: true, folder: '/h', claudeVersion: '2.1' })),
    resumeConversation: rec('resumeConversation', Promise.resolve()),
    forkAgent: rec('forkAgent', agent),
    image: rec('image', Promise.resolve(null)),
    attachmentPath: (_id: string, _file: string) => null, // 기록 안 함 — 시험이 진짜 첨부 가게로 갈아 낀다
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

const PREFS = { tourDone: true, approvalTipSeen: false, claudeAutoUpdate: true }

/** 앱 쪽 흉내 — 13 메서드 모두 vi.fn, 돌려주는 값은 서로 다르게(칸이 뒤바뀌면 잡힌다) */
function fakeApp() {
  return {
    appInfo: vi.fn(async () => ({ version: '1.2.3', packaged: false })),
    prefs: vi.fn(async () => PREFS),
    setPrefs: vi.fn(async (p: object) => ({ ...PREFS, ...p })),
    setupState: vi.fn(async () => ({ phase: 'ready' as const })),
    installClaude: vi.fn(async () => {}),
    loginClaude: vi.fn(async () => {}),
    openSetupGuide: vi.fn(async () => {}),
    setTourVeil: vi.fn(async () => {}),
    claudeUpdateState: vi.fn(async () => 'running' as const),
    updateState: vi.fn(async () => ({ kind: 'dev' as const })),
    checkUpdate: vi.fn(async () => ({ kind: 'none' as const })),
    downloadUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
    openReleasePage: vi.fn(async () => {}),
  } satisfies AppHost
}

/** 아무것도 하지 않는 deps — 각 시험이 필요한 칸만 갈아 낀다 */
function quietDeps(): IpcDeps {
  return {
    pickFolder: async () => null, openFolder: async () => {}, openPath: async () => {}, showInFolder: () => {}, openExternal: async () => {}, isAppPage,
    setTaskbar: async () => {}, flashWindow: async () => {}, focusWindow: async () => {}, applyTheme: () => {}, saveText: async () => null,
    app: fakeApp(), engineReady: Promise.resolve(), onAppEvent: () => {},
  }
}

type AppEventFn = (name: keyof AppEventMap, payload: unknown) => void

function setup(withEngine = true, over: { engineReady?: Promise<void> } = {}) {
  const handlers = new Map<string, Fn>()
  const ipc = { handle: (ch: string, fn: Fn) => void handlers.set(ch, fn) }
  const sent: [string, any][] = []
  let appEvent: AppEventFn | null = null
  const deps = {
    pickFolder: vi.fn(async () => 'C:/picked'), openFolder: vi.fn(async () => {}), openPath: vi.fn(async (_p: string) => {}), showInFolder: vi.fn((_p: string) => {}),
    openExternal: vi.fn(async (_url: string) => {}), isAppPage,
    setTaskbar: vi.fn(async () => {}), flashWindow: vi.fn(async () => {}), focusWindow: vi.fn(async () => {}),
    applyTheme: vi.fn(), saveText: vi.fn(async (name: string, _text: string) => `C:/docs/${name}`),
    app: fakeApp(),
    engineReady: over.engineReady ?? Promise.resolve(),
    onAppEvent: vi.fn((fn: AppEventFn) => {
      appEvent = fn
    }),
  }
  const fe = fakeEngine()
  registerIpc(ipc, withEngine ? fe.engine : null, (ch, p) => sent.push([ch, p]), deps)
  const callFrom = (event: unknown, method: string, ...args: unknown[]) =>
    handlers.get(CHANNEL.invoke)!(event, { method, args }) as Promise<any>
  const call = (method: string, ...args: unknown[]) => callFrom(fromApp, method, ...args)
  /** main 이 앱 사건을 낸 것처럼 */
  const emitApp = (name: keyof AppEventMap, payload: unknown) => appEvent!(name, payload)
  return { call, callFrom, sent, deps, emitApp, ...fe }
}

describe('registerIpc', () => {
  it('지난 대화 메서드는 글이 아닌 인자를 거절한다', async () => {
    const { call, calls } = setup()
    for (const [m, a] of [
      ['conversations', [1]], ['conversation', ['a1', 2]], ['conversation', [1, 'k']], ['resumeConversation', [1, 2]],
      ['resumeConversation', ['a1', 2]], ['forkAgent', [{ from: 'a1', key: 1, name: 'n', role: 'r' }]], ['forkAgent', [null]],
    ] as [string, unknown[]][]) {
      expect(await call(m, ...a), m).toMatchObject({ ok: false })
    }
    expect(calls).toEqual([])
  })

  it('snapshot 의 에이전트에 pastCount 가 실린다', async () => {
    const { call } = setup()
    const r = await call('snapshot')
    expect(r.value.agents[0].pastCount).toBe(4)
  })
  it('snapshot 의 에이전트에 remoteIssue 가 실린다', async () => {
    const { call } = setup()
    expect((await call('snapshot')).value.agents[0].remoteIssue).toEqual({ kind: 'denied', detail: null })
  })

  it('addRoom — 이름만 · remote {host} · null 은 엔진으로, 모양이 틀리면 거절', async () => {
    const { call, calls } = setup()
    expect((await call('addRoom', '방')).ok).toBe(true)
    expect((await call('addRoom', '방', null)).ok).toBe(true)
    expect((await call('addRoom', '서버', { host: 'dev' })).ok).toBe(true)
    expect(calls).toEqual([['addRoom', ['방']], ['addRoom', ['방']], ['addRoom', ['서버', { host: 'dev' }]]])
    for (const bad of [{ host: 5 }, {}, 'dev', { host: 'dev', extra: 1 }, [], 7]) {
      expect(await call('addRoom', '서버', bad), JSON.stringify(bad)).toMatchObject({ ok: false })
    }
    expect(await call('addRoom', 5)).toMatchObject({ ok: false })
    expect(calls).toHaveLength(3)
  })

  it('sshAvailable · sshHosts · checkRemote · checkRemoteFolder — 엔진으로, 글이 아닌 인자는 거절', async () => {
    const { call, calls } = setup()
    expect(await call('sshAvailable')).toEqual({ ok: true, value: true })
    expect(await call('sshHosts')).toEqual({ ok: true, value: [{ host: 'dev', user: null, hostName: null, port: null }] })
    expect((await call('checkRemote', 'dev')).ok).toBe(true)
    expect((await call('checkRemoteFolder', 'r1', '/home/a')).ok).toBe(true)
    expect(calls).toEqual([['checkRemote', ['dev']], ['checkRemoteFolder', ['r1', '/home/a']]])
    for (const [m, a] of [['checkRemote', [1]], ['checkRemoteFolder', [1, '/a']], ['checkRemoteFolder', ['r1', null]]] as [string, unknown[]][]) {
      expect(await call(m, ...a), m).toMatchObject({ ok: false })
    }
    expect(calls).toHaveLength(2)
  })

  it('rejects methods outside the whitelist', async () => {
    const { call } = setup()
    for (const m of ['shutdown', 'on', 'constructor', '__proto__', 'start']) {
      expect(await call(m)).toMatchObject({ ok: false })
    }
  })

  it('rejects a malformed request', async () => {
    const handlers = new Map<string, Fn>()
    registerIpc({ handle: (c, f) => void handlers.set(c, f) }, fakeEngine().engine, () => {}, quietDeps())
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
      conversations: ['a1'], conversation: ['a1', 'k1', { limit: 5 }], resumeConversation: ['a1', 'k1'],
      forkAgent: [{ from: 'a1', key: 'k1', name: 'n', role: 'r' }],
      approveMessage: ['m1'], dismissMessage: ['m1'], continueHeld: ['r1'],
      answerRequest: ['q1', { type: 'allow' }], setAutoChainLimit: [5],
      setEffort: ['a1', 'high'], refreshUsage: [], setAllowBypass: [true], setNotify: [{ finished: true }], setTheme: ['dark'], setBypass: ['a1', false],
      setPlanMode: ['a1', true], resumeHold: ['a1'], dropHoldItem: ['a1', 'i1'], dropHold: ['a1'], revokeAlwaysAllow: ['a1', 'Bash'],
      sleep: ['a1'], sleepRoom: ['r1'], sleepBlock: ['a1'], sleepableIn: ['r1'], setSleepAfter: [15],
    }
    for (const [m, a] of Object.entries(args)) {
      const r = await call(m, ...a)
      expect(r.ok, m).toBe(true)
    }
    expect(calls.map(([n, a]) => [n, a])).toEqual(Object.entries(args))
  })

  it('재우기 메서드는 엔진에 그대로 이어지고 결과를 돌려준다', async () => {
    const { call } = setup()
    expect(await call('sleep', 'a1')).toEqual({ ok: true, value: true })
    expect(await call('sleepRoom', 'r1')).toEqual({ ok: true, value: 2 })
    expect(await call('sleepBlock', 'a1')).toEqual({ ok: true, value: 'working' })
    expect(await call('sleepableIn', 'r1')).toEqual({ ok: true, value: 3 })
    for (const m of ['sleep', 'sleepRoom', 'sleepBlock', 'sleepableIn', 'setSleepAfter']) expect(METHODS).toContain(m)
  })

  it('every whitelisted method is covered by a handler', async () => {
    const { call } = setup()
    for (const m of [...METHODS, ...APP_METHODS]) {
      const r = await call(m, 'a1')
      expect(r.error ?? '', m).not.toBe('허용되지 않은 요청이에요')
    }
  })

  it('APP_METHODS 14개 · 엔진 메서드와 겹치지 않는다 · BEFORE_START 는 엔진 메서드 중에서 · 앱 사건 이름 셋', () => {
    expect([...APP_METHODS].sort()).toEqual([
      'appInfo', 'checkUpdate', 'claudeUpdateState', 'downloadUpdate', 'installClaude', 'installUpdate', 'loginClaude',
      'openReleasePage', 'openSetupGuide', 'prefs', 'setPrefs', 'setTourVeil', 'setupState', 'updateState',
    ])
    for (const m of APP_METHODS) expect(METHODS as readonly string[], m).not.toContain(m)
    expect([...BEFORE_START].sort()).toEqual([
      'conversation', 'conversations', 'flashWindow', 'focusWindow', 'history', 'image', 'openAttachment', 'pickFolder', 'saveConversation',
      'setTaskbar', 'sleepBlock', 'sleepableIn', 'snapshot', 'sshAvailable', 'sshHosts',
    ])
    for (const m of BEFORE_START) expect(METHODS as readonly string[], m).toContain(m)
    expect([...APP_EVENT_NAMES].sort()).toEqual(['claude-update', 'setup', 'update'])
    for (const n of APP_EVENT_NAMES) expect(EVENT_NAMES as readonly string[], n).not.toContain(n)
  })

  it('엔진 없이도 앱 메서드 — deps.app 으로 가고 결과가 돌아온다', async () => {
    const { call, deps } = setup(false)
    expect(await call('prefs')).toEqual({ ok: true, value: PREFS })
    expect(deps.app.prefs).toHaveBeenCalledTimes(1)
    expect(await call('appInfo')).toEqual({ ok: true, value: { version: '1.2.3', packaged: false } })
    expect(await call('setupState')).toEqual({ ok: true, value: { phase: 'ready' } })
    expect(await call('claudeUpdateState')).toEqual({ ok: true, value: 'running' })
    expect(await call('updateState')).toEqual({ ok: true, value: { kind: 'dev' } })
    expect(await call('checkUpdate')).toEqual({ ok: true, value: { kind: 'none' } })
    for (const m of ['installClaude', 'loginClaude', 'openSetupGuide', 'downloadUpdate', 'installUpdate', 'openReleasePage'] as const) {
      expect(await call(m, 'x', { y: 1 }), m).toEqual({ ok: true, value: null })
      expect(deps.app[m], m).toHaveBeenCalledTimes(1)
      expect(deps.app[m], m).toHaveBeenCalledWith() // renderer 가 붙인 인자는 넘기지 않는다
    }
    // 엔진 메서드는 여전히 claude 가 없다고
    expect(await call('addRoom', 'x')).toEqual({ ok: false, error: 'claude 를 찾을 수 없어요' })
  })

  it('앱 메서드 오류는 { error: 문구 } 로 — 스택 없이', async () => {
    const { call, deps } = setup(false)
    deps.app.installClaude.mockRejectedValueOnce(new Error('설치하지 못했어요'))
    expect(await call('installClaude')).toEqual({ ok: false, error: '설치하지 못했어요' })
  })

  it('setTourVeil — 불리언 true 만 true 로 본다(그 밖은 false)', async () => {
    const { call, deps } = setup(false)
    await call('setTourVeil', true)
    expect(deps.app.setTourVeil).toHaveBeenLastCalledWith(true)
    for (const bad of ['true', 1, null, {}]) {
      await call('setTourVeil', bad)
      expect(deps.app.setTourVeil, String(bad)).toHaveBeenLastCalledWith(false)
    }
  })

  it("setPrefs — 아는 칸의 불리언만 deps.app 으로, 그 밖({tourDone:'x'}·모르는 칸·객체 아님)은 무시", async () => {
    const { call, deps } = setup(false)
    expect(await call('setPrefs', { tourDone: 'x' })).toEqual({ ok: true, value: PREFS })
    expect(deps.app.setPrefs).toHaveBeenLastCalledWith({})
    await call('setPrefs', { tourDone: false, approvalTipSeen: 1, claudeAutoUpdate: false, theme: 'dark' })
    expect(deps.app.setPrefs).toHaveBeenLastCalledWith({ tourDone: false, claudeAutoUpdate: false })
    // 물려받은 칸은 보지 않는다
    await call('setPrefs', Object.create({ tourDone: true }))
    expect(deps.app.setPrefs).toHaveBeenLastCalledWith({})
    for (const bad of [null, 'tourDone', [true], 5, undefined]) {
      expect((await call('setPrefs', bad)).ok, String(bad)).toBe(true)
      expect(deps.app.setPrefs).toHaveBeenLastCalledWith({})
    }
  })

  it('engineReady 전엔 띄우는 메서드가 기다린다 — 시작 전에도 되는 것(BEFORE_START)·앱 메서드는 바로', async () => {
    let ready!: () => void
    const { call, calls } = setup(true, { engineReady: new Promise<void>((r) => (ready = r)) })
    let settled = false
    const waiting = call('setSelected', 'a1').then((r) => {
      settled = true
      return r
    })
    expect(await call('history', 'a1')).toEqual({ ok: true, value: [] })
    expect((await call('snapshot')).ok).toBe(true)
    expect(await call('sleepBlock', 'a1')).toEqual({ ok: true, value: 'working' })
    expect(await call('pickFolder')).toEqual({ ok: true, value: 'C:/picked' })
    expect(await call('prefs')).toEqual({ ok: true, value: PREFS })
    // 첨부 열기는 claude 를 띄우지 않는다 — 시작 전에도 바로 답한다
    expect(await call('openAttachment', 'a1', '20261104-120000-a.txt')).toEqual({ ok: false, error: '첨부 파일을 찾을 수 없어요' })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    expect(calls.map(([n]) => n)).toEqual(['history', 'sleepBlock']) // setSelected 는 아직 엔진에 닿지 않았다
    ready()
    expect(await waiting).toEqual({ ok: true, value: null })
    expect(calls.map(([n]) => n)).toEqual(['history', 'sleepBlock', 'setSelected'])
    expect(calls[2]).toEqual(['setSelected', ['a1']])
  })

  it('engineReady 가 거절돼도 기다리던 메서드는 엔진에 닿는다', async () => {
    const { call, calls } = setup(true, { engineReady: Promise.reject(new Error('시작 실패')) })
    expect(await call('setSelected', 'a1')).toEqual({ ok: true, value: null })
    expect(calls.map(([n]) => n)).toEqual(['setSelected'])
  })

  it('앱 사건을 event 채널로 — { name, payload } 봉투, 엔진 사건과 같은 길', () => {
    const { emitApp, sent, engine, deps } = setup()
    expect(deps.onAppEvent).toHaveBeenCalledTimes(1)
    emitApp('setup', { phase: 'checking' })
    emitApp('update', { kind: 'available', version: '0.2.0', current: '0.1.0', highlights: ['a'], url: 'https://x' })
    emitApp('claude-update', 'running')
    engine.emit('held', { roomId: 'r1' })
    expect(sent).toEqual([
      [CHANNEL.event, { name: 'setup', payload: { phase: 'checking' } }],
      [CHANNEL.event, { name: 'update', payload: { kind: 'available', version: '0.2.0', current: '0.1.0', highlights: ['a'], url: 'https://x' } }],
      [CHANNEL.event, { name: 'claude-update', payload: 'running' }],
      [CHANNEL.event, { name: 'held', payload: { roomId: 'r1' } }],
    ])
  })

  it('앱 사건은 엔진이 없어도 간다', () => {
    const { emitApp, sent } = setup(false)
    emitApp('setup', { phase: 'needs', install: { state: 'todo' }, login: { state: 'locked' } })
    expect(sent).toEqual([[CHANNEL.event, { name: 'setup', payload: { phase: 'needs', install: { state: 'todo' }, login: { state: 'locked' } } }]])
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
      agents: [{ id: 'a1', status: 'idle', errorText: null, bypassOn: true, bypass: true, bypassBySettings: false, bypassPending: true, heldInput: 2, effortNow: 'high', modelNow: 'claude-opus-5-5', subagentsRunning: ['toolu_1', 'toolu_2'], planMode: true, hold: { since: 1, items: [] }, asleep: true, waking: false }],
      sleepAfterMin: 60,
      usage: { windows: [{ key: 'session', percent: 40 }] },
    })
  })

  it('forwards every engine event as dure:event { name, payload }', () => {
    const { engine, sent } = setup()
    expect(EVENT_NAMES).toHaveLength(20)
    expect(EVENT_NAMES).toContain('always-allow')
    expect(EVENT_NAMES).toContain('sleep')
    expect(EVENT_NAMES).toContain('subagents')
    expect(EVENT_NAMES).toContain('agent-added')
    for (const name of EVENT_NAMES) engine.emit(name, { n: name })
    expect(sent).toEqual(EVENT_NAMES.map((name) => [CHANNEL.event, { name, payload: { n: name } }]))
  })

  it('does not break the engine when sending fails', () => {
    const e = fakeEngine()
    let appEvent: AppEventFn | null = null
    registerIpc({ handle: () => {} }, e.engine, () => {
      throw new Error('Object has been destroyed')
    }, { ...quietDeps(), onAppEvent: (fn) => void (appEvent = fn) })
    expect(() => e.engine.emit('held', { roomId: 'r1' })).not.toThrow()
    expect(() => appEvent!('setup', { phase: 'ready' })).not.toThrow()
  })

  it('with no engine: snapshot says claudeMissing, everything else is rejected in Korean', async () => {
    const { call, sent } = setup(false)
    const s = await call('snapshot')
    expect(s.value).toEqual({
      claudeMissing: true, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0, allowBypass: false, notify: { asks: true, finished: false }, theme: 'system', sleepAfterMin: 30, usage: null,
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

  it('saveConversation — 파일 이름을 다듬어(경로·쓸 수 없는 글자 빼고 .md) 창 쪽 저장으로 · 글이 아니면 거절', async () => {
    const { call, deps } = setup()
    expect(await call('saveConversation', '..\\..\\웹:화면-대화-2026-10-28.md', '# 대화')).toEqual({ ok: true, value: 'C:/docs/웹_화면-대화-2026-10-28.md' })
    expect(deps.saveText).toHaveBeenLastCalledWith('웹_화면-대화-2026-10-28.md', '# 대화')
    await call('saveConversation', 'a/b/메모', 'x')
    expect(deps.saveText).toHaveBeenLastCalledWith('메모.md', 'x')
    await call('saveConversation', '  ', 'x') // 이름이 비면 '대화.md'
    expect(deps.saveText).toHaveBeenLastCalledWith('대화.md', 'x')
    expect(await call('saveConversation', 5, 'x')).toMatchObject({ ok: false })
    expect(await call('saveConversation', 'a.md', null)).toMatchObject({ ok: false })
    expect(deps.saveText).toHaveBeenCalledTimes(3)
  })

  it('openAgentFolder — 등록된 에이전트만 · 이 PC 방은 폴더 열기', async () => {
    const { call, deps } = setup()
    expect(await call('openAgentFolder', 'ghost')).toMatchObject({ ok: false })
    expect(await call('openAgentFolder', 5)).toMatchObject({ ok: false })
    expect(deps.openFolder).not.toHaveBeenCalled()
    expect((await call('openAgentFolder', 'a1')).ok).toBe(true)
    expect(deps.openFolder).toHaveBeenCalledWith('C:/work/a')
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('openAgentFolder — 서버 방이면 VS Code 원격 창 주소 · 못 열면 VS Code 글', async () => {
    const { call, deps, engine } = setup()
    ;(engine as any).folderTarget = () => ({ kind: 'remote', host: 'dev', path: '/home/a/web' })
    expect((await call('openAgentFolder', 'a1')).ok).toBe(true)
    expect(deps.openExternal).toHaveBeenCalledWith('vscode://vscode-remote/ssh-remote+dev/home/a/web')
    expect(deps.openFolder).not.toHaveBeenCalled()
    ;(engine as any).folderTarget = () => ({ kind: 'remote', host: 'me@h:2222', path: '/home/a/my web' })
    await call('openAgentFolder', 'a1')
    expect(deps.openExternal).toHaveBeenLastCalledWith('vscode://vscode-remote/ssh-remote+me%40h%3A2222/home/a/my%20web')
    for (const [p, enc] of [['/home/a/proj#1', 'proj%231'], ['/home/a/q?x', 'q%3Fx'], ['/home/a/my dir', 'my%20dir']]) {
      ;(engine as any).folderTarget = () => ({ kind: 'remote', host: 'dev', path: p })
      await call('openAgentFolder', 'a1')
      expect(deps.openExternal).toHaveBeenLastCalledWith('vscode://vscode-remote/ssh-remote+dev/home/a/' + enc)
    }
    deps.openExternal.mockRejectedValueOnce(new Error('x'))
    expect(await call('openAgentFolder', 'a1')).toEqual({ ok: false, error: 'VS Code 를 찾지 못했어요' })
  })

  it('openAttachment — 폴더 밖 거절·없으면 오류·있으면 openPath', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-ipc-attach-'))
    try {
      // 진짜 첨부 가게(시험 폴더 안) — 엔진 흉내는 등록된 에이전트(a1)만 그 가게로 푼다
      const store = openAttachmentStore(dir)
      const src = path.join(dir, '원본.txt')
      fs.writeFileSync(src, '내용')
      const { file, abs } = await store.copyIn('a1', src, '보고서 최종.txt')
      fs.writeFileSync(path.join(dir, 'attachments', '20261104-120000-밖.txt'), '밖') // 첨부 폴더 안이지만 a1 폴더 밖
      const { call, calls, deps, engine } = setup()
      const attachmentPath = vi.fn((id: string, f: string) => (id === 'a1' ? store.resolve(id, f) : null))
      ;(engine as any).attachmentPath = attachmentPath
      const NOT_FOUND = { ok: false, error: '첨부 파일을 찾을 수 없어요' }
      // 글이 아닌 인자는 엔진에 닿지도 않는다
      for (const a of [[5, file], ['a1', 5], ['a1'], ['a1', null], [null, file], ['a1', { file }], ['a1', [file]]] as unknown[][]) {
        expect(await call('openAttachment', ...a), JSON.stringify(a)).toEqual(NOT_FOUND)
      }
      expect(attachmentPath).not.toHaveBeenCalled()
      // 폴더 밖(.. · 절대 경로 · 원본) · 없는 사본 · 빈 이름 · 다른(없는) 에이전트 — 아무것도 열지 않는다
      for (const [id, f] of [
        ['a1', '..\\20261104-120000-밖.txt'], ['a1', '../20261104-120000-밖.txt'], ['a1', abs], ['a1', src],
        ['a1', 'C:\\Windows\\notepad.exe'], ['a1', '20261104-120000-없음.txt'], ['a1', ''], ['ghost', file], ['..', file],
      ]) {
        expect(await call('openAttachment', id, f), `${id} ${f}`).toEqual(NOT_FOUND)
      }
      expect(deps.openPath).not.toHaveBeenCalled()
      expect(deps.openFolder).not.toHaveBeenCalled()
      // 있으면 그 사본의 절대 경로를 연다 — 엔진의 다른 메서드(claude 를 띄우는 것 등)는 부르지 않는다
      expect(await call('openAttachment', 'a1', file)).toEqual({ ok: true, value: null })
      expect(deps.openPath).toHaveBeenCalledTimes(1)
      expect(deps.openPath).toHaveBeenCalledWith(abs)
      expect(calls).toEqual([])
      // 열지 못하면(연결된 프로그램 없음 등) 쉬운 글 — 원문(경로가 들 수 있다)은 싣지 않는다
      deps.openPath.mockRejectedValueOnce(new Error(`Failed to open path ${abs}`))
      expect(await call('openAttachment', 'a1', file)).toEqual({ ok: false, error: '첨부 파일을 열지 못했어요' })
      expect(fs.readFileSync(src, 'utf8')).toBe('내용') // 원본은 그대로
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('openAttachment — 허용 목록(문서·그림·소리·영상·zip)에 없는 종류(실행·스크립트·프로젝트·디스크 이미지·확장자 없음 …)는 열지 않고 탐색기에서 그 파일을 보인다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-ipc-attach-'))
    try {
      const store = openAttachmentStore(dir)
      const { call, deps, engine } = setup()
      ;(engine as any).attachmentPath = (id: string, f: string) => store.resolve(id, f)
      const src = path.join(dir, 'x')
      fs.writeFileSync(src, 'echo')
      for (const name of [
        'run.bat', 'SETUP.EXE', '바로 가기.lnk', 'a.ps1', 'a.cmd', 'a.vbs', 'a.js', 'a.msi', 'a.reg', 'a.hta', 'a.scr', 'a.url', '확장자없음',
        'cleanup.sh', 'a.pdf.exe', '\u202Efdp.exe', 'a.rdp', 'a.themepack', 'a.diagcfg', 'a.pfx', 'a.mht', 'a.appinstaller',
        // \uD5C8\uC6A9 \uBAA9\uB85D \uBC16 \u2014 \uAE30\uBCF8 \uC5F0\uACB0\uC774 \uBE4C\uB4DC\u00B7\uB9C8\uC6B4\uD2B8\u00B7\uC2A4\uD06C\uB9BD\uD2B8\uB97C \uB3CC\uB9B4 \uC218 \uC788\uB2E4
        'App.sln', 'App.csproj', 'disk.iso', 'disk.img', 'addin.vsto', 'tool.py', 'index.ts', 'page.html', 'logo.svg', 'data.xml', 'a.7z', '.env',
      ]) {
        const { file, abs } = await store.copyIn('a1', src, name)
        deps.openPath.mockClear()
        deps.showInFolder.mockClear()
        expect(await call('openAttachment', 'a1', file), name).toEqual({ ok: true, value: null })
        expect(deps.openPath, name).not.toHaveBeenCalled()
        expect(deps.showInFolder, name).toHaveBeenCalledWith(abs)
      }
      // 문서·그림은 그대로 연다
      for (const name of ['보고서.pdf', 'notes.md', 'a.txt', 'shot.png', 'data.xlsx', '기획서.hwp', 'clip.MP4', 'memo.m4a', 'bundle.zip', 'photo.jfif', 'shot.AVIF']) {
        const { file, abs } = await store.copyIn('a1', src, name)
        deps.openPath.mockClear()
        deps.showInFolder.mockClear()
        expect(await call('openAttachment', 'a1', file), name).toEqual({ ok: true, value: null })
        expect(deps.openPath, name).toHaveBeenCalledWith(abs)
        expect(deps.showInFolder, name).not.toHaveBeenCalled()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sendUser file part 검증 — type·path(절대)·name(글)·bytes(0 이상 정수)만, 다른 칸·틀린 값은 엔진에 닿지 않고 거절', async () => {
    const { call, calls } = setup()
    const abs = path.resolve(os.tmpdir(), '보고서 최종.pdf')
    const good = { type: 'file', path: abs, name: '보고서 최종.pdf', bytes: 1234 }
    const empty = { type: 'file', path: abs, name: '', bytes: 0 }
    const text = { type: 'text', text: '읽어 줘' }
    const image = { type: 'image', mediaType: 'image/png', base64: 'AAAA' }
    expect(await call('sendUser', 'a1', [text, good, image, empty])).toEqual({ ok: true, value: null })
    expect(await call('sendUser', 'a1', [good], { plan: true })).toEqual({ ok: true, value: null })
    expect(calls).toEqual([
      ['sendUser', ['a1', [text, good, image, empty], undefined]],
      ['sendUser', ['a1', [good], { plan: true }]],
    ])
    // 네트워크 공유·빗금 꼴·긴 경로 꼴도 절대 경로다 — 검증을 조이다가 막히지 않게
    calls.length = 0
    for (const p of ['\\\\server\\share\\a.pdf', 'C:/x/a.pdf', '\\\\?\\C:\\x\\a.pdf']) {
      expect(await call('sendUser', 'a1', [{ ...good, path: p }]), p).toEqual({ ok: true, value: null })
    }
    expect(calls).toHaveLength(3)
    const BAD = { ok: false, error: '파일을 보내지 못했어요 — 첨부 정보가 올바르지 않아요' }
    const { path: _p, ...noPath } = good
    const { name: _n, ...noName } = good
    const { bytes: _b, ...noBytes } = good
    const bads: unknown[] = [
      { ...good, extra: 1 },
      { ...good, sendPath: abs }, // 준비된 꼴(Claude 에게 줄 경로)을 화면이 꾸며 보내도
      { type: 'file', name: good.name, bytes: 1, file: '20261104-120000-x.txt', sendPath: abs },
      { ...good, remotePath: '/home/a/x' },
      noPath, noName, noBytes,
      { ...good, path: 'rel.txt' }, { ...good, path: '..\\a.txt' }, { ...good, path: 'C:a.txt' }, { ...good, path: '' },
      { ...good, path: 5 }, { ...good, path: null }, { ...good, path: [abs] }, { ...good, path: `${abs}\u0000.txt` },
      { ...good, name: 5 }, { ...good, name: null }, { ...good, name: ['a'] },
      { ...good, bytes: -1 }, { ...good, bytes: 1.5 }, { ...good, bytes: '3' }, { ...good, bytes: NaN }, { ...good, bytes: Infinity },
      { ...good, bytes: null }, { ...good, bytes: 2 ** 53 },
    ]
    for (const bad of bads) {
      expect(await call('sendUser', 'a1', [text, bad]), JSON.stringify(bad)).toEqual(BAD)
      expect(await call('sendUser', 'a1', [bad, good]), JSON.stringify(bad)).toEqual(BAD) // 몇째 칸이든
    }
    // 칸 목록이 아니면 거절
    for (const parts of [undefined, null, 'hi', 5, text, { 0: good, length: 1 }]) {
      expect(await call('sendUser', 'a1', parts), JSON.stringify(parts)).toEqual({ ok: false, error: '보낼 내용이 올바르지 않아요' })
    }
    expect(calls).toHaveLength(3) // 위의 정상 경로 셋 — 틀린 꼴은 하나도 엔진에 닿지 않았다
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
      expect(await callFrom(ev, 'installClaude')).toEqual({ ok: false, error: '허용되지 않은 요청이에요' })
      expect(await callFrom(ev, 'setPrefs', { tourDone: true })).toEqual({ ok: false, error: '허용되지 않은 요청이에요' })
    }
    expect(calls).toEqual([])
    expect(deps.pickFolder).not.toHaveBeenCalled()
    expect(deps.app.installClaude).not.toHaveBeenCalled()
    expect(deps.app.setPrefs).not.toHaveBeenCalled()
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
