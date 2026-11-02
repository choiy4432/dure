import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import type { PendingRequest, RelayMessage } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id === 'a' ? '디자인' : id, role: '', folder: 'C:/w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const req = (id: string, agentId = 'a'): PendingRequest => ({ id, agentId, toolName: 'Edit', input: { file_path: 'C:/w/x.ts' }, kind: 'permission', createdAt: 1 })
const msg = (id: string): RelayMessage => ({ id, roomId: 'r1', from: 'a', to: 'b', text: 'x', createdAt: 1, state: 'pending', updatedAt: 1 })

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let dure: Record<string, ReturnType<typeof vi.fn>>
const emit = (k: string, p: unknown) => act(async () => { (handlers[k] ?? []).forEach(f => f(p)) })

beforeEach(() => {
  vi.resetModules()
  handlers = {}
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }], agents: [agent('a'), agent('b')],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  dure = { setTaskbar: vi.fn(async () => {}), flashWindow: vi.fn(async () => {}), focusWindow: vi.fn(async () => {}) }
  ;(window as any).dure = {
    snapshot: async () => snapshot, history: async () => [],
    on: (k: string, fn: (p: any) => void) => { (handlers[k] ??= []).push(fn); return () => {} },
    ...dure,
  }
})
afterEach(() => cleanup())

async function setup(opts: { focus?: boolean } = {}) {
  const { getStore } = await import('../../src/renderer/state/store')
  const { useAttention } = await import('../../src/renderer/shell/useAttention')
  const notify = vi.fn()
  const drawBadge = vi.fn((t: string) => `png:${t}`)
  let announced: { text: string; n: number } = { text: '', n: 0 }
  function Probe() {
    announced = useAttention({ hasFocus: () => opts.focus ?? false, notify, drawBadge })
    return null
  }
  // 훅이 먼저 붙고 스냅샷이 나중에 오는 실제 순서 — 첫 스냅샷의 요청이 알림 폭풍이 되면 안 된다
  const r = render(<Probe />)
  await act(async () => { await getStore().init() })
  return { store: getStore(), notify, drawBadge, announced: () => announced, ...r }
}

