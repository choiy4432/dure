import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { AgentDescription, EngineEventMap, UserPart } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'

// 이미지 줄이기는 image.test 가 따로 본다 — 여기선 그 결과만 정해 준다(jsdom 엔 캔버스가 없다)
const prep = vi.hoisted(() => vi.fn())
vi.mock('../../src/renderer/lib/image', async orig => ({ ...(await orig<object>()), prepareImage: prep }))

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, status: 'idle', errorText: null, bypass: false, heldInput: 0, ...over,
})
const cmd = (name: string, description = `${name} command`) => ({ name, description, argumentHint: '' })
// Claude 가 주는 그대로(영어 설명) — /c 로 시작하는 것이 9개
const DESC: AgentDescription = {
  commands: [
    cmd('compact', 'Clear conversation history but keep a summary in context'),
    cmd('context'), cmd('cost'), cmd('clear', 'Clear conversation history and free up context'),
    cmd('config'), cmd('commit'), cmd('code-review'), cmd('copy'), cmd('color'),
    cmd('model', 'Set the AI model for Claude Code'), cmd('init'), cmd('review'),
  ],
  models: [
    { value: 'default', displayName: 'Default (recommended)' },
    { value: 'sonnet', displayName: 'Sonnet' },
  ],
  permissionMode: 'default',
}

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let api: Record<'sendUser' | 'describe' | 'newConversation', ReturnType<typeof vi.fn>>

const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

beforeEach(() => {
  vi.resetModules()
  prep.mockReset()
  handlers = {}
  snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }],
    agents: [agent('w', { name: '웹 화면', role: '화면 구현' }), agent('p', { name: '기획', role: '기획서 · 문구' })],
    messages: [], requests: [], autoChainLimit: 3,
  }
  api = {
    sendUser: vi.fn(async (_id: string, _parts: UserPart[]) => {}),
    describe: vi.fn(async (_id: string) => DESC),
    newConversation: vi.fn(async (_id: string) => {}),
  }
  ;(window as any).dure = {
    ...api,
    snapshot: async () => snapshot,
    history: async () => [],
    setModel: async () => {},
    on: (k: string, fn: (p: any) => void) => {
      ;(handlers[k] ??= []).push(fn)
      return () => {}
    },
  }
})
afterEach(() => cleanup())

async function renderPanel(select = 'w') {
  const { getStore } = await import('../../src/renderer/state/store')
  const { AgentPanel } = await import('../../src/renderer/panel/AgentPanel')
  await act(async () => { await getStore().init() })
  const r = render(<AgentPanel />)
  await act(async () => { getStore().selectAgent(select) })
  await settle()
  return { ...r, store: getStore() }
}

const input = () => screen.getByRole('textbox', { name: '웹 화면에게 보낼 메시지' }) as HTMLTextAreaElement
const sendButton = () => screen.getByRole('button', { name: '보내기' }) as HTMLButtonElement
const type = (text: string) => fireEvent.change(input(), { target: { value: text } })
const key = (k: string, o: Record<string, unknown> = {}) => fireEvent.keyDown(input(), { key: k, ...o })
const menu = () => screen.queryByRole('listbox', { name: '명령' })
const options = () => within(menu()!).getAllByRole('option')
const names = () => options().map(o => o.querySelector('.f')!.textContent)

describe('Composer — 보내기', () => {
  it('자리표시는 "<이름>에게 일 시키기… ( / 명령 )"', async () => {
    await renderPanel()
    expect(input()).toHaveAttribute('placeholder', '웹 화면에게 일 시키기… ( / 명령 )')
  })

  it('빈 입력(공백만)이면 보내기 비활성 — 글을 쓰면 활성', async () => {
    await renderPanel()
    expect(sendButton()).toBeDisabled()
    type('   \n ')
    expect(sendButton()).toBeDisabled()
    type('헤더 높이 줄여 줘')
    expect(sendButton()).toBeEnabled()
  })

  it('Enter 로 보내고, 보내지면 입력을 비운다', async () => {
    await renderPanel()
    type('헤더 높이 줄여 줘')
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [{ type: 'text', text: '헤더 높이 줄여 줘' }])
    expect(input().value).toBe('')
  })

  it('보내기 버튼으로도', async () => {
    await renderPanel()
    type('안녕')
    fireEvent.click(sendButton())
    await settle()
    expect(api.sendUser).toHaveBeenCalledTimes(1)
  })

  it('Shift+Enter 는 줄바꿈 — 보내지 않는다', async () => {
    await renderPanel()
    type('첫 줄')
    key('Enter', { shiftKey: true })
    await settle()
    expect(api.sendUser).not.toHaveBeenCalled()
  })

  it('한글 조합 중 Enter 는 보내지 않는다(isComposing · keyCode 229)', async () => {
    await renderPanel()
    type('안녕하세')
    key('Enter', { isComposing: true })
    key('Enter', { keyCode: 229 })
    await settle()
    expect(api.sendUser).not.toHaveBeenCalled()
    expect(input().value).toBe('안녕하세')
  })

  it('못 보내면 엔진 문구를 보여 주고 입력은 남긴다', async () => {
    api.sendUser.mockRejectedValueOnce(new Error('에이전트를 찾을 수 없어요'))
    await renderPanel()
    type('안녕')
    key('Enter')
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('에이전트를 찾을 수 없어요')
    expect(input().value).toBe('안녕')
  })

  it('대기 입력이 있으면 "보낼 차례를 기다리는 입력 N개" — 이벤트로 바뀐다', async () => {
    snapshot.agents[0].heldInput = 2
    await renderPanel()
    expect(screen.getByText('보낼 차례를 기다리는 입력 2개')).toBeInTheDocument()
    await emit('held-input', { agentId: 'w', count: 0 })
    expect(screen.queryByText(/보낼 차례를 기다리는/)).toBeNull()
  })
})

