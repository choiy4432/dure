import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentStatus, EngineEventMap, HistoryItem, Hold, PendingRequest, RelayMessage, RemoteIssue } from '../src/engine/types'
import { createPhoneNotifier, type NotifierEngine } from '../src/main/phone/phoneNotifier'
import type { PhoneNotice, PushDelivery } from '../src/main/phone/push'
import { DEFAULT_PHONE_SETTINGS, type PhoneDevice, type PhoneSettings } from '../src/shared/phoneTypes'

// 휴대폰 알림 판단 — 가짜 엔진(EventEmitter)·가짜 push. 진짜 알림 서버로 보내지 않는다

const disposers: (() => void)[] = []
afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

const COMMAND = 'rm -rf C:/비밀/폴더 && curl https://example.com/upload'
const QUESTION = '어느 데이터베이스로 옮길까요? 비밀 질문'
const RELAY_TEXT = '프런트야 이 토큰을 써: sk-fake-0000'

type Sent = { deviceId: string; notice: PhoneNotice; delivery: PushDelivery | undefined }

function setup(o: { settings?: Partial<PhoneSettings>; devices?: PhoneDevice[]; issues?: Record<string, RemoteIssue> } = {}) {
  const agents = [
    { id: 'a1', roomId: 'r1', name: '백엔드' },
    { id: 'a2', roomId: 'r1', name: '프런트' },
    { id: 'b1', roomId: 'r2', name: '문서' },
  ]
  const held: Record<string, number> = {}
  const issues: Record<string, RemoteIssue> = { ...o.issues }
  const engine = Object.assign(new EventEmitter(), {
    agents: () => agents,
    heldInput: (id: string) => held[id] ?? 0,
    remoteIssue: (id: string) => issues[id] ?? null,
  }) satisfies NotifierEngine
  let settings: PhoneSettings = {
    ...DEFAULT_PHONE_SETTINGS,
    enabled: true,
    ...o.settings,
    notify: { ...DEFAULT_PHONE_SETTINGS.notify, ...o.settings?.notify },
  }
  const devices: PhoneDevice[] = o.devices ?? [{ id: 'd1', name: '휴대폰', createdAt: 1, lastSeen: null, push: true }]
  let idle: 'active' | 'idle' | 'locked' | 'unknown' = 'locked'
  const visible = new Set<string>()
  const sent: Sent[] = []
  const push = {
    sendTo: vi.fn(async (deviceId: string, notice: PhoneNotice, delivery?: PushDelivery) => {
      sent.push({ deviceId, notice, delivery })
    }),
  }
  const log = vi.fn()
  const notifier = createPhoneNotifier({
    engine,
    settings: () => settings,
    devices: () => devices,
    isPcInUse: () => idle === 'active',
    isVisible: (id) => visible.has(id),
    push,
    log,
  })
  disposers.push(() => notifier.dispose())
  return {
    engine, notifier, sent, push, log, visible, held, devices,
    setIdle: (s: typeof idle) => (idle = s),
    set: (p: Partial<PhoneSettings>) => (settings = { ...settings, ...p }),
    request: (id: string, over: Partial<PendingRequest> = {}) =>
      engine.emit('request', {
        id, agentId: 'a1', toolName: 'Bash', input: { command: COMMAND, description: '지우기' }, kind: 'permission', createdAt: 1, ...over,
      } satisfies PendingRequest),
    message: (id: string, state: RelayMessage['state'], over: Partial<RelayMessage> = {}) =>
      engine.emit('message', {
        id, roomId: 'r1', from: 'a1', to: 'a2', text: RELAY_TEXT, createdAt: 1, state, updatedAt: 1, ...over,
      } satisfies RelayMessage),
    hold: (agentId: string, hold: Hold | null) => engine.emit('hold', { agentId, hold }),
    history: (agentId: string, item: HistoryItem) => engine.emit('history', { agentId, item }),
    /** 상태 사건 — 서버 방 에이전트는 remoteIssue 칸(문제 또는 null)을 싣고, 이 PC 방은 칸이 없다(undefined) */
    status: (agentId: string, remoteIssue: RemoteIssue | null | undefined, status: AgentStatus = 'idle') =>
      engine.emit('status', {
        agentId, status, errorText: null, ...(remoteIssue !== undefined ? { remoteIssue } : {}),
      } satisfies EngineEventMap['status']),
  }
}

