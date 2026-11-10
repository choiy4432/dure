import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentStatus, EngineEventMap, HistoryItem, Hold, PendingRequest, RelayMessage, RemoteIssue } from '../src/engine/types'
import { createPhoneNotifier, PC_RECHECK_MS, type NotifierEngine } from '../src/main/phone/phoneNotifier'
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
  const failing = { on: false } // true 면 보낼 때마다 일시 오류('retry')
  // 다시 보내기 타이머 — 가짜: 시험이 손으로 부른다(대기 ms 와 함께 쌓인다)
  const retries: { ms: number; fn: () => void }[] = []
  const push = {
    sendTo: vi.fn(async (deviceId: string, notice: PhoneNotice, delivery?: PushDelivery): Promise<'retry' | undefined> => {
      sent.push({ deviceId, notice, delivery })
      return failing.on ? 'retry' : undefined
    }),
  }
  const log = vi.fn()
  // PC 를 떠났다는 신호(진짜는 powerMonitor 'lock-screen')·다시 보기 타이머 — 가짜로, 시험이 손으로 부른다
  const away = new Set<() => void>()
  const polls: { ms: number; fn: () => void }[] = []
  const notifier = createPhoneNotifier({
    engine,
    settings: () => settings,
    devices: () => devices,
    isPcInUse: () => idle === 'active',
    isVisible: (id) => visible.has(id),
    push,
    log,
    pcAway: (fn) => {
      away.add(fn)
      return () => away.delete(fn)
    },
    retryAfter: (ms, fn) => {
      const r = { ms, fn }
      retries.push(r)
      return () => {
        const i = retries.indexOf(r)
        if (i >= 0) retries.splice(i, 1)
      }
    },
    every: (ms, fn) => {
      const p = { ms, fn }
      polls.push(p)
      return () => polls.splice(polls.indexOf(p), 1)
    },
  })
  disposers.push(() => notifier.dispose())
  return {
    engine, notifier, sent, push, log, visible, held, devices, agents, away, polls, failing, retries,
    /** 기다리는 다시 보내기 중 가장 먼저 걸린 것을 지금 돌린다 */
    fireRetry: async () => {
      const r = retries.shift()
      r?.fn()
      await flush()
    },
    setIdle: (s: typeof idle) => (idle = s),
    /** PC 를 잠갔다(lock-screen) — 그 순간 idle 상태가 아직 active 로 읽혀도 */
    lock: () => {
      for (const f of [...away]) f()
    },
    /** 다시 보기 한 번 — 돌고 있지 않으면 아무것도 안 한다 */
    tick: () => {
      for (const p of [...polls]) p.fn()
    },
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

  // 같은 요청이 다시 와도 또 판단하지 않는다(PC 앞이라 미룬 것은 자리를 비울 때 — 아래 시험들)
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

test('finished 기본 켜짐 — 끄면 안 보낸다', async () => {
  const t = setup()
  t.history('a1', { t: 10, kind: 'result', ok: true, subtype: 'success' })
  await flush()
  expect(t.sent).toHaveLength(1)

  const off = setup({ settings: { notify: { asks: true, finished: false } } })
  off.history('a1', { t: 10, kind: 'result', ok: true, subtype: 'success' })
  await flush()
  expect(off.sent).toHaveLength(0)

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
    { title: '두레', body: '백엔드 · 답이 왔어요', tag: expect.stringMatching(/^dure-a1-finished-\d+$/), url: '/#agent=a1' },
    { title: '두레', body: '프런트 · 답이 왔어요', tag: expect.stringMatching(/^dure-a2-finished-\d+$/), url: '/#agent=a2' },
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

test('서버 방 문제 — PC 앞이라 미룬 문제가 또 실려 와도 그 자리에서 안 보냄 · 켤 때 이미 있던 문제도', async () => {
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

test('서버 방 문제가 있는 에이전트의 차례 끝은 답이 왔어요 대신 문제만', async () => {
  const t = setup({ settings: { notify: { asks: true, finished: true } } })
  // 서버 claude 로그인이 풀렸다는 답 — 엔진은 그 result 를 기록하기 전에 login 문제를 상태 사건으로 알린다
  t.status('a1', { kind: 'login', detail: null }, 'working')
  t.history('a1', { t: 20, kind: 'result', ok: false, subtype: 'success' })
  // 다음 정상 답 — 문제가 먼저 지워지고 차례 끝
  t.status('a1', null, 'working')
  t.history('a1', { t: 21, kind: 'result', ok: true, subtype: 'success' })
  await flush()
  expect(bodies(t.sent)).toEqual(['백엔드 · 서버에 문제가 있어요', '백엔드 · 답이 왔어요'])
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

const dev = (id: string, push = true): PhoneDevice => ({ id, name: id, createdAt: 1, lastSeen: null, push })
const DONE: HistoryItem = { t: 30, kind: 'result', ok: true, subtype: 'success' }

test('PC 쓰는 중에 생긴 승인 — 잠그면 보냄', async () => {
  const t = setup({ settings: { notify: { asks: true, finished: true } } })
  expect(t.polls).toHaveLength(0) // 미룬 것이 없으면 다시 보기도 없다
  t.setIdle('active') // 승인 요청이 왔을 때 PC 앞에 있었다
  t.request('r1')
  t.request('q1', { kind: 'question', toolName: 'AskUserQuestion', input: { questions: [{ question: QUESTION, options: [] }] } })
  t.message('m1', 'pending')
  t.message('m2', 'held', { roomId: 'r2', from: 'b1', to: 'b1' })
  t.hold('a1', HOLD)
  t.status('a2', { kind: 'unreachable', detail: SSH_DETAIL })
  t.history('a1', DONE) // 끝남은 기다림이 아니다 — 미루지 않는다(PC 앞에서 봤다)
  await flush()
  expect(t.sent).toHaveLength(0)
  expect(t.polls.map((p) => p.ms)).toEqual([PC_RECHECK_MS])

  t.lock() // 잠갔다 — 그 순간 idle 상태가 아직 active 로 읽혀도 자리를 떴다
  await flush()
  expect(bodies(t.sent)).toEqual([
    '백엔드 · 승인을 기다려요',
    '백엔드 · 답을 기다려요',
    '프런트 · 넘기기 승인을 기다려요',
    '문서 · 넘기기 승인을 기다려요',
    '백엔드 · 넘기기 승인을 기다려요',
    '프런트 · 서버에 문제가 있어요',
  ])
  expect(t.sent.map((s) => s.notice.url)).toEqual(['/#agent=a1', '/#agent=a1', '/#agent=a2', '/#agent=b1', '/#agent=a1', '/#agent=a2'])
  expect(new Set(t.sent.map((s) => s.notice.tag)).size).toBe(t.sent.length)
  expect(t.sent.every((s) => s.deviceId === 'd1' && s.delivery?.urgency === 'high' && s.delivery.ttl === 3600)).toBe(true)
  const all = JSON.stringify(t.sent)
  for (const secret of ['rm -rf', '비밀', 'sk-fake', '토큰', 'lab-fake', 'ssh', 'AskUserQuestion', 'Bash']) expect(all).not.toContain(secret)
  expect(t.polls).toHaveLength(0) // 다 보냈다 — 다시 보기를 멈춘다

  // 잠근 뒤엔 미룬 것이 없다 — 또 잠가도 그대로
  t.lock()
  await flush()
  expect(t.sent).toHaveLength(6)
})

test('자리를 비워 2분 지나면 보냄', async () => {
  const t = setup()
  t.setIdle('active')
  t.request('r1')
  t.tick() // 아직 PC 앞(마지막 입력 뒤 2분 안)
  await flush()
  expect(t.sent).toHaveLength(0)
  expect(t.polls).toHaveLength(1)

  t.setIdle('idle') // 잠그지 않고 떠났다 — getSystemIdleState(120) 이 idle
  t.tick()
  await flush()
  expect(bodies(t.sent)).toEqual(['백엔드 · 승인을 기다려요'])
  expect(t.sent[0].notice.tag).toMatch(/^dure-a1-approval-\d+$/)
  expect(t.polls).toHaveLength(0)

  // PC 상태를 못 읽어도(던짐) 안 쓰는 중으로 친다 — 미룬 것도 보낸다
  const u = setup()
  let reads = 0
  const engine = Object.assign(new EventEmitter(), { agents: () => [{ id: 'a1', name: '백엔드' }], heldInput: () => 0 })
  const sent: string[] = []
  const poll: { fn: (() => void) | null } = { fn: null }
  const n = createPhoneNotifier({
    engine,
    settings: () => ({ ...DEFAULT_PHONE_SETTINGS, enabled: true }),
    devices: () => u.devices,
    isPcInUse: () => {
      if (reads++ === 0) return true
      throw new Error('idle 상태를 못 읽음')
    },
    isVisible: () => false,
    push: { sendTo: async (_d: string, notice: PhoneNotice) => void sent.push(notice.body) },
    log: () => {},
    every: (_ms, fn) => {
      poll.fn = fn
      return () => (poll.fn = null)
    },
  })
  disposers.push(() => n.dispose())
  engine.emit('request', { id: 'x', agentId: 'a1', toolName: 'Bash', input: {}, kind: 'permission', createdAt: 1 })
  expect(sent).toEqual([])
  poll.fn?.()
  await flush()
  expect(sent).toEqual(['백엔드 · 승인을 기다려요'])
  expect(poll.fn).toBeNull()
})

test('그새 풀린 승인은 안 보냄', async () => {
  const t = setup()
  t.setIdle('active')
  t.request('r1')
  t.request('r2')
  t.message('m1', 'pending')
  t.message('m2', 'held')
  t.message('m3', 'held')
  t.hold('a1', HOLD)
  t.status('a2', { kind: 'disconnected', detail: null })
  t.request('r3', { agentId: 'b1' })
  // PC 앞에서 다 풀었다 — 승인함 · 넘기기 승인 · 이어 보내기 · 붙잡기 풀림 · 서버 다시 이음 · 에이전트 지움
  t.engine.emit('request-resolved', { id: 'r1', agentId: 'a1' })
  t.message('m1', 'delivered')
  t.message('m2', 'queued')
  t.message('m3', 'queued')
  t.hold('a1', null)
  t.status('a2', null)
  t.agents.splice(t.agents.findIndex((a) => a.id === 'b1'), 1)
  t.lock()
  await flush()
  expect(bodies(t.sent)).toEqual(['백엔드 · 승인을 기다려요']) // r2 만 아직 기다린다
  expect(t.polls).toHaveLength(0)

  // 다 풀리면 다시 보기도 멈춘다
  const u = setup()
  u.setIdle('active')
  u.request('r1')
  expect(u.polls).toHaveLength(1)
  u.engine.emit('request-resolved', { id: 'r1', agentId: 'a1' })
  expect(u.polls).toHaveLength(0)

  // 지운 에이전트의 미룬 것은 PC 앞에 있어도 다시 볼 때 버린다(다시 보기가 계속 돌지 않게)
  const gone = setup()
  gone.setIdle('active')
  gone.request('r1', { agentId: 'b1' })
  gone.agents.splice(gone.agents.findIndex((a) => a.id === 'b1'), 1)
  gone.tick()
  expect(gone.polls).toHaveLength(0)

  // 그 사이 휴대폰으로 쓰기를 껐거나 승인·질문 알림을 껐으면 안 보낸다
  const off = setup()
  off.setIdle('active')
  off.request('r1')
  off.set({ enabled: false })
  off.lock()
  const asks = setup()
  asks.setIdle('active')
  asks.request('r1')
  asks.set({ notify: { asks: false, finished: false } })
  asks.lock()
  await flush()
  expect([...off.sent, ...asks.sent]).toHaveLength(0)
  expect([...off.polls, ...asks.polls]).toHaveLength(0)
})

test('화면 보던 기기가 나가면 그 기기에 보냄', async () => {
  const t = setup({ devices: [dev('d1'), dev('d2'), dev('d3', false)] })
  const sentTo = () => t.sent.map((s) => s.deviceId)
  t.visible.add('d1') // d1 은 승인이 올 때 두레 화면을 보고 있었다
  t.request('r1')
  await flush()
  expect(sentTo()).toEqual(['d2'])
  t.visible.delete('d1') // 화면을 떠났다(다른 앱 · 화면 끔 · 끊김)
  t.notifier.deviceHidden('d1')
  await flush()
  expect(sentTo()).toEqual(['d2', 'd1'])
  expect(t.sent[1].notice.body).toBe('백엔드 · 승인을 기다려요')
  expect(t.polls).toHaveLength(0)

  // 보던 중에 풀었으면(휴대폰에서 승인) 나가도 안 보낸다
  t.visible.add('d1')
  t.request('r2')
  t.engine.emit('request-resolved', { id: 'r2', agentId: 'a1' })
  t.visible.delete('d1')
  t.notifier.deviceHidden('d1')
  await flush()
  expect(sentTo()).toEqual(['d2', 'd1', 'd2'])

  // 나갈 때 PC 를 쓰는 중이면 아직 — 자리를 비울 때
  t.visible.add('d2')
  t.request('r3')
  await flush()
  expect(sentTo()).toEqual(['d2', 'd1', 'd2', 'd1'])
  t.setIdle('active')
  t.visible.delete('d2')
  t.notifier.deviceHidden('d2')
  await flush()
  expect(sentTo()).toHaveLength(4)
  t.lock()
  await flush()
  expect(sentTo()).toEqual(['d2', 'd1', 'd2', 'd1', 'd2'])

  // 짝을 끊은 기기엔 보내지 않는다
  const u = setup({ devices: [dev('d1')] })
  u.visible.add('d1')
  u.request('r1')
  u.devices.splice(0)
  u.visible.delete('d1')
  u.notifier.deviceHidden('d1')
  await flush()
  expect(u.sent).toHaveLength(0)
  expect(u.polls).toHaveLength(0)
})

test('두 번 안 보냄', async () => {
  const t = setup({ devices: [dev('d1'), dev('d2')] })
  const sentTo = () => t.sent.map((s) => s.deviceId)
  t.setIdle('active')
  t.request('r1')
  t.visible.add('d1')
  t.lock() // d2 엔 지금, 화면을 보는 d1 은 나갈 때
  await flush()
  expect(sentTo()).toEqual(['d2'])
  t.lock()
  t.setIdle('locked')
  t.tick()
  t.request('r1') // 같은 요청이 다시 와도
  await flush()
  expect(sentTo()).toEqual(['d2'])
  t.visible.delete('d1')
  t.notifier.deviceHidden('d1')
  t.notifier.deviceHidden('d1')
  t.lock()
  t.tick()
  t.request('r1')
  await flush()
  expect(sentTo()).toEqual(['d2', 'd1'])
  expect(t.polls).toHaveLength(0)

  // 미룬 사이 서버 방 문제가 바뀌었다 — 지금 문제 하나만
  const u = setup()
  u.setIdle('active')
  u.status('a1', { kind: 'disconnected', detail: null })
  u.status('a1', { kind: 'login', detail: null })
  u.lock()
  u.tick()
  await flush()
  expect(bodies(u.sent)).toEqual(['백엔드 · 서버에 문제가 있어요'])
  // 미뤘던 문제가 PC 를 안 쓸 때 바뀌면 새 문제를 그 자리에서 — 앞의 것은 버린다
  const w = setup()
  w.setIdle('active')
  w.status('a1', { kind: 'disconnected', detail: null })
  w.setIdle('locked')
  w.status('a1', { kind: 'login', detail: null })
  w.lock()
  w.tick()
  await flush()
  expect(bodies(w.sent)).toEqual(['백엔드 · 서버에 문제가 있어요'])
  expect(w.polls).toHaveLength(0)
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

  // 잠금 신호·다시 보기·기기 나감(powerMonitor·타이머·서버 안에서 돈다)도 던지지 않는다
  const v = setup()
  v.setIdle('active')
  v.request('r1')
  v.engine.agents = () => {
    throw new Error(`목록 못 읽음 ${COMMAND}`)
  }
  v.log.mockClear()
  expect(() => v.lock()).not.toThrow()
  expect(() => v.tick()).not.toThrow()
  expect(() => v.notifier.deviceHidden('d1')).not.toThrow()
  expect(v.log).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(v.log.mock.calls)).not.toContain('rm -rf')
})

test('dispose — 엔진 사건을 더 듣지 않음', async () => {
  const t = setup({ settings: { notify: { asks: true, finished: true } } })
  const names = ['request', 'request-resolved', 'message', 'hold', 'history', 'status']
  for (const name of names) expect(t.engine.listenerCount(name), name).toBe(1)
  expect(t.away.size).toBe(1)
  t.setIdle('active')
  t.request('r0') // 미룬 것이 있다 — 다시 보기가 돈다
  expect(t.polls).toHaveLength(1)
  t.notifier.dispose()
  for (const name of names) expect(t.engine.listenerCount(name), name).toBe(0)
  expect(t.away.size).toBe(0) // 잠금 신호도 푼다
  expect(t.polls).toHaveLength(0) // 다시 보기도 멈춘다
  t.setIdle('locked')
  t.request('r1')
  t.history('a1', { t: 1, kind: 'result', ok: true, subtype: 'success' })
  t.status('a1', { kind: 'disconnected', detail: null })
  t.notifier.deviceHidden('d1')
  await flush()
  expect(t.sent).toHaveLength(0)
  t.notifier.dispose() // 두 번 불러도 괜찮다
})

test('askPushRetries — 일시 오류면 5 s·30 s·120 s 뒤 최대 세 번 다시 보냄(같은 알림 글) · 그다음엔 포기', async () => {
  const t = setup()
  t.failing.on = true
  t.request('r1')
  await flush()
  expect(t.sent).toHaveLength(1)
  expect(t.retries.map((r) => r.ms)).toEqual([5_000])
  const first = t.sent[0].notice
  await t.fireRetry()
  expect(t.sent).toHaveLength(2)
  expect(t.retries.map((r) => r.ms)).toEqual([30_000])
  await t.fireRetry()
  expect(t.sent).toHaveLength(3)
  expect(t.retries.map((r) => r.ms)).toEqual([120_000])
  await t.fireRetry()
  expect(t.sent).toHaveLength(4) // 처음 + 세 번
  expect(t.retries).toHaveLength(0) // 더 안 함
  expect(t.sent.every((s) => s.notice.body === first.body && s.deviceId === 'd1' && s.delivery?.urgency === 'high')).toBe(true)
})

test('askPushRetries — 다시 보내다 성공하면 그만 · 기다림이 풀리면 그만 · 기기를 끊거나 끄면 그만', async () => {
  // 성공하면 그만
  let t = setup()
  t.failing.on = true
  t.request('r1')
  await flush()
  t.failing.on = false
  await t.fireRetry()
  expect(t.sent).toHaveLength(2)
  expect(t.retries).toHaveLength(0)

  // 기다림이 풀렸다(요청 풀림)
  t = setup()
  t.failing.on = true
  t.request('r1')
  await flush()
  t.engine.emit('request-resolved', { id: 'r1', agentId: 'a1' })
  expect(t.retries).toHaveLength(0)
  expect(t.sent).toHaveLength(1)

  // 넘기기 승인(pending)이 풀렸다
  t = setup()
  t.failing.on = true
  t.message('m1', 'pending')
  await flush()
  expect(t.retries).toHaveLength(1)
  t.message('m1', 'delivered')
  expect(t.retries).toHaveLength(0)

  // 타이머가 이미 울렸는데 그 사이 풀림·끊김·꺼짐 — 안 보냄
  for (const stop of [
    (x: ReturnType<typeof setup>) => x.devices.splice(0),
    (x: ReturnType<typeof setup>) => x.set({ enabled: false }),
    (x: ReturnType<typeof setup>) => x.set({ notify: { ...DEFAULT_PHONE_SETTINGS.notify, asks: false } }),
    (x: ReturnType<typeof setup>) => x.agents.splice(0),
    (x: ReturnType<typeof setup>) => x.visible.add('d1'),
  ]) {
    t = setup()
    t.failing.on = true
    t.request('r1')
    await flush()
    stop(t)
    await t.fireRetry()
    expect(t.sent).toHaveLength(1)
    expect(t.retries).toHaveLength(0)
  }

  // dispose 가 기다리는 다시 보내기를 지운다
  t = setup()
  t.failing.on = true
  t.request('r1')
  await flush()
  t.notifier.dispose()
  expect(t.retries).toHaveLength(0)
})

test('askPushRetries — 끝 알림(finished)은 실패해도 다시 안 보냄 · 기기마다 따로', async () => {
  const t = setup({
    devices: [
      { id: 'd1', name: 'a', createdAt: 1, lastSeen: null, push: true },
      { id: 'd2', name: 'b', createdAt: 1, lastSeen: null, push: true },
    ],
  })
  t.failing.on = true
  t.history('a1', { t: 5, kind: 'result', ok: true, subtype: 'success' })
  await flush()
  expect(t.sent).toHaveLength(2)
  expect(t.retries).toHaveLength(0)

  t.request('r1')
  await flush()
  expect(t.retries).toHaveLength(2) // 기기마다 하나
})