describe('Composer — / 명령', () => {
  it('처음 / 를 치면 그때 명령 목록을 받는다(한 번만) — 받는 동안 "명령을 불러오는 중…"', async () => {
    let resolve!: (d: AgentDescription) => void
    api.describe.mockReturnValueOnce(new Promise<AgentDescription>(r => { resolve = r }))
    await renderPanel()
    expect(api.describe).not.toHaveBeenCalled()
    type('/')
    await settle()
    expect(api.describe).toHaveBeenCalledWith('w')
    expect(within(menu()!).getByText('명령을 불러오는 중…')).toBeInTheDocument()
    await act(async () => { resolve(DESC) })
    expect(options()).toHaveLength(8)
    type('/c')
    type('/')
    await settle()
    expect(api.describe).toHaveBeenCalledTimes(1)
  })

  it('이름 앞부분으로 거른다 — 최대 8개, 이름 mono + 설명 한 줄', async () => {
    await renderPanel()
    type('/co')
    await settle()
    expect(names()).toEqual(['/compact', '/context', '/cost', '/config', '/commit', '/code-review', '/copy', '/color'])
    type('/c')
    expect(options()).toHaveLength(8)
    type('/comp')
    expect(names()).toEqual(['/compact'])
    expect(options()[0]).toHaveTextContent('Clear conversation history but keep a summary in context')
  })

  it('맞는 게 없거나 띄어 쓰면 목록이 닫히고 Enter 는 그대로 보낸다', async () => {
    await renderPanel()
    type('/zzz')
    await settle()
    expect(menu()).toBeNull()
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [{ type: 'text', text: '/zzz' }])
  })

  it('↑↓ 로 고르고 Enter — 그 밖 명령은 "/<이름> " 을 채우기만(보내지 않음), 인자 뒤 Enter 로 보낸다', async () => {
    await renderPanel()
    type('/co')
    await settle()
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    key('ArrowDown')
    key('ArrowDown')
    expect(options()[2]).toHaveAttribute('aria-selected', 'true')
    expect(input()).toHaveAttribute('aria-activedescendant', options()[2].id)
    key('ArrowUp')
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')
    key('ArrowUp')
    key('ArrowUp')
    expect(options()[7]).toHaveAttribute('aria-selected', 'true') // 맨 위에서 위로 — 맨 아래
    key('ArrowDown')
    key('Enter')
    expect(input().value).toBe('/compact ')
    expect(menu()).toBeNull()
    expect(api.sendUser).not.toHaveBeenCalled()
    type('/compact 디자인 이야기만 남겨')
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [{ type: 'text', text: '/compact 디자인 이야기만 남겨' }])
  })

  it('누르기로도 고른다', async () => {
    await renderPanel()
    type('/re')
    await settle()
    fireEvent.click(options()[0])
    expect(input().value).toBe('/review ')
  })

  it('Esc 는 목록만 닫는다 — 더 치면 다시 열린다', async () => {
    await renderPanel()
    type('/co')
    await settle()
    key('Escape')
    expect(menu()).toBeNull()
    expect(input().value).toBe('/co')
    type('/con')
    expect(names()).toEqual(['/context', '/config'])
  })

  it('/model 은 모델 목록을 연다 — 보내지 않고 입력은 비운다(목록은 다시 받지 않는다)', async () => {
    await renderPanel()
    type('/mo')
    await settle()
    expect(options()[0]).toHaveTextContent('모델 고르기')
    key('Enter')
    await settle()
    expect(screen.getByRole('menu', { name: '모델' })).toBeInTheDocument()
    expect(input().value).toBe('')
    expect(api.sendUser).not.toHaveBeenCalled()
    expect(api.describe).toHaveBeenCalledTimes(1)
  })

  it('/clear 는 새 대화 확인을 거친다 — 취소면 아무것도, [새로 시작] 이면 newConversation', async () => {
    await renderPanel()
    type('/cle')
    await settle()
    expect(options()[0]).toHaveTextContent('새 대화 시작')
    key('Enter')
    const dlg = screen.getByRole('alertdialog', { name: '지금까지 대화를 접고 새로 시작할까요?' })
    fireEvent.click(within(dlg).getByRole('button', { name: '취소' }))
    expect(api.newConversation).not.toHaveBeenCalled()
    expect(input().value).toBe('')

    type('/clear')
    await settle()
    key('Enter')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '새로 시작' }))
    await settle()
    expect(api.newConversation).toHaveBeenCalledWith('w')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.sendUser).not.toHaveBeenCalled()
  })

  it('명령 목록을 못 받으면 안내 + 다시 시도', async () => {
    api.describe.mockRejectedValueOnce(new Error('claude 를 켜지 못했어요'))
    await renderPanel()
    type('/')
    await settle()
    expect(within(menu()!).getByText('명령을 불러오지 못했어요')).toBeInTheDocument()
    fireEvent.click(within(menu()!).getByRole('button', { name: '다시 시도' }))
    await settle()
    expect(api.describe).toHaveBeenCalledTimes(2)
    expect(options()).toHaveLength(8)
  })
})

