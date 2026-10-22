import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import type { RelayMessage } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:/w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, subagentsRunning: [], ...over,
})
const msg = (id: string, from: string, to: string, state: RelayMessage['state'], createdAt: number, text = '본문'): RelayMessage => ({
  id, roomId: 'r1', from, to, text, createdAt, state, updatedAt: createdAt,
})

let snapshot: Snapshot
let updateAgent: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.resetModules()
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }, { id: 'r2', name: '다른 방', createdAt: 2 }],
    agents: [], messages: [], requests: [], autoChainLimit: 3, allowBypass: false, usage: null,
  }
  // 엔진처럼 — 자리를 저장하면 다음 스냅샷에 그 자리가 들어 있다
  updateAgent = vi.fn(async (id: string, p: { pos?: { x: number; y: number } }) => {
    snapshot = { ...snapshot, agents: snapshot.agents.map(a => (a.id === id && p.pos ? { ...a, pos: p.pos } : a)) }
    return snapshot.agents.find(a => a.id === id)
  })
  ;(window as any).dure = { snapshot: async () => snapshot, history: async () => [], on: () => () => {}, updateAgent }
})
afterEach(() => cleanup())

async function renderMap() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { RelationMap } = await import('../../src/renderer/map/RelationMap')
  await act(async () => { await getStore().init() })
  const r = render(<RelationMap />)
  return { ...r, store: getStore() }
}

describe('RelationMap — 자리', () => {
  it('자리 없는 에이전트 12개(긴 이름·역할)는 서로·이미 놓인 카드와 겹치지 않는 자리를 받아 저장된다', async () => {
    const W = 256
    const H = 136
    const longRole = '보도자료·뉴스레터·소셜 문구·광고 카피 작성 담당'
    snapshot.agents = [
      agent('placed', { pos: { x: 64, y: 64 } }),
      ...Array.from({ length: 12 }, (_, i) => agent(`n${i}`, { name: `아주 긴 이름의 에이전트 ${i}번`, role: longRole })),
      agent('other', { roomId: 'r2' }),
    ]
    const { store } = await renderMap()
    await vi.waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(12))
    const saved = updateAgent.mock.calls.map(([id, p]) => ({ id: id as string, ...(p.pos as { x: number; y: number }) }))
    expect(saved.map(s => s.id).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `n${i}`).sort())
    const all = [{ id: 'placed', x: 64, y: 64 }, ...saved]
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]
        const b = all[j]
        const overlap = a.x < b.x + W && b.x < a.x + W && a.y < b.y + H && b.y < a.y + H
        expect(overlap).toBe(false)
      }
    // 저장이 스토어로 돌아온 뒤엔 다시 저장하지 않는다
    await vi.waitFor(() => expect(store.getState().agents.every(a => a.id === 'other' || a.pos.x !== 0)).toBe(true))
    await act(async () => { await store.refresh() })
    expect(updateAgent).toHaveBeenCalledTimes(12)
  })

  it('이미 자리가 있으면 저장하지 않는다', async () => {
    snapshot.agents = [agent('a', { pos: { x: 300, y: 80 } })]
    await renderMap()
    await act(async () => {})
    expect(updateAgent).not.toHaveBeenCalled()
  })
})

describe('RelationMap — 에이전트가 만든 새 에이전트의 자리', () => {
  it('agent-added 로 온 새 에이전트는 만든 카드 가까운 빈 칸(바로 아래)에 놓여 저장된다 — 첫 빈 칸이 아니라', async () => {
    const handlers: Record<string, ((p: any) => void)[]> = {}
    ;(window as any).dure.on = (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    }
    const q = { x: 64 + 256 + 104, y: 64 }
    snapshot.agents = [agent('p', { pos: { x: 64, y: 64 } }), agent('q', { pos: q })]
    await renderMap()
    const n = agent('n')
    snapshot = { ...snapshot, agents: [...snapshot.agents, n] }
    await act(async () => { (handlers['agent-added'] ?? []).forEach(f => f({ agent: n, by: 'q' })) })
    await vi.waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1))
    // q 바로 아래 칸(세로 칸 사이 = 가장 큰 카드 217 + 64) — 첫 빈 칸이었다면 첫 줄 셋째 칸 {784, 64}
    expect(updateAgent).toHaveBeenCalledWith('n', { pos: { x: q.x, y: q.y + 217 + 64 } })
  })

  it('만든 쪽을 모르면(사건을 놓친 새 에이전트) 지금처럼 첫 빈 칸', async () => {
    snapshot.agents = [agent('p', { pos: { x: 64, y: 64 } }), agent('q', { pos: { x: 424, y: 64 } }), agent('n')]
    await renderMap()
    await vi.waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1))
    expect(updateAgent).toHaveBeenCalledWith('n', { pos: { x: 784, y: 64 } })
  })
})

