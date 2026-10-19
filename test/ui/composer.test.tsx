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
// Claude 가 주는 그대로 — 기본 명령은 영어 설명에 꼬리표 없음, 사용자 명령·스킬은 끝에 (user)·(project) 꼬리표
// 보이는 것 중 /c 로 시작하는 것이 9개(compact·clear + 사용자 7), context·cost·config·copy 는 기본이라 숨는다
const DESC: AgentDescription = {
  commands: [
    cmd('compact', 'Clear conversation history but keep a summary in context'),
    cmd('context', 'Visualize current context usage'), cmd('cost', 'Show the total cost'),
    cmd('clear', 'Clear conversation history and free up context'),
    cmd('config', 'Open config panel'), cmd('copy', 'Copy the last response'),
    cmd('canary', '배포 뒤 화면을 지켜봐요 (gstack) (user)'), cmd('careful', '지우는 명령 전에 한 번 더 (user)'),
    cmd('codex', 'Second opinion from another model (user)'), cmd('commit', '커밋 메시지를 써 줘요 (user)'),
    cmd('code-review', '바뀐 코드를 꼼꼼히 봐요 (project)'), cmd('color-check', '색 대비를 재요 (user)'),
    cmd('cso', '보안 점검 (user)'),
    cmd('model', 'Set the AI model for Claude Code'), cmd('init', 'Initialize a new CLAUDE.md file'),
    cmd('review', 'Review a pull request'), cmd('doctor', 'Diagnose your installation'),
  ],
  models: [
    { value: 'default', displayName: 'Default (recommended)' },
    { value: 'sonnet', displayName: 'Sonnet' },
  ],
  permissionMode: 'default',
}

let snapshot: Snapshot
let handlers: Record<string, ((p: any) => void)[]>
let api: Record<'sendUser' | 'describe' | 'newConversation' | 'setModel', ReturnType<typeof vi.fn>>

const emit = <K extends keyof EngineEventMap>(k: K, p: EngineEventMap[K]) => act(() => (handlers[k] ?? []).forEach(f => f(p)))
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

// 미리보기 주소 — jsdom 엔 URL.createObjectURL 이 없다. 만든 것·놓아 준 것을 센다
let created: Blob[]
let revoked: string[]

