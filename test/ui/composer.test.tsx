import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { AgentDescription, EngineEventMap, UserPart } from '../../src/engine/types'
import type { AgentView, Snapshot } from '../../src/shared/ipcContract'
import { ATTACH_MAX_BYTES, ATTACH_TOO_BIG } from '../../src/shared/attachments'
import { IMAGE_TOO_BIG } from '../../src/renderer/lib/image'

// 이미지 줄이기는 image.test 가 따로 본다 — 여기선 그 결과만 정해 준다(jsdom 엔 캔버스가 없다)
const prep = vi.hoisted(() => vi.fn())
vi.mock('../../src/renderer/lib/image', async orig => ({ ...(await orig<object>()), prepareImage: prep }))

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id, roomId: 'r1', name: id, role: '역할', folder: 'C:\\w', sessionId: 's', started: true, auto: false, model: null,
  alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, bypassOn: false, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, bypassBySettings: false, bypassPending: false, heldInput: 0, planMode: false, asleep: false, waking: false, hold: null, subagentsRunning: [], pastCount: 0, remoteIssue: null, ...over,
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
let api: Record<'sendUser' | 'describe' | 'newConversation' | 'setModel' | 'setPlanMode' | 'interrupt', ReturnType<typeof vi.fn>>
/** preload 의 webUtils.getPathForFile 흉내 — 디스크 파일이면 경로, noPath 에 넣은 것(붙여 넣은 그림 등)은 '' */
let pathForFile: ReturnType<typeof vi.fn>
let noPath: WeakSet<File>

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
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  api = {
    sendUser: vi.fn(async (_id: string, _parts: UserPart[]) => {}),
    describe: vi.fn(async (_id: string) => DESC),
    newConversation: vi.fn(async (_id: string) => {}),
    setModel: vi.fn(async (_id: string, _model: string | null) => {}),
    setPlanMode: vi.fn(async (_id: string, _on: boolean) => {}),
    interrupt: vi.fn(async (_id: string) => {}),
  }
  pathForFile = vi.fn((f: File) => (noPath.has(f) ? '' : `C:\\files\\${f.name}`))
  noPath = new WeakSet()
  ;(window as any).dure = {
    ...api,
    pathForFile,
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

  it('휴대폰 — 보냈는데 답 전에 끊기면(보냈는지 모름) 그 글을 보이고 입력은 남긴다(기록을 보고 다시 보낼지 정하게)', async () => {
    const { PHONE_UNSURE } = await import('../../src/renderer/mobile/wsApi')
    api.sendUser.mockRejectedValueOnce(new Error(PHONE_UNSURE))
    await renderPanel()
    type('배포해 줘')
    key('Enter')
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('보냈는지 확인하지 못했어요 — 기록을 확인해 주세요')
    expect(input().value).toBe('배포해 줘')
    expect(sendButton()).toBeEnabled()
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
    // 영어 출처 꼬리표 대신 작은 한국어 출처 — 설명 끝의 (user) 는 떼고 '내 명령'
    expect(options()[1]).toHaveTextContent('커밋 메시지를 써 줘요')
    expect(options()[1]).not.toHaveTextContent('(user)')
    expect(options()[1].querySelector('.sl-src')).toHaveTextContent('내 명령')
    expect(options()[0].querySelector('.sl-src')).toBeNull() // 기본 명령(/compact)엔 출처가 없다
    type('/con')
    expect(menu()).toBeNull() // context · config 는 두레에선 쓸 수 없는 기본 명령
  })

  it('이름 가운데 글자로도 거른다 — 앞부분이 맞는 것이 먼저', async () => {
    await renderPanel()
    type('/rev')
    await settle()
    expect(names()).toEqual(['/review', '/code-review']) // 받은 순서는 code-review 가 먼저
    type('/check')
    expect(names()).toEqual(['/color-check'])
    type('/view')
    expect(names()).toEqual(['/code-review', '/review'])
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
  it('끝에 출처 꼬리표가 있으면 사용자 명령·스킬 — 끝의 괄호 꼬리표는 떼고, 출처는 한국어로(user → 내 명령 · project → 이 프로젝트)', async () => {
    const { slashEntry } = await import('../../src/renderer/panel/SlashMenu')
    expect(slashEntry(cmd('commit', '커밋 메시지를 써 줘요 (user)'))).toEqual({ name: 'commit', text: '커밋 메시지를 써 줘요', source: '내 명령' })
    expect(slashEntry(cmd('canary', 'Watch after deploy (gstack) (user)'))).toEqual({ name: 'canary', text: 'Watch after deploy', source: '내 명령' })
    expect(slashEntry(cmd('lint', 'Run the linter (project)'))).toEqual({ name: 'lint', text: 'Run the linter', source: '이 프로젝트' })
    // 같은 이름이 기본 목록에 있어도 꼬리표가 있으면 사용자 것
    expect(slashEntry(cmd('review', '내 검토 순서 (user)'))).toEqual({ name: 'review', text: '내 검토 순서', source: '내 명령' })
    // 설명 안의 한국어 괄호는 꼬리표가 아니다 — 남긴다
    expect(slashEntry(cmd('doc', '설명서(CLAUDE.md)를 고쳐요 (user)'))).toEqual({ name: 'doc', text: '설명서(CLAUDE.md)를 고쳐요', source: '내 명령' })
    expect(slashEntry(cmd('only', '(user)'))).toEqual({ name: 'only', text: '', source: '내 명령' })
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
  it('이름에 : 이 있으면 설치한 플러그인 스킬 — 꼬리표가 없어도 보이고, 출처는 : 앞 플러그인 이름(괄호 없이)', async () => {
    const { slashEntry } = await import('../../src/renderer/panel/SlashMenu')
    const d = 'You MUST use this before any creative work'
    expect(slashEntry(cmd('superpowers:brainstorming', d))).toEqual({ name: 'superpowers:brainstorming', text: d, source: 'superpowers' })
    expect(slashEntry(cmd('code-review:code-review', 'Review the current diff'))).toEqual({
      name: 'code-review:code-review', text: 'Review the current diff', source: 'code-review',
    })
    // 플러그인 스킬 설명 끝에 출처 꼬리표가 붙어 와도 떼고, 출처는 플러그인 이름
    expect(slashEntry(cmd('gsd:plan', 'Plan a phase (user)'))).toEqual({ name: 'gsd:plan', text: 'Plan a phase', source: 'gsd' })
  })

  it('마지막 꼬리표가 (user)·(project) 일 때만 사용자 것 — 다른 괄호 꼬리표는 기본 명령이라 숨긴다', async () => {
    const { slashEntry } = await import('../../src/renderer/panel/SlashMenu')
    expect(slashEntry(cmd('x', 'Watch after deploy (gstack) (user)'))).toEqual({ name: 'x', text: 'Watch after deploy', source: '내 명령' })
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

describe('matchCommands — 이름 어디든 맞으면 보이고, 앞부분 → 낱말 머리 → 그 밖 순', () => {
  const mine = (name: string) => cmd(name, `${name} (user)`)
  const match = async (list: ReturnType<typeof cmd>[], q: string) => {
    const { matchCommands } = await import('../../src/renderer/panel/SlashMenu')
    return matchCommands(list, q).map(e => e.name)
  }

  it('가운데 낱말의 앞부분으로도 — 플러그인 스킬은 : 뒤 이름으로 찾는다', async () => {
    const list = [cmd('superpowers:brainstorming', 'Explore first'), mine('plan-eng-review'), cmd('review', 'Review a pull request')]
    expect(await match(list, 'brain')).toEqual(['superpowers:brainstorming'])
    expect(await match(list, 'eng')).toEqual(['plan-eng-review'])
    expect(await match(list, 'rev')).toEqual(['review', 'plan-eng-review'])
  })

  it('낱말 가운데 몇 글자로도 — 대소문자 무시', async () => {
    const list = [cmd('superpowers:brainstorming', 'Explore first'), mine('code-review')]
    expect(await match(list, 'storm')).toEqual(['superpowers:brainstorming'])
    expect(await match(list, 'VIEW')).toEqual(['code-review'])
  })

  it('받은 순서보다 맞는 자리가 먼저 — 앞부분 · 낱말 머리 · 그 밖(같은 자리끼리는 받은 순서)', async () => {
    const list = [mine('preview'), mine('x-view'), mine('preview-two'), mine('view'), mine('y_view')]
    expect(await match(list, 'view')).toEqual(['view', 'x-view', 'y_view', 'preview', 'preview-two'])
  })

  it('같은 글이 두 번 나오면 낱말 머리인 쪽으로 친다', async () => {
    expect(await match([mine('preview'), mine('preview-view')], 'view')).toEqual(['preview-view', 'preview'])
  })

  it('8개를 넘으면 맞는 자리가 좋은 것부터 8개 — 뒤에 받은 앞부분 일치도 빠지지 않는다', async () => {
    const list = [...Array.from({ length: 9 }, (_, i) => mine(`a${i}-xlint`)), mine('lint')]
    const got = await match(list, 'lint')
    expect(got).toHaveLength(8)
    expect(got[0]).toBe('lint')
  })

  it('숨는 기본 명령은 가운데가 맞아도 숨는다', async () => {
    expect(await match([cmd('context', 'Visualize current context usage'), mine('my-context')], 'text')).toEqual(['my-context'])
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
const pdf = (name = 'report.pdf', bytes = 1229) => new File([new Uint8Array(bytes)], name, { type: 'application/pdf' })
/** 큰 파일 — 바이트는 만들지 않고 크기만(jsdom 의 File.size 를 덮는다) */
const sized = (name: string, size: number, type = 'application/zip') => {
  const f = new File([], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}
const fileChips = () => Array.from(document.querySelectorAll('.att-file')) as HTMLElement[]
/** 파일 칩의 [이름, 아랫줄(크기 또는 오류)] */
const chipText = (c: HTMLElement) => [c.querySelector('.af-n')!.textContent, c.querySelector('.af-m')!.textContent]

describe('Composer — 이미지', () => {

  it('파일 첨부 단추 → 파일 고르기 → 그림은 미리보기 칩, 보내면 이미지가 먼저 · 글이 뒤', async () => {
    prep.mockResolvedValue(ready())
    const { container } = await renderPanel()
    const pick = screen.getByRole('button', { name: '파일 첨부' })
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

  it('붙인 썸네일을 누르면 크게 — 여러 장이면 누른 것부터, 지우기(×)는 그대로', async () => {
    prep.mockResolvedValueOnce(ready('QQ==')).mockResolvedValueOnce(ready('Qg=='))
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [png('a.png'), png('b.png')] } })
    await settle()
    expect(chips()).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '붙인 이미지 2 크게 보기' }))
    const dlg = screen.getByRole('dialog', { name: '이미지 보기' })
    expect(dlg.querySelector('.iv-img')).toHaveAttribute('src', chips()[1].getAttribute('src'))
    expect(dlg).toHaveTextContent('2 / 2')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getAllByRole('button', { name: '이미지 지우기' })).toHaveLength(2)
  })

  it('경로가 없는 그림(붙여 넣은 것)을 못 붙이면 그 문구 — 칩도 없고 원본도 보내지 않는다', async () => {
    prep.mockResolvedValue({ error: '이미지가 너무 커요 — 더 작은 이미지를 붙여 주세요' })
    await renderPanel()
    const huge = png('huge.png')
    noPath.add(huge)
    fireEvent.paste(input(), { clipboardData: { files: [huge], types: ['Files'], getData: () => '' } })
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('이미지가 너무 커요 — 더 작은 이미지를 붙여 주세요')
    expect(chips()).toHaveLength(0)
    expect(fileChips()).toHaveLength(0)
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

describe('Composer — 파일 첨부', () => {
  const select = async (store: { selectAgent(id: string): void }, id: string) => {
    await act(async () => { store.selectAgent(id) })
    await settle()
  }

  it('단추는 "파일 첨부"(툴팁도) — 고르기 창은 종류 제한 없이 여러 개', async () => {
    const { container } = await renderPanel()
    expect(screen.getByRole('button', { name: '파일 첨부' })).toHaveAttribute('title', '파일 첨부')
    expect(screen.queryByRole('button', { name: '이미지 붙여 넣기' })).toBeNull()
    const fi = fileInput(container)
    expect(fi).not.toHaveAttribute('accept')
    expect(fi.multiple).toBe(true)
  })

  it('고르기 — 그림은 그림 칩, pdf 는 파일 칩(이름 · 크기 · 빼기)', async () => {
    prep.mockResolvedValue(ready())
    const { container } = await renderPanel()
    const doc = pdf('report.pdf', 1229)
    fireEvent.change(fileInput(container), { target: { files: [png('a.png'), doc] } })
    await settle()
    expect(prep).toHaveBeenCalledTimes(1) // 그림만 그림 길로
    expect((prep.mock.calls[0][0] as File).name).toBe('a.png')
    expect(chips()).toHaveLength(1)
    expect(fileChips()).toHaveLength(1)
    expect(chipText(fileChips()[0])).toEqual(['report.pdf', '1.2 KB'])
    expect(fileChips()[0]).toHaveAttribute('title', 'report.pdf')
    expect(pathForFile).toHaveBeenCalledWith(doc)
    // 고른 차례 그대로 — 그림 칩 다음 파일 칩
    expect([...container.querySelector('.atts')!.children].map(e => (e.classList.contains('att-file') ? 'file' : 'img'))).toEqual(['img', 'file'])
    expect(sendButton()).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'report.pdf 빼기' }))
    expect(fileChips()).toHaveLength(0)
    expect(chips()).toHaveLength(1)
  })

  it('끌어다 놓기도 같음 — 종류를 모르는 파일도 파일 칩', async () => {
    prep.mockResolvedValue(ready())
    await renderPanel()
    const box = input().closest('.box')!
    fireEvent.dragOver(box, { dataTransfer: { types: ['Files'], files: [] } })
    expect(box).toHaveClass('drop')
    const files = [png('a.png'), pdf('spec.pdf', 512), new File(['# 메모'], 'notes.md', { type: 'text/markdown' }), new File(['all:'], 'Makefile')]
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files } })
    await settle()
    expect(box).not.toHaveClass('drop')
    expect(prep).toHaveBeenCalledTimes(1)
    expect(chips()).toHaveLength(1)
    expect(fileChips().map(chipText)).toEqual([['spec.pdf', '512 B'], ['notes.md', '8 B'], ['Makefile', '4 B']])
  })

  it('100MB 정확히 됨 · 100MB+1 막음', async () => {
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [sized('exact.zip', ATTACH_MAX_BYTES)] } })
    await settle()
    expect(chipText(fileChips()[0])).toEqual(['exact.zip', '100 MB'])
    expect(fileChips()[0]).not.toHaveClass('bad')
    expect(sendButton()).toBeEnabled()

    fireEvent.change(fileInput(container), { target: { files: [sized('over.zip', ATTACH_MAX_BYTES + 1)] } })
    await settle()
    const over = fileChips()[1]
    expect(over).toHaveClass('bad')
    expect(within(over).getByRole('alert')).toHaveTextContent(ATTACH_TOO_BIG)
    expect(ATTACH_TOO_BIG).toBe('100MB 보다 큰 파일은 보낼 수 없어요')
    type('같이 보내 줘')
    expect(sendButton()).toBeDisabled()
    key('Enter')
    await settle()
    expect(api.sendUser).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'over.zip 빼기' }))
    expect(sendButton()).toBeEnabled()
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [
      { type: 'text', text: '같이 보내 줘' },
      { type: 'file', path: 'C:\\files\\exact.zip', name: 'exact.zip', bytes: ATTACH_MAX_BYTES },
    ])
  })

  it('상한 넘는 그림 — 파일 칩으로(거절하지 않고 경로 줄로 보낸다)', async () => {
    prep.mockResolvedValue({ error: IMAGE_TOO_BIG })
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [png('huge.png')] } })
    await settle()
    expect(chips()).toHaveLength(0)
    expect(screen.queryByRole('status', { name: '이미지 준비 중' })).toBeNull()
    expect(fileChips().map(chipText)).toEqual([['huge.png', '10 B']])
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(sendButton())
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [{ type: 'file', path: 'C:\\files\\huge.png', name: 'huge.png', bytes: 10 }])
  })

  it('경로를 모르는 파일(디스크 파일이 아님)은 칩 없이 안내', async () => {
    await renderPanel()
    const blob = pdf('clip.pdf')
    noPath.add(blob)
    fireEvent.paste(input(), { clipboardData: { files: [blob], types: ['Files'], getData: () => '' } })
    await settle()
    expect(fileChips()).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent('이 파일은 붙일 수 없어요 — 저장한 뒤 파일 첨부 단추로 골라 주세요')
  })

  it('폴더를 끌어다 놓으면 칩 없이 안내 — 같이 놓은 파일은 칩으로(폴더가 0 B 칩이 되지 않게)', async () => {
    await renderPanel()
    const box = input().closest('.box')!
    const entry = (isDirectory: boolean) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory, isFile: !isDirectory }) })
    // 폴더도 files 에 크기 0 의 File 로 끼어 온다 — items 의 같은 자리에서 폴더인지 안다
    const folder = new File([], '시안 모음', { type: '' })
    const drop = fireEvent.drop(box, {
      dataTransfer: { types: ['Files'], files: [folder, pdf('spec.pdf', 512)], items: [entry(true), entry(false)] },
    })
    await settle()
    expect(drop).toBe(false) // 기본 동작(파일 열기)을 막았다
    expect(fileChips().map(chipText)).toEqual([['spec.pdf', '512 B']])
    expect(screen.getByRole('alert')).toHaveTextContent('폴더는 보낼 수 없어요')

    // 폴더만 놓아도 — 칩 없이 안내, 기본 동작은 막는다
    fireEvent.click(screen.getByRole('button', { name: 'spec.pdf 빼기' }))
    const only = fireEvent.drop(box, { dataTransfer: { types: ['Files'], files: [folder], items: [entry(true)] } })
    await settle()
    expect(only).toBe(false)
    expect(fileChips()).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent('폴더는 보낼 수 없어요')
  })

  it('보내기 — sendUser 에 file part(path·name·bytes) · 그림 → 글 → 파일 차례, 보내면 칩을 비운다', async () => {
    prep.mockResolvedValue(ready())
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [pdf('보고서 최종.pdf', 2048), png('a.png')] } })
    await settle()
    type('둘 다 읽어 줘')
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [
      { type: 'image', mediaType: 'image/png', base64: 'QUJD' },
      { type: 'text', text: '둘 다 읽어 줘' },
      { type: 'file', path: 'C:\\files\\보고서 최종.pdf', name: '보고서 최종.pdf', bytes: 2048 },
    ])
    expect(fileChips()).toHaveLength(0)
    expect(chips()).toHaveLength(0)
    expect(input().value).toBe('')
  })

  it('보내기 실패 — 오류 줄에 엔진 글 그대로, 글·칩 그대로(다시 보내면 같은 것)', async () => {
    api.sendUser.mockRejectedValueOnce(new Error('파일을 보내지 못했어요 — report.pdf: 찾을 수 없어요'))
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [pdf()] } })
    await settle()
    type('읽어 줘')
    key('Enter')
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('파일을 보내지 못했어요 — report.pdf: 찾을 수 없어요')
    expect(input().value).toBe('읽어 줘')
    expect(fileChips().map(chipText)).toEqual([['report.pdf', '1.2 KB']])
    expect(sendButton()).toBeEnabled()
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledTimes(2)
    expect(api.sendUser.mock.calls[1][1]).toEqual(api.sendUser.mock.calls[0][1])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('보내는 중 — "보내는 중…" · 다른 카드에 갔다 와도 그대로(두 번 보내지 않는다) · 끝나면 비운다', async () => {
    let done!: () => void
    api.sendUser.mockReturnValueOnce(new Promise<void>(r => { done = r }))
    const { container, store } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [pdf()] } })
    await settle()
    type('읽어 줘')
    key('Enter')
    await settle()
    expect(screen.getByText('보내는 중…')).toHaveAttribute('role', 'status')
    expect(sendButton()).toBeDisabled()
    // 이미 보내는 칩은 뺄 수 없다 — 빼도 그 파일은 간다(뺀 줄 알게 하지 않는다)
    expect(screen.getByRole('button', { name: 'report.pdf 빼기' })).toBeDisabled()

    await select(store, 'p')
    expect(screen.queryByText('보내는 중…')).toBeNull() // 기획은 보내는 게 없다
    await select(store, 'w')
    expect(screen.getByText('보내는 중…')).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    expect(input()).toHaveAttribute('readonly')
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledTimes(1)

    await act(async () => { done() })
    expect(screen.queryByText('보내는 중…')).toBeNull()
    expect(fileChips()).toHaveLength(0)
    expect(input().value).toBe('')
  })

  it('보내는 사이 다른 카드로 갔어도 실패 글은 그 에이전트 입력창에 남는다', async () => {
    let fail!: (e: Error) => void
    api.sendUser.mockReturnValueOnce(new Promise<void>((_, rej) => { fail = rej }))
    const { container, store } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [pdf()] } })
    await settle()
    fireEvent.click(sendButton())
    await settle()
    await select(store, 'p')
    await act(async () => { fail(new Error('파일을 보내지 못했어요 — report.pdf: dev 연결이 끊겼어요 — 다시 보내면 이어서 해요')) })
    expect(screen.queryByRole('alert')).toBeNull() // 기획 입력창엔 없다
    await select(store, 'w')
    expect(screen.getByRole('alert')).toHaveTextContent('파일을 보내지 못했어요 — report.pdf: dev 연결이 끊겼어요 — 다시 보내면 이어서 해요')
    expect(fileChips()).toHaveLength(1)
    expect(sendButton()).toBeEnabled()
    expect(screen.getByRole('button', { name: 'report.pdf 빼기' })).toBeEnabled()
  })

  it('첨부를 보내는 중엔 쉬는 에이전트여도 멈출 수 있다 — 머리의 멈추기 · Esc', async () => {
    let fail!: (e: Error) => void
    api.sendUser.mockReturnValueOnce(new Promise<void>((_, rej) => { fail = rej }))
    const { container } = await renderPanel()
    const stop = screen.getByRole('button', { name: '멈추기' })
    expect(stop).toBeDisabled() // 쉬는 중 — 멈출 것이 없다
    fireEvent.change(fileInput(container), { target: { files: [pdf()] } })
    await settle()
    fireEvent.click(sendButton())
    await settle()
    expect(stop).toBeEnabled()
    await act(async () => { fireEvent.click(stop) })
    expect(api.interrupt).toHaveBeenCalledWith('w')
    key('Escape')
    await settle()
    expect(api.interrupt).toHaveBeenCalledTimes(2)
    await act(async () => { fail(new Error('파일을 보내지 못했어요 — report.pdf: 서버로 올리는 중에 그만뒀어요')) })
    expect(stop).toBeDisabled()
    expect(fileChips()).toHaveLength(1)
  })

  it('글만 보낼 땐 "보내는 중…"을 띄우지 않는다', async () => {
    let done!: () => void
    api.sendUser.mockReturnValueOnce(new Promise<void>(r => { done = r }))
    await renderPanel()
    type('안녕')
    key('Enter')
    await settle()
    expect(screen.queryByText('보내는 중…')).toBeNull()
    await act(async () => { done() })
  })

  it('보내는 중에 새로 붙인 칩은 뺄 수 있다 — 가는 칩만 빼기를 막고, 끝나면 새 칩은 남는다', async () => {
    let done!: () => void
    api.sendUser.mockReturnValueOnce(new Promise<void>(r => { done = r }))
    prep.mockResolvedValue(ready())
    const { container, store } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [pdf()] } })
    await settle()
    key('Enter')
    await settle()
    expect(screen.getByText('보내는 중…')).toBeInTheDocument()
    fireEvent.change(fileInput(container), { target: { files: [pdf('more.pdf', 512), pdf('extra.pdf', 256), png('b.png')] } })
    await settle()
    expect(screen.getByRole('button', { name: 'report.pdf 빼기' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'more.pdf 빼기' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '이미지 지우기' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'extra.pdf 빼기' }))
    expect(fileChips().map(c => chipText(c)[0])).toEqual(['report.pdf', 'more.pdf'])

    // 다른 카드에 갔다 와도 — 가는 칩만 막힌 채
    await select(store, 'p')
    await select(store, 'w')
    expect(screen.getByRole('button', { name: 'report.pdf 빼기' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'more.pdf 빼기' })).toBeEnabled()

    await act(async () => { done() })
    expect(fileChips().map(c => chipText(c)[0])).toEqual(['more.pdf'])
    expect(chips()).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'more.pdf 빼기' })).toBeEnabled()
    expect(sendButton()).toBeEnabled()
  })

  it('칩을 빼면 오류 줄을 지운다', async () => {
    api.sendUser.mockRejectedValueOnce(new Error('파일을 보내지 못했어요 — report.pdf: 찾을 수 없어요'))
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [pdf(), pdf('notes.md', 8)] } })
    await settle()
    fireEvent.click(sendButton())
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('파일을 보내지 못했어요 — report.pdf: 찾을 수 없어요')
    fireEvent.click(screen.getByRole('button', { name: 'report.pdf 빼기' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fileChips().map(c => chipText(c)[0])).toEqual(['notes.md'])
  })

  it('칩을 붙이면 새 칩이 보이게 — 오류 칩이 있으면 그것도(칸이 넘쳐 안에서 스크롤할 때)', async () => {
    let seen: Element[] = []
    const into = vi.fn(function (this: Element, _o?: ScrollIntoViewOptions) { seen.push(this) })
    ;(HTMLElement.prototype as any).scrollIntoView = into
    try {
      const { container } = await renderPanel()
      fireEvent.change(fileInput(container), { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } })
      await settle()
      const named = (n: string) => fileChips().find(c => chipText(c)[0] === n)
      expect(seen.at(-1)).toBe(named('b.pdf')) // 가장 새 칩
      expect(into).toHaveBeenLastCalledWith({ block: 'nearest' })

      seen = []
      into.mockClear()
      fireEvent.change(fileInput(container), { target: { files: [sized('over.zip', ATTACH_MAX_BYTES + 1), pdf('c.pdf')] } })
      await settle()
      // 새 칩 다음에 첫 오류 칩 — 둘 다 들어가지 않으면 보내기를 막은 까닭이 보이게
      expect(seen).toEqual([named('c.pdf'), named('over.zip')])
      expect(into.mock.calls.every(c => c[0]?.block === 'nearest')).toBe(true)

      // 칩을 빼거나 글을 쳐도 다시 스크롤하지 않는다
      seen = []
      into.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'c.pdf 빼기' }))
      type('같이')
      await settle()
      expect(into).not.toHaveBeenCalled()
    } finally {
      delete (HTMLElement.prototype as any).scrollIntoView
    }
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