describe('RelationMap — 요약 칩', () => {
  it('세 칩의 수, 누르면 그 상태의 첫 에이전트를 고른다 · 0 이면 못 누른다', async () => {
    snapshot.agents = [
      agent('w', { name: '웹 화면', status: 'working', pos: { x: 400, y: 200 } }),
      agent('d', { name: '디자인', pos: { x: 64, y: 400 } }),
      agent('s', { name: '서버', pos: { x: 500, y: 500 } }),
    ]
    snapshot.requests = [{ id: 'q1', agentId: 'd', toolName: 'Write', input: {}, kind: 'permission', createdAt: 1 }]
    snapshot.messages = [msg('m1', 'w', 's', 'pending', 5)]
    const { store } = await renderMap()
    const chip = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
    expect(chip('작업 중 1')).toBeTruthy()
    fireEvent.click(chip('내 승인 필요 1'))
    expect(store.getState().selectedAgentId).toBe('d')
    fireEvent.click(chip('받은 메시지 1'))
    expect(store.getState().selectedAgentId).toBe('s')
    fireEvent.click(chip('작업 중 1'))
    expect(store.getState().selectedAgentId).toBe('w')
  })

  it('새 결과 칩 — 수, 0 이면 물러남', async () => {
    const handlers: Record<string, ((p: any) => void)[]> = {}
    ;(window as any).dure.on = (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    }
    snapshot.agents = [agent('a', { pos: { x: 64, y: 64 } }), agent('b', { pos: { x: 500, y: 64 } })]
    const { store } = await renderMap()
    const zero = screen.getByRole('button', { name: '새 결과 0' }) as HTMLButtonElement
    expect(zero.disabled).toBe(true)
    expect(zero.classList.contains('zero')).toBe(true)
    await act(async () => { (handlers['history'] ?? []).forEach(f => f({ agentId: 'b', item: { kind: 'result', t: 5 } })) })
    expect(store.getState().fresh.b).toBe(5)
    const one = screen.getByRole('button', { name: '새 결과 1' }) as HTMLButtonElement
    expect(one.disabled).toBe(false)
    expect(one.classList.contains('zero')).toBe(false)
    expect(one.querySelector('.dot.n')).toBeTruthy()
    fireEvent.click(one)
    expect(store.getState().selectedAgentId).toBe('b')
  })

  it('같은 칩을 두 번 누르면 그 상태의 다음 에이전트로', async () => {
    snapshot.agents = [
      agent('w1', { status: 'working', pos: { x: 64, y: 64 } }),
      agent('w2', { status: 'working', pos: { x: 500, y: 64 } }),
    ]
    const { store } = await renderMap()
    const chip = () => screen.getByRole('button', { name: '작업 중 2' })
    fireEvent.click(chip())
    expect(store.getState().selectedAgentId).toBe('w1')
    fireEvent.click(chip())
    expect(store.getState().selectedAgentId).toBe('w2')
    fireEvent.click(chip())
    expect(store.getState().selectedAgentId).toBe('w1')
  })

  it('수가 0 인 칩은 누를 수 없다', async () => {
    snapshot.agents = [agent('a', { pos: { x: 64, y: 64 } })]
    await renderMap()
    expect((screen.getByRole('button', { name: '내 승인 필요 0' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('수가 0 인 칩은 뒤로 물러난다(조용한 칩 — 흐린 점·수), 0 이 아닌 칩은 제 색 그대로', async () => {
    snapshot.agents = [agent('w', { status: 'working', pos: { x: 64, y: 64 } }), agent('s', { pos: { x: 500, y: 64 } })]
    snapshot.messages = [msg('m1', 'w', 's', 'pending', 5)]
    await renderMap()
    const chip = (name: string) => screen.getByRole('button', { name })
    expect(chip('내 승인 필요 0').classList.contains('zero')).toBe(true)
    expect(chip('작업 중 1').classList.contains('zero')).toBe(false)
    expect(chip('받은 메시지 1').classList.contains('zero')).toBe(false)
  })
})

describe('RelationMap — 확대 조절', () => {
  it('축소 · 100% · 확대 · 모두 보기', async () => {
    snapshot.agents = [agent('a', { pos: { x: 64, y: 64 } })]
    await renderMap()
    const zc = screen.getByRole('group', { name: '확대 조절' })
    expect(zc.textContent).toContain('100%')
    for (const name of ['축소', '확대', '모두 보기']) expect(screen.getByRole('button', { name })).toBeTruthy()
  })
})

describe('RelationMap — 자리 정리', () => {
  it('자리 정리를 누르면 읽는 순서대로 격자 자리를 저장한다', async () => {
    // jsdom 은 너비가 0 이라 columnsFor 가 2 칸을 돌려준다
    snapshot.agents = [
      agent('c', { pos: { x: 900, y: 300 } }),
      agent('a', { pos: { x: 100, y: 40 } }),
      agent('b', { pos: { x: 500, y: 60 } }),
    ]
    await renderMap()
    await act(async () => {})
    expect(updateAgent).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '자리 정리' })) })
    await vi.waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(3))
    expect(updateAgent).toHaveBeenCalledWith('a', { pos: { x: 64, y: 64 } })
    expect(updateAgent).toHaveBeenCalledWith('b', { pos: { x: 64 + 256 + 104, y: 64 } })
    expect(updateAgent).toHaveBeenCalledWith('c', { pos: { x: 64, y: 64 + 217 + 64 } })
  })
})