const HOLD: Hold = { since: 100, items: [{ id: 'm9', source: 'relay', from: 'a2', text: RELAY_TEXT, images: 0 }] }
const bodies = (sent: Sent[]) => sent.map((s) => s.notice.body)
const flush = () => new Promise((r) => setTimeout(r, 0))

test('PC 쓰는 중이면 안 보냄 · 잠금이면 보냄 · 본문에 명령 없음', async () => {
  const t = setup()
  t.setIdle('active') // 마지막 입력 뒤 2분 안 · 잠금 아님 — PC 앞에 있다
  t.request('r1')
  expect(t.sent).toHaveLength(0)

  t.setIdle('locked')
  t.request('r2')
  t.request('q1', { kind: 'question', toolName: 'AskUserQuestion', input: { questions: [{ question: QUESTION, options: [] }] } })
  t.request('p1', { kind: 'plan', toolName: 'ExitPlanMode', input: { plan: '# 비밀 계획' } })
  t.request('c1', { kind: 'create-agent', toolName: 'mcp__dure__create_agent', input: { name: '새것', role: '역할', folder: 'C:/비밀', task: null } })
  t.setIdle('idle')
  t.request('r3', { agentId: 'b1' })
  await flush()

  expect(t.sent.map((s) => s.notice)).toEqual([
    { title: '두레', body: '백엔드 · 승인을 기다려요', tag: expect.stringMatching(/^dure-a1-approval-\d+$/), url: '/#agent=a1' },
    { title: '두레', body: '백엔드 · 답을 기다려요', tag: expect.stringMatching(/^dure-a1-question-\d+$/), url: '/#agent=a1' },
    { title: '두레', body: '백엔드 · 승인을 기다려요', tag: expect.stringMatching(/^dure-a1-approval-\d+$/), url: '/#agent=a1' },
    { title: '두레', body: '백엔드 · 승인을 기다려요', tag: expect.stringMatching(/^dure-a1-approval-\d+$/), url: '/#agent=a1' },
    { title: '두레', body: '문서 · 승인을 기다려요', tag: expect.stringMatching(/^dure-b1-approval-\d+$/), url: '/#agent=b1' },
  ])
  // 알림마다 다른 tag — 같은 tag 면 안드로이드가 옛 알림을 바꾸기만 하고 다시 울리지 않는다(probe28)
  expect(new Set(t.sent.map((s) => s.notice.tag)).size).toBe(t.sent.length)
  expect(t.sent.every((s) => s.deviceId === 'd1')).toBe(true)
  expect(t.sent[0].delivery).toEqual({ urgency: 'high', ttl: 3600 })
  const all = JSON.stringify(t.sent)
  for (const secret of ['rm -rf', '비밀', 'curl', 'example.com', 'AskUserQuestion', 'Bash', '지우기', '새것']) expect(all).not.toContain(secret)

  // PC 앞이라 안 보낸 기다림은 나중에 자리를 떠도 다시 보내지 않는다(한 번만 판단)
  t.request('r1')
  await flush()
  expect(t.sent).toHaveLength(5)
})

