import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, waitFor } from '@testing-library/react'
import { animate } from 'animejs'
import type { EngineEventMap, PendingRequest, RelayMessage } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import { allowMotion, fastMotion } from './motion'

vi.mock('animejs', async orig => {
  const m = await orig<typeof import('animejs')>()
  return { ...m, animate: vi.fn(m.animate) }
})

const agent = (id: string): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, heldInput: 0,
})
const perm = (id: string, agentId = 'w'): PendingRequest => ({
  id, agentId, toolName: 'Edit', input: { file_path: 'C:\w\a.css' }, kind: 'permission', createdAt: Date.now(),
})
const ask = (id: string, agentId = 'w'): PendingRequest => ({
  id, agentId, toolName: 'AskUserQuestion', kind: 'question', createdAt: Date.now(),
  input: { questions: [{ question: '색은?', header: '색', options: [{ label: '파랑', description: '' }], multiSelect: false }] },
})

const relay = (state: RelayMessage['state'], updatedAt = 10): RelayMessage => ({
  id: 'm1', roomId: 'r1', from: 'p', to: 'w', text: '긴 본문\n\n'.repeat(6), createdAt: 5, state, updatedAt,
})

/**
 * 고정 카드 자리의 배치 흉내 — jsdom 은 배치를 하지 않아 scrollHeight·clientHeight 가 늘 0 이다.
 * 브라우저에서처럼: 카드는 한 장에 100px(offsetTop 은 앞 카드들 높이), .pnl-pins 는 카드 + 아래 여백
 * (base.css — 평소 2px · .more 16px)만큼 크되 max(60% 상한 흉내)를 넘지 않는다. 들어오는 중인 맨 아래 카드는
 * transform(translateY)만큼 아래로 삐져나와 scrollHeight 에는 들지만 배치(offset*)는 그대로다.
 */
function fakePinsLayout(max = Infinity): () => void {
  const style = document.createElement('style')
  style.textContent = '.pnl-pins { padding-bottom: 2px } .pnl-pins.more { padding-bottom: 16px }'
  document.head.appendChild(style)
  const cards = (el: Element) => Array.from(el.children) as HTMLElement[]
  const pad = (el: Element) => parseFloat(getComputedStyle(el).paddingBottom) || 0
  const stickOut = (el: HTMLElement | undefined) => {
    const m = el && /translateY\((-?[\d.]+)px\)/.exec(el.style.transform)
    return m ? Math.max(0, parseFloat(m[1])) : 0
  }
  const defs: Record<string, (this: HTMLElement) => number> = {
    offsetHeight() {
      return this.classList.contains('pin') ? 100 : 0
    },
    offsetTop() {
      return this.classList.contains('pin') && this.parentElement ? cards(this.parentElement).indexOf(this) * 100 : 0
    },
    clientHeight() {
      return this.classList.contains('pnl-pins') ? Math.min(max, cards(this).length * 100 + pad(this)) : 0
    },
    scrollHeight() {
      if (!this.classList.contains('pnl-pins')) return 0
      const list = cards(this)
      return Math.max(this.clientHeight, list.length * 100 + Math.max(pad(this), stickOut(list.at(-1))))
    },
  }
  const proto = HTMLElement.prototype
  const saved = Object.keys(defs).map(k => [k, Object.getOwnPropertyDescriptor(proto, k)] as const)
  for (const [k, get] of Object.entries(defs)) Object.defineProperty(proto, k, { configurable: true, get })
  return () => {
    style.remove()
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d)
      else delete (proto as any)[k]
    }
  }
}

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
const answerRequest = vi.fn(async () => {})
const approveMessage = vi.fn(async () => {})
const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

beforeEach(() => {
  vi.resetModules()
  answerRequest.mockClear()
  approveMessage.mockClear()
  handlers = {}
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '방', createdAt: 1 }],
    agents: [agent('w'), agent('p')],
    messages: [], requests: [], autoChainLimit: 3, usage: null,
  }
  ;(window as any).dure = {
    snapshot: async () => snapshot,
    history: async () => [],
    describe: async () => ({ commands: [], models: [], permissionMode: 'default' }),
    answerRequest,
    approveMessage,
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
  }
})
afterEach(() => {
  cleanup()
  vi.mocked(animate).mockClear()
})

async function renderPanel() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentPanel } = await import('../../src/renderer/panel/AgentPanel')
  await act(async () => { await getStore().init() })
  render(<AgentPanel />)
  await act(async () => { getStore().selectAgent('w') })
  await settle()
  return getStore()
}
const pins = () => document.querySelector('.pnl-pins') as HTMLElement
const pinCalls = () => vi.mocked(animate).mock.calls.filter(c => (c[0] as HTMLElement).classList?.contains('pin'))

