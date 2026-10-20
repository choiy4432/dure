import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import type { RelayMessage } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:/w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null, status: 'idle', errorText: null, bypass: false, heldInput: 0, ...over,
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
    agents: [], messages: [], requests: [], autoChainLimit: 3,
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
    fireEvent.click(chip('승인 기다림 1'))
    expect(store.getState().selectedAgentId).toBe('d')
    fireEvent.click(chip('받은 메시지 1'))
    expect(store.getState().selectedAgentId).toBe('s')
    fireEvent.click(chip('작업 중 1'))
    expect(store.getState().selectedAgentId).toBe('w')
  })

  it('수가 0 인 칩은 누를 수 없다', async () => {
    snapshot.agents = [agent('a', { pos: { x: 64, y: 64 } })]
    await renderMap()
    expect((screen.getByRole('button', { name: '승인 기다림 0' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('수가 0 인 칩은 뒤로 물러난다(조용한 칩 — 흐린 점·수), 0 이 아닌 칩은 제 색 그대로', async () => {
    snapshot.agents = [agent('w', { status: 'working', pos: { x: 64, y: 64 } }), agent('s', { pos: { x: 500, y: 64 } })]
    snapshot.messages = [msg('m1', 'w', 's', 'pending', 5)]
    await renderMap()
    const chip = (name: string) => screen.getByRole('button', { name })
    expect(chip('승인 기다림 0').classList.contains('zero')).toBe(true)
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
    expect(rows[0].querySelector('.pm-h')!.textContent).toBe('웹 화면기획· 확인 대기 · 방금')
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