test('넘기기 기다림도 asks', async () => {
  const t = setup()
  // 넘기는 메시지 승인 기다림 — 받는 에이전트(카드가 그쪽에 뜬다)
  t.message('m1', 'pending')
  // 이어 보내기 한도 — 방마다 묶음 하나(한 번에 풀어 준다). 그 방에 걸린 게 다 풀린 뒤 다시 걸리면 또
  t.message('m2', 'held')
  t.message('m3', 'held', { to: 'a1', from: 'a2' })
  t.message('m4', 'held', { roomId: 'r2', from: 'b1', to: 'b1' })
  t.message('m2', 'queued')
  t.message('m3', 'queued', { to: 'a1', from: 'a2' })
  t.message('m5', 'held')
  // 붙잡힌 입력 — 붙잡힐 때 한 번(항목이 늘어도 다시 안 울림), 풀린 뒤 다시 붙잡히면 또
  t.hold('a1', HOLD)
  t.hold('a1', { ...HOLD, items: [...HOLD.items, { id: 'u1', source: 'human', from: null, text: '내 말', images: 0 }] })
  t.hold('a1', null)
  t.hold('a1', { ...HOLD, since: 200 })
  await flush()
  expect(t.sent.map((s) => [s.notice.body, s.notice.url])).toEqual([
    ['프런트 · 넘기기 승인을 기다려요', '/#agent=a2'],
    ['프런트 · 넘기기 승인을 기다려요', '/#agent=a2'],
    ['문서 · 넘기기 승인을 기다려요', '/#agent=b1'],
    ['프런트 · 넘기기 승인을 기다려요', '/#agent=a2'],
    ['백엔드 · 넘기기 승인을 기다려요', '/#agent=a1'],
    ['백엔드 · 넘기기 승인을 기다려요', '/#agent=a1'],
  ])
  expect(t.sent.every((s) => /^dure-[ab][12]-handoff-\d+$/.test(s.notice.tag))).toBe(true)
  expect(t.sent.every((s) => s.delivery?.urgency === 'high')).toBe(true)
  const all = JSON.stringify(t.sent)
  for (const secret of ['토큰', 'sk-fake', '내 말']) expect(all).not.toContain(secret)

  // 승인·질문 알림을 끄면 넘기기 기다림도 안 울린다(같은 칸)
  const off = setup({ settings: { notify: { asks: false, finished: true } } })
  off.request('r1')
  off.message('m1', 'pending')
  off.message('m2', 'held')
  off.hold('a1', HOLD)
  await flush()
  expect(off.sent).toHaveLength(0)
})

test('finished 기본 꺼짐', async () => {
  const t = setup()
  t.history('a1', { t: 10, kind: 'result', ok: true, subtype: 'success' })
  await flush()
  expect(t.sent).toHaveLength(0)

  const on = setup({ settings: { notify: { asks: false, finished: true } } })
  on.history('a1', { t: 11, kind: 'assistant', blocks: [{ type: 'text', text: '다 했어요 — 비밀 요약' }] })
  on.history('a1', { t: 12, kind: 'result', ok: true, subtype: 'success' })
  on.history('a1', { t: 12, kind: 'result', ok: true, subtype: 'success' }) // 같은 차례가 두 번 와도 한 번
  on.held.a2 = 1 // 기다리던 내 입력이 곧 나간다 — 아직 안 끝났다
  on.history('a2', { t: 13, kind: 'result', ok: true, subtype: 'success' })
  on.held.a2 = 0
  on.history('a2', { t: 14, kind: 'result', ok: false, subtype: 'error_during_execution' })
  await flush()
  expect(on.sent.map((s) => s.notice)).toEqual([
    { title: '두레', body: '백엔드 · 일을 마쳤어요', tag: expect.stringMatching(/^dure-a1-finished-\d+$/), url: '/#agent=a1' },
    { title: '두레', body: '프런트 · 일을 마쳤어요', tag: expect.stringMatching(/^dure-a2-finished-\d+$/), url: '/#agent=a2' },
  ])
  expect(on.sent[0].delivery).toEqual({ urgency: 'normal', ttl: 600 })
  expect(JSON.stringify(on.sent)).not.toContain('비밀')
})

const SSH_DETAIL = 'ssh: connect to host lab-fake.example.edu port 22: Connection timed out'