describe('Composer — context 링', () => {
  const withCtx = (over: Partial<AgentView> = {}) => {
    snapshot = {
      ...snapshot,
      agents: snapshot.agents.map(a => (a.id === 'w'
        ? { ...a, lastContext: { total: 340000, max: 1_000_000, percent: 34, autoCompactAt: 967_000, at: 1 }, ...over }
        : a)),
    }
  }

  it('lastContext 가 없으면 링이 없다', async () => {
    await renderPanel()
    expect(screen.queryByRole('button', { name: /^대화 공간/ })).toBeNull()
  })

  it('있으면 보내기 단추 바로 앞에 있다', async () => {
    withCtx()
    await renderPanel()
    const ring = screen.getByRole('button', { name: '대화 공간 34% 사용' })
    expect(ring.closest('.ctx')!.nextElementSibling).toBe(sendButton())
  })

  it('[지금 요약하기] 는 /compact 를 보낸다', async () => {
    withCtx()
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '대화 공간 34% 사용' }))
    fireEvent.click(screen.getByRole('button', { name: '지금 요약하기' }))
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [{ type: 'text', text: '/compact' }])
  })

  it('보내지 못하면 입력창 아래 오류 줄에 문구', async () => {
    withCtx()
    api.sendUser.mockRejectedValueOnce(new Error('지금은 보낼 수 없어요'))
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '대화 공간 34% 사용' }))
    fireEvent.click(screen.getByRole('button', { name: '지금 요약하기' }))
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('지금은 보낼 수 없어요')
  })

  it('일하는 중이면 요약을 막는다', async () => {
    withCtx({ status: 'working' })
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '대화 공간 34% 사용' }))
    expect(screen.getByRole('button', { name: '지금 요약하기' })).toBeDisabled()
  })

  it('승인을 기다리는 중이어도 요약을 막는다 — 같은 안내', async () => {
    withCtx()
    snapshot = {
      ...snapshot,
      requests: [{ id: 'q1', agentId: 'w', toolName: 'Write', input: { file_path: 'C:\\w\\a.ts' }, kind: 'permission', createdAt: Date.now() }],
    }
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '대화 공간 34% 사용' }))
    expect(screen.getByRole('button', { name: '지금 요약하기' })).toBeDisabled()
    expect(screen.getByText('일이 끝나면 요약할 수 있어요')).toBeInTheDocument()
  })
})