describe('Composer — 이미지', () => {
  const png = (name = 'shot.png') => new File([new Uint8Array(10)], name, { type: 'image/png' })
  const ready = (base64 = 'QUJD') => ({ mediaType: 'image/png', base64, bytes: 3 })
  const fileInput = (c: HTMLElement) => c.querySelector('input[type="file"]') as HTMLInputElement
  const chips = () => screen.queryAllByRole('img', { name: /붙인 이미지/ })

  it('이미지 버튼 → 파일 고르기 → 미리보기 칩, 보내면 이미지가 먼저 · 글이 뒤', async () => {
    prep.mockResolvedValue(ready())
    const { container } = await renderPanel()
    const pick = screen.getByRole('button', { name: '이미지 붙여 넣기' })
    const fi = fileInput(container)
    const clicked = vi.spyOn(fi, 'click')
    fireEvent.click(pick)
    expect(clicked).toHaveBeenCalled()
    fireEvent.change(fi, { target: { files: [png()] } })
    await settle()
    expect(prep).toHaveBeenCalledTimes(1)
    expect(chips()).toHaveLength(1)
    expect(chips()[0]).toHaveAttribute('src', 'data:image/png;base64,QUJD')
    type('이 화면 봐 줘')
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [
      { type: 'image', mediaType: 'image/png', base64: 'QUJD' },
      { type: 'text', text: '이 화면 봐 줘' },
    ])
    expect(chips()).toHaveLength(0)
  })

  it('이미지만 있어도 보낼 수 있다 · × 로 지우면 다시 비활성', async () => {
    prep.mockResolvedValue(ready())
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [png()] } })
    await settle()
    expect(sendButton()).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '이미지 지우기' }))
    expect(chips()).toHaveLength(0)
    expect(sendButton()).toBeDisabled()
  })

  it('못 붙이면 그 문구 — 칩도 없고 원본도 보내지 않는다', async () => {
    prep.mockResolvedValue({ error: '이미지가 너무 커요 — 더 작은 이미지를 붙여 주세요' })
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [png('huge.png')] } })
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('이미지가 너무 커요 — 더 작은 이미지를 붙여 주세요')
    expect(chips()).toHaveLength(0)
    expect(sendButton()).toBeDisabled()
  })

  it('붙여 넣기 — 클립보드에 이미지만 있으면 칩으로', async () => {
    prep.mockResolvedValue(ready())
    await renderPanel()
    fireEvent.paste(input(), { clipboardData: { files: [png()], types: ['Files'], getData: () => '' } })
    await settle()
    expect(prep).toHaveBeenCalledTimes(1)
    expect(chips()).toHaveLength(1)
  })

  it('붙여 넣기 — 글이 함께 있으면(표 복사 등) 글로 둔다', async () => {
    prep.mockResolvedValue(ready())
    await renderPanel()
    fireEvent.paste(input(), { clipboardData: { files: [png()], types: ['text/plain', 'Files'], getData: () => 'a\tb' } })
    await settle()
    expect(prep).not.toHaveBeenCalled()
  })

  it('끌어 놓기도', async () => {
    prep.mockResolvedValue(ready())
    await renderPanel()
    const box = input().closest('.box')!
    fireEvent.dragOver(box, { dataTransfer: { types: ['Files'], files: [] } })
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files: [png('a.png'), png('b.png')] } })
    await settle()
    expect(prep).toHaveBeenCalledTimes(2)
    expect(chips()).toHaveLength(2)
  })

  it('준비하는 동안엔 보내지 않는다', async () => {
    let done!: (v: unknown) => void
    prep.mockReturnValueOnce(new Promise(r => { done = r }))
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [png()] } })
    await settle()
    type('같이 보내')
    expect(sendButton()).toBeDisabled()
    key('Enter')
    await settle()
    expect(api.sendUser).not.toHaveBeenCalled()
    await act(async () => { done(ready()) })
    expect(sendButton()).toBeEnabled()
  })
})
