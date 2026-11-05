import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDispatcher, phoneDispatcher, type DispatchDeps } from '../src/main/dispatch'
import { registerIpc } from '../src/main/ipc'
import { APP_METHODS, BEFORE_START, CHANNEL, CLAUDE_MISSING_ERROR, METHODS, type InvokeResult } from '../src/shared/ipcContract'
import { PHONE_ACCESS, PHONE_DENIED, phoneAllows } from '../src/shared/phoneAccess'
import type { Engine } from '../src/engine'

type Call = [string, unknown[]]

/**
 * 엔진 흉내 — snapshot 이 읽는 것은 정해진 값, 그 밖의 메서드는 부른 것을 적고 over 가 있으면 그 값(없으면 undefined).
 * 칸을 하나하나 적지 않아도 되게 Proxy 로
 */
function fakeEngine(over: Record<string, (...a: any[]) => unknown> = {}) {
  const calls: Call[] = []
  const agent = { id: 'a1', roomId: 'r1', name: '기획', role: '기획자', folder: 'C:/work/a' }
  const reads: Record<string, (...a: unknown[]) => unknown> = {
    rooms: () => [{ id: 'r1', name: '방', createdAt: 1 }],
    agents: () => [agent],
    flags: () => ({ bypass: true, bySettings: false, pending: true }),
    status: () => 'idle',
    errorText: () => null,
    heldInput: () => 2,
    planMode: () => true,
    sleepState: () => ({ asleep: false, waking: false }),
    hold: () => null,
    effortNow: () => 'high',
    modelNow: () => null,
    subagentsRunning: () => [],
    pastCount: () => 3,
    remoteIssue: () => null,
    messages: () => [],
    pendingRequests: () => [],
    autoChainLimit: () => 8,
    allowBypass: () => true,
    notify: () => ({ asks: false, finished: true }),
    theme: () => 'dark',
    sleepAfter: () => 45,
    usage: () => null,
    on: () => {},
  }
  const engine = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => {
      if (typeof k !== 'string') return undefined
      if (Object.hasOwn(reads, k)) return reads[k]
      return (...args: unknown[]) => {
        calls.push([k, args])
        return over[k]?.(...args)
      }
    },
  }) as unknown as Engine
  return { engine, calls }
}

const PREFS = { tourDone: true, approvalTipSeen: false, claudeAutoUpdate: true }

function fakeDeps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    app: {
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
    },
    engineReady: Promise.resolve(),
    pickFolder: vi.fn(async () => 'C:/picked'),
    openFolder: vi.fn(async () => {}),
    openPath: vi.fn(async () => {}),
    showInFolder: vi.fn(),
    openExternal: vi.fn(async () => {}),
    saveText: vi.fn(async (name: string) => `C:/docs/${name}`),
    setTaskbar: vi.fn(async () => {}),
    flashWindow: vi.fn(async () => {}),
    focusWindow: vi.fn(async () => {}),
    applyTheme: vi.fn(),
    ...over,
  }
}

/** 같은 엔진·deps 로 IPC 를 단다 — 앱 화면에서 온 요청처럼 부르는 함수 */
function ipcOf(engine: Engine | null, deps: DispatchDeps) {
  let handler: ((event: unknown, req: unknown) => unknown) | null = null
  registerIpc(
    { handle: (ch, fn) => void (ch === CHANNEL.invoke && (handler = fn)) },
    engine,
    () => {},
    { ...deps, isAppPage: () => true, onAppEvent: () => {} },
  )
  return (req: unknown) => handler!({ senderFrame: { url: 'file:///app/index.html' } }, req) as Promise<InvokeResult>
}

