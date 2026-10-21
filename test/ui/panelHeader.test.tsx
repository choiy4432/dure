import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { AgentDescription, PendingRequest } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, heldInput: 0, ...over,
})
const request = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  id: 'q1', agentId: 'w', toolName: 'Write', input: { file_path: 'C:\\w\\a.ts' }, kind: 'permission',
  createdAt: Date.now(), ...over,
})
// Claude 가 주는 그대로(영어) — 화면엔 값으로 고른 한국어만 보여야 한다
const DESC: AgentDescription = {
  commands: [],
  permissionMode: 'default',
  models: [
    { value: 'default', displayName: 'Default (recommended)', description: 'Use the default model' },
    { value: 'opus', displayName: 'Opus', description: 'Most capable for complex work' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Best for everyday tasks' },
    { value: 'gpt-x', displayName: 'Custom Model', description: 'Some English text' },
  ],
}

let snapshot: Snapshot
let api: Record<'describe' | 'setModel' | 'updateAgent' | 'removeAgent' | 'newConversation' | 'interrupt' | 'openFolder', ReturnType<typeof vi.fn>>

// 엔진처럼 — 바꾼 값은 다음 스냅샷에 들어 있다(엔진은 에이전트 바뀜 이벤트를 보내지 않는다)
const patch = (id: string, p: Partial<AgentView>) => {
  snapshot = { ...snapshot, agents: snapshot.agents.map(a => (a.id === id ? { ...a, ...p } : a)) }
}

beforeEach(() => {
  vi.resetModules()
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }],
    agents: [agent('w', { name: '웹 화면', role: '화면 구현' }), agent('p', { name: '기획', role: '기획서 · 문구' })],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, usage: null,
  }
  api = {
    describe: vi.fn(async (_id: string) => DESC),
    setModel: vi.fn(async (id: string, model: string | null) => patch(id, { model })),
    updateAgent: vi.fn(async (id: string, p: Partial<AgentView>) => {
      const name = p.name?.trim()
      if (name !== undefined && snapshot.agents.some(a => a.id !== id && a.name === name)) {
        throw new Error(`이미 있는 이름입니다: ${name}`)
      }
      patch(id, p)
      return snapshot.agents.find(a => a.id === id)
    }),
    removeAgent: vi.fn(async (id: string) => {
      snapshot = { ...snapshot, agents: snapshot.agents.filter(a => a.id !== id) }
    }),
    newConversation: vi.fn(async (_id: string) => {}),
    interrupt: vi.fn(async (_id: string) => {}),
    openFolder: vi.fn(async (_path: string) => {}),
  }
  ;(window as any).dure = { ...api, snapshot: async () => snapshot, history: async () => [], on: () => () => {} }
})
afterEach(() => cleanup())

/** 기다리던 약속(describe·refresh 등)이 다 풀리게 */
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

async function renderPanel(select: string | null = 'w') {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentPanel } = await import('../../src/renderer/panel/AgentPanel')
  await act(async () => { await getStore().init() })
  const r = render(<AgentPanel />)
  if (select) await act(async () => { getStore().selectAgent(select) })
  await settle()
  return { ...r, store: getStore() }
}

const stopButton = () => screen.getByRole('button', { name: '멈추기' }) as HTMLButtonElement
const modelChip = () => screen.getByRole('button', { name: /^모델/ }) as HTMLButtonElement

describe('AgentPanel — 고른 에이전트가 없을 때', () => {
  it('조용한 안내만, 패널 이름은 에이전트', async () => {
    await renderPanel(null)
    expect(screen.getByText('관계도에서 에이전트를 골라 보세요')).toBeTruthy()
    expect(screen.getByRole('complementary', { name: '에이전트' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '멈추기' })).toBeNull()
    expect(api.describe).not.toHaveBeenCalled()
  })

  it('고르면 머리에 이름·역할, 패널 이름은 에이전트 이름', async () => {
    await renderPanel()
    const panel = screen.getByRole('complementary', { name: '웹 화면' })
    expect(within(panel).getByText('웹 화면')).toBeTruthy()
    expect(within(panel).getByText('화면 구현')).toBeTruthy()
    expect(panel.querySelector('.av.b')?.textContent).toBe('웹')
  })
})