beforeEach(() => {
  vi.resetModules()
  prep.mockReset()
  created = []
  revoked = []
  URL.createObjectURL = vi.fn((b: Blob) => {
    created.push(b)
    return `blob:dure/${created.length}`
  })
  URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u))
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
    setModel: vi.fn(async (_id: string, _model: string | null) => {}),
  }
  ;(window as any).dure = {
    ...api,
    snapshot: async () => snapshot,
    history: async () => [],
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

  it('이름 앞부분으로 거른다 — 최대 8개, 이름 mono + 설명 한 줄(숨는 기본 명령은 빼고)', async () => {
    await renderPanel()
    type('/co')
    await settle()
    expect(names()).toEqual(['/compact', '/codex', '/commit', '/code-review', '/color-check'])
    type('/c')
    expect(options()).toHaveLength(8)
    type('/comp')
    expect(names()).toEqual(['/compact'])
    expect(options()[0]).toHaveTextContent('대화를 요약해 용량을 줄여요')
    type('/com')
    expect(options()[1]).toHaveTextContent('커밋 메시지를 써 줘요 (user)')
    type('/con')
    expect(menu()).toBeNull() // context · config 는 두레에선 쓸 수 없는 기본 명령
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
    expect(options()[options().length - 1]).toHaveAttribute('aria-selected', 'true') // 맨 위에서 위로 — 맨 아래
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
    type('/com')
    expect(names()).toEqual(['/compact', '/commit'])
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

  it('누르기로 고른 /review 는 기본 명령 — 한국어 설명', async () => {
    await renderPanel()
    type('/re')
    await settle()
    expect(options()[0]).toHaveTextContent('바뀐 내용을 검토해요')
    type('/in')
    expect(options()[0]).toHaveTextContent('이 폴더 설명서(CLAUDE.md)를 만들어요')
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

describe('slashEntry — / 목록에 무엇을 보이나', () => {
  it('끝에 출처 꼬리표가 있으면 사용자 명령·스킬 — 그 설명 그대로', async () => {
    const { slashEntry } = await import('../../src/renderer/panel/SlashMenu')
    expect(slashEntry(cmd('commit', '커밋 메시지를 써 줘요 (user)'))).toEqual({ name: 'commit', text: '커밋 메시지를 써 줘요 (user)' })
    expect(slashEntry(cmd('canary', 'Watch after deploy (gstack) (user)'))).toEqual({ name: 'canary', text: 'Watch after deploy (gstack) (user)' })
    expect(slashEntry(cmd('lint', 'Run the linter (project)'))).toEqual({ name: 'lint', text: 'Run the linter (project)' })
    // 같은 이름이 기본 목록에 있어도 꼬리표가 있으면 사용자 것
    expect(slashEntry(cmd('review', '내 검토 순서 (user)'))).toEqual({ name: 'review', text: '내 검토 순서 (user)' })
  })

  it('꼬리표 없는 기본 명령은 두레에서 쓸 수 있는 것만 — 한국어 설명', async () => {
    const { slashEntry } = await import('../../src/renderer/panel/SlashMenu')
    expect(slashEntry(cmd('compact', 'Clear conversation history but keep a summary'))).toEqual({ name: 'compact', text: '대화를 요약해 용량을 줄여요' })
    expect(slashEntry(cmd('init', 'Initialize a new CLAUDE.md file'))).toEqual({ name: 'init', text: '이 폴더 설명서(CLAUDE.md)를 만들어요' })
    expect(slashEntry(cmd('review', 'Review a pull request'))).toEqual({ name: 'review', text: '바뀐 내용을 검토해요' })
    expect(slashEntry(cmd('clear', 'Clear conversation history'))).toEqual({ name: 'clear', text: '새 대화 시작' })
    expect(slashEntry(cmd('model', 'Set the AI model'))).toEqual({ name: 'model', text: '모델 고르기' })
  })

  it.each(['config', 'copy', 'cost', 'context', 'doctor'])('꼬리표 없는 %s 는 숨긴다', async name => {
    const { slashEntry } = await import('../../src/renderer/panel/SlashMenu')
    expect(slashEntry(cmd(name, 'Some built-in thing'))).toBeNull()
  })

  // 실제 claude 2.1.270 initialize 목록의 모양
  it('이름에 : 이 있으면 설치한 플러그인 스킬 — 꼬리표가 없어도 그 설명 그대로', async () => {
    const { slashEntry } = await import('../../src/renderer/panel/SlashMenu')
    const d = 'You MUST use this before any creative work'
    expect(slashEntry(cmd('superpowers:brainstorming', d))).toEqual({ name: 'superpowers:brainstorming', text: d })
    expect(slashEntry(cmd('code-review:code-review', 'Review the current diff'))).toEqual({ name: 'code-review:code-review', text: 'Review the current diff' })
  })

  it('마지막 꼬리표가 (user)·(project) 일 때만 사용자 것 — 다른 괄호 꼬리표는 기본 명령이라 숨긴다', async () => {
    const { slashEntry } = await import('../../src/renderer/panel/SlashMenu')
    expect(slashEntry(cmd('x', 'Watch after deploy (gstack) (user)'))).toEqual({ name: 'x', text: 'Watch after deploy (gstack) (user)' })
    expect(slashEntry(cmd('fork', 'Fork this conversation (dynamic workflow)'))).toBeNull()
    expect(slashEntry(cmd('resume', 'Resume a conversation (resumable with /resume)'))).toBeNull()
    expect(slashEntry(cmd('sync', 'Sync settings (claude.ai sync)'))).toBeNull()
    expect(slashEntry(cmd('mine', 'My helper (user) note'))).toBeNull() // (user) 가 끝이 아니면 아니다
  })

  it('꼬리표 없는 config 는 숨기고 compact 는 한국어로', async () => {
    const { slashEntry } = await import('../../src/renderer/panel/SlashMenu')
    expect(slashEntry(cmd('config', 'Open config panel'))).toBeNull()
    expect(slashEntry(cmd('compact', 'Clear conversation history but keep a summary in context'))).toEqual({
      name: 'compact', text: '대화를 요약해 용량을 줄여요',
    })
  })
})

describe('Composer — /clear · /model 은 목록과 상관없이 두레가 처리', () => {
  /** 목록을 받는 중(describe 가 끝나지 않음) */
  const describeHangs = () => api.describe.mockReturnValueOnce(new Promise<AgentDescription>(() => {}))

  it('목록을 받는 중에 /clear + Enter — 확인을 거쳐 newConversation, Claude 에는 보내지 않는다', async () => {
    describeHangs()
    await renderPanel()
    type('/clear')
    await settle()
    expect(within(menu()!).getByText('명령을 불러오는 중…')).toBeInTheDocument()
    key('Enter')
    const dlg = screen.getByRole('alertdialog', { name: '지금까지 대화를 접고 새로 시작할까요?' })
    expect(input().value).toBe('')
    fireEvent.click(within(dlg).getByRole('button', { name: '새로 시작' }))
    await settle()
    expect(api.newConversation).toHaveBeenCalledWith('w')
    expect(api.sendUser).not.toHaveBeenCalled()
  })

  it('Esc 로 목록을 닫은 뒤 보내기 버튼으로도 · 앞뒤 공백이 있어도 같다', async () => {
    await renderPanel()
    type('/clear')
    await settle()
    key('Escape')
    expect(menu()).toBeNull()
    fireEvent.click(sendButton())
    const dlg = screen.getByRole('alertdialog', { name: '지금까지 대화를 접고 새로 시작할까요?' })
    fireEvent.click(within(dlg).getByRole('button', { name: '취소' }))

    type('  /clear \n')
    key('Enter')
    expect(screen.getByRole('alertdialog', { name: '지금까지 대화를 접고 새로 시작할까요?' })).toBeInTheDocument()
    expect(api.sendUser).not.toHaveBeenCalled()
  })

  it('목록을 받는 중에 /model + Enter — 모델 목록을 연다', async () => {
    describeHangs()
    await renderPanel()
    type('/model')
    await settle()
    key('Enter')
    await settle()
    expect(screen.getByRole('menu', { name: '모델' })).toBeInTheDocument()
    expect(input().value).toBe('')
    expect(api.sendUser).not.toHaveBeenCalled()
  })

  it('/model <이름> — 그 모델로 바꾸고(setModel) 보내지 않는다 · default 는 기본(null)', async () => {
    await renderPanel()
    type('/model sonnet')
    key('Enter')
    await settle()
    expect(api.setModel).toHaveBeenCalledWith('w', 'sonnet')
    expect(input().value).toBe('')
    type('/model default')
    key('Enter')
    await settle()
    expect(api.setModel).toHaveBeenLastCalledWith('w', null)
    expect(api.sendUser).not.toHaveBeenCalled()
  })

  it('/model <이름> 이 실패하면 엔진 문구를 입력창 아래에 — 입력은 남긴다', async () => {
    api.setModel.mockRejectedValueOnce(new Error('모르는 모델이에요: gpt'))
    await renderPanel()
    type('/model gpt')
    key('Enter')
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('모르는 모델이에요: gpt')
    expect(input().value).toBe('/model gpt')
    expect(api.sendUser).not.toHaveBeenCalled()
  })

  it('/models · /clearly 같은 다른 이름은 그대로 보낸다', async () => {
    await renderPanel()
    type('/clearly')
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [{ type: 'text', text: '/clearly' }])
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

const png = (name = 'shot.png') => new File([new Uint8Array(10)], name, { type: 'image/png' })
const ready = (base64 = 'QUJD') => ({ mediaType: 'image/png', base64, bytes: 3, blob: new Blob([base64], { type: 'image/png' }) })
const fileInput = (c: HTMLElement) => c.querySelector('input[type="file"]') as HTMLInputElement
const chips = () => screen.queryAllByRole('img', { name: /붙인 이미지/ })

describe('Composer — 이미지', () => {

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
    expect(chips()[0]).toHaveAttribute('src', 'blob:dure/1')
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

describe('Composer — 에이전트마다 쓰던 글·이미지(이번 실행 동안)', () => {
  const box = (name: string) => screen.getByRole('textbox', { name: `${name}에게 보낼 메시지` }) as HTMLTextAreaElement
  const select = async (store: { selectAgent(id: string): void }, id: string) => {
    await act(async () => { store.selectAgent(id) })
    await settle()
  }

  it('A 에서 쓰던 글과 이미지 칩은 B 에 갔다 와도 그대로 — B 는 B 의 것', async () => {
    prep.mockResolvedValue(ready())
    const { container, store } = await renderPanel('w')
    type('헤더를 고쳐 줘')
    fireEvent.change(fileInput(container), { target: { files: [png()] } })
    await settle()
    expect(chips()).toHaveLength(1)

    await select(store, 'p')
    expect(box('기획').value).toBe('')
    expect(chips()).toHaveLength(0)
    fireEvent.change(box('기획'), { target: { value: '문구를 다듬어 줘' } })

    await select(store, 'w')
    expect(box('웹 화면').value).toBe('헤더를 고쳐 줘')
    expect(chips()).toHaveLength(1)
    expect(chips()[0]).toHaveAttribute('src', 'blob:dure/1')
    expect(sendButton()).toBeEnabled()

    await select(store, 'p')
    expect(box('기획').value).toBe('문구를 다듬어 줘')
    expect(created).toHaveLength(1) // 오가도 미리보기를 다시 만들지 않는다
    expect(revoked).toEqual([])
  })

  it('보내면 그 에이전트의 것만 비운다', async () => {
    prep.mockResolvedValue(ready())
    const { container, store } = await renderPanel('w')
    type('웹 화면에 남을 글')
    await select(store, 'p')
    fireEvent.change(box('기획'), { target: { value: '기획에게 보낼 글' } })
    fireEvent.change(fileInput(container), { target: { files: [png()] } })
    await settle()
    fireEvent.keyDown(box('기획'), { key: 'Enter' })
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('p', [
      { type: 'image', mediaType: 'image/png', base64: 'QUJD' },
      { type: 'text', text: '기획에게 보낼 글' },
    ])
    expect(box('기획').value).toBe('')
    expect(chips()).toHaveLength(0)
    expect(revoked).toEqual(['blob:dure/1']) // 보낸 이미지의 미리보기는 놓아 준다

    await select(store, 'w')
    expect(box('웹 화면').value).toBe('웹 화면에 남을 글')
    await select(store, 'p')
    expect(box('기획').value).toBe('') // 다시 가도 비어 있다
  })

  it('미리보기 주소는 붙일 때 한 번 — 글을 쳐도 다시 만들지 않고, 지우면 놓아 준다', async () => {
    const r = ready()
    prep.mockResolvedValue(r)
    const { container } = await renderPanel('w')
    fireEvent.change(fileInput(container), { target: { files: [png()] } })
    await settle()
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(created[0]).toBe(r.blob) // 보낼 그 이미지로
    for (const t of ['이', '이 화', '이 화면', '이 화면 봐 줘']) type(t)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(chips()[0]).toHaveAttribute('src', 'blob:dure/1')
    expect(revoked).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '이미지 지우기' }))
    expect(revoked).toEqual(['blob:dure/1'])
  })

  it('에이전트가 지워지면 그 에이전트의 쓰던 글·이미지도 버리고 미리보기를 놓아 준다', async () => {
    prep.mockResolvedValue(ready())
    const { container, store } = await renderPanel('w')
    fireEvent.change(fileInput(container), { target: { files: [png()] } })
    await settle()
    await select(store, 'p')
    snapshot = { ...snapshot, agents: snapshot.agents.filter(a => a.id !== 'w') }
    await act(async () => { await store.refresh() })
    expect(revoked).toEqual(['blob:dure/1'])
  })

  it('다른 에이전트로 간 사이 이미지 준비가 끝나도 그 에이전트 칩으로 남는다', async () => {
    let done!: (v: unknown) => void
    prep.mockReturnValueOnce(new Promise(r => { done = r }))
    const { container, store } = await renderPanel('w')
    fireEvent.change(fileInput(container), { target: { files: [png()] } })
    await settle()
    await select(store, 'p')
    await act(async () => { done(ready()) })
    expect(chips()).toHaveLength(0) // 기획 입력창엔 없다
    await select(store, 'w')
    expect(chips()).toHaveLength(1)
  })
})