describe('위에 붙는 카드 움직임', () => {
  it('패널을 열 때 이미 있던 카드는 움직이지 않는다', async () => {
    allowMotion()
    snapshot.requests = [perm('a'), ask('b')]
    await renderPanel()
    expect(pins().querySelectorAll('.pin')).toHaveLength(2)
    expect(pinCalls()).toHaveLength(0)
  })

  it('보는 동안 승인 요청이 오면 그 카드가 260ms 로 들어온다', async () => {
    allowMotion()
    await renderPanel()
    await emit('request', perm('a'))
    const calls = pinCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(pins().querySelector('.pin'))
    const p = calls[0][1] as any
    expect(p.opacity.from).toBe(0)
    expect(p.translateY.from).toBe(12)
    expect(p.scale.from).toBe(0.98)
    expect(p.duration).toBe(260)
    expect(p.ease).toBe('outQuint')
  })

  it('허락·거절로 요청이 사라지면 카드는 마지막 내용 그대로 150ms 남아 inert, 그 뒤 사라진다', async () => {
    allowMotion()
    const restore = fastMotion(50)
    snapshot.requests = [perm('a')]
    await renderPanel()
    const before = pins().querySelector('.pin')!.textContent
    vi.mocked(animate).mockClear()
    await emit('request-resolved', { id: 'a', agentId: 'w' })
    const el = pins().querySelector('.pin') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.textContent).toBe(before)
    expect(el.hasAttribute('inert')).toBe(true)
    const p = pinCalls().at(-1)![1] as any
    expect(p.translateY).toBe(-6)
    expect(p.opacity).toBe(0)
    expect(p.scale).toBe(0.98)
    expect(p.duration).toBe(150)
    expect(p.ease).toBe('outCubic')
    await waitFor(() => expect(pins().querySelector('.pin')).toBeNull(), { timeout: 1500 })
    restore()
  })

  it('하나가 나가는 동안 새 질문 카드가 오면 둘 다 있고 새 카드는 눌린다', async () => {
    allowMotion()
    snapshot.requests = [perm('a')]
    await renderPanel()
    await emit('request-resolved', { id: 'a', agentId: 'w' })
    await emit('request', ask('b'))
    const cards = pins().querySelectorAll('.pin')
    expect(cards).toHaveLength(2)
    const [old, fresh] = Array.from(cards) as HTMLElement[]
    expect(old.hasAttribute('inert')).toBe(true)
    expect(fresh.hasAttribute('inert')).toBe(false)
    expect(fresh.style.pointerEvents).toBe('')
    expect(screen.getByRole('button', { name: '대답 안 함' })).toBeTruthy()
  })

  it('에이전트를 바꾸면 새 에이전트의 카드는 들어오지 않고 옛 카드도 남지 않는다', async () => {
    allowMotion()
    snapshot.requests = [perm('a', 'w'), ask('b', 'p')]
    const store = await renderPanel()
    vi.mocked(animate).mockClear()
    await act(async () => { store.selectAgent('p') })
    await settle()
    expect(pins().querySelectorAll('.pin')).toHaveLength(1)
    expect(pins().querySelector('.pin')!.getAttribute('aria-label')).toBe('질문이 있어요')
    expect(pinCalls()).toHaveLength(0)
  })

  it('움직임 줄이기면 animate 를 부르지 않고 바로 사라진다', async () => {
    await renderPanel()
    await emit('request', perm('a'))
    expect(animate).not.toHaveBeenCalled()
    await emit('request-resolved', { id: 'a', agentId: 'w' })
    expect(pins().querySelector('.pin')).toBeNull()
  })
})

describe('고정 카드 자리 — 넘침 표시(.more)와 들어오는 카드', () => {
  let restoreLayout = () => {}
  afterEach(() => {
    restoreLayout()
    restoreLayout = () => {}
  })

  it('보는 동안 카드가 맨 아래로 들어와도 넘침 표시가 오가며 멈추지 않는다 — 들어오며 비켜 선 자리(transform)는 넘침이 아니다', async () => {
    allowMotion()
    restoreLayout = fakePinsLayout()
    await renderPanel()
    expect(pins().classList.contains('more')).toBe(false) // 카드가 없으면 넘칠 것도 없다
    await emit('request', perm('a'))
    const card = pins().querySelector('.pin') as HTMLElement
    // 들어오는 중 — 아래로 비켜 있어 scrollHeight 로만 재면 넘친다
    expect(card.style.transform).toContain('translateY(12px)')
    expect(pins().classList.contains('more')).toBe(false)
    expect(card.hasAttribute('inert')).toBe(false)
  })

  it('일 시키기로 전달되면 같은 카드가 그 자리에 남는다 — 나갔다 다시 들어오지 않고 넘침 표시도 오가지 않는다', async () => {
    allowMotion()
    restoreLayout = fakePinsLayout()
    snapshot.messages = [relay('pending')]
    await renderPanel()
    const card = pins().querySelector('.pin') as HTMLElement
    expect(card.textContent).toContain('확인 대기')
    vi.mocked(animate).mockClear()

    await act(async () => screen.getByRole('button', { name: '일 시키기' }).click())
    expect(approveMessage).toHaveBeenCalledWith('m1')
    // 엔진 차례 그대로 — queued → 받는 쪽 기록에 넘김 줄 · 작업 중 → delivered
    await emit('message', relay('queued', 11))
    await emit('history', { agentId: 'w', item: { t: 12, kind: 'user', source: 'relay', messageId: 'm1', parts: [{ type: 'text', text: '긴 본문' }] } })
    await emit('status', { agentId: 'w', status: 'working', errorText: null })
    await emit('message', relay('delivered', 13))

    const now = pins().querySelectorAll('.pin')
    expect(now).toHaveLength(1)
    expect(now[0]).toBe(card)
    expect(card.hasAttribute('inert')).toBe(false)
    expect(card.textContent).toContain('전달됨')
    expect(pinCalls()).toHaveLength(0)
    expect(pins().classList.contains('more')).toBe(false)
  })

  it('카드가 정말 칸(60% 상한)보다 많으면 넘침 표시가 붙고, 줄면 떨어진다', async () => {
    allowMotion()
    restoreLayout = fakePinsLayout(150)
    snapshot.requests = [perm('a'), ask('b')]
    await renderPanel()
    expect(pins().classList.contains('more')).toBe(true)
    await emit('request-resolved', { id: 'a', agentId: 'w' })
    await waitFor(() => expect(pins().querySelectorAll('.pin')).toHaveLength(1), { timeout: 1500 })
    await emit('status', { agentId: 'w', status: 'idle', errorText: null }) // 다시 그리기
    expect(pins().classList.contains('more')).toBe(false)
  })
})