/** IPC 와 디스패처에 같은 요청을 — 둘이 같은 답인지 견준다 */
const CASES: [unknown, unknown][] = [
  ['snapshot', []],
  ['appInfo', []],
  ['prefs', []],
  ['setPrefs', [{ tourDone: false, x: 1 }]],
  ['setTourVeil', ['yes']],
  ['history', ['a1']],
  ['conversations', [1]],
  ['addRoom', ['방', { host: 'dev', x: 1 }]],
  ['sendUser', ['a1', 'hi']],
  ['sendUser', ['a1', [{ type: 'file', path: 'rel.txt', name: 'a', bytes: 1 }]]],
  ['sendUser', ['a1', [{ type: 'attach', sendPath: 'C:\\x.pdf', inline: { mediaType: 'application/pdf', base64: 'AAAA' } }]]],
  ['updateAgent', ['a1', null]],
  ['addAgent', [{ roomId: 'r1', name: 'n', role: {}, folder: 'f' }]],
  ['history', ['a1', { limit: 0 }]],
  ['saveConversation', ['../a:b', '글']],
  ['setSelected', ['a1']],
  ['nope', []],
  ['toString', []],
  ['__proto__', []],
  ['on', []],
  ['pathForFile', []],
  [5, []],
  [undefined, undefined],
  ['snapshot', 'not-array'],
]

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** os.tmpdir() 안의 새 폴더 — inbox 와 inbox 밖 파일 */
function tmpInbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-dispatch-'))
  tmpDirs.push(root)
  const inbox = path.join(root, 'phone-inbox')
  fs.mkdirSync(inbox)
  const put = (p: string, text = 'x') => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
    return p
  }
  return { root, inbox, put }
}

describe('createDispatcher', () => {
  it('IPC 와 같은 결과(snapshot·APP 메서드·claude 없음·engineReady)', async () => {
    // 엔진 있음 · 없음(claude 없음) 두 경우 모두 — 같은 요청에 같은 답
    for (const withEngine of [true, false]) {
      const a = fakeEngine()
      const b = fakeEngine()
      const dispatch = createDispatcher(withEngine ? a.engine : null, fakeDeps())
      const ipc = ipcOf(withEngine ? b.engine : null, fakeDeps())
      for (const [method, args] of CASES) {
        const want = await ipc({ method, args })
        expect(await dispatch(method as string, args as unknown[]), `${withEngine} ${String(method)}`).toEqual(want)
      }
      expect(a.calls).toEqual(b.calls) // 엔진에 닿은 것도 같다
    }

    // 값도 본다 — snapshot 은 엔진 상태, 앱 메서드는 deps.app, 모르는 이름은 거절, claude 없으면 엔진 메서드 거절
    const { engine } = fakeEngine()
    const dispatch = createDispatcher(engine, fakeDeps())
    const snap = await dispatch('snapshot', [])
    expect(snap).toMatchObject({ ok: true, value: { claudeMissing: false, autoChainLimit: 8, theme: 'dark', sleepAfterMin: 45 } })
    expect((snap as { value: { agents: { pastCount: number; bypassPending: boolean }[] } }).value.agents[0]).toMatchObject({ pastCount: 3, bypassPending: true })
    expect(await dispatch('appInfo', [])).toEqual({ ok: true, value: { version: '1.2.3', packaged: false } })
    expect(await dispatch('nope', [])).toEqual({ ok: false, error: '허용되지 않은 요청이에요' })
    const none = createDispatcher(null, fakeDeps())
    expect(await none('snapshot', [])).toMatchObject({ ok: true, value: { claudeMissing: true } })
    expect(await none('setSelected', ['a1'])).toEqual({ ok: false, error: CLAUDE_MISSING_ERROR })
    expect(await none('prefs', [])).toEqual({ ok: true, value: PREFS })

    // engineReady — 띄우는 메서드는 풀릴 때까지 기다리고, BEFORE_START·앱 메서드는 바로
    let ready!: () => void
    const late = fakeEngine()
    const waitDispatch = createDispatcher(late.engine, fakeDeps({ engineReady: new Promise<void>((r) => (ready = r)) }))
    let settled = false
    const waiting = waitDispatch('setSelected', ['a1']).then((r) => {
      settled = true
      return r
    })
    expect(await waitDispatch('history', ['a1'])).toEqual({ ok: true, value: null })
    expect(await waitDispatch('pickFolder', [])).toEqual({ ok: true, value: 'C:/picked' })
    expect(await waitDispatch('prefs', [])).toEqual({ ok: true, value: PREFS })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    expect(late.calls.map(([n]) => n)).toEqual(['history'])
    ready()
    expect(await waiting).toEqual({ ok: true, value: null })
    expect(late.calls).toEqual([['history', ['a1', undefined]], ['setSelected', ['a1']]])

    // engineReady 가 거절돼도 기다리던 메서드는 엔진에 닿는다
    const failed = fakeEngine()
    const rejected = Promise.reject(new Error('시작 실패'))
    expect(await createDispatcher(failed.engine, fakeDeps({ engineReady: rejected }))('setSelected', ['a1'])).toEqual({ ok: true, value: null })
    expect(failed.calls).toEqual([['setSelected', ['a1']]])
  })
})

