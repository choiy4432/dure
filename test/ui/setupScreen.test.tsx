import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { SetupState } from '../../src/shared/appTypes'

let setup: SetupState
/** appInfo 의 운영체제 — undefined 면 appInfo 가 없는 옛 api(받지 못함 → Windows 글) */
let platform: 'win32' | 'darwin' | undefined
let emit: (name: string, payload: unknown) => void
const api = { installClaude: vi.fn(async () => {}), loginClaude: vi.fn(async () => {}), openSetupGuide: vi.fn(async () => {}) }

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  platform = undefined
  const handlers: Record<string, (p: unknown) => void> = {}
  emit = (n, p) => handlers[n]?.(p)
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: true, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null }),
    history: async () => [], setupState: async () => setup,
    appInfo: async () => {
      if (!platform) throw new Error('없음')
      return { version: '0.1.0', packaged: true, platform }
    },
    on: (n: string, h: (p: unknown) => void) => { handlers[n] = h; return () => {} },
    ...api,
  }
})
afterEach(() => cleanup())

async function show(s: SetupState) {
  setup = s
  const { getStore } = await import('../../src/renderer/state/store')
  const { SetupScreen } = await import('../../src/renderer/shell/SetupScreen')
  await act(async () => { await getStore().init() })
  render(<SetupScreen />)
}
const needs = (install: any, login: any): SetupState => ({ phase: 'needs', install, login })