describe('useAttention', () => {
  it('처음 스냅샷에 있던 요청엔 깜박임·알림이 없다', async () => {
    snapshot.requests = [req('q0')]
    const { notify } = await setup()
    expect(dure.flashWindow).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(document.title).toBe('(1) 두레 — 여름 캠페인')
    expect(dure.setTaskbar).toHaveBeenLastCalledWith(1, 'png:1')
  })

  it('초점 없음 + 새 승인 → flashWindow · 알림(제목·본문·tag) · 읽어 줄 글', async () => {
    const { notify, announced } = await setup()
    await emit('request', req('q1'))
    expect(dure.flashWindow).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('디자인이 파일을 고치려 해요', expect.objectContaining({ body: 'x.ts', tag: 'dure-a' }))
    expect(announced().text).toBe('디자인이 승인을 기다려요')
  })

  it('초점 있음 + 새 승인 → 알림·깜박임 없음, 제목·배지 수만', async () => {
    const { notify } = await setup({ focus: true })
    await emit('request', req('q1'))
    expect(dure.flashWindow).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(document.title).toBe('(1) 두레 — 여름 캠페인')
    expect(dure.setTaskbar).toHaveBeenLastCalledWith(1, 'png:1')
  })

  it('notify.asks 꺼짐 → 알림 없음, 깜박임은 있음', async () => {
    snapshot.notify = { asks: false, finished: false }
    const { notify } = await setup()
    await emit('request', req('q1'))
    expect(notify).not.toHaveBeenCalled()
    expect(dure.flashWindow).toHaveBeenCalledTimes(1)
  })

  it('알림을 누르면 focusWindow + focusAgent', async () => {
    const { notify, store } = await setup()
    await emit('request', req('q1', 'b'))
    await act(async () => { notify.mock.calls[0][1].onClick() })
    expect(dure.focusWindow).toHaveBeenCalled()
    expect(store.getState().selectedAgentId).toBe('b')
  })

  it('같은 에이전트가 연달아 승인을 물으면 두 번 다 알린다(n 이 오른다)', async () => {
    const { announced } = await setup()
    await emit('request', req('q1'))
    const first = announced()
    await emit('request', req('q2'))
    expect(announced().text).toBe(first.text)
    expect(announced().n).toBe(first.n + 1)
  })

  it('새 pending 메시지 → 읽어 줄 글만(깜박임·알림 없음)', async () => {
    const { notify, announced } = await setup()
    await emit('message', msg('m1'))
    expect(announced().text).toBe('b에게 메시지가 왔어요')
    expect(dure.flashWindow).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('fresh 새로 생김 + 초점 없음 + finished 켬 → 끝남 알림', async () => {
    snapshot.notify = { asks: true, finished: true }
    const { notify } = await setup()
    await emit('history', { agentId: 'a', item: { t: 5, kind: 'assistant', blocks: [{ type: 'text', text: '다 했어요\n끝' }] } })
    await emit('history', { agentId: 'a', item: { t: 6, kind: 'result', ok: true, subtype: 'success' } })
    expect(notify).toHaveBeenCalledWith('디자인이 일을 끝냈어요', expect.objectContaining({ body: '다 했어요', tag: 'dure-a' }))
  })

  it('finished 꺼짐이면 끝남 알림 없음', async () => {
    const { notify } = await setup()
    await emit('history', { agentId: 'a', item: { t: 6, kind: 'result', ok: true, subtype: 'success' } })
    expect(notify).not.toHaveBeenCalled()
  })

  it('할 일 수 0 → setTaskbar(0, null) · 제목 두레 — 방', async () => {
    snapshot.requests = [req('q0')]
    await setup()
    await emit('request-resolved', { id: 'q0', agentId: 'a' })
    expect(dure.setTaskbar).toHaveBeenLastCalledWith(0, null)
    expect(document.title).toBe('두레 — 여름 캠페인')
  })

  it('unmount 하면 구독을 푼다', async () => {
    const { unmount, notify } = await setup()
    unmount()
    await emit('request', req('q1'))
    expect(notify).not.toHaveBeenCalled()
  })

  describe('서버 방 문제 — 오류처럼 알린다(엔진 상태는 쉬는 중 그대로)', () => {
    const serverRoom = () => {
      snapshot.rooms = [{ id: 'r1', name: '서버 실험', createdAt: 1, remote: { host: 'dev' } }]
    }
    const drop = { kind: 'disconnected' as const, detail: null }

    it('초점 없음 + 새 끊김 → 깜박임 · 알림(이름 · 문제 한 줄) · 읽어 줄 글', async () => {
      serverRoom()
      const { notify, announced } = await setup()
      await emit('status', { agentId: 'a', status: 'idle', errorText: null, remoteIssue: drop })
      expect(dure.flashWindow).toHaveBeenCalledTimes(1)
      expect(notify).toHaveBeenCalledWith('디자인', expect.objectContaining({ body: 'dev 연결이 끊겼어요 — 다시 보내면 이어서 해요', tag: 'dure-a' }))
      expect(announced().text).toBe('디자인: dev 연결이 끊겼어요 — 다시 보내면 이어서 해요')
      // 같은 문제가 이어지면(상태 사건이 또 와도) 다시 알리지 않는다
      await emit('status', { agentId: 'a', status: 'idle', errorText: null, remoteIssue: drop })
      expect(dure.flashWindow).toHaveBeenCalledTimes(1)
      expect(notify).toHaveBeenCalledTimes(1)
      // 로그인 만료로 바뀌면 다시
      await emit('status', { agentId: 'a', status: 'idle', errorText: null, remoteIssue: { kind: 'login', detail: null } })
      expect(notify).toHaveBeenLastCalledWith('디자인', expect.objectContaining({ body: 'dev 의 claude 로그인이 만료됐어요' }))
    })

    it('처음 스냅샷에 있던 문제엔 깜박임·알림이 없다 · 초점 있으면 읽어 줄 글만 · notify.asks 꺼짐이면 알림 없이 깜박임', async () => {
      serverRoom()
      snapshot.agents = [agent('a', { remoteIssue: drop }), agent('b')]
      const first = await setup()
      expect(dure.flashWindow).not.toHaveBeenCalled()
      expect(first.notify).not.toHaveBeenCalled()
      cleanup()

      vi.resetModules()
      snapshot.agents = [agent('a'), agent('b')]
      const focused = await setup({ focus: true })
      await emit('status', { agentId: 'a', status: 'idle', errorText: null, remoteIssue: drop })
      expect(dure.flashWindow).not.toHaveBeenCalled()
      expect(focused.notify).not.toHaveBeenCalled()
      expect(focused.announced().text).toBe('디자인: dev 연결이 끊겼어요 — 다시 보내면 이어서 해요')
      cleanup()

      vi.resetModules()
      snapshot.notify = { asks: false, finished: false }
      const quiet = await setup()
      await emit('status', { agentId: 'b', status: 'idle', errorText: null, remoteIssue: drop })
      expect(dure.flashWindow).toHaveBeenCalledTimes(1)
      expect(quiet.notify).not.toHaveBeenCalled()
    })

    it('로그인 만료 답(새 결과)은 "일을 끝냈어요" 대신 문제 알림 하나', async () => {
      serverRoom()
      snapshot.notify = { asks: true, finished: true }
      const { notify } = await setup()
      await emit('status', { agentId: 'a', status: 'idle', errorText: null, remoteIssue: { kind: 'login', detail: null } })
      await emit('history', { agentId: 'a', item: { t: 6, kind: 'result', ok: false, subtype: 'success' } })
      const bodies = notify.mock.calls.map(c => c[0])
      expect(bodies).toEqual(['디자인'])
    })
  })
})
