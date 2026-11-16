import { describe, it, expect, vi } from 'vitest'
import { createStore } from '../../src/renderer/state/store'
import type { AssistantBlock, DiffHunk, HistoryItem, RelayMessage } from '../../src/engine/types'
import type { AgentView, DureApi, Snapshot } from '../../src/shared/ipcContract'
import type { ScreenEvent } from '../../src/renderer/power/events'

// 파워 모드 듣기 — 엔진 사건을 화면 사건으로(도구 · 결과 · diff · 답 글 · 넘김 · 차례 끝). 진짜만, 글은 한 줄 글자로만

const agent = (id: string, roomId = 'r1'): AgentView => ({
  id, roomId, name: id, role: '', folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null,
})
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  claudeMissing: false,
  rooms: [{ id: 'r1', name: '첫 방', createdAt: 2 }, { id: 'r2', name: '둘째', createdAt: 1 }],
  agents: [agent('a'), agent('b'), agent('c', 'r2')],
  messages: [], requests: [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null, ...over,
})
const relay = (id: string, over: Partial<RelayMessage> = {}): RelayMessage => ({
  id, roomId: 'r1', from: 'a', to: 'b', text: 'x', createdAt: 1, state: 'pending', updatedAt: 1, ...over,
})

async function powered(opts: { snapshot?: () => Promise<Snapshot> } = {}) {
  const handlers: Record<string, ((p: any) => void)[]> = {}
  const api = {
    snapshot: vi.fn(opts.snapshot ?? (async () => snap())),
    history: vi.fn(async () => []),
    setPowerMode: vi.fn(async () => {}),
    on: vi.fn((k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    }),
  } as unknown as DureApi
  const s = createStore(api)
  await s.init()
  const got: ScreenEvent[] = []
  s.onPowerEvent(e => got.push(e))
  await s.setPower(true)
  const emit = (k: string, p: unknown) => (handlers[k] ?? []).forEach(f => f(p))
  const hist = (agentId: string, item: HistoryItem) => emit('history', { agentId, item })
  return { s, got, emit, hist }
}

const assistant = (blocks: AssistantBlock[], parent?: string): HistoryItem => ({ t: 5, kind: 'assistant', blocks, ...(parent ? { parent } : {}) })
const toolUse = (name: string, input: unknown): AssistantBlock => ({ type: 'tool_use', id: 'u', name, input })
const toolResult = (over: Partial<Extract<HistoryItem, { kind: 'tool-result' }>> = {}): HistoryItem => ({ t: 6, kind: 'tool-result', toolUseId: 'u', isError: false, text: '', viaApproval: false, ...over })