describe('인자 꼴 검사 — 창·휴대폰이 같이 탄다', () => {
  const PARTS_BAD = { ok: false, error: '보낼 내용이 올바르지 않아요' }
  const AGENT_BAD = { ok: false, error: '에이전트 정보가 올바르지 않아요' }
  const HISTORY_BAD = { ok: false, error: '대화 기록을 부를 수 없어요' }

  it('sendUser — 글·그림·파일 칸만, 그 밖의 꼴(준비된 첨부 꾸미기 등)은 엔진에 닿지 않고 거절', async () => {
    const { engine, calls } = fakeEngine()
    const dispatch = createDispatcher(engine, fakeDeps())
    const abs = path.resolve(os.tmpdir(), 'a.pdf')
    const text = { type: 'text', text: '읽어 줘' }
    const file = { type: 'file', path: abs, name: 'a.pdf', bytes: 3 }
    // 입력창이 보내는 꼴 — 글(빈 글도) · 그림 넷(renderer IMAGE_TYPES) · 파일
    const images = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].map((mediaType) => ({ type: 'image', mediaType, base64: 'AAAA' }))
    const goods = [text, { type: 'text', text: '' }, ...images, file]
    expect(await dispatch('sendUser', ['a1', goods])).toEqual({ ok: true, value: null })
    expect(calls).toEqual([['sendUser', ['a1', goods, undefined]]])

    calls.length = 0
    const bads: unknown[] = [
      // 엔진의 준비된 첨부(FileReady) 꼴 — 경로 줄·문서 블록을 꾸며 넣지 못하게
      { type: 'attach', sendPath: 'C:\\Windows\\win.ini', inline: { mediaType: 'application/pdf', base64: 'AAAA' } },
      { type: 'ready', name: 'x', bytes: 1, file: 'x', sendPath: 'C:\\x' },
      { name: 'x', bytes: 1, file: 'x', sendPath: 'C:\\x' },
      { type: 'TEXT', text: 'a' }, { type: 'document', source: {} }, { type: 'tool_result', content: 'x' },
      // 글 칸 — text 가 글이어야 · 다른 칸 없음
      { type: 'text' }, { type: 'text', text: 5 }, { type: 'text', text: null }, { type: 'text', text: ['a'] },
      { type: 'text', text: 'a', extra: 1 }, { type: 'text', text: 'a', sendPath: 'C:\\x' },
      // 그림 칸 — 받는 형식 넷 · base64 가 글 · 다른 칸 없음
      { type: 'image', mediaType: 'image/svg+xml', base64: 'AAAA' }, { type: 'image', mediaType: 'application/pdf', base64: 'AAAA' },
      { type: 'image', mediaType: 'IMAGE/PNG', base64: 'AAAA' }, { type: 'image', mediaType: 5, base64: 'AAAA' },
      { type: 'image', mediaType: 'image/png' }, { type: 'image', mediaType: 'image/png', base64: 5 }, { type: 'image', base64: 'AAAA' },
      { type: 'image', mediaType: 'image/png', base64: 'AAAA', sendPath: 'C:\\x' },
      { type: 'image', mediaType: 'image/png', base64: 'AAAA', inline: { mediaType: 'application/pdf', base64: 'AAAA' } },
      null, undefined, 'hi', 5, true, [], {},
    ]
    for (const bad of bads) {
      expect(await dispatch('sendUser', ['a1', [text, bad]]), JSON.stringify(bad)).toEqual(PARTS_BAD)
      expect(await dispatch('sendUser', ['a1', [bad, file]]), JSON.stringify(bad)).toEqual(PARTS_BAD) // 몇째 칸이든
    }
    expect(calls).toEqual([])

    // 휴대폰 길(file part 가 없어 inbox 검사를 건너뛰는 요청)도 같은 검사를 탄다
    const phone = phoneDispatcher(dispatch, { inboxDir: path.join(os.tmpdir(), 'dure-no-inbox') })
    expect(await phone('sendUser', ['a1', [{ type: 'attach', sendPath: 'C:\\Windows\\win.ini', inline: { mediaType: 'application/pdf', base64: 'AAAA' } }]])).toEqual(PARTS_BAD)
    expect(await phone('sendUser', ['a1', [{ type: 'image', mediaType: 'image/svg+xml', base64: 'AAAA' }]])).toEqual(PARTS_BAD)
    expect(calls).toEqual([])
  })

  it('addAgent — roomId·name·role·folder 글 넷만', async () => {
    const { engine, calls } = fakeEngine({ addAgent: () => ({ id: 'a2' }) })
    const dispatch = createDispatcher(engine, fakeDeps())
    const good = { roomId: 'r1', name: '검토', role: '검토자', folder: 'C:/work/b' }
    expect(await dispatch('addAgent', [good])).toEqual({ ok: true, value: { id: 'a2' } })
    expect(await dispatch('addAgent', [{ ...good, role: '' }])).toEqual({ ok: true, value: { id: 'a2' } }) // 역할은 비워도 된다
    expect(calls).toEqual([['addAgent', [good]], ['addAgent', [{ ...good, role: '' }]]])

    calls.length = 0
    const { roomId: _r, ...noRoom } = good
    const { folder: _f, ...noFolder } = good
    const { role: _o, ...noRole } = good
    const bads: unknown[] = [
      undefined, null, 'a', 5, [], [good],
      noRoom, noFolder, noRole,
      { ...good, roomId: 5 }, { ...good, name: null }, { ...good, name: ['n'] }, { ...good, role: {} }, { ...good, folder: 5 },
      { ...good, sessionId: 's1' }, { ...good, bypassOn: true }, { ...good, extra: 1 },
    ]
    for (const bad of bads) expect(await dispatch('addAgent', [bad]), JSON.stringify(bad)).toEqual(AGENT_BAD)
    expect(calls).toEqual([])
  })

  it('updateAgent — 엔진이 받는 칸(name·role·auto·pos·color·bypassNoticeClosed)의 맞는 값만, 모르는 칸은 거절', async () => {
    const { engine, calls } = fakeEngine({ updateAgent: (id: string) => ({ id }) })
    const dispatch = createDispatcher(engine, fakeDeps())
    // 화면이 보내는 꼴 — 이름·역할 고치기 · 자동 · 자리(끌기·정리·새 카드) · 경고 닫기, 그리고 색
    const goods: Record<string, unknown>[] = [
      { name: '새 이름', role: '역할' }, { name: ' 앞뒤 ', role: '' }, { auto: true }, { auto: false },
      { pos: { x: 120, y: -40 } }, { pos: { x: 1.5, y: 0 } }, { bypassNoticeClosed: true }, { bypassNoticeClosed: false },
      { color: '#3366ff' }, { color: null }, {},
    ]
    for (const p of goods) expect(await dispatch('updateAgent', ['a1', p]), JSON.stringify(p)).toEqual({ ok: true, value: { id: 'a1' } })
    expect(calls).toEqual(goods.map((p) => ['updateAgent', ['a1', p]]))
    // 값이 undefined 인 아는 칸은 없는 것으로(엔진도 그렇게 본다) — 엔진엔 정한 칸만
    calls.length = 0
    expect(await dispatch('updateAgent', ['a1', { auto: true, name: undefined }])).toEqual({ ok: true, value: { id: 'a1' } })
    expect(Object.keys((calls[0][1] as [string, object])[1])).toEqual(['auto'])

    calls.length = 0
    const bads: [unknown, unknown][] = [
      // 고칠 칸이 없음 — 리뷰가 본 'updateAgent(a1, null)' 의 영어 TypeError
      ['a1', null], ['a1', undefined], ['a1', 'x'], ['a1', 5], ['a1', []], ['a1', [{ auto: true }]],
      // id 가 글이 아님
      [5, { auto: true }], [null, { auto: true }], [{ id: 'a1' }, { auto: true }],
      // 자리 — {x,y} 유한한 수 둘만
      ['a1', { pos: null }], ['a1', { pos: {} }], ['a1', { pos: { x: 1 } }], ['a1', { pos: { x: '1', y: 2 } }],
      ['a1', { pos: { x: NaN, y: 0 } }], ['a1', { pos: { x: 0, y: Infinity } }], ['a1', { pos: { x: 1, y: 2, z: 3 } }],
      ['a1', { pos: [1, 2] }], ['a1', { pos: 'x' }],
      // 글·참거짓 칸의 틀린 값
      ['a1', { name: 5 }], ['a1', { name: null }], ['a1', { role: {} }], ['a1', { role: null }], ['a1', { auto: 'yes' }],
      ['a1', { auto: 1 }], ['a1', { auto: null }], ['a1', { color: 5 }], ['a1', { color: {} }], ['a1', { bypassNoticeClosed: 'true' }],
      ['a1', { bypassNoticeClosed: null }],
      // 엔진이 따로 다루는 칸·모르는 칸 — 화면이 꾸며 넣지 못하게
      ['a1', { model: 'opus' }], ['a1', { sessionId: 's1' }], ['a1', { alwaysAllow: ['Bash'] }], ['a1', { bypassOn: true }],
      ['a1', { started: true }], ['a1', { remoteLaunch: { pid: 1, run: 'x' } }], ['a1', { folder: 'C:/x' }], ['a1', { auto: true, extra: 1 }],
      ['a1', { model: undefined }],
    ]
    for (const args of bads) expect(await dispatch('updateAgent', args), JSON.stringify(args)).toEqual(AGENT_BAD)
    expect(calls).toEqual([])
  })

  it('history — id 글 · o 는 없음 또는 { all?: 참거짓, limit?: 1 이상 정수·Infinity }', async () => {
    const { engine, calls } = fakeEngine({ history: () => [] })
    const dispatch = createDispatcher(engine, fakeDeps())
    // 화면이 보내는 꼴 — 지금 대화(o 없음) · 내보내기(limit: Infinity)
    const goods: unknown[][] = [['a1'], ['a1', undefined], ['a1', {}], ['a1', { limit: Infinity }], ['a1', { all: true }], ['a1', { all: false, limit: 1 }], ['a1', { limit: 500 }]]
    for (const args of goods) expect(await dispatch('history', args), JSON.stringify(args)).toEqual({ ok: true, value: [] })
    expect(calls).toEqual([
      ['history', ['a1', undefined]], ['history', ['a1', undefined]], ['history', ['a1', {}]], ['history', ['a1', { limit: Infinity }]],
      ['history', ['a1', { all: true }]], ['history', ['a1', { all: false, limit: 1 }]], ['history', ['a1', { limit: 500 }]],
    ])

    calls.length = 0
    const bads: unknown[][] = [
      [], [5], [null], [{ id: 'a1' }],
      ['a1', null], ['a1', 'x'], ['a1', 5], ['a1', []], ['a1', true],
      ['a1', { limit: 0 }], ['a1', { limit: -1 }], ['a1', { limit: 1.5 }], ['a1', { limit: '5' }], ['a1', { limit: NaN }],
      ['a1', { limit: -Infinity }], ['a1', { limit: null }], ['a1', { limit: 2 ** 53 }],
      ['a1', { all: 'yes' }], ['a1', { all: 1 }], ['a1', { all: null }], ['a1', { sinceBoundary: false }], ['a1', { all: true, extra: 1 }],
    ]
    for (const args of bads) expect(await dispatch('history', args), JSON.stringify(args)).toEqual(HISTORY_BAD)
    expect(calls).toEqual([])
  })
})