describe('RelationMap — 고르기 풀기', () => {
  const pick = async () => {
    snapshot.agents = [agent('a', { pos: { x: 100, y: 40 } })]
    const r = await renderMap()
    act(() => r.store.selectAgent('a'))
    expect(r.store.getState().selectedAgentId).toBe('a')
    return r
  }
  it('빈 곳을 누르면 고르기를 푼다', async () => {
    const { store, container } = await pick()
    fireEvent.click(container.querySelector('.react-flow__pane')!)
    expect(store.getState().selectedAgentId).toBeNull()
  })
  it('Esc — 초점이 바탕이면 풀고, 입력창이면 그대로', async () => {
    const { store } = await pick()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(store.getState().selectedAgentId).toBe('a')
    input.remove()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(store.getState().selectedAgentId).toBeNull()
  })
})

describe('PairPopover', () => {
  async function renderPopover(onClose = vi.fn()) {
    snapshot.agents = [agent('a', { name: '기획', pos: { x: 64, y: 64 } }), agent('b', { name: '웹 화면', pos: { x: 400, y: 64 } })]
    snapshot.messages = [
      msg('m1', 'a', 'b', 'delivered', Date.now() - 5 * 60_000, '첫 메시지'),
      msg('m2', 'b', 'a', 'pending', Date.now() - 1_000, '답장'),
      msg('m3', 'a', 'b', 'dismissed', Date.now() - 2 * 60_000, '버린 메시지'),
    ]
    const { getStore } = await import('../../src/renderer/state/store')
    const { PairPopover } = await import('../../src/renderer/map/RelationMap')
    await act(async () => { await getStore().init() })
    const bounds = { current: document.createElement('div') }
    render(
      <div>
        <p>바깥</p>
        <PairPopover at={{ a: 'a', b: 'b', x: 10, y: 10 }} bounds={bounds} onClose={onClose} />
      </div>,
    )
    return { onClose, dialog: screen.getByRole('dialog', { name: '기획 · 웹 화면 사이에 오간 메시지' }) }
  }

  it('양방향 최신 먼저 — 줄마다 보낸 → 받은 · 상태 · 시각 + 본문, 버린 것은 흐리게', async () => {
    const { dialog } = await renderPopover()
    expect(dialog.textContent).toContain('메시지 3개')
    const rows = [...dialog.querySelectorAll('li')]
    expect(rows.map(r => r.querySelector('.pm-t')!.textContent)).toEqual(['답장', '버린 메시지', '첫 메시지'])
    expect(rows[0].querySelector('.pm-h')!.textContent).toBe('웹 화면기획· 내 확인 필요 · 방금')
    expect(rows[1].querySelector('.pm-m')!.textContent).toBe('· 버림 · 2분 전')
    expect(rows[1].classList.contains('off')).toBe(true)
    expect(rows[0].classList.contains('off')).toBe(false)
    expect(rows[2].querySelector('.pm-m')!.textContent).toBe('· 전달됨 · 5분 전')
  })

  it('Esc · 바깥 누르기로 닫히고, 창 안을 누르면 그대로', async () => {
    const { onClose, dialog } = await renderPopover()
    fireEvent.pointerDown(dialog)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(screen.getByText('바깥'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