describe('PanelHeader — 멈추기', () => {
  it.each([
    ['작업 중', { status: 'working' }, [], true],
    ['승인 기다림(상태)', { status: 'awaiting' }, [], true],
    ['승인 기다림(남은 요청)', { status: 'idle' }, [request()], true],
    ['대기', { status: 'idle' }, [], false],
    ['멈춘 프로세스', { status: 'stopped' }, [], false],
    ['오류', { status: 'error', errorText: '끝났어요' }, [], false],
  ] as const)('%s → 활성 %s', async (_label, over, requests, enabled) => {
    snapshot.agents = [agent('w', { name: '웹 화면', ...over })]
    snapshot.requests = [...requests]
    await renderPanel()
    expect(stopButton().disabled).toBe(!enabled)
    if (!enabled) return
    await act(async () => { fireEvent.click(stopButton()) })
    expect(api.interrupt).toHaveBeenCalledTimes(1)
    expect(api.interrupt).toHaveBeenCalledWith('w')
  })

  it('상태 알약 — 작업 중은 초록, 승인 기다림은 앰버, 대기·멈춤', async () => {
    snapshot.agents = [
      agent('w', { name: '웹 화면', status: 'working' }),
      agent('d', { name: '디자인', status: 'awaiting' }),
      agent('s', { name: '서버' }),
      agent('e', { name: '오류', status: 'error', errorText: 'x' }),
    ]
    const { store } = await renderPanel()
    const pill = () => document.querySelector('.ph .pill')!
    expect(pill().textContent).toBe('작업 중')
    expect(pill().classList.contains('w')).toBe(true)
    await act(async () => store.selectAgent('d'))
    expect(pill().textContent).toBe('승인 기다림')
    expect(pill().classList.contains('p')).toBe(true)
    await act(async () => store.selectAgent('s'))
    expect(pill().textContent).toBe('대기')
    await act(async () => store.selectAgent('e'))
    expect(pill().textContent).toBe('멈춤')
    expect(pill().classList.contains('e')).toBe(true)
  })
})

describe('PanelHeader — 자동 스위치', () => {
  it('누르면 updateAgent(id, {auto}) 를 부르고 스냅샷을 다시 받아 켜진다', async () => {
    await renderPanel()
    const sw = screen.getByRole('switch', { name: '자동' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await act(async () => { fireEvent.click(sw) })
    await settle()
    expect(api.updateAgent).toHaveBeenCalledWith('w', { auto: true })
    expect(screen.getByRole('switch', { name: '자동' }).getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: '자동' })) })
    await settle()
    expect(api.updateAgent).toHaveBeenLastCalledWith('w', { auto: false })
    expect(screen.getByRole('switch', { name: '자동' }).getAttribute('aria-checked')).toBe('false')
  })

  it('실패하면 엔진 문구를 머리에 보여 주고 스위치는 그대로', async () => {
    api.updateAgent.mockRejectedValueOnce(new Error('에이전트를 찾을 수 없습니다: w'))
    await renderPanel()
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: '자동' })) })
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('에이전트를 찾을 수 없습니다: w')
    expect(screen.getByRole('switch', { name: '자동' }).getAttribute('aria-checked')).toBe('false')
  })
})