describe('phoneDispatcher', () => {
  /** 계획이 정한 PC 전용 엔진 메서드 — 이것과 APP_METHODS 전부가 'pc' */
  const PC_ENGINE = [
    'pickFolder', 'openAgentFolder', 'saveConversation', 'setTaskbar', 'flashWindow', 'focusWindow', 'sshHosts', 'checkRemote',
    'setSelected', 'setTheme', 'setAllowBypass', 'setAutoChainLimit', 'setSleepAfter', 'setNotify', 'openAttachment',
  ]

  it('PHONE_ACCESS — pc 메서드 거절 글', async () => {
    // 모든 메서드(METHODS + APP_METHODS)가 빠짐없이, 그것만 분류돼 있다
    expect(Object.keys(PHONE_ACCESS).sort()).toEqual([...METHODS, ...APP_METHODS].sort())
    const pc = Object.entries(PHONE_ACCESS).filter(([, v]) => v === 'pc').map(([k]) => k)
    expect(pc.sort()).toEqual([...PC_ENGINE, ...APP_METHODS].sort())
    expect(Object.values(PHONE_ACCESS).every((v) => v === 'pc' || v === 'phone')).toBe(true)
    expect(PHONE_DENIED).toBe('휴대폰에서는 할 수 없는 일이에요')

    const inner = vi.fn(async (): Promise<InvokeResult> => ({ ok: true, value: 'inner' }))
    const phone = phoneDispatcher(inner, { inboxDir: path.join(os.tmpdir(), 'dure-no-inbox') })
    // PC 전용 · 모르는 이름 · 프로토타입 이름 · preload 전용 · 글이 아닌 이름 — 거절 글, 안쪽 디스패처는 부르지 않는다
    for (const m of [...pc, 'nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'on', 'pathForFile', '', 5, null, undefined]) {
      expect(await phone(m as string, []), String(m)).toEqual({ ok: false, error: PHONE_DENIED })
      expect(phoneAllows(m as string), String(m)).toBe(false)
    }
    expect(inner).not.toHaveBeenCalled()

    // 'phone' 메서드는 그대로 안쪽으로 — 인자도 그대로
    const allowed = Object.entries(PHONE_ACCESS).filter(([, v]) => v === 'phone').map(([k]) => k)
    expect(allowed).toEqual(expect.arrayContaining(['snapshot', 'sendUser', 'answerRequest', 'approveMessage', 'history', 'addRoom', 'setBypass']))
    for (const m of allowed) {
      if (m === 'sendUser' || m === 'addRoom') continue // 아래 시험들
      inner.mockClear()
      expect(await phone(m, ['a1', 2]), m).toEqual({ ok: true, value: 'inner' })
      expect(inner, m).toHaveBeenCalledWith(m, ['a1', 2])
      expect(phoneAllows(m)).toBe(true)
    }

    // 진짜 디스패처 위에서도 — PC 전용은 엔진·창 쪽 deps 에 닿지 않는다
    const { engine, calls } = fakeEngine()
    const deps = fakeDeps()
    const real = phoneDispatcher(createDispatcher(engine, deps), { inboxDir: path.join(os.tmpdir(), 'dure-no-inbox') })
    for (const m of pc) expect(await real(m, ['a1'])).toEqual({ ok: false, error: PHONE_DENIED })
    expect(calls).toEqual([])
    expect(deps.pickFolder).not.toHaveBeenCalled()
    expect(deps.app.setPrefs).not.toHaveBeenCalled()
    expect(deps.app.installClaude).not.toHaveBeenCalled()
    expect(await real('snapshot', [])).toMatchObject({ ok: true, value: { claudeMissing: false } })
  })

  it('addRoom remote 거절', async () => {
    const { engine, calls } = fakeEngine({ addRoom: () => ({ id: 'r2' }) })
    const phone = phoneDispatcher(createDispatcher(engine, fakeDeps()), { inboxDir: path.join(os.tmpdir(), 'dure-no-inbox') })
    // 이 PC 방 — 이름만·remote 가 null 이면 엔진으로
    expect(await phone('addRoom', ['방'])).toEqual({ ok: true, value: { id: 'r2' } })
    expect(await phone('addRoom', ['방', null])).toEqual({ ok: true, value: { id: 'r2' } })
    expect(calls).toEqual([['addRoom', ['방']], ['addRoom', ['방']]])
    // 서버 방(remote 가 있음)은 어떤 꼴이든 거절 — 엔진에 닿지 않는다
    calls.length = 0
    for (const remote of [{ host: 'dev' }, {}, 'dev', false, 0, [], { host: 'dev', x: 1 }]) {
      expect(await phone('addRoom', ['방', remote]), JSON.stringify(remote)).toEqual({ ok: false, error: PHONE_DENIED })
    }
    expect(calls).toEqual([])
  })

  it('sendUser file — inbox 밖 경로 거절, 보낸 뒤 inbox 파일 지움', async () => {
    const { root, inbox, put } = tmpInbox()
    const INBOX_ONLY = { ok: false, error: '파일을 보내지 못했어요 — 휴대폰에서 올린 파일만 보낼 수 있어요' }
    const seen: boolean[] = []
    let fail = false
    const { engine, calls } = fakeEngine({
      // 엔진이 사본을 만드는 동안 원본(inbox 파일)은 아직 있다 — 끝난 뒤에야 지운다
      sendUser: async (_id: string, parts: { type: string; path?: string }[]) => {
        await new Promise((r) => setTimeout(r, 5))
        for (const p of parts) if (p.type === 'file') seen.push(fs.existsSync(p.path!))
        if (fail) throw new Error('파일을 보내지 못했어요 — 복사하지 못했어요')
      },
    })
    const phone = phoneDispatcher(createDispatcher(engine, fakeDeps()), { inboxDir: inbox })
    const file = (p: string) => ({ type: 'file', path: p, name: path.basename(p), bytes: 1 })
    const text = { type: 'text', text: '읽어 줘' }

    // inbox 밖 — 거절, 엔진에 닿지 않고, 밖의 파일은 지우지 않는다
    const outside = put(path.join(root, 'outside.txt'))
    const sibling = put(path.join(root, 'phone-inbox2', 'x.txt')) // 이름이 inbox 로 시작하는 옆 폴더
    const nested = put(path.join(inbox, 'sub', 'c.txt')) // inbox 바로 안이 아닌 하위 폴더
    const kept = put(path.join(inbox, 'kept.txt'))
    const outsiders: unknown[] = [
      outside,
      sibling,
      nested,
      // path.join 은 .. 를 풀어 버린다 — 휴대폰이 보낸 글 그대로
      [inbox, '..', 'outside.txt'].join(path.sep),
      [inbox, 'sub', '..', 'kept.txt'].join(path.sep), // .. 는 안으로 돌아와도 거절
      [inbox, '..', 'phone-inbox', 'kept.txt'].join('/'),
      path.join(inbox, 'missing.txt'),
      inbox,
      path.join(inbox, 'sub'),
      'kept.txt',
      `${kept}:stream`,
      `${kept}\u0000.txt`,
      5,
      null,
    ]
    // 링크로 밖을 가리키는 inbox 안 이름 — 파일 링크(만들 권한이 있을 때만)
    const link = path.join(inbox, 'link.txt')
    let linked = false
    try {
      fs.symlinkSync(outside, link, 'file')
      linked = true
      outsiders.push(link)
    } catch {
      // 개발자 모드가 아니면 Windows 는 파일 링크를 못 만든다 — 이 칸만 건너뛴다
    }
    for (const bad of outsiders) {
      expect(await phone('sendUser', ['a1', [text, { type: 'file', path: bad, name: 'x', bytes: 1 }]]), String(bad)).toEqual(INBOX_ONLY)
    }
    expect(calls).toEqual([])
    for (const p of [outside, sibling, nested, kept]) expect(fs.existsSync(p), p).toBe(true)
    if (linked) expect(fs.lstatSync(link).isSymbolicLink()).toBe(true) // 링크도 지우지 않았다(따라가 밖을 지우지도)

    // inbox 안 — 보내고(엔진은 원본이 있을 때 받는다), 성공한 뒤 그 inbox 파일을 지운다
    const a = put(path.join(inbox, '1a2b-보고서.pdf'))
    const b = put(path.join(inbox, '3c4d-사진.jpg'))
    const parts = [text, file(a), file(b)]
    expect(await phone('sendUser', ['a1', parts, { plan: true }])).toEqual({ ok: true, value: null })
    expect(calls).toEqual([['sendUser', ['a1', parts, { plan: true }]]])
    expect(seen).toEqual([true, true])
    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(b)).toBe(false)

    // 엔진이 실패해도 지운다 — 오류 글은 그대로
    fail = true
    const c = put(path.join(inbox, '5e6f-표.xlsx'))
    expect(await phone('sendUser', ['a1', [file(c)]])).toEqual({ ok: false, error: '파일을 보내지 못했어요 — 복사하지 못했어요' })
    expect(fs.existsSync(c)).toBe(false)
    fail = false

    // 함께 공유된 검증(file part 칸)도 휴대폰 길에서 돈다 — 거절되고 엔진에 닿지 않으며, 그 inbox 파일은 지운다
    calls.length = 0
    const d = put(path.join(inbox, '7a8b-메모.txt'))
    expect(await phone('sendUser', ['a1', [{ ...file(d), sendPath: d }]])).toEqual({ ok: false, error: '파일을 보내지 못했어요 — 첨부 정보가 올바르지 않아요' })
    expect(calls).toEqual([])
    expect(fs.existsSync(d)).toBe(false)

    // 한 칸이라도 inbox 밖이면 통째로 거절 — 밖의 것은 남고, 같이 온 inbox 파일은 지운다
    const e = put(path.join(inbox, '9c0d-그림.png'))
    expect(await phone('sendUser', ['a1', [file(e), file(outside)]])).toEqual(INBOX_ONLY)
    expect(calls).toEqual([])
    expect(fs.existsSync(e)).toBe(false)
    expect(fs.existsSync(outside)).toBe(true)

    // file part 가 없으면 inbox 와 상관없이 그대로 · 칸 목록이 아니면 공유된 검증이 거절
    expect(await phone('sendUser', ['a1', [text]])).toEqual({ ok: true, value: null })
    expect(await phone('sendUser', ['a1', 'hi'])).toEqual({ ok: false, error: '보낼 내용이 올바르지 않아요' })
    expect(calls).toEqual([['sendUser', ['a1', [text], undefined]]])
    expect(fs.existsSync(kept)).toBe(true) // 부르지 않은 inbox 파일은 그대로
  })

  it('sendUser file — 진짜 경로(realpath)가 inbox 밖이면 거절 · 못 푸는 볼륨은 inbox 가 진짜 폴더일 때만', async () => {
    // 파일 링크는 권한이 있어야 만들어진다 — 진짜 경로 검사는 realpath 를 갈아 끼워 직접 본다
    const { root, inbox, put } = tmpInbox()
    const { engine, calls } = fakeEngine()
    const phone = phoneDispatcher(createDispatcher(engine, fakeDeps()), { inboxDir: inbox })
    const send = (p: string) => phone('sendUser', ['a1', [{ type: 'file', path: p, name: 'x', bytes: 1 }]])
    const INBOX_ONLY = { ok: false, error: '파일을 보내지 못했어요 — 휴대폰에서 올린 파일만 보낼 수 있어요' }
    const realpath = fs.promises.realpath
    const spy = vi.spyOn(fs.promises, 'realpath')
    try {
      // inbox 안 이름이지만 진짜 경로는 밖 — 거절, 그 파일은 지우지 않는다
      const a = put(path.join(inbox, 'a.txt'))
      spy.mockImplementation((async (p: fs.PathLike) => (String(p) === a ? path.join(root, 'outside.txt') : realpath(p))) as typeof realpath)
      expect(await send(a)).toEqual(INBOX_ONLY)
      expect(fs.existsSync(a)).toBe(true)
      // 없음·권한·잠김으로 못 풀면 거절
      spy.mockImplementation((async () => {
        throw Object.assign(new Error('x'), { code: 'EACCES' })
      }) as typeof realpath)
      expect(await send(a)).toEqual(INBOX_ONLY)
      expect(calls).toEqual([])
      // 진짜 경로를 못 푸는 볼륨(EISDIR·UNKNOWN 등) — inbox 가 진짜 폴더면 받고, 보낸 뒤 지운다
      spy.mockImplementation((async () => {
        throw Object.assign(new Error('x'), { code: 'UNKNOWN' })
      }) as typeof realpath)
      expect(await send(a)).toEqual({ ok: true, value: null })
      expect(calls).toHaveLength(1)
      expect(fs.existsSync(a)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('BEFORE_START 와 PHONE_ACCESS 는 서로 모른다 — 휴대폰도 엔진 시작 전 규칙을 그대로 탄다', async () => {
    let ready!: () => void
    const { engine, calls } = fakeEngine()
    const phone = phoneDispatcher(createDispatcher(engine, fakeDeps({ engineReady: new Promise<void>((r) => (ready = r)) })), {
      inboxDir: path.join(os.tmpdir(), 'dure-no-inbox'),
    })
    const waiting = phone('interrupt', ['a1'])
    const nowMethod = BEFORE_START.find((m) => PHONE_ACCESS[m] === 'phone' && m !== 'snapshot')!
    expect(await phone(nowMethod, ['a1'])).toEqual({ ok: true, value: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.map(([n]) => n)).toEqual([nowMethod])
    ready()
    expect(await waiting).toEqual({ ok: true, value: null })
    expect(calls.map(([n]) => n)).toEqual([nowMethod, 'interrupt'])
  })
})