test('서버 방 문제도 asks — 문제마다 한 번 · 서버 이름·ssh 글 없음', async () => {
  const t = setup()
  t.status('a1', { kind: 'disconnected', detail: null })
  t.status('a1', { kind: 'disconnected', detail: null }, 'stopped') // 같은 문제가 이어진다 — 상태만 바뀜
  t.status('a2', { kind: 'unreachable', detail: SSH_DETAIL })
  t.status('a1', { kind: 'login', detail: null }) // 다른 문제가 됐다
  t.status('a1', null) // 풀렸다
  t.status('a1', null)
  t.status('a1', { kind: 'login', detail: null }) // 다시 생겼다 — 또
  t.status('b1', undefined) // 이 PC 방 — 문제 칸이 없다
  t.status('b1', undefined, 'error')
  await flush()
  expect(t.sent.map((s) => s.notice)).toEqual([
    { title: '두레', body: '백엔드 · 서버에 문제가 있어요', tag: expect.stringMatching(/^dure-a1-remote-\d+$/), url: '/#agent=a1' },
    { title: '두레', body: '프런트 · 서버에 문제가 있어요', tag: expect.stringMatching(/^dure-a2-remote-\d+$/), url: '/#agent=a2' },
    { title: '두레', body: '백엔드 · 서버에 문제가 있어요', tag: expect.stringMatching(/^dure-a1-remote-\d+$/), url: '/#agent=a1' },
    { title: '두레', body: '백엔드 · 서버에 문제가 있어요', tag: expect.stringMatching(/^dure-a1-remote-\d+$/), url: '/#agent=a1' },
  ])
  expect(new Set(t.sent.map((s) => s.notice.tag)).size).toBe(t.sent.length)
  expect(t.sent.every((s) => s.delivery?.urgency === 'high' && s.delivery.ttl === 3600)).toBe(true)
  const all = JSON.stringify(t.sent)
  for (const secret of ['lab-fake', 'example.edu', 'ssh', 'port 22', 'timed out', 'login', 'disconnected', 'unreachable']) expect(all).not.toContain(secret)

  // 승인·질문 알림을 끄면 안 울린다(PC 의 Windows 알림과 같은 칸)
  const off = setup({ settings: { notify: { asks: false, finished: true } } })
  off.status('a1', { kind: 'disconnected', detail: null })
  await flush()
  expect(off.sent).toHaveLength(0)

  // 휴대폰으로 쓰기 꺼짐 · 모르는 에이전트 · 화면 보는 기기 — 안 보냄
  const no = setup({ settings: { enabled: false } })
  no.status('a1', { kind: 'disconnected', detail: null })
  const unknown = setup()
  unknown.status('지운-에이전트', { kind: 'disconnected', detail: null })
  const seen = setup()
  seen.visible.add('d1')
  seen.status('a1', { kind: 'disconnected', detail: null })
  await flush()
  expect([...no.sent, ...unknown.sent, ...seen.sent]).toHaveLength(0)
})

test('서버 방 문제 — PC 앞이라 안 보낸 문제는 다시 안 보냄 · 켤 때 이미 있던 문제도', async () => {
  const t = setup()
  t.setIdle('active')
  t.status('a1', { kind: 'disconnected', detail: null })
  t.setIdle('locked')
  t.status('a1', { kind: 'disconnected', detail: null }, 'stopped') // 같은 문제 — 한 번 판단했다
  await flush()
  expect(t.sent).toHaveLength(0)
  t.status('a1', { kind: 'hostkey', detail: null })
  await flush()
  expect(bodies(t.sent)).toEqual(['백엔드 · 서버에 문제가 있어요'])

  // 알림 판단을 켜기 전부터 있던 문제 — 상태가 바뀌어 다시 실려 와도 새 문제가 아니다
  const late = setup({ issues: { a1: { kind: 'login', detail: null } } })
  late.status('a1', { kind: 'login', detail: null }, 'working')
  late.status('a1', { kind: 'login', detail: null })
  await flush()
  expect(late.sent).toHaveLength(0)
  late.status('a1', null)
  late.status('a1', { kind: 'login', detail: null })
  await flush()
  expect(bodies(late.sent)).toEqual(['백엔드 · 서버에 문제가 있어요'])
})

test('서버 방 문제가 있는 에이전트의 차례 끝은 일을 마쳤어요 대신 문제만', async () => {
  const t = setup({ settings: { notify: { asks: true, finished: true } } })
  // 서버 claude 로그인이 풀렸다는 답 — 엔진은 그 result 를 기록하기 전에 login 문제를 상태 사건으로 알린다
  t.status('a1', { kind: 'login', detail: null }, 'working')
  t.history('a1', { t: 20, kind: 'result', ok: false, subtype: 'success' })
  // 다음 정상 답 — 문제가 먼저 지워지고 차례 끝
  t.status('a1', null, 'working')
  t.history('a1', { t: 21, kind: 'result', ok: true, subtype: 'success' })
  await flush()
  expect(bodies(t.sent)).toEqual(['백엔드 · 서버에 문제가 있어요', '백엔드 · 일을 마쳤어요'])
})