describe('SetupScreen — 준비 화면', () => {
  it('설치 전: 제목 둘, [설치], 2·3 칸은 흐림', async () => {
    await show(needs({ state: 'todo' }, { state: 'locked' }))
    expect(screen.getByText('두레를 쓰기 전에')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '준비가 두 가지 필요해요' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '설치' })).toBeEnabled()
    expect(screen.getByText('Claude 계정 로그인').closest('li')).toHaveClass('locked')
    expect(screen.getByText('둘러보기').closest('li')).toHaveClass('locked')
    expect(screen.queryByRole('button', { name: '로그인' })).toBeNull()
  })

  it('[설치]는 installClaude 만 부르고, 다음 상태가 올 때까지 막힌다', async () => {
    await show(needs({ state: 'todo' }, { state: 'locked' }))
    fireEvent.click(screen.getByRole('button', { name: '설치' }))
    expect(api.installClaude).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '설치' })).toBeDisabled()
    await act(async () => emit('setup', needs({ state: 'running', lines: ['a'] }, { state: 'locked' })))
    expect(screen.queryByRole('button', { name: '설치' })).toBeNull()
  })

  it('도는 중: 줄이 log 에', async () => {
    await show(needs({ state: 'running', lines: ['one', 'two', 'three', 'four'] }, { state: 'locked' }))
    const log = screen.getByRole('log')
    expect(within(log).getAllByText(/one|two|three|four/)).toHaveLength(4)
    expect(screen.getByText('1~2분')).toBeInTheDocument()
  })

  it('실패: 오류 글 + [다시 시도] → installClaude', async () => {
    await show(needs({ state: 'failed', message: '네트워크가 끊겼어요', lines: ['x'] }, { state: 'locked' }))
    expect(screen.getByText('설치하지 못했어요')).toBeInTheDocument()
    expect(screen.getByText('네트워크가 끊겼어요')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(api.installClaude).toHaveBeenCalled()
  })

  it('설치 끝 + 로그인 전: 제목 하나, ✓ 버전, [로그인] → loginClaude', async () => {
    await show(needs({ state: 'done', version: '2.1.316' }, { state: 'todo' }))
    expect(screen.getByRole('heading', { name: '준비가 하나 남았어요' })).toBeInTheDocument()
    expect(screen.getByText('2.1.316')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '로그인' }))
    expect(api.loginClaude).toHaveBeenCalledTimes(1)
  })

  it('로그인 기다림: 안내 + 다시 열기 → loginClaude', async () => {
    await show(needs({ state: 'done', version: null }, { state: 'waiting' }))
    expect(screen.getByText('브라우저에서 마치면 저절로 넘어가요')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '다시 열기' }))
    expect(api.loginClaude).toHaveBeenCalledTimes(1)
  })

  it('로그인 실패 문구', async () => {
    await show(needs({ state: 'done', version: null }, { state: 'failed', message: 'x' }))
    expect(screen.getByText('로그인을 확인하지 못했어요 — 다시 해 주세요')).toBeInTheDocument()
  })

  it('실행하는 명령 보기 — 펼침', async () => {
    await show(needs({ state: 'todo' }, { state: 'locked' }))
    const b = screen.getByRole('button', { name: /실행하는 명령 보기/ })
    expect(b).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(b)
    expect(b).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('irm https://claude.ai/install.ps1 | iex')).toBeInTheDocument()
  })

  it('직접 설치할게요 → openSetupGuide', async () => {
    await show(needs({ state: 'todo' }, { state: 'locked' }))
    fireEvent.click(screen.getByRole('button', { name: '직접 설치할게요' }))
    expect(api.openSetupGuide).toHaveBeenCalledTimes(1)
  })

  it('다시 켜는 중', async () => {
    await show({ phase: 'relaunching' })
    expect(screen.getByText('두레를 다시 켜요…')).toBeInTheDocument()
  })

  describe('운영체제 — 설치·로그인 안내', () => {
    const WIN_INSTALL = '두레는 이 PC 의 Claude Code 로 에이전트를 움직여요. 단추를 누르면 Anthropic 공식 설치 스크립트(install.ps1)를 대신 실행해요. 관리자 권한 없이 1~2분.'
    const WIN_COMMAND = 'irm https://claude.ai/install.ps1 | iex'
    const WIN_LOGIN = '단추를 누르면 브라우저가 열려요. 쓰고 있는 Claude 구독 계정으로 로그인하고 돌아오면 이어져요.'
    /** 설치 안내 + 펼친 명령 + 로그인 안내가 한 화면에 보이는 글(설치·로그인 둘 다 할 일) */
    async function allText(p: typeof platform): Promise<string> {
      platform = p
      await show(needs({ state: 'todo' }, { state: 'todo' }))
      fireEvent.click(screen.getByRole('button', { name: /실행하는 명령 보기/ }))
      await screen.findByText(p === 'darwin' ? /install\.sh \| bash/ : WIN_COMMAND)
      return document.body.textContent ?? ''
    }

    it('win32 면 지금 글 그대로', async () => {
      const text = await allText('win32')
      expect(text).toContain(WIN_INSTALL)
      expect(text).toContain(WIN_COMMAND)
      expect(text).toContain(WIN_LOGIN)
    })

    it('appInfo 를 못 받았어도(옛 api) 지금 글 그대로', async () => {
      const text = await allText(undefined)
      expect(text).toContain(WIN_INSTALL)
      expect(text).toContain(WIN_COMMAND)
      expect(text).toContain(WIN_LOGIN)
    })

    it('darwin 이면 Windows·PowerShell 낱말이 안 보이고 설치 안내가 mac 글(install.sh · curl … | bash) · 로그인은 터미널 창', async () => {
      const text = await allText('darwin')
      expect(text).not.toMatch(/Windows|윈도|PowerShell|install\.ps1|irm |iex|이 PC/)
      expect(text).toContain('두레는 이 Mac 의 Claude Code 로 에이전트를 움직여요. 단추를 누르면 Anthropic 공식 설치 스크립트(install.sh)를 대신 실행해요. 관리자 권한 없이 1~2분.')
      expect(text).toContain('curl -fsSL https://claude.ai/install.sh | bash')
      expect(text).toContain('터미널 창')
      expect(text).not.toContain(WIN_LOGIN)
    })
  })

  describe('초점', () => {
    const title = (t: string) => screen.getByText(t).closest<HTMLElement>('.setup-t')
    it('처음 그릴 때는 초점을 가져오지 않는다', async () => {
      await show(needs({ state: 'todo' }, { state: 'locked' }))
      expect(document.activeElement).toBe(document.body)
    })

    it('[설치] → 도는 중이면 단추가 없으니 현재 단계 제목으로', async () => {
      await show(needs({ state: 'todo' }, { state: 'locked' }))
      screen.getByRole('button', { name: '설치' }).focus()
      await act(async () => emit('setup', needs({ state: 'running', lines: [] }, { state: 'locked' })))
      expect(document.activeElement).toBe(title('Claude Code 설치'))
    })

    it('설치 끝 → 다음 단계의 [로그인] 으로', async () => {
      await show(needs({ state: 'running', lines: [] }, { state: 'locked' }))
      title('Claude Code 설치')!.focus()
      await act(async () => emit('setup', needs({ state: 'done', version: '1' }, { state: 'todo' })))
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '로그인' }))
    })

    it('[로그인] → 기다림이면 [다시 열기] 로', async () => {
      await show(needs({ state: 'done', version: null }, { state: 'todo' }))
      screen.getByRole('button', { name: '로그인' }).focus()
      await act(async () => emit('setup', needs({ state: 'done', version: null }, { state: 'waiting' })))
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '다시 열기' }))
    })

    it('다시 켜는 중이면 현재 단계 제목으로', async () => {
      await show(needs({ state: 'done', version: null }, { state: 'waiting' }))
      screen.getByRole('button', { name: '다시 열기' }).focus()
      await act(async () => emit('setup', { phase: 'relaunching' }))
      expect(document.activeElement).toBe(title('둘러보기'))
    })

    it('초점이 다른 곳에 있으면 뺏지 않는다', async () => {
      await show(needs({ state: 'todo' }, { state: 'locked' }))
      const other = document.createElement('button')
      document.body.appendChild(other)
      other.focus()
      await act(async () => emit('setup', needs({ state: 'running', lines: [] }, { state: 'locked' })))
      expect(document.activeElement).toBe(other)
      other.remove()
    })
  })
})