describe('Composer — 계획 먼저 · Esc 멈추기', () => {
  const planBtn = () => screen.getByRole('button', { name: '계획 먼저' })
  const NOTE = '계획을 보고 승인하기 전에는 파일을 고치거나 명령을 실행하지 않아요'

  it('계획 먼저 — 켜고 보내면 sendUser 에 {plan:true}, 보낸 뒤 꺼짐 · 자리표시·안내 줄', async () => {
    await renderPanel()
    expect(planBtn()).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText(NOTE)).toBeNull()
    fireEvent.click(planBtn())
    expect(planBtn()).toHaveAttribute('aria-pressed', 'true')
    expect(input()).toHaveAttribute('placeholder', '웹 화면에게 계획부터 세워 달라고 하기…')
    expect(screen.getByText(NOTE)).toBeInTheDocument()
    type('로그인 만들어 줘')
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [{ type: 'text', text: '로그인 만들어 줘' }], { plan: true })
    expect(planBtn()).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText(NOTE)).toBeNull()
    type('다음 일')
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenLastCalledWith('w', [{ type: 'text', text: '다음 일' }])
  })

  it('에이전트가 계획 모드면 켜진 채 — 누르면 setPlanMode(false)', async () => {
    snapshot.agents[0] = agent('w', { name: '웹 화면', planMode: true })
    await renderPanel()
    expect(planBtn()).toHaveAttribute('aria-pressed', 'true')
    type('이어서')
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [{ type: 'text', text: '이어서' }]) // 이미 계획 모드 — plan 옵션 없이
    fireEvent.click(planBtn())
    await settle()
    expect(api.setPlanMode).toHaveBeenCalledWith('w', false)
  })

  it('계획 모드를 못 끄면 입력창 아래에 오류 글', async () => {
    snapshot.agents[0] = agent('w', { name: '웹 화면', planMode: true })
    await renderPanel()
    api.setPlanMode.mockRejectedValueOnce(new Error('못 껐어요'))
    fireEvent.click(planBtn())
    await settle()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('계획 먼저 켬은 다른 에이전트에 갔다 와도 그대로(초안)', async () => {
    const { store } = await renderPanel('w')
    fireEvent.click(planBtn())
    await act(async () => { store.selectAgent('p') })
    await settle()
    expect(planBtn()).toHaveAttribute('aria-pressed', 'false')
    await act(async () => { store.selectAgent('w') })
    await settle()
    expect(planBtn()).toHaveAttribute('aria-pressed', 'true')
  })

  it('Esc — 일하는 중이면 멈추기, 쉬는 중·/ 목록이 열렸으면 아님', async () => {
    await renderPanel()
    key('Escape')
    expect(api.interrupt).not.toHaveBeenCalled() // 쉬는 중
    cleanup()
    snapshot.agents[0] = agent('w', { name: '웹 화면', status: 'working' })
    await renderPanel()
    key('Escape', { isComposing: true })
    expect(api.interrupt).not.toHaveBeenCalled()
    type('/co')
    await settle()
    key('Escape')
    expect(api.interrupt).not.toHaveBeenCalled() // 목록만 닫힌다
    type('')
    key('Escape')
    expect(api.interrupt).toHaveBeenCalledWith('w')
  })
})