test('화면 보는 기기는 건너뜀', async () => {
  const dev = (id: string, push = true): PhoneDevice => ({ id, name: id, createdAt: 1, lastSeen: null, push })
  const t = setup({ devices: [dev('d1'), dev('d2'), dev('d3', false)] })
  t.visible.add('d1') // d1 은 지금 두레 화면을 보고 있다
  t.request('r1')
  await flush()
  expect(t.sent.map((s) => s.deviceId)).toEqual(['d2']) // d3 은 알림 구독이 없다
  t.visible.add('d2')
  t.request('r2')
  await flush()
  expect(t.sent).toHaveLength(1)
})

test('같은 기다림 한 번만', async () => {
  const t = setup()
  t.request('r1')
  t.request('r1')
  t.message('m1', 'pending')
  t.message('m1', 'pending')
  t.hold('a1', HOLD)
  t.hold('a1', HOLD)
  await flush()
  expect(bodies(t.sent)).toEqual(['백엔드 · 승인을 기다려요', '프런트 · 넘기기 승인을 기다려요', '백엔드 · 넘기기 승인을 기다려요'])
  // 풀린 뒤 새 기다림은 새로 — 같은 에이전트의 다음 승인도 울린다
  t.engine.emit('request-resolved', { id: 'r1', agentId: 'a1' })
  t.message('m1', 'delivered')
  t.request('r2')
  t.message('m2', 'pending')
  await flush()
  expect(t.sent).toHaveLength(5)
  expect(new Set(t.sent.map((s) => s.notice.tag)).size).toBe(5)
})

test('휴대폰으로 쓰기 꺼짐이면 안 보냄 · 모르는 에이전트는 건너뜀', async () => {
  const t = setup({ settings: { enabled: false } })
  t.request('r1')
  t.message('m1', 'pending')
  await flush()
  expect(t.sent).toHaveLength(0)
  t.set({ enabled: true })
  t.request('r2', { agentId: '지운-에이전트' })
  t.message('m2', 'pending', { to: '지운-에이전트' })
  t.request('r3')
  await flush()
  expect(bodies(t.sent)).toEqual(['백엔드 · 승인을 기다려요'])
})

test('판단·보내기가 던져도 엔진으로 안 던짐 · 로그에 내용 없음', async () => {
  const t = setup()
  t.push.sendTo.mockRejectedValueOnce(new Error(`보내기 실패 ${COMMAND}`))
  expect(() => t.request('r1')).not.toThrow()
  await flush()
  expect(t.log).toHaveBeenCalled()
  expect(JSON.stringify(t.log.mock.calls)).not.toContain('rm -rf')

  // PC 상태를 못 읽으면(powerMonitor 오류) 보낸다 — 자리를 비웠을 수 있다
  const u = setup()
  const engine = Object.assign(new EventEmitter(), { agents: () => [{ id: 'a1', name: '백엔드' }], heldInput: () => 0 })
  const sent: string[] = []
  const n = createPhoneNotifier({
    engine,
    settings: () => ({ ...DEFAULT_PHONE_SETTINGS, enabled: true }),
    devices: () => u.devices,
    isPcInUse: () => {
      throw new Error('idle 상태를 못 읽음')
    },
    isVisible: () => false,
    push: { sendTo: async (_d: string, notice: PhoneNotice) => void sent.push(notice.body) },
    log: () => {},
  })
  disposers.push(() => n.dispose())
  engine.emit('request', { id: 'x', agentId: 'a1', toolName: 'Bash', input: {}, kind: 'permission', createdAt: 1 })
  await flush()
  expect(sent).toEqual(['백엔드 · 승인을 기다려요'])
})

test('dispose — 엔진 사건을 더 듣지 않음', async () => {
  const t = setup({ settings: { notify: { asks: true, finished: true } } })
  const names = ['request', 'request-resolved', 'message', 'hold', 'history', 'status']
  for (const name of names) expect(t.engine.listenerCount(name), name).toBe(1)
  t.notifier.dispose()
  for (const name of names) expect(t.engine.listenerCount(name), name).toBe(0)
  t.request('r1')
  t.history('a1', { t: 1, kind: 'result', ok: true, subtype: 'success' })
  t.status('a1', { kind: 'disconnected', detail: null })
  await flush()
  expect(t.sent).toHaveLength(0)
  t.notifier.dispose() // 두 번 불러도 괜찮다
})
