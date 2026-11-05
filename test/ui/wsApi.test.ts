import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWsApi, OPEN_TIMEOUT_MS, PHONE_BAD_ARGS, PHONE_OFFLINE, PHONE_UNSURE, PING_EVERY_MS, PONG_WAIT_MS, RECONNECT_MS, type PhoneApi } from '../../src/renderer/mobile/wsApi'
import { HTTP_TIMEOUT_MS } from '../../src/renderer/mobile/phoneHttp'
import { getConn, onPhoneConn } from '../../src/renderer/mobile/connection'
import { getStore } from '../../src/renderer/state/store'
import { getDraft, updateDraft } from '../../src/renderer/panel/drafts'
import { PHONE_DENIED } from '../../src/shared/phoneAccess'
import { PHONE_CLOSE_UNPAIRED } from '../../src/shared/phoneWire'
import { ATTACH_MAX_BYTES, ATTACH_TOO_BIG } from '../../src/shared/attachments'
import type { HistoryItem } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

// ── 가짜 WebSocket — 보낸 글을 모으고, 시험이 열기·끊기·답·사건을 흉내 낸다 ──
type Sent = { t: 'call'; id: number; method: string; args: unknown[] } | { t: 'visible'; on: boolean } | { t: 'ping' }
class FakeWs {
  static all: FakeWs[] = []
  static last(): FakeWs {
    return FakeWs.all[FakeWs.all.length - 1]
  }
  readyState = 0
  bufferedAmount = 0
  sent: Sent[] = []
  raw: string[] = []
  closedByClient: number | null = null
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(public url: string) {
    FakeWs.all.push(this)
  }
  send(s: string) {
    this.raw.push(s)
    this.sent.push(JSON.parse(s))
  }
  close(code = 1000) {
    this.closedByClient = code
    this.readyState = 3
  }
  // 시험 손잡이
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code, reason: '' })
  }
  pings() {
    return this.sent.filter(m => m.t === 'ping').length
  }
  visibles() {
    return this.sent.filter((m): m is Extract<Sent, { t: 'visible' }> => m.t === 'visible')
  }
  pong() {
    this.onmessage?.({ data: JSON.stringify({ t: 'pong' }) })
  }
  calls(method?: string) {
    return this.sent.filter((m): m is Extract<Sent, { t: 'call' }> => m.t === 'call' && (!method || m.method === method))
  }
  reply(id: number, value: unknown) {
    this.onmessage?.({ data: JSON.stringify({ t: 'result', id, ok: true, value }) })
  }
  fail(id: number, error: string) {
    this.onmessage?.({ data: JSON.stringify({ t: 'result', id, ok: false, error }) })
  }
  emit(name: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ t: 'event', name, payload }) })
  }
}

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '', folder: '/x', sessionId: '', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, effortNow: null, modelNow: null, lastContext: null, bypassOn: false, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
})
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  claudeMissing: false, rooms: [{ id: 'r1', name: '첫 방', createdAt: 1 }], agents: [agent('a'), agent('b')],
  messages: [], requests: [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null, ...over,
})
const note = (text: string, t = 1): HistoryItem => ({ t, kind: 'notice', text })

/** 약속을 몇 바퀴 돌린다 — 가짜 시계라 setTimeout 으로 기다리지 않는다 */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const meFetch = (status: number) => vi.fn(async () => new Response(JSON.stringify(status === 200 ? { ok: true } : { ok: false, error: 'x' }), { status }))

let api: PhoneApi | null = null
const make = (o: Partial<Parameters<typeof createWsApi>[0]> = {}) => {
  api = createWsApi({ url: 'wss://pc.tail.ts.net/api/ws', WebSocketImpl: FakeWs as unknown as typeof WebSocket, fetchImpl: meFetch(200) as unknown as typeof fetch, ...o })
  return api
}

beforeEach(() => {
  FakeWs.all = []
  vi.useFakeTimers()
})
afterEach(() => {
  api?.close()
  api = null
  vi.useRealTimers()
})

