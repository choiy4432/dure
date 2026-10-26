import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { HistoryItem, RelayMessage } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, hold: null, subagentsRunning: [], ...over,
})
const NOW = Date.now()
const msg = (id: string, from: string, to: string, state: RelayMessage['state'], ago: number, text: string): RelayMessage => ({
  id, roomId: 'r1', from, to, text, createdAt: NOW - ago, updatedAt: NOW - ago + 1, state,
})
// 웹(w) 기준 — 받은 것 셋 · 보낸 것 하나
const MESSAGES = [
  msg('m4', 'd', 'w', 'dismissed', 3_600_000, '쿠폰 칸 시안 올렸어요.'),
  msg('m3', 'w', 's', 'delivered', 720_000, '쿠폰 확인 API 가 필요해요.'),
  msg('m2', 's', 'w', 'delivered', 480_000, '## 쿠폰 API\n만들었어요. 장바구니에 붙여 주세요.'),
  msg('m1', 'p', 'w', 'pending', 1_000, "로그인 문구를 '이메일로 계속하기'로 바꿔 주세요."),
]
const HISTORY: HistoryItem[] = [
  { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '장바구니 손봐 줘' }] },
  { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '했어요.' }] },
  { t: 3, kind: 'user', source: 'relay', messageId: 'm2', parts: [{ type: 'text', text: '[두레 메시지 — 보낸 쪽: 서버(API)]\n## 쿠폰 API\n만들었어요.' }] },
  { t: 4, kind: 'assistant', blocks: [{ type: 'text', text: '붙였어요.' }] },
]

let snapshot: Snapshot
const approveMessage = vi.fn(async (_id: string) => {})

beforeEach(() => {
  vi.resetModules()
  approveMessage.mockClear()
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '쇼핑몰', createdAt: 1 }],
    agents: [agent('w', { name: '웹' }), agent('p', { name: '기획' }), agent('s', { name: '서버' }), agent('d', { name: '디자인' })],
    messages: MESSAGES, requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, usage: null,
  }
  ;(window as any).dure = {
    snapshot: async () => snapshot,
    history: async (id: string) => (id === 'w' ? HISTORY : []),
    describe: async () => ({ commands: [], models: [], permissionMode: 'default' }),
    sendUser: async () => {},
    approveMessage,
    on: () => () => {},
  }
})
afterEach(() => cleanup())

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function renderPanel(select = 'w') {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentPanel } = await import('../../src/renderer/panel/AgentPanel')
  await act(async () => { await getStore().init() })
  const r = render(<AgentPanel />)
  await act(async () => { getStore().selectAgent(select) })
  await settle()
  return { ...r, store: getStore() }
}
const msgTab = () => screen.getByRole('tab', { name: /메시지/ })
const rows = () => within(screen.getByRole('region', { name: '메시지' })).getAllByRole('listitem')

describe('메시지 탭', () => {
  it('주고받은 메시지가 있으면 [대화 | 메시지 N] — 받은 것에 내 확인이 필요하면 주황 점', async () => {
    await renderPanel()
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['대화', expect.stringMatching(/^메시지 4/)])
    expect(within(msgTab()).getByRole('img', { name: '내 확인 필요' })).toBeInTheDocument()
  })

  it('주고받은 메시지가 없으면 탭이 없다', async () => {
    snapshot.messages = []
    await renderPanel()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('새것부터 한 줄씩 — 내 확인 필요는 펼친 채 [일 시키기], 나중에는 접기', async () => {
    await renderPanel()
    fireEvent.click(msgTab())
    const list = rows()
    expect(list).toHaveLength(4)
    const heads = list.map(li => li.querySelector('.mrow-tg')!)
    expect(heads[0]).toHaveAccessibleName("기획이 웹에게 보낸 메시지")
    expect(heads[1]).toHaveAccessibleName('서버가 웹에게 보낸 메시지 — 쿠폰 API')
    expect(heads[2]).toHaveAccessibleName('웹이 서버에게 보낸 메시지 — 쿠폰 확인 API 가 필요해요.')
    expect(heads[0]).toHaveAttribute('aria-expanded', 'true')
    expect(list[0]).toHaveClass('wait')
    expect(list[3]).toHaveClass('gone')
    fireEvent.click(within(list[0]).getByRole('button', { name: '일 시키기' }))
    expect(approveMessage).toHaveBeenCalledWith('m1')
    fireEvent.click(within(list[0]).getByRole('button', { name: '나중에' }))
    expect(heads[0]).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(heads[1])
    expect(heads[1]).toHaveAttribute('aria-expanded', 'true')
    expect(within(list[1]).getByText('쿠폰 API')).toBeInTheDocument()
  })

  it('메시지는 어느 탭에서도 위에 고정하지 않는다 · 메시지 탭에선 입력창을 숨긴다', async () => {
    const { container } = await renderPanel()
    expect(container.querySelectorAll('.pin.msg')).toHaveLength(0)
    fireEvent.click(msgTab())
    await settle()
    expect(container.querySelectorAll('.pin.msg')).toHaveLength(0)
    expect(container.querySelector('.pnl-cmp')).not.toBeVisible()
  })

  it("받은 메시지의 '대화에서 보기' — 대화 탭으로 가서 그 메시지 줄로, 초점도 그 줄로", async () => {
    const { store } = await renderPanel()
    fireEvent.click(msgTab())
    const delivered = rows()[1]
    fireEvent.click(delivered.querySelector('.mrow-tg')!)
    fireEvent.click(within(delivered).getByRole('button', { name: '대화에서 보기' }))
    await settle()
    expect(store.getState().panelTab.w).toBe('chat')
    expect(document.activeElement).toHaveAttribute('data-msg', 'm2')
    expect(store.getState().messageFocus).toBeNull()
  })

  it("보낸 메시지의 '서버 대화에서 보기' — 받은 에이전트를 고른다", async () => {
    const { store } = await renderPanel()
    fireEvent.click(msgTab())
    const sent = rows()[2]
    fireEvent.click(sent.querySelector('.mrow-tg')!)
    fireEvent.click(within(sent).getByRole('button', { name: '서버 대화에서 보기' }))
    await settle()
    expect(store.getState().selectedAgentId).toBe('s')
  })
})
