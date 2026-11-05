// 위 띠의 휴대폰 알약(시안 D1) — 휴대폰 연결이 켜져 있을 때만, 톱니 왼쪽. 'phone' 사건으로 바뀐다(되묻지 않는다)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import type { Snapshot } from '../../src/shared/ipcContract'
import type { PhoneState } from '../../src/shared/phoneTypes'

const base = (): PhoneState => ({
  settings: { enabled: false, keepAwake: true, openAtLogin: false, notify: { asks: true, finished: false }, port: 47615 },
  devices: [],
  online: [],
  connected: 0,
  tailscale: null,
  url: null,
  pairing: null,
  problem: null,
})

let phone: PhoneState
let handlers: Record<string, (p: any) => void>
let phoneState: ReturnType<typeof vi.fn>

const emit = (patch: Partial<PhoneState>) =>
  act(() => {
    phone = { ...phone, ...patch }
    handlers.phone?.(phone)
  })

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  phone = base()
  handlers = {}
  phoneState = vi.fn(async () => phone)
  const snapshot: Snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }], agents: [],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  ;(window as any).dure = {
    appInfo: async () => ({ version: '0.1.0', packaged: true }),
    prefs: async () => ({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true }),
    updateState: async () => ({ kind: 'idle' }),
    claudeUpdateState: async () => 'idle',
    setupState: async () => ({ phase: 'ready' }),
    snapshot: async () => snapshot,
    history: async () => [],
    phoneState,
    phoneCheck: async () => ({ kind: 'missing' }),
    on: (n: string, h: (p: any) => void) => {
      handlers[n] = h
      return () => {}
    },
  }
})
afterEach(() => cleanup())

async function renderTopBar(onPhone = () => {}) {
  const { getStore } = await import('../../src/renderer/state/store')
  const { TopBar } = await import('../../src/renderer/shell/TopBar')
  await act(async () => { await getStore().init() })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  render(<TopBar hasRoom onSettings={() => {}} onPhone={onPhone} />)
  return getStore()
}

const pill = () => document.querySelector<HTMLButtonElement>('.phn-top')

/** aria-describedby 가 가리키는 글 */
const described = (el: Element) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(id => document.getElementById(id)?.textContent ?? '')
    .join(' ')

describe('TopBar 휴대폰 알약', () => {
  it('켜짐·접속 수 표시', async () => {
    const onPhone = vi.fn()
    const store = await renderTopBar(onPhone)
    expect(phoneState).toHaveBeenCalledTimes(1)
    expect(store.getState().app.phone).toEqual(phone)
    // 꺼져 있으면 없다
    expect(pill()).toBeNull()

    // 켜졌지만 길이 아직 — 앰버 점 · 이름은 보이는 글 그대로(WCAG 2.5.3), 긴 말은 설명으로
    emit({ settings: { ...phone.settings, enabled: true } })
    expect(pill()).not.toBeNull()
    expect(pill()!.textContent).toBe('휴대폰 · 0')
    expect(pill()!.querySelector('.dot.a')).not.toBeNull()
    expect(screen.getByRole('button', { name: '휴대폰 · 0' })).toBe(pill())
    expect(described(pill()!)).toBe('휴대폰 연결 켜짐 · 아직 안 열렸어요')

    // 길이 열리고 두 대 접속 — 초록 점 · 숫자
    emit({ tailscale: { kind: 'ready', dnsName: 'fake-pc.tail0000.ts.net' }, url: 'https://fake-pc.tail0000.ts.net/mobile.html', connected: 2, online: ['a', 'b'] })
    const p = screen.getByRole('button', { name: '휴대폰 · 2' })
    expect(p).toBe(pill())
    expect(p.textContent).toBe('휴대폰 · 2')
    expect(described(p)).toBe('휴대폰 연결 켜짐 · 2대 접속 중')
    expect(p.getAttribute('title')).toBe('휴대폰 연결 켜짐 · 2대 접속 중')
    expect(p.querySelector('.dot.g')).not.toBeNull()
    expect(p.querySelector('svg')).not.toBeNull()
    // 톱니 바로 왼쪽
    expect(p.nextElementSibling).toBe(screen.getByRole('button', { name: '설정' }))
    fireEvent.click(p)
    expect(onPhone).toHaveBeenCalledTimes(1)

    // 까닭이 있으면 앰버
    emit({ problem: '그 포트는 이미 다른 곳에 쓰이고 있어요' })
    expect(pill()!.querySelector('.dot.a')).not.toBeNull()
    expect(pill()!.querySelector('.dot.g')).toBeNull()

    // 끄면 사라진다
    emit({ settings: { ...phone.settings, enabled: false } })
    expect(pill()).toBeNull()
  })

  it('첫 응답보다 먼저 온 사건을 늦은 응답이 덮지 않는다', async () => {
    let answer!: (s: PhoneState) => void
    phoneState.mockImplementationOnce(() => new Promise<PhoneState>(r => { answer = r }))
    const { getStore } = await import('../../src/renderer/state/store')
    await act(async () => { await getStore().init() })
    emit({ settings: { ...phone.settings, enabled: true }, connected: 1 })
    await act(async () => { answer(base()) })
    expect(getStore().getState().app.phone?.settings.enabled).toBe(true)
  })
})