describe('ModelPicker', () => {
  const openPicker = async () => {
    await act(async () => { fireEvent.click(modelChip()) })
    await settle()
  }

  it('고르기만으론 describe 를 부르지 않는다(claude 를 켜지 않음) — 목록을 열 때 한 번, 다시 열거나 갔다 와도 그대로', async () => {
    const { store } = await renderPanel()
    expect(api.describe).not.toHaveBeenCalled()
    await openPicker()
    expect(api.describe).toHaveBeenCalledTimes(1)
    expect(api.describe).toHaveBeenCalledWith('w')
    fireEvent.keyDown(screen.getByRole('menu', { name: '모델' }), { key: 'Escape' })
    await openPicker()
    expect(api.describe).toHaveBeenCalledTimes(1)
    await act(async () => store.selectAgent('p'))
    await settle()
    expect(api.describe).toHaveBeenCalledTimes(1)
    await act(async () => store.selectAgent('w'))
    await openPicker()
    expect(api.describe).toHaveBeenCalledTimes(1)
  })

  it('칩 이름은 describe 없이 agent.model 로 — 없으면 기본 (추천)', async () => {
    snapshot.agents = [agent('w', { name: '웹 화면', model: 'sonnet' }), agent('p', { name: '기획' }), agent('o', { name: '오푸스', model: 'opus[1m]' })]
    const { store } = await renderPanel()
    expect(modelChip().textContent).toBe('Sonnet')
    await act(async () => store.selectAgent('p'))
    expect(modelChip().textContent).toBe('기본 (추천)')
    await act(async () => store.selectAgent('o'))
    expect(modelChip().textContent).toBe('Opus (긴 대화)')
    expect(api.describe).not.toHaveBeenCalled()
  })

  it('고르면 setModel — default 는 null 로, 지금 모델엔 표시 · 이름·설명은 한국어(Claude 의 영어 설명은 안 보임)', async () => {
    snapshot.agents = [agent('w', { name: '웹 화면', model: 'sonnet' })]
    await renderPanel()
    await openPicker()
    const menu = screen.getByRole('menu', { name: '모델' })
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items.map(i => i.querySelector('.mi-t')?.textContent)).toEqual(['기본 (추천)', 'Opus', 'Sonnet', 'Custom Model'])
    expect(items.map(i => i.querySelector('.mi-d')?.textContent ?? null)).toEqual([
      '평소 쓰기 좋은 모델', '어려운 일에 가장 똑똑한 모델', '빠르고 균형 잡힌 모델', null,
    ])
    expect(items.map(i => i.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false'])
    expect(menu.textContent).not.toMatch(/Use the default|Most capable|everyday|English|recommended/)

    await act(async () => { fireEvent.click(items[0]) })
    await settle()
    expect(api.setModel).toHaveBeenCalledWith('w', null)
    expect(screen.queryByRole('menu', { name: '모델' })).toBeNull()
    expect(modelChip().textContent).toBe('기본 (추천)')

    await openPicker()
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: /Opus/ })) })
    await settle()
    expect(api.setModel).toHaveBeenLastCalledWith('w', 'opus')
    expect(modelChip().textContent).toBe('Opus')
  })

  it('describe 가 실패하면 칩은 그대로, 목록에 실패 줄과 다시 시도', async () => {
    api.describe.mockRejectedValueOnce(new Error('claude 를 시작하지 못했어요'))
    snapshot.agents = [agent('w', { name: '웹 화면', model: 'sonnet' })]
    await renderPanel()
    await openPicker()
    expect(api.describe).toHaveBeenCalledTimes(1)
    expect(modelChip().textContent).toBe('Sonnet')
    const menu = screen.getByRole('menu', { name: '모델' })
    expect(menu.textContent).toContain('모델 목록을 받지 못했어요')
    // 다시 열기만으론 다시 부르지 않는다 — 다시 시도를 눌러야
    fireEvent.keyDown(menu, { key: 'Escape' })
    await openPicker()
    expect(api.describe).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '다시 시도' })) })
    await settle()
    expect(api.describe).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4)
  })

  it('밖에서 열고 닫을 수 있다(open · onOpenChange) — 열리면 받고, Esc 로 닫으면 onOpenChange(false)', async () => {
    const { ModelPicker } = await import('../../src/renderer/panel/ModelPicker')
    const onOpenChange = vi.fn()
    const onLoad = vi.fn()
    const { rerender } = render(
      <ModelPicker agentId="w" model={null} description={{ state: 'idle' }} onLoad={onLoad} onRetry={() => {}} open={false} onOpenChange={onOpenChange} />,
    )
    expect(onLoad).not.toHaveBeenCalled()
    rerender(
      <ModelPicker agentId="w" model={null} description={{ state: 'idle' }} onLoad={onLoad} onRetry={() => {}} open onOpenChange={onOpenChange} />,
    )
    expect(onLoad).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('menu', { name: '모델' }).textContent).toBe('모델 목록을 불러오는 중…')
    rerender(
      <ModelPicker agentId="w" model={null} description={{ state: 'ready', value: DESC }} onLoad={onLoad} onRetry={() => {}} open onOpenChange={onOpenChange} />,
    )
    const menu = screen.getByRole('menu', { name: '모델' })
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(4)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    // 제어 모드 — 부모가 open 을 바꾸기 전엔 그대로 열려 있다
    expect(screen.getByRole('menu', { name: '모델' })).toBeTruthy()
  })

  const LIST: AgentDescription = {
    commands: [],
    permissionMode: 'default',
    models: [
      { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
      { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
      { value: 'fable', displayName: 'Fable 5.1', resolvedModel: 'claude-fable-5-1' },
      { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' },
      { value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', resolvedModel: 'claude-opus-4-8' },
      { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001' },
    ],
  }

  it("버전 이름 — 늘 최신 별칭이 위, 예전 버전은 '버전 고정' 아래, ↓ 는 이름표를 건너뛴다, 칩은 버전 이름", async () => {
    api.describe.mockResolvedValue(LIST)
    snapshot.agents = [agent('w', { name: '웹 화면', model: 'opus' })]
    await renderPanel()
    expect(modelChip().textContent).toBe('Opus')
    await openPicker()
    expect(modelChip().textContent).toBe('Opus 5.5')
    const menu = screen.getByRole('menu', { name: '모델' })
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items.map(i => i.querySelector('.mi-t')?.textContent)).toEqual([
      '기본 (추천)', 'Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5', 'Opus 4.8', 'Haiku 4.5',
    ])
    expect(items[0].querySelector('.mi-d')?.textContent).toBe('Opus 5.5 · 평소 쓰기 좋은 모델')
    // 이름표는 별칭과 고정 사이에 한 번
    const all = Array.from(menu.querySelectorAll('.mi, .pop-group'))
    expect(all[5].textContent).toBe('버전 고정')
    expect(menu.querySelectorAll('.pop-group')).toHaveLength(1)
    items[4].focus()
    fireEvent.keyDown(items[4], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[5])
    // 저장은 값 그대로
    await act(async () => { fireEvent.click(items[5]) })
    await settle()
    expect(api.setModel).toHaveBeenCalledWith('w', 'claude-opus-4-8')
  })

  it('별칭만 있으면 이름표가 없다', async () => {
    api.describe.mockResolvedValue({ ...LIST, models: LIST.models.slice(0, 5) })
    await renderPanel()
    await openPicker()
    expect(document.querySelector('.pop-group')).toBeNull()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
  })

  it('modelText — 값으로 한국어 이름·설명, 모르는 값은 Claude 이름만', async () => {
    const { modelText } = await import('../../src/renderer/lib/words')
    expect(modelText('default', 'Default (recommended)')).toEqual({ name: '기본 (추천)', description: '평소 쓰기 좋은 모델' })
    expect(modelText('opus')).toEqual({ name: 'Opus', description: '어려운 일에 가장 똑똑한 모델' })
    expect(modelText('opus[1m]', 'Opus (1M context)')).toEqual({ name: 'Opus (긴 대화)', description: '어려운 일에 가장 똑똑한 모델' })
    expect(modelText('sonnet')).toEqual({ name: 'Sonnet', description: '빠르고 균형 잡힌 모델' })
    expect(modelText('haiku')).toEqual({ name: 'Haiku', description: '가장 빠르고 가벼운 모델' })
    expect(modelText('claude-x-2', 'Custom')).toEqual({ name: 'Custom', description: null })
    expect(modelText('claude-x-2')).toEqual({ name: 'claude-x-2', description: null })
  })
})

describe('AgentMenu', () => {
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: '메뉴' }))
  const item = (name: string) => screen.getByRole('menuitem', { name })

  it('지우기는 확인 대화상자를 거쳐야만 removeAgent — 취소·Esc·바깥 누르기는 부르지 않는다', async () => {
    const { store } = await renderPanel()
    openMenu()
    fireEvent.click(item('지우기'))
    let dlg = screen.getByRole('alertdialog')
    expect(dlg.textContent).toContain('에이전트 웹 화면을 지울까요?')
    expect(dlg.textContent).toContain('대화 기록도 지워져요.')
    expect(api.removeAgent).not.toHaveBeenCalled()

    fireEvent.click(within(dlg).getByRole('button', { name: '취소' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    openMenu()
    fireEvent.click(item('지우기'))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()

    openMenu()
    fireEvent.click(item('지우기'))
    fireEvent.pointerDown(document.querySelector('.dlg-bd')!)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.removeAgent).not.toHaveBeenCalled()

    openMenu()
    fireEvent.click(item('지우기'))
    dlg = screen.getByRole('alertdialog')
    const confirm = within(dlg).getByRole('button', { name: '지우기' })
    expect(confirm.classList.contains('dng')).toBe(true)
    await act(async () => { fireEvent.click(confirm) })
    await settle()
    expect(api.removeAgent).toHaveBeenCalledTimes(1)
    expect(api.removeAgent).toHaveBeenCalledWith('w')
    expect(store.getState().selectedAgentId).toBeNull()
    expect(screen.getByText('관계도에서 에이전트를 골라 보세요')).toBeTruthy()
  })

  it('지우기에 실패하면 대화상자에 엔진 문구', async () => {
    api.removeAgent.mockRejectedValueOnce(new Error('에이전트를 찾을 수 없습니다: w'))
    await renderPanel()
    openMenu()
    fireEvent.click(item('지우기'))
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '지우기' })) })
    await settle()
    expect(within(screen.getByRole('alertdialog')).getByText('에이전트를 찾을 수 없습니다: w')).toBeTruthy()
  })

  it('새 대화는 확인을 거쳐 newConversation', async () => {
    await renderPanel()
    openMenu()
    fireEvent.click(item('새 대화'))
    const dlg = screen.getByRole('alertdialog')
    expect(dlg.textContent).toContain('지금까지 대화를 접고 새로 시작할까요?')
    expect(api.newConversation).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '새로 시작' })) })
    await settle()
    expect(api.newConversation).toHaveBeenCalledWith('w')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('폴더 열기는 openFolder(에이전트 폴더)', async () => {
    await renderPanel()
    openMenu()
    await act(async () => { fireEvent.click(item('폴더 열기')) })
    expect(api.openFolder).toHaveBeenCalledWith('C:\\w')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('이름·역할 바꾸기는 같은 자리 입력 — 이름 겹침은 칸 아래 해요체 안내, 고치면 저장', async () => {
    await renderPanel()
    openMenu()
    fireEvent.click(item('이름·역할 바꾸기'))
    const name = screen.getByRole('textbox', { name: '이름' }) as HTMLInputElement
    const role = screen.getByRole('textbox', { name: '역할' }) as HTMLInputElement
    expect(name.value).toBe('웹 화면')
    expect(role.value).toBe('화면 구현')
    expect(document.activeElement).toBe(name)

    fireEvent.change(name, { target: { value: '기획' } })
    await act(async () => { fireEvent.keyDown(name, { key: 'Enter' }) })
    await settle()
    // 추가 대화상자와 같은 해요체 안내(엔진 원문은 보이지 않는다)
    expect(screen.getByText('‘기획’이라는 에이전트가 이미 있어요. 다른 이름을 써 주세요.')).toBeTruthy()
    expect(screen.queryByText('이미 있는 이름입니다: 기획')).toBeNull()
    expect(screen.getByRole('textbox', { name: '이름' })).toBeTruthy()

    fireEvent.change(name, { target: { value: '웹 화면 2' } })
    fireEvent.change(role, { target: { value: '화면 · 접근성' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '저장' })) })
    await settle()
    expect(api.updateAgent).toHaveBeenLastCalledWith('w', { name: '웹 화면 2', role: '화면 · 접근성' })
    expect(screen.queryByRole('textbox', { name: '이름' })).toBeNull()
    expect(screen.getByRole('complementary', { name: '웹 화면 2' })).toBeTruthy()
    expect(screen.getByText('화면 · 접근성')).toBeTruthy()
  })

  it('Esc 는 바꾸기를 접는다(저장 안 함)', async () => {
    await renderPanel()
    openMenu()
    fireEvent.click(item('이름·역할 바꾸기'))
    const name = screen.getByRole('textbox', { name: '이름' })
    fireEvent.change(name, { target: { value: '다른 이름' } })
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: '이름' })).toBeNull()
    expect(api.updateAgent).not.toHaveBeenCalled()
    expect(screen.getByText('웹 화면')).toBeTruthy()
  })
})