describe('createWsApi — 휴대폰의 window.dure', () => {
  it('다시 잇기 — 스냅샷 다시·쓰던 글 남음', async () => {
    const conns: string[] = []
    const a = make({ onConn: (s, again) => { conns.push(`${s}:${again}`); onPhoneConn(s, again) } })
    window.dure = a // 첫 getStore() 전에
    const store = getStore()
    const ws1 = FakeWs.last()
    const init = store.init()
    ws1.open()
    expect(conns).toEqual(['open:false'])
    ws1.reply(ws1.calls('snapshot')[0].id, snap())
    await init
    store.selectAgent('a')
    await flush()
    ws1.reply(ws1.calls('history')[0].id, [note('하나', 1)])
    await flush()
    expect(store.getState().history.a).toHaveLength(1)
    updateDraft('a', d => ({ ...d, text: '쓰던 글' }))

    // 지하철 — 끊김
    ws1.drop()
    expect(getConn()).toBe('reconnecting')
    expect(conns).toEqual(['open:false', 'reconnecting:true'])
    vi.advanceTimersByTime(RECONNECT_MS[0])
    const ws2 = FakeWs.last()
    expect(ws2).not.toBe(ws1)
    ws2.open()
    expect(getConn()).toBe('open')
    expect(conns.at(-1)).toBe('open:true')

    // 그사이 일어난 일 — 스냅샷부터 다시 받고, 열린 대화의 기록도 다시 받는다
    await flush()
    const s2 = ws2.calls('snapshot')
    expect(s2).toHaveLength(1)
    ws2.reply(s2[0].id, snap({ agents: [agent('a', { status: 'awaiting' }), agent('b')] }))
    await flush()
    const h2 = ws2.calls('history')
    expect(h2.map(c => c.args[0])).toEqual(['a'])
    ws2.reply(h2[0].id, [note('하나', 1), note('끊긴 사이', 2)])
    await flush()
    expect(store.getState().agents.find(x => x.id === 'a')!.status).toBe('awaiting')
    expect(store.getState().history.a.map(i => (i.kind === 'notice' ? i.text : ''))).toEqual(['하나', '끊긴 사이'])
    expect(getDraft('a').text).toBe('쓰던 글')
    // 다시 받는 동안 기록을 지우지 않았다(불러오는 중 깜박임 없음)
    expect(store.getState().historyStatus.a).toEqual({ state: 'ready' })
  })

  it('pc 메서드 — 부르지 않고 거절', async () => {
    const a = make()
    FakeWs.last().open()
    await expect(a.setSelected('a')).rejects.toThrow(PHONE_DENIED)
    await expect(a.pickFolder()).rejects.toThrow(PHONE_DENIED)
    await expect(a.phonePairStart()).rejects.toThrow(PHONE_DENIED)
    await expect(a.setTheme('dark')).rejects.toThrow(PHONE_DENIED)
    await expect(a.appInfo()).rejects.toThrow(PHONE_DENIED)
    expect(FakeWs.last().calls()).toEqual([])
    expect(a.pathForFile(new File(['x'], 'a.txt'))).toBe('')
  })

  it('끊길 때 진행 중 call 실패 · 끊긴 동안의 call 은 보내지 않고 바로 실패', async () => {
    const a = make()
    const ws = FakeWs.last()
    ws.open()
    const p = a.snapshot()
    const q = a.sendUser('a', [{ type: 'text', text: '안녕' }])
    expect(ws.calls().map(c => c.method)).toEqual(['snapshot', 'sendUser'])
    ws.drop()
    // 이미 보냈는데 답을 못 받았다 — PC 가 받았는지 모른다('연결이 끊겼어요' 면 사용자가 그대로 또 보낸다)
    expect(PHONE_UNSURE).toBe('보냈는지 확인하지 못했어요 — 기록을 확인해 주세요')
    await expect(p).rejects.toThrow(PHONE_UNSURE)
    await expect(q).rejects.toThrow(PHONE_UNSURE)
    const before = ws.sent.length
    await expect(a.snapshot()).rejects.toThrow(PHONE_OFFLINE)
    expect(ws.sent.length).toBe(before)
    // 늦게 온 답은 버린다(이미 실패로 끝난 call)
    expect(() => ws.reply(ws.calls('snapshot')[0].id, snap())).not.toThrow()
  })

  it('처음 잇는 동안의 call 은 열리면 보낸다 · 첫 시도가 실패하면 거절', async () => {
    const a = make()
    const ws = FakeWs.last()
    const p = a.snapshot()
    expect(ws.sent).toEqual([])
    ws.open()
    expect(ws.calls('snapshot')).toHaveLength(1)
    ws.reply(ws.calls('snapshot')[0].id, snap())
    await expect(p).resolves.toMatchObject({ rooms: [{ id: 'r1' }] })

    a.close()
    const b = make()
    const q = b.snapshot()
    FakeWs.last().drop()
    await expect(q).rejects.toThrow(PHONE_OFFLINE)
  })

  it('답 ok:false 는 그 글로 거절 · 사건은 on 의 함수로, 해제하면 안 옴', async () => {
    const a = make()
    const ws = FakeWs.last()
    ws.open()
    const p = a.removeAgent('a')
    ws.fail(ws.calls('removeAgent')[0].id, '없는 에이전트예요')
    await expect(p).rejects.toThrow('없는 에이전트예요')
    const got: unknown[] = []
    const off = a.on('status', p => got.push(p))
    ws.emit('status', { agentId: 'a', status: 'working', errorText: null })
    off()
    ws.emit('status', { agentId: 'a', status: 'idle', errorText: null })
    expect(got).toEqual([{ agentId: 'a', status: 'working', errorText: null }])
    // 꼴이 틀린 글은 버린다
    expect(() => ws.onmessage?.({ data: 'not json' })).not.toThrow()
  })

  it('visible — 열자마자 지금 상태를 보내고, 화면이 숨거나 보일 때 또 보낸다', async () => {
    make()
    const ws = FakeWs.last()
    ws.open()
    expect(ws.sent[0]).toEqual({ t: 'visible', on: true })
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(ws.sent.at(-1)).toEqual({ t: 'visible', on: false })
    // 다시 이어도 지금 상태(숨음)를 먼저
    ws.drop()
    vi.advanceTimersByTime(RECONNECT_MS[0])
    FakeWs.last().open()
    expect(FakeWs.last().sent[0]).toEqual({ t: 'visible', on: false })
    vis.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(FakeWs.last().visibles().at(-1)).toEqual({ t: 'visible', on: true })
    vis.mockRestore()
  })

  it('반쯤 열린 연결 — 화면이 다시 보이면 바로 묻고, 7초 안에 아무 글도 없으면 끊긴 것으로 치고 다시 잇는다', async () => {
    const conns: string[] = []
    const a = make({ onConn: (s, again) => conns.push(`${s}:${again}`) })
    const ws = FakeWs.last()
    ws.open()
    // 주머니 속 — 숨은 동안엔 묻지 않는다(휴대폰은 숨은 화면의 시계를 멈춘다)
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(10 * 60_000)
    expect(ws.pings()).toBe(0)
    // PC 가 잠들었다(닫힘 신호 없음) — 휴대폰을 다시 켜고 바로 보낸다
    vis.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(ws.pings()).toBe(1)
    const p = a.sendUser('a', [{ type: 'text', text: '안녕' }])
    vi.advanceTimersByTime(PONG_WAIT_MS - 1)
    expect(conns).toEqual(['open:false'])
    expect(ws.closedByClient).toBeNull()
    vi.advanceTimersByTime(1)
    expect(conns).toEqual(['open:false', 'reconnecting:true'])
    expect(ws.closedByClient).not.toBeNull()
    await expect(p).rejects.toThrow(PHONE_UNSURE)
    // 닫은 소켓의 늦은 닫힘은 버린다 — 다시 잇기는 한 번만
    ws.drop()
    expect(conns).toHaveLength(2)
    vi.advanceTimersByTime(RECONNECT_MS[0])
    expect(FakeWs.all).toHaveLength(2)
    FakeWs.last().open()
    expect(conns.at(-1)).toBe('open:true')
    vis.mockRestore()
  })

  it('보이는 동안 25초마다 묻는다 — 답(pong)이든 사건이든 무엇이 오면 살아 있음 · 숨으면 멈춤', async () => {
    make()
    const ws = FakeWs.last()
    ws.open()
    vi.advanceTimersByTime(PING_EVERY_MS - 1)
    expect(ws.pings()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(ws.pings()).toBe(1)
    vi.advanceTimersByTime(3000)
    ws.pong()
    vi.advanceTimersByTime(PING_EVERY_MS - 3000)
    expect(ws.pings()).toBe(2)
    ws.emit('status', { agentId: 'a', status: 'working', errorText: null })
    vi.advanceTimersByTime(PONG_WAIT_MS * 2)
    expect(ws.closedByClient).toBeNull()
    expect(FakeWs.all).toHaveLength(1)
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    const n = ws.pings()
    vi.advanceTimersByTime(PING_EVERY_MS * 4)
    expect(ws.pings()).toBe(n)
    expect(ws.closedByClient).toBeNull()
    vis.mockRestore()
  })

  it('큰 글을 보내는 중(그림)엔 답이 늦어도 — 보낼 몫이 줄고 있으면 기다리고, 멈췄으면 끊긴 것', async () => {
    const conns: string[] = []
    make({ onConn: (s, again) => conns.push(`${s}:${again}`) })
    const ws = FakeWs.last()
    ws.open()
    ws.bufferedAmount = 6_000_000
    vi.advanceTimersByTime(PING_EVERY_MS)
    expect(ws.pings()).toBe(1)
    ws.bufferedAmount = 3_000_000
    vi.advanceTimersByTime(PONG_WAIT_MS)
    expect(conns).toEqual(['open:false'])
    ws.bufferedAmount = 1_000_000
    vi.advanceTimersByTime(PONG_WAIT_MS)
    expect(conns).toEqual(['open:false'])
    // 더 줄지 않는다 — 망이 막혔다
    vi.advanceTimersByTime(PONG_WAIT_MS)
    expect(conns).toEqual(['open:false', 'reconnecting:true'])
  })

  it('여는 데 10초를 넘기면 못 연 것으로 → /api/me → 다시 · 늦게 열린 옛 소켓은 버린다', async () => {
    const fetchImpl = meFetch(200)
    const conns: string[] = []
    const a = make({ fetchImpl: fetchImpl as unknown as typeof fetch, onConn: (s, again) => conns.push(`${s}:${again}`) })
    const ws = FakeWs.last()
    const p = a.snapshot()
    vi.advanceTimersByTime(OPEN_TIMEOUT_MS - 1)
    expect(ws.closedByClient).toBeNull()
    vi.advanceTimersByTime(1)
    expect(ws.closedByClient).not.toBeNull()
    expect(conns).toEqual(['reconnecting:false'])
    // 보내지 못한 call — '보냈는지 모름' 이 아니라 못 보냈다
    await expect(p).rejects.toThrow(PHONE_OFFLINE)
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    ws.open()
    expect(conns).toEqual(['reconnecting:false'])
    vi.advanceTimersByTime(RECONNECT_MS[0])
    expect(FakeWs.all).toHaveLength(2)
  })

  it('/api/me 가 답하지 않아도 8초 뒤 모름으로 치고 다시 잇는다(요청은 끊어 둔다)', async () => {
    let signal: AbortSignal | undefined
    const hang = vi.fn((_u: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {}) // 끊기 신호도 무시하는 fetch
    })
    const onUnpaired = vi.fn()
    make({ fetchImpl: hang as unknown as typeof fetch, onUnpaired })
    FakeWs.last().drop()
    await flush()
    expect(hang).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(false)
    vi.advanceTimersByTime(HTTP_TIMEOUT_MS)
    await flush()
    expect(signal?.aborted).toBe(true)
    vi.advanceTimersByTime(RECONNECT_MS[0])
    expect(FakeWs.all).toHaveLength(2)
    expect(onUnpaired).not.toHaveBeenCalled()
  })

  it('JSON 으로 못 바꾸는 인자 — 그 call 만 바로 거절(보내지 않음) · 열리기 전이어도 · 다른 call 은 그대로', async () => {
    const a = make()
    const ws = FakeWs.last()
    const loop: Record<string, unknown> = {}
    loop.self = loop
    // 열리기 전 — 열릴 때까지 기다리지 않고 바로
    await expect(a.updateAgent('a', loop as never)).rejects.toThrow(PHONE_BAD_ARGS)
    const ok = a.snapshot()
    ws.open()
    await expect(a.sendUser('a', [{ type: 'text', text: 1n as never }])).rejects.toThrow(PHONE_BAD_ARGS)
    expect(ws.calls().map(c => c.method)).toEqual(['snapshot'])
    ws.reply(ws.calls('snapshot')[0].id, snap())
    await expect(ok).resolves.toMatchObject({ rooms: [{ id: 'r1' }] })
  })


  it('PC 에서 끊기(4401) — 다시 잇지 않고 onUnpaired', async () => {
    const onUnpaired = vi.fn()
    const a = make({ onUnpaired })
    const ws = FakeWs.last()
    ws.open()
    const p = a.snapshot()
    ws.drop(PHONE_CLOSE_UNPAIRED)
    expect(onUnpaired).toHaveBeenCalledTimes(1)
    await expect(p).rejects.toThrow()
    vi.advanceTimersByTime(60_000)
    expect(FakeWs.all).toHaveLength(1)
  })

  it('열지 못하면 /api/me 를 본다 — 401 이면 onUnpaired, 아니면 1s→2s→5s→10s 로 다시', async () => {
    const onUnpaired = vi.fn()
    const fetchImpl = meFetch(200)
    make({ onUnpaired, fetchImpl: fetchImpl as unknown as typeof fetch })
    const waits: number[] = []
    for (let i = 0; i < 5; i++) {
      const n = FakeWs.all.length
      FakeWs.last().drop()
      await flush()
      let t = 0
      while (FakeWs.all.length === n && t < 20_000) {
        vi.advanceTimersByTime(500)
        t += 500
        await flush()
      }
      waits.push(t)
    }
    expect(waits).toEqual([1000, 2000, 5000, 10000, 10000])
    expect(fetchImpl).toHaveBeenCalled()
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe('https://pc.tail.ts.net/api/me')
    expect(onUnpaired).not.toHaveBeenCalled()

    // 짝이 끊긴 기기 — 업그레이드가 401 이라 브라우저는 1006 만 준다 → /api/me 로 안다
    api!.close()
    FakeWs.all = []
    const gone = vi.fn()
    make({ onUnpaired: gone, fetchImpl: meFetch(401) as unknown as typeof fetch })
    FakeWs.last().drop()
    await flush()
    expect(gone).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(FakeWs.all).toHaveLength(1)
  })

  it('이어진 뒤엔 다시 잇기 간격이 처음(1초)부터', async () => {
    make()
    FakeWs.last().drop()
    await flush()
    vi.advanceTimersByTime(1000)
    FakeWs.last().drop()
    await flush()
    vi.advanceTimersByTime(2000)
    FakeWs.last().open()
    FakeWs.last().drop()
    const n = FakeWs.all.length
    vi.advanceTimersByTime(999)
    expect(FakeWs.all).toHaveLength(n)
    vi.advanceTimersByTime(1)
    expect(FakeWs.all).toHaveLength(n + 1)
  })

  it('uploadFile — 100MB 넘으면 올리지 않음 · POST /api/upload?name= 답의 path·name·bytes', async () => {
    const fetchImpl = vi.fn(async (_u: unknown, _o?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, path: 'C:\\in\\ab-사진.png', name: '사진.png', bytes: 3 }), { status: 200 }))
    const a = make({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const big = new File(['x'], 'big.bin')
    Object.defineProperty(big, 'size', { value: ATTACH_MAX_BYTES + 1 })
    await expect(a.uploadFile(big)).rejects.toThrow(ATTACH_TOO_BIG)
    expect(fetchImpl).not.toHaveBeenCalled()

    const f = new File(['abc'], '사진.png')
    await expect(a.uploadFile(f)).resolves.toEqual({ path: 'C:\\in\\ab-사진.png', name: '사진.png', bytes: 3 })
    const [u, init] = fetchImpl.mock.calls[0]
    expect(String(u)).toBe(`https://pc.tail.ts.net/api/upload?name=${encodeURIComponent('사진.png')}`)
    expect(init).toMatchObject({ method: 'POST', body: f, credentials: 'same-origin' })

    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: '파일을 올리지 못했어요' }), { status: 500 }))
    await expect(a.uploadFile(f)).rejects.toThrow('파일을 올리지 못했어요')
    fetchImpl.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(a.uploadFile(f)).rejects.toThrow('파일을 올리지 못했어요')
  })

  it('JSON 꼴 — Infinity 는 큰 정수로(지난 대화 전부 보기) · 끝의 undefined 인자는 뺀다', async () => {
    const a = make()
    const ws = FakeWs.last()
    ws.open()
    void a.conversation('a', 'k', { limit: Infinity }).catch(() => {})
    void a.history('a', undefined).catch(() => {})
    expect(ws.calls('conversation')[0].args).toEqual(['a', 'k', { limit: Number.MAX_SAFE_INTEGER }])
    expect(ws.calls('history')[0].args).toEqual(['a'])
  })

  it('store.resync — 고른 에이전트 기록만 다시 받고 나머지는 잊는다 · 쉬는 에이전트의 생각·흐르던 글은 내린다 · 다시 받기 실패면 목록 그대로', async () => {
    const { createStore } = await import('../../src/renderer/state/store')
    const a = make()
    const ws = FakeWs.last()
    ws.open()
    const s = createStore(a)
    const init = s.init()
    await flush()
    ws.reply(ws.calls('snapshot')[0].id, snap({ agents: [agent('a', { status: 'working' }), agent('b', { status: 'working' })] }))
    await init
    const histOf = async (id: string, items: HistoryItem[]) => {
      await flush()
      const c = ws.calls('history').filter(x => x.args[0] === id).at(-1)!
      ws.reply(c.id, items)
      await flush()
    }
    s.selectAgent('b')
    await histOf('b', [note('b1')])
    s.selectAgent('a')
    await histOf('a', [note('a1')])
    ws.emit('agent-event', { agentId: 'b', event: { kind: 'thinking', active: true, tokens: null } })
    ws.emit('agent-event', { agentId: 'a', event: { kind: 'text-delta', text: '반쯤 온 글' } })
    expect(Object.keys(s.getState().history).sort()).toEqual(['a', 'b'])
    expect(s.getState().thinking.b).toEqual({ tokens: null })
    expect(s.getState().streaming.a).toBe('반쯤 온 글')

    const done = s.resync()
    await flush()
    ws.reply(ws.calls('snapshot').at(-1)!.id, snap({ agents: [agent('a', { status: 'working' }), agent('b', { status: 'idle' })] }))
    await flush()
    // 고른 a 만 다시 받는다 — 받는 동안 앞 목록 그대로
    expect(s.getState().history.a.map(i => (i.kind === 'notice' ? i.text : ''))).toEqual(['a1'])
    ws.fail(ws.calls('history').at(-1)!.id, '끊겼어요')
    await done
    expect(s.getState().history.a.map(i => (i.kind === 'notice' ? i.text : ''))).toEqual(['a1'])
    expect(s.getState().historyStatus.a).toEqual({ state: 'ready' })
    expect(s.getState().history.b).toBeUndefined()
    expect(s.getState().thinking.b).toBeUndefined()
    expect(s.getState().streaming).toEqual({})
  })

  it('store.resync — 고르지 않은 에이전트의 끝남 표시·마지막 글: 다시 일하면 끝남을 내리고, 새 대화면 둘 다 내리고, 없어진 에이전트는 잊는다', async () => {
    const { createStore } = await import('../../src/renderer/state/store')
    const a = make()
    const ws = FakeWs.last()
    ws.open()
    const s = createStore(a, { hasFocus: () => true })
    const init = s.init()
    await flush()
    const ids = ['a', 'b', 'c', 'd', 'e']
    ws.reply(ws.calls('snapshot')[0].id, snap({ agents: ids.map(id => agent(id)) }))
    await init
    s.selectAgent('a')
    await flush()
    ws.reply(ws.calls('history').at(-1)!.id, [])
    await flush()
    for (const [i, id] of ['b', 'c', 'd', 'e'].entries()) {
      ws.emit('history', { agentId: id, item: { t: 10 + i, kind: 'assistant', blocks: [{ type: 'text', text: `${id} 끝` }] } })
      ws.emit('history', { agentId: id, item: { t: 20 + i, kind: 'result', ok: true, subtype: 'success' } })
    }
    expect(Object.keys(s.getState().fresh).sort()).toEqual(['b', 'c', 'd', 'e'])
    expect(Object.keys(s.getState().lastText).sort()).toEqual(['b', 'c', 'd', 'e'])

    // 끊긴 사이 — b 는 다시 일을 시작했고, c 는 새 대화를 시작했고(지난 대화 수 +1), d 는 지워졌다. e 는 그대로
    const done = s.resync()
    await flush()
    ws.reply(ws.calls('snapshot').at(-1)!.id, snap({ agents: [agent('a'), agent('b', { status: 'working' }), agent('c', { pastCount: 1 }), agent('e')] }))
    await flush()
    ws.reply(ws.calls('history').at(-1)!.id, [])
    await done
    const st = s.getState()
    expect(Object.keys(st.fresh).sort()).toEqual(['e'])
    expect(Object.keys(st.lastText).sort()).toEqual(['b', 'e'])
    expect(st.lastText.e).toEqual({ text: 'e 끝', at: 13 })
    expect(st.fresh.e).toBe(23)
  })

  it('close — 소켓을 닫고 다시 잇지 않음', async () => {
    const a = make()
    const ws = FakeWs.last()
    ws.open()
    a.close()
    expect(ws.closedByClient).toBe(1000)
    ws.drop(1000)
    vi.advanceTimersByTime(60_000)
    expect(FakeWs.all).toHaveLength(1)
  })
})