describe('파워 모드 듣기', () => {
  it('tool_use_→_tool', async () => {
    const { got, hist } = await powered()
    hist('b', assistant([toolUse('Read', { file_path: 'src/a.ts' }), toolUse('Bash', { command: 'npm test' }), toolUse('Glob', { count: 3 })]))
    expect(got).toMatchObject([
      { kind: 'tool', agentId: 'b', tool: 'Read', target: 'src/a.ts' },
      { kind: 'tool', agentId: 'b', tool: 'Bash', target: 'npm test' },
      { kind: 'tool', agentId: 'b', tool: 'Glob', target: '' },
    ])
    expect(typeof got[0].at).toBe('number')
    expect(got[0]).not.toHaveProperty('real')
  })

  it('tool_result_의_patch_→_added_removed_diff(12줄까지)', async () => {
    const { got, hist } = await powered()
    const patch: DiffHunk[] = [
      { oldStart: 1, newStart: 1, lines: [' 그대로', '-지운 줄', '+더한 줄', '+또 더함'] },
      { oldStart: 40, newStart: 41, lines: Array.from({ length: 20 }, (_, i) => `+새 줄 ${i}`) },
    ]
    hist('a', toolResult({ text: '파일을 고쳤어요\n자세히', patch }))
    expect(got).toHaveLength(1)
    const ev = got[0]
    expect(ev).toMatchObject({ kind: 'result', agentId: 'a', ok: true, text: '파일을 고쳤어요', added: 22, removed: 1 })
    if (ev.kind !== 'result') throw new Error('result 가 아니다')
    expect(ev.diff).toHaveLength(12)
    expect(ev.diff.slice(0, 4)).toEqual([
      { sign: ' ', text: '그대로' },
      { sign: '-', text: '지운 줄' },
      { sign: '+', text: '더한 줄' },
      { sign: '+', text: '또 더함' },
    ])
    expect(ev.diff[11]).toEqual({ sign: '+', text: '새 줄 7' })
    // patch 가 없으면 바꾼 줄도 없다
    hist('a', toolResult({ text: '12줄 읽음' }))
    expect(got[1]).toMatchObject({ kind: 'result', added: 0, removed: 0, diff: [] })
  })

  it('오류_결과는_ok_false', async () => {
    const { got, hist } = await powered()
    hist('a', toolResult({ isError: true, text: '\n  파일이 없어요\n둘째 줄' }))
    expect(got).toMatchObject([{ kind: 'result', agentId: 'a', ok: false, text: '파일이 없어요' }])
  })

  it('답_글은_문단_첫_줄_최대_3개_한_줄로', async () => {
    const { got, hist } = await powered()
    hist('a', assistant([
      { type: 'text', text: '첫 문단 첫 줄\n첫 문단 둘째 줄\n\n둘째 문단\n\n\n  셋째 문단  \n더\n\n넷째 문단' },
      toolUse('Read', { file_path: 'x.ts' }),
    ]))
    expect(got).toEqual([
      { kind: 'say', agentId: 'a', text: '첫 문단 첫 줄', at: expect.any(Number) },
      { kind: 'say', agentId: 'a', text: '둘째 문단', at: expect.any(Number) },
      { kind: 'say', agentId: 'a', text: '셋째 문단', at: expect.any(Number) },
      { kind: 'tool', agentId: 'a', tool: 'Read', target: 'x.ts', at: expect.any(Number) },
    ])
    // 한 사건 안의 여러 글 블록도 합쳐 셋까지
    got.length = 0
    hist('a', assistant([{ type: 'text', text: '하나\n\n둘' }, { type: 'text', text: '셋\n\n넷' }]))
    expect(got.map(e => (e.kind === 'say' ? e.text : e.kind))).toEqual(['하나', '둘', '셋'])
  })

  it('result_→_done', async () => {
    const { got, hist } = await powered()
    hist('b', { t: 9, kind: 'result', ok: true, subtype: 'success' })
    hist('b', { t: 10, kind: 'result', ok: false, subtype: 'error_during_execution' })
    expect(got).toEqual([
      { kind: 'done', agentId: 'b', at: expect.any(Number) },
      { kind: 'done', agentId: 'b', at: expect.any(Number) },
    ])
  })

  it('<img_onerror>_·_줄바꿈_·_2000자_→_한_줄_글자', async () => {
    const { got, hist, emit } = await powered()
    const evil = '<img src=x onerror=alert(1)>'
    const long = `${evil}\n${'가'.repeat(2000)}`
    hist('a', assistant([{ type: 'text', text: `${evil} ${'나'.repeat(2000)}` }, toolUse('Bash', { command: long })]))
    hist('a', toolResult({ text: `${evil} ${'다'.repeat(2000)}`, patch: [{ oldStart: 1, newStart: 1, lines: [`+${evil}${'라'.repeat(2000)}`] }] }))
    emit('message', relay('n1', { text: long }))
    const texts = got.flatMap(e =>
      e.kind === 'say' ? [e.text]
      : e.kind === 'tool' ? [e.target]
      : e.kind === 'result' ? [e.text, ...e.diff.map(d => d.text)]
      : e.kind === 'handoff' ? [e.text]
      : [],
    )
    expect(got.map(e => e.kind)).toEqual(['say', 'tool', 'result', 'handoff'])
    expect(texts).toHaveLength(5)
    for (const t of texts) {
      expect(typeof t).toBe('string')
      expect(t.startsWith(evil)).toBe(true)
      expect(t).not.toMatch(/[\r\n]/)
      expect(t.length).toBeLessThanOrEqual(80)
    }
  })

  it('parent_있는_줄_·_방_밖_·_목록_밖은_버린다', async () => {
    const list = [agent('a'), agent('b'), agent('c', 'r2')]
    const { s, got, hist, emit } = await powered({ snapshot: async () => snap({ agents: list }) })
    // 서브에이전트 줄
    hist('a', assistant([{ type: 'text', text: '안쪽 글' }, toolUse('Read', { file_path: 'sub.ts' })], 'p1'))
    hist('a', toolResult({ text: '안쪽 결과', parent: 'p1' }))
    // 다른 방
    hist('c', assistant([toolUse('Read', { file_path: 'other-room.ts' })]))
    hist('c', { t: 9, kind: 'result', ok: true, subtype: 'success' })
    emit('message', relay('m-other', { roomId: 'r2', from: 'c', to: 'c' }))
    // 켠 뒤에 방에 들어온 에이전트 — 굳힌 목록 밖
    list.push(agent('zz-new'))
    await s.refresh()
    expect(s.getState().agents.map(a => a.id)).toContain('zz-new')
    hist('zz-new', assistant([toolUse('Read', { file_path: 'from-new.ts' })]))
    emit('message', relay('m-new1', { from: 'zz-new', to: 'a' }))
    emit('message', relay('m-new2', { from: 'a', to: 'zz-new' }))
    expect(got).toEqual([])
    // 목록 안은 그대로 온다
    hist('a', assistant([toolUse('Read', { file_path: 'known.ts' })]))
    expect(got).toMatchObject([{ kind: 'tool', agentId: 'a', target: 'known.ts' }])
  })

  it('켜기_전_메시지는_안_쏜다', async () => {
    const old = Array.from({ length: 100 }, (_, i) => relay(`o${i}`, { state: 'delivered' }))
    const { got, emit } = await powered({ snapshot: async () => snap({ messages: old }) })
    emit('message', relay('o3', { state: 'read', updatedAt: 9 }))
    expect(got).toEqual([])
    emit('message', relay('n1', { text: '넘겨요', updatedAt: 2 }))
    emit('message', relay('n1', { state: 'delivered', updatedAt: 3 }))
    expect(got).toEqual([{ kind: 'handoff', from: 'a', to: 'b', text: '넘겨요', at: expect.any(Number) }])
  })
})