describe('Composer — 휴대폰 첨부', () => {
  /** 휴대폰의 window.dure(wsApi) — PC 경로가 없어(pathForFile '') 파일 바이트를 PC 의 받은 폴더로 올린다 */
  const phone = (upload: (f: File) => Promise<{ path: string; name: string; bytes: number }>) => {
    const uploadFile = vi.fn(upload)
    ;(window as any).dure.pathForFile = () => ''
    ;(window as any).dure.uploadFile = uploadFile
    ;(window as any).dure[Symbol.for('dure.phone')] = true // 휴대폰 표시(createWsApi 가 붙인다)
    return uploadFile
  }

  it('휴대폰 — uploadFile 로 얻은 path 로 보냄', async () => {
    let finish!: () => void
    const uploadFile = phone(f => new Promise(r => { finish = () => r({ path: `C:\\dure\\inbox\\x-${f.name}`, name: f.name, bytes: f.size }) }))
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [pdf('보고서.pdf', 2048)] } })
    await settle()
    expect(uploadFile).toHaveBeenCalledTimes(1)
    // 올리는 동안 — 칩은 있되 '올리는 중…', 보내기는 막힘
    expect(fileChips()).toHaveLength(1)
    expect(chipText(fileChips()[0])).toEqual(['보고서.pdf', '올리는 중…'])
    type('읽어 줘')
    expect(sendButton()).toBeDisabled()
    await act(async () => { finish() })
    await settle()
    expect(chipText(fileChips()[0])).toEqual(['보고서.pdf', '2 KB'])
    expect(sendButton()).toBeEnabled()
    await act(async () => { fireEvent.click(sendButton()) })
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [
      { type: 'text', text: '읽어 줘' },
      { type: 'file', path: 'C:\\dure\\inbox\\x-보고서.pdf', name: '보고서.pdf', bytes: 2048 },
    ])
  })

  it('휴대폰 — Enter 는 줄바꿈(보내지 않는다 · 막지 않는다), 보내기는 단추로', async () => {
    phone(async f => ({ path: `C:\\inbox\\${f.name}`, name: f.name, bytes: f.size }))
    await renderPanel()
    type('첫 줄')
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input().dispatchEvent(ev)
    await settle()
    expect(ev.defaultPrevented).toBe(false) // 휴대폰 자판이 줄을 바꾼다
    expect(api.sendUser).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(sendButton()) })
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [{ type: 'text', text: '첫 줄' }])
  })

  it('휴대폰 — 올리는 중인 칩을 빼면 올리기를 끊는다(오류 줄 없이) · 다 올린 칩을 빼면 끊을 것이 없다', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const finish: (() => void)[] = []
    const uploadFile = phone((f, signal?: AbortSignal) => new Promise((resolve, reject) => {
      signals.push(signal)
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      finish.push(() => resolve({ path: `C:\\inbox\\${f.name}`, name: f.name, bytes: f.size }))
    }))
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [pdf('a.pdf')] } })
    await settle()
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(signals[0]?.aborted).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'a.pdf 빼기' }))
    await settle()
    expect(signals[0]?.aborted).toBe(true)
    expect(fileChips()).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()
    // 다 올린 뒤에 빼기 — 끊기 신호는 그대로(이미 끝남)
    fireEvent.change(fileInput(container), { target: { files: [pdf('b.pdf')] } })
    await settle()
    await act(async () => { finish[1]() })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'b.pdf 빼기' }))
    await settle()
    expect(signals[1]?.aborted).toBe(false)
  })

  it('PC 창은 그대로 — Enter 로 보내고 Shift+Enter 는 줄바꿈', async () => {
    await renderPanel()
    type('보내기')
    key('Enter', { shiftKey: true })
    await settle()
    expect(api.sendUser).not.toHaveBeenCalled()
    key('Enter')
    await settle()
    expect(api.sendUser).toHaveBeenCalledWith('w', [{ type: 'text', text: '보내기' }])
  })

  it('휴대폰 — 올리기 실패는 칩을 빼고 오류 줄 · 100MB 넘으면 올리지 않고 오류 칩', async () => {
    const uploadFile = phone(async () => { throw new Error('파일을 올리지 못했어요') })
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [pdf('a.pdf')] } })
    await settle()
    expect(fileChips()).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent('a.pdf — 파일을 올리지 못했어요')
    fireEvent.change(fileInput(container), { target: { files: [sized('big.zip', ATTACH_MAX_BYTES + 1)] } })
    await settle()
    expect(uploadFile).toHaveBeenCalledTimes(1) // 큰 파일은 올리지 않는다
    expect(chipText(fileChips()[0])).toEqual(['big.zip', ATTACH_TOO_BIG])
    expect(sendButton()).toBeDisabled()
  })

  it('휴대폰 — 그림은 그림 길 그대로(올리지 않음), 그림 길로 못 가는 그림은 올려서 파일로', async () => {
    const uploadFile = phone(async f => ({ path: `C:\\inbox\\${f.name}`, name: f.name, bytes: f.size }))
    prep.mockResolvedValueOnce(ready()).mockResolvedValueOnce({ error: IMAGE_TOO_BIG })
    const { container } = await renderPanel()
    fireEvent.change(fileInput(container), { target: { files: [png('a.png')] } })
    await settle()
    expect(chips()).toHaveLength(1)
    expect(uploadFile).not.toHaveBeenCalled()
    fireEvent.change(fileInput(container), { target: { files: [png('huge.png')] } })
    await settle()
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(chipText(fileChips()[0])).toEqual(['huge.png', '10 B'])
  })
})