describe('PanelHeader — 띠', () => {
  it('오류면 머리 아래 빨간 띠 — 오류 글과 다시 켜지는 안내(누르는 것처럼 보이는 굵은 글 없음)', async () => {
    snapshot.agents = [agent('w', { name: '웹 화면', status: 'error', errorText: '프로세스가 예기치 않게 끝났어요 (코드 1)' })]
    await renderPanel()
    const band = document.querySelector('.band.err')!
    expect(band.textContent).toContain('프로세스가 예기치 않게 끝났어요 (코드 1)')
    expect(band.querySelector('.band-h')!.textContent).toBe('다음에 일을 시키면 다시 켜져요')
    expect(band.querySelector('b')).toBeNull()
    expect(band.textContent).not.toContain('다시 시도')
  })

  it('묻지 않고 실행하는 에이전트면 앰버 띠', async () => {
    snapshot.agents = [agent('w', { name: '웹 화면', bypass: true })]
    await renderPanel()
    expect(document.querySelector('.band.warn')!.textContent).toBe('이 에이전트는 묻지 않고 실행해요 (Claude 설정의 전부 허용)')
    expect(document.querySelector('.band.err')).toBeNull()
  })
})

describe('ConfirmDialog', () => {
  it('열리면 안으로 포커스, Tab 은 대화상자 안에서만 돈다', async () => {
    const { ConfirmDialog } = await import('../../src/renderer/shell/ConfirmDialog')
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const { rerender } = render(
      <ConfirmDialog open title="지울까요?" body="되돌릴 수 없어요." confirmLabel="지우기" danger onConfirm={onConfirm} onCancel={onCancel} />,
    )
    const dlg = screen.getByRole('alertdialog', { name: '지울까요?' })
    const [cancel, ok] = within(dlg).getAllByRole('button')
    expect(cancel.textContent).toBe('취소')
    expect(ok.textContent).toBe('지우기')
    // 위험한 확인은 취소에 먼저 포커스
    expect(document.activeElement).toBe(cancel)
    ok.focus()
    fireEvent.keyDown(ok, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(ok)
    fireEvent.keyDown(ok, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(ok)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // 닫히면 연 자리로 포커스를 돌려준다
    rerender(<ConfirmDialog open={false} title="지울까요?" confirmLabel="지우기" onConfirm={onConfirm} onCancel={onCancel} />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('포커스가 body 에 있어도 Esc 는 닫고 Tab 은 안으로 — 앱으로 새지 않는다', async () => {
    const { ConfirmDialog } = await import('../../src/renderer/shell/ConfirmDialog')
    const onCancel = vi.fn()
    render(<ConfirmDialog open title="새로 시작할까요?" confirmLabel="새로 시작" onConfirm={() => {}} onCancel={onCancel} />)
    const [cancel, ok] = within(screen.getByRole('alertdialog')).getAllByRole('button')
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(ok)
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('확인을 기다리는 동안 포커스는 대화상자에, Esc 는 무시 · 실패하면 문구와 함께 확인 버튼으로', async () => {
    const { ConfirmDialog } = await import('../../src/renderer/shell/ConfirmDialog')
    const onCancel = vi.fn()
    let fail: (e: Error) => void = () => {}
    const onConfirm = () => new Promise<void>((_, reject) => { fail = reject })
    render(<ConfirmDialog open title="지울까요?" confirmLabel="지우기" danger onConfirm={onConfirm} onCancel={onCancel} />)
    const dlg = screen.getByRole('alertdialog')
    const ok = within(dlg).getByRole('button', { name: '지우기' }) as HTMLButtonElement
    await act(async () => { fireEvent.click(ok) })
    expect(ok.disabled).toBe(true)
    expect(document.activeElement).toBe(dlg)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.keyDown(dlg, { key: 'Tab' })
    expect(document.activeElement).toBe(dlg)
    await act(async () => { fail(new Error('에이전트를 찾을 수 없습니다: w')) })
    await settle()
    expect(within(dlg).getByText('에이전트를 찾을 수 없습니다: w')).toBeTruthy()
    expect(ok.disabled).toBe(false)
    expect(document.activeElement).toBe(ok)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('PanelHeader — effort 칩 자리', () => {
  it('둘째 줄에서 모델 칩 다음이 effort 칩, 그 다음이 자동 스위치', async () => {
    snapshot.agents = [agent('w', { name: '웹 화면', effort: 'high' })]
    await renderPanel()
    const row = document.querySelector('.ph-r2')!
    const kids = Array.from(row.children)
    const model = kids.findIndex(k => k.contains(modelChip()))
    const eff = kids.findIndex(k => k.querySelector('button[aria-label="effort high"]'))
    const auto = kids.findIndex(k => k.getAttribute('role') === 'switch')
    expect(eff).toBe(model + 1)
    expect(auto).toBe(eff + 1)
  })
})
