// PC 설정의 '휴대폰' 칸 · 휴대폰 창 · 짝 맺기 창(시안 C2) — 가짜 window.dure 로 앱을 띄우고 'phone' 사건을 흉내 낸다
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import type { Snapshot } from '../../src/shared/ipcContract'
import type { PhoneSettingsChange, PhoneState, TailscaleState } from '../../src/shared/phoneTypes'
import { allowMotion } from './motion'

const READY: TailscaleState = { kind: 'ready', dnsName: 'fake-pc.tail0000.ts.net' }
const URL_OPEN = 'https://fake-pc.tail0000.ts.net/mobile.html'
const ENABLE_URL = 'https://login.tailscale.com/f/serve?node=nFAKE'
const QR = 'data:image/png;base64,iVBORw0KGgo='

const base = (): PhoneState => ({
  settings: { enabled: false, keepAwake: true, openAtLogin: false, notify: { asks: true, finished: false }, port: 47615 },
  devices: [],
  online: [],
  connected: 0,
  tailscale: null,
  url: null,
  pairing: null,
  problem: null,
  notice: null,
  androidApp: null,
})

let phone: PhoneState
let handlers: Record<string, (p: any) => void>
let api: Record<string, any>
let pairExpires: number

/** main 이 'phone' 사건을 보낸 것처럼 */
const emit = (patch: Partial<PhoneState>) =>
  act(() => {
    phone = { ...phone, ...patch }
    handlers.phone?.(phone)
  })

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  phone = base()
  handlers = {}
  pairExpires = Date.now() + 5 * 60_000
  const snapshot: Snapshot = {
    claudeMissing: false, rooms: [{ id: 'r1', name: '여름 캠페인', createdAt: 1 }], agents: [],
    messages: [], requests: [], autoChainLimit: 3, allowBypass: false, notify: { asks: true, finished: false }, sleepAfterMin: 30, usage: null,
  }
  api = {
    appInfo: async () => ({ version: '0.1.0', packaged: true }),
    prefs: async () => ({ tourDone: true, approvalTipSeen: true, claudeAutoUpdate: true }),
    setPrefs: vi.fn(async (p: any) => p),
    updateState: async () => ({ kind: 'idle' }),
    claudeUpdateState: async () => 'idle',
    setupState: async () => ({ phase: 'ready' }),
    snapshot: async () => snapshot,
    history: async () => [],
    setAutoChainLimit: vi.fn(async () => {}),
    setTheme: vi.fn(async () => {}),
    phoneState: vi.fn(async () => phone),
    setPhone: vi.fn(async (p: PhoneSettingsChange) => {
      const s = phone.settings
      phone = { ...phone, settings: { ...s, ...p, notify: { ...s.notify, ...(p.notify ?? {}) } } }
      handlers.phone?.(phone)
    }),
    phoneCheck: vi.fn(async () => phone.tailscale ?? { kind: 'missing' }),
    phonePairStart: vi.fn(async () => {
      phone = { ...phone, pairing: { pin: '482017', expiresAt: pairExpires } }
      handlers.phone?.(phone)
      return { qr: QR, pin: '482017', url: `${URL_OPEN}#pair=abc`, expiresAt: pairExpires }
    }),
    phonePairCancel: vi.fn(async () => {
      phone = { ...phone, pairing: null }
      handlers.phone?.(phone)
    }),
    phoneUnpair: vi.fn(async (id: string) => {
      phone = { ...phone, devices: phone.devices.filter(d => d.id !== id) }
      handlers.phone?.(phone)
    }),
    // main 처럼 — 봤다고 하면 알림을 지우고 'phone' 사건
    phoneNoticeSeen: vi.fn(async () => {
      phone = { ...phone, notice: null }
      handlers.phone?.(phone)
    }),
    on: (n: string, h: (p: any) => void) => {
      handlers[n] = h
      return () => {}
    },
  }
  ;(window as any).dure = api
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function renderApp() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { App } = await import('../../src/renderer/App')
  await act(async () => { await getStore().init() })
  render(<App />)
  await settle()
  return getStore()
}

const openSettings = () => {
  fireEvent.click(screen.getByRole('button', { name: '설정' }))
  return screen.getByRole('dialog', { name: '설정' })
}

/** 설정 → 휴대폰 [열기] — 휴대폰 창 */
async function openPhone() {
  const settings = openSettings()
  await act(async () => { fireEvent.click(within(settings).getByRole('button', { name: '휴대폰 열기' })) })
  await settle()
  return { settings, dlg: screen.getByRole('dialog', { name: '휴대폰' }) }
}

/** 확인 단계 목록 — [글, 상태] */
const steps = (dlg: HTMLElement) =>
  Array.from(dlg.querySelectorAll<HTMLElement>('[data-step]')).map(li => [li.querySelector('.phn-step-t')!.textContent, li.dataset.step])

/** 머리의 켜기 스위치 — 이름에 보이는 글(켜짐/꺼짐)을 담는다(WCAG 2.5.3) */
const master = (dlg: HTMLElement) => within(dlg).getByRole('switch', { name: /^휴대폰으로 쓰기 — (켜짐|꺼짐)$/ })

/** aria-describedby 가 가리키는 글 */
const described = (el: Element) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(id => document.getElementById(id)?.textContent ?? '')
    .join(' ')

const STALE = '두레가 전에 연 길을 정리하지 못했어요 — Tailscale 이 켜져 있는지 확인해 주세요'

describe('설정의 휴대폰 칸', () => {
  it('꺼짐 · 켜짐 · N대 접속 중 — [열기] 는 설정 창 위에 휴대폰 창을 띄우고, 설정에서 바꾸던 값은 그대로 · Esc 는 맨 위 창만 닫는다', async () => {
    await renderApp()
    const settings = openSettings()
    const field = within(settings).getByText('휴대폰', { selector: '.fld-l' }).closest('.fld') as HTMLElement
    expect(field.textContent).toContain('꺼짐')
    expect(field.textContent).toContain('밖에서 휴대폰으로 에이전트 일을 보고 승인해요')
    // 점 — 꺼짐 회색 · 켰는데 아직(또는 까닭) 앰버 · 열림 초록
    expect(field.querySelector('.dot.s')).not.toBeNull()
    emit({ settings: { ...phone.settings, enabled: true } })
    expect(field.textContent).toContain('켜짐 · 아직 안 열렸어요')
    expect(field.querySelector('.dot.a')).not.toBeNull()

    emit({ tailscale: READY, url: URL_OPEN, connected: 1, online: ['d1'] })
    expect(field.textContent).toContain('켜짐 · 1대 접속 중')
    expect(field.querySelector('.dot.g')).not.toBeNull()

    // 설정에서 바꾸던 값 — 휴대폰 창을 열고 닫아도 남는다
    const limit = within(settings).getByRole('spinbutton', { name: '자동 전달 상한' }) as HTMLInputElement
    fireEvent.change(limit, { target: { value: '9' } })
    const opener = within(settings).getByRole('button', { name: '휴대폰 열기' })
    opener.focus()
    await act(async () => { fireEvent.click(opener) })
    const dlg = screen.getByRole('dialog', { name: '휴대폰' })
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy()
    // 처음 초점은 창 자체(스위치에 두면 Space 한 번에 꺼진다) · Tab 은 위 창 안에서만 돈다(아래 설정 창으로 새지 않는다)
    const head = master(dlg)
    expect(document.activeElement).toBe(dlg)
    const close = within(dlg).getByRole('button', { name: '닫기' })
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(head)
    fireEvent.keyDown(head, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)

    fireEvent.keyDown(dlg, { key: 'Escape' })
    await settle()
    expect(screen.queryByRole('dialog', { name: '휴대폰' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy()
    expect(limit.value).toBe('9')
    expect(document.activeElement).toBe(opener)
  })

  it('위 띠 알약으로 연 휴대폰 창 — 끄면 알약이 사라지니 닫을 때 초점은 설정 톱니로', async () => {
    phone = { ...phone, settings: { ...phone.settings, enabled: true }, tailscale: READY, url: URL_OPEN }
    await renderApp()
    const pill = document.querySelector<HTMLButtonElement>('.phn-top')!
    pill.focus()
    await act(async () => { fireEvent.click(pill) })
    await settle()
    const dlg = screen.getByRole('dialog', { name: '휴대폰' })
    await act(async () => { fireEvent.click(master(dlg)) })
    await settle()
    expect(api.setPhone).toHaveBeenLastCalledWith({ enabled: false })
    expect(document.querySelector('.phn-top')).toBeNull()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '닫기' })) })
    await settle()
    expect(screen.queryByRole('dialog', { name: '휴대폰' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '설정' }))
  })

  it('phoneState 가 없으면(옛 api) 칸을 숨긴다', async () => {
    delete api.phoneState
    await renderApp()
    const settings = openSettings()
    expect(within(settings).queryByRole('button', { name: '휴대폰 열기' })).toBeNull()
  })
})

describe('휴대폰 창', () => {
  it('켜기 — 단계별 안내(missing·logged-out·no-https·ready)', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await renderApp()
    const { dlg } = await openPhone()
    // 꺼진 채 처음 열면 아직 모르니 한 번 확인한다
    expect(api.phoneCheck).toHaveBeenCalledTimes(1)

    // missing — 내려받기는 기본 브라우저로(새 창 요청 → main 이 연다)
    emit({ tailscale: { kind: 'missing' } })
    expect(steps(dlg)).toEqual([
      ['Tailscale 을 깔고 켜 주세요', 'need'],
      ['로그인', 'todo'],
      ['휴대폰 주소 열기', 'todo'],
    ])
    // 시간 상한(서비스가 안 돎)도 missing 으로 온다 — 깔았는데도 이렇게 보이는 사람에게
    expect(dlg.textContent).toContain('이미 깔았다면 Tailscale 이 켜져 있는지 확인해 주세요')
    fireEvent.click(within(dlg).getByRole('button', { name: '내려받기' }))
    expect(open).toHaveBeenCalledWith('https://tailscale.com/download', '_blank')

    // logged-out
    emit({ tailscale: { kind: 'logged-out' } })
    expect(steps(dlg)).toEqual([
      ['Tailscale 이 깔려 있어요', 'ok'],
      ['Tailscale 에 로그인해 주세요', 'need'],
      ['휴대폰 주소 열기', 'todo'],
    ])
    expect(dlg.textContent).toContain('작업 표시줄의 Tailscale 아이콘을 눌러 로그인해요')

    // no-https — 켜기 링크가 있으면 [켜러 가기], 없으면 [다시 확인]
    emit({ tailscale: { kind: 'no-https', enableUrl: ENABLE_URL } })
    expect(steps(dlg)).toEqual([
      ['Tailscale 이 깔려 있어요', 'ok'],
      ['로그인돼 있어요', 'ok'],
      ['Tailscale 에서 Serve 를 한 번 켜야 해요', 'need'],
    ])
    fireEvent.click(within(dlg).getByRole('button', { name: '켜러 가기' }))
    expect(open).toHaveBeenLastCalledWith(ENABLE_URL, '_blank')
    emit({ tailscale: { kind: 'no-https', enableUrl: null } })
    expect(within(dlg).queryByRole('button', { name: '켜러 가기' })).toBeNull()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '다시 확인' })) })
    expect(api.phoneCheck).toHaveBeenCalledTimes(2)

    // ready 인데 꺼져 있다 — 짝 맺기는 아직
    emit({ tailscale: READY })
    expect(steps(dlg)).toEqual([
      ['Tailscale 이 깔려 있어요', 'ok'],
      ['로그인돼 있어요', 'ok'],
      ['켜면 휴대폰 주소가 열려요', 'todo'],
    ])
    expect((within(dlg).getByRole('button', { name: '휴대폰 짝 맺기' }) as HTMLButtonElement).disabled).toBe(true)
    expect(dlg.textContent).not.toContain('Tailscale 대시보드에서') // 주소 줄이기 팁은 주소가 보일 때만

    // 켜졌고 길이 열렸다 — 주소와 짝 맺기
    emit({ settings: { ...phone.settings, enabled: true }, url: URL_OPEN })
    expect(steps(dlg)).toEqual([
      ['Tailscale 이 깔려 있어요', 'ok'],
      ['로그인돼 있어요', 'ok'],
      ['휴대폰 주소가 열렸어요', 'ok'],
    ])
    expect(within(dlg).getByText(URL_OPEN).closest('.phn-url')).not.toBeNull()
    // 켠 채 이름을 바꾸면 휴대폰이 아는 주소가 끊긴다 — 끄고 바꾼 뒤 다시 켜라고
    expect(dlg.textContent).toContain('Tailscale 대시보드에서 PC 이름을 dure 처럼 바꾸면 주소가 짧아져요 — 바꾸기 전에 휴대폰 연결을 끄고, 바꾼 뒤 다시 켜 주세요')
    expect((within(dlg).getByRole('button', { name: '휴대폰 짝 맺기' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('창으로 돌아오면(바깥 브라우저·Tailscale 대시보드에 다녀옴) — 아직 안 됐거나 주소가 열려 있으면 다시 확인 · 꺼져 있고 다 됐으면 안 부름', async () => {
    const focus = async () => {
      await act(async () => { window.dispatchEvent(new Event('focus')) })
      await settle()
    }
    await renderApp()
    await openPhone()
    expect(api.phoneCheck).toHaveBeenCalledTimes(1) // 처음 열 때
    emit({ tailscale: { kind: 'no-https', enableUrl: ENABLE_URL } })
    await focus()
    expect(api.phoneCheck).toHaveBeenCalledTimes(2)
    // 주소가 열려 있어도 — 대시보드에서 PC 이름을 바꾸고 돌아왔을 수 있다(main 이 지금 이름으로 다시 연다)
    emit({ tailscale: READY, settings: { ...phone.settings, enabled: true }, url: URL_OPEN })
    await focus()
    expect(api.phoneCheck).toHaveBeenCalledTimes(3)
    // 꺼져 있고 Tailscale 이 준비됐으면 볼 것이 없다
    emit({ settings: { ...phone.settings, enabled: false }, url: null })
    await focus()
    expect(api.phoneCheck).toHaveBeenCalledTimes(3)
  })

  it('주소가 열린 채 휴대폰 창을 열면 한 번 확인 — 창이 닫혀 있는 동안 PC 이름을 바꿨을 수 있다', async () => {
    phone = { ...base(), settings: { ...base().settings, enabled: true }, tailscale: READY, url: URL_OPEN }
    await renderApp()
    await openPhone()
    expect(api.phoneCheck).toHaveBeenCalledTimes(1)
    // 꺼져 있고 Tailscale 을 이미 알면 열 때 부르지 않는다(지금처럼)
    cleanup()
    api.phoneCheck.mockClear()
    phone = { ...base(), tailscale: READY }
    await renderApp()
    await openPhone()
    expect(api.phoneCheck).not.toHaveBeenCalled()
  })

  it('까닭(problem)은 그대로 — 꺼져 있어도 보인다', async () => {
    await renderApp()
    const { dlg } = await openPhone()
    emit({ tailscale: READY, problem: '두레가 전에 연 길을 정리하지 못했어요 — Tailscale 이 켜져 있는지 확인해 주세요' })
    expect(within(dlg).getByText('두레가 전에 연 길을 정리하지 못했어요 — Tailscale 이 켜져 있는지 확인해 주세요')).toBeTruthy()
    emit({ settings: { ...phone.settings, enabled: true }, problem: 'tailnet 의 https 포트 443·47615 가 모두 다른 곳에 쓰이고 있어요 — 하나를 비워 주세요' })
    expect(within(dlg).getByText('tailnet 의 https 포트 443·47615 가 모두 다른 곳에 쓰이고 있어요 — 하나를 비워 주세요')).toBeTruthy()
    expect(steps(dlg).at(-1)?.[1]).toBe('need')
  })

  it('주소가 바뀌었다는 알림(notice) — 창을 열면 보이고 main 엔 봤다고 알린다 · main 이 지워도 창이 열린 동안은 남고, 짝 맺기를 열면 사라진다', async () => {
    const MOVED = '주소가 바뀌었어요 — 휴대폰을 다시 짝 맺어 주세요'
    phone = { ...phone, settings: { ...phone.settings, enabled: true }, tailscale: READY, url: 'https://fake-pc.tail0000.ts.net:47615/mobile.html', notice: MOVED }
    await renderApp()
    expect(api.phoneNoticeSeen).not.toHaveBeenCalled() // 창을 열기 전엔 — 아직 아무도 못 봤다
    const { dlg } = await openPhone()
    expect(api.phoneNoticeSeen).toHaveBeenCalledTimes(1)
    expect(phone.notice).toBeNull()
    const line = within(dlg).getByText(MOVED)
    expect(line.closest('.phn-panel')).not.toBeNull() // 주소와 같은 칸
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '휴대폰 짝 맺기' })) })
    await settle()
    expect(within(dlg).queryByText(MOVED)).toBeNull()
    expect(api.phoneNoticeSeen).toHaveBeenCalledTimes(1)
  })

  it('창이 열린 채 주소가 바뀌면 그 자리에 알림 · 닫았다 다시 열면 없다(이미 봤다)', async () => {
    const MOVED = '주소가 바뀌었어요 — 휴대폰을 다시 짝 맺어 주세요'
    phone = { ...phone, settings: { ...phone.settings, enabled: true }, tailscale: READY, url: URL_OPEN }
    await renderApp()
    const { dlg } = await openPhone()
    expect(within(dlg).queryByText(MOVED)).toBeNull()
    emit({ url: 'https://fake-pc.tail0000.ts.net:47615/mobile.html', notice: MOVED })
    await settle()
    expect(within(dlg).getByText(MOVED)).toBeTruthy()
    expect(api.phoneNoticeSeen).toHaveBeenCalledTimes(1)
    expect(within(dlg).getByText(MOVED)).toBeTruthy() // main 이 지운 뒤에도
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '닫기' })) })
    await settle()
    expect(screen.queryByRole('dialog', { name: '휴대폰' })).toBeNull()
    const settings = screen.getByRole('dialog', { name: '설정' })
    await act(async () => { fireEvent.click(within(settings).getByRole('button', { name: '휴대폰 열기' })) })
    await settle()
    expect(within(screen.getByRole('dialog', { name: '휴대폰' })).queryByText(MOVED)).toBeNull()
    expect(api.phoneNoticeSeen).toHaveBeenCalledTimes(1)
  })

  it('꺼진 채 까닭이 있으면(전에 연 길을 못 정리) [다시 확인] — 창으로 돌아와도 다시 확인, 풀리면 단추는 없다', async () => {
    await renderApp()
    const { dlg } = await openPhone()
    expect(api.phoneCheck).toHaveBeenCalledTimes(1)
    emit({ tailscale: READY, problem: STALE })
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '다시 확인' })) })
    await settle()
    expect(api.phoneCheck).toHaveBeenCalledTimes(2)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await settle()
    expect(api.phoneCheck).toHaveBeenCalledTimes(3)
    emit({ problem: null })
    expect(within(dlg).queryByRole('button', { name: '다시 확인' })).toBeNull()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await settle()
    expect(api.phoneCheck).toHaveBeenCalledTimes(3)
  })

  it('처음 켤 때 자동 켜기 켬으로 — 두 번째부터는 켜기만', async () => {
    await renderApp()
    const { dlg } = await openPhone()
    const sw = master(dlg)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(sw.textContent).toContain('꺼짐')
    // 이름은 보이는 글(켜짐/꺼짐)을 담는다
    expect(within(dlg).getByRole('switch', { name: '휴대폰으로 쓰기 — 꺼짐' })).toBe(sw)
    await act(async () => { fireEvent.click(sw) })
    await settle()
    expect(api.setPhone).toHaveBeenLastCalledWith({ enabled: true, openAtLogin: true })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(sw.textContent).toContain('켜짐')
    expect(within(dlg).getByRole('switch', { name: '휴대폰으로 쓰기 — 켜짐' })).toBe(sw)
    expect(within(dlg).getByRole('switch', { name: 'Windows 를 켜면 두레도 켜기' }).getAttribute('aria-checked')).toBe('true')
    // 말없이 바뀌지 않게 — 그 스위치 아래 한 줄
    expect(dlg.textContent).toContain('PC 를 다시 켜도 휴대폰 연결이 이어지게 함께 켰어요')

    await act(async () => { fireEvent.click(sw) })
    await settle()
    expect(api.setPhone).toHaveBeenLastCalledWith({ enabled: false })
    // 사용자가 자동 켜기를 끈 뒤 다시 켜면 — 끈 것을 덮지 않는다
    await act(async () => { fireEvent.click(within(dlg).getByRole('switch', { name: 'Windows 를 켜면 두레도 켜기' })) })
    await settle()
    expect(api.setPhone).toHaveBeenLastCalledWith({ openAtLogin: false })
    await act(async () => { fireEvent.click(sw) })
    await settle()
    expect(api.setPhone).toHaveBeenLastCalledWith({ enabled: true })
  })

  it('켜는 동안 스위치는 바라는 쪽으로 · 기다림 표시 — 실패하면 되돌리고 까닭', async () => {
    let release!: () => void
    api.setPhone.mockImplementationOnce(() => new Promise<void>(r => { release = r }))
    await renderApp()
    const { dlg } = await openPhone()
    const sw = master(dlg)
    await act(async () => { fireEvent.click(sw) })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(sw.getAttribute('aria-busy')).toBe('true')
    await act(async () => { release() })
    await settle()
    expect(sw.getAttribute('aria-busy')).toBeNull()

    api.setPhone.mockRejectedValueOnce(new Error('휴대폰 연결을 켜지 못했어요'))
    const asks = within(dlg).getByRole('switch', { name: '승인·질문이 오면 휴대폰 알림' })
    expect(asks.getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(asks) })
    await settle()
    expect(asks.getAttribute('aria-checked')).toBe('true')
    expect(within(dlg).getByRole('alert').textContent).toBe('휴대폰 연결을 켜지 못했어요')
  })

  it('켜는 중(오래 걸림)에도 끌 수 있다 — {enabled:false} 를 보내고, 먼저 보낸 켜기가 늦게 끝나도 끄는 중 표시는 남고 그 실패도 띄우지 않는다', async () => {
    let failOn!: () => void
    let releaseOff!: () => void
    api.setPhone
      .mockImplementationOnce(() => new Promise<void>((_, no) => { failOn = () => no(new Error('휴대폰 연결을 켜지 못했어요')) }))
      .mockImplementationOnce(() => new Promise<void>(r => { releaseOff = r }))
    await renderApp()
    const { dlg } = await openPhone()
    const sw = master(dlg)
    await act(async () => { fireEvent.click(sw) })
    expect(api.setPhone).toHaveBeenLastCalledWith({ enabled: true, openAtLogin: true })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(sw.getAttribute('aria-busy')).toBe('true')

    // 켜는 동안 다시 누름 — 끄기를 바로 보낸다
    await act(async () => { fireEvent.click(sw) })
    expect(api.setPhone).toHaveBeenCalledTimes(2)
    expect(api.setPhone).toHaveBeenLastCalledWith({ enabled: false })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(sw.getAttribute('aria-busy')).toBe('true')

    // 앞의 켜기가 (끄기에 밀려) 끝남 — 뒤의 끄기가 아직이니 표시는 그대로, 앞의 실패는 지난 일
    await act(async () => { failOn() })
    await settle()
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(sw.getAttribute('aria-busy')).toBe('true')
    expect(within(dlg).queryByRole('alert')).toBeNull()

    await act(async () => { releaseOff() })
    await settle()
    expect(sw.getAttribute('aria-busy')).toBeNull()
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('주소 복사 — 클립보드에 넣고 그 옆에 복사했어요(못 하면 까닭)', async () => {
    const writeText = vi.fn(async (_: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    phone = { ...phone, settings: { ...phone.settings, enabled: true }, tailscale: READY, url: URL_OPEN }
    await renderApp()
    const { dlg } = await openPhone()
    const say = dlg.querySelector('.phn-url [role="status"]')!
    expect(say.textContent).toBe('')
    const copy = within(dlg).getByRole('button', { name: '주소 복사' })
    expect(copy.querySelector('svg')).not.toBeNull()
    await act(async () => { fireEvent.click(copy) })
    expect(writeText).toHaveBeenCalledWith(URL_OPEN)
    expect(say.textContent).toBe('복사했어요')
    expect(within(dlg).getByText(URL_OPEN).closest('.phn-url')).not.toBeNull()

    writeText.mockRejectedValueOnce(new Error('Document is not focused'))
    await act(async () => { fireEvent.click(copy) })
    expect(say.textContent).toBe('복사하지 못했어요')
  })

  it('알림 · 전원 스위치 — 바꾼 칸만 바로 보낸다 · 덮개 안내', async () => {
    await renderApp()
    const { dlg } = await openPhone()
    expect(dlg.textContent).toContain("노트북 덮개를 닫으면 PC 가 잠들어요 — Windows 전원 설정에서 '덮개를 닫을 때'를 '아무 것도 안 함'으로 바꿔 주세요")
    await act(async () => { fireEvent.click(within(dlg).getByRole('switch', { name: '일을 마치면 휴대폰 알림' })) })
    expect(api.setPhone).toHaveBeenLastCalledWith({ notify: { finished: true } })
    await act(async () => { fireEvent.click(within(dlg).getByRole('switch', { name: '켜 둔 동안 PC 절전 막기' })) })
    expect(api.setPhone).toHaveBeenLastCalledWith({ keepAwake: false })
    await settle()
    expect(phone.settings).toMatchObject({ keepAwake: false, notify: { asks: true, finished: true } })
  })

  it('짝 맺은 휴대폰 — 접속 중 · 마지막 접속 · 없음', async () => {
    const now = Date.now()
    await renderApp()
    const { dlg } = await openPhone()
    expect(dlg.textContent).toContain('아직 짝 맺은 휴대폰이 없어요')
    emit({
      devices: [
        { id: 'd1', name: '갤럭시 S25', createdAt: now - 86_400_000, lastSeen: now, push: true },
        { id: 'd2', name: '아이폰 15', createdAt: now - 86_400_000, lastSeen: now - 3 * 3_600_000, push: false },
        { id: 'd3', name: '휴대폰', createdAt: now, lastSeen: null, push: false },
      ],
      online: ['d1'],
      connected: 1,
    })
    const rows = within(dlg).getAllByRole('listitem').filter(li => li.classList.contains('phn-dev'))
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('갤럭시 S25지금 접속 중'),
      expect.stringContaining('아이폰 15마지막 접속 3시간 전'),
      expect.stringContaining('휴대폰아직 접속한 적 없어요'),
    ])
    expect(rows[0].querySelector('.dot.g')).not.toBeNull()
    expect(rows[1].querySelector('.dot.s')).not.toBeNull()
  })

  it('끊기 — phoneUnpair', async () => {
    const now = Date.now()
    phone = { ...phone, devices: [{ id: 'd1', name: '갤럭시 S25', createdAt: now, lastSeen: now, push: true }] }
    await renderApp()
    const { dlg } = await openPhone()
    // 확인 창에서 취소하면 안 끊는다
    fireEvent.click(within(dlg).getByRole('button', { name: '갤럭시 S25 끊기' }))
    let confirm = screen.getByRole('alertdialog', { name: '‘갤럭시 S25’ 연결을 끊을까요?' })
    fireEvent.click(within(confirm).getByRole('button', { name: '취소' }))
    await settle()
    expect(api.phoneUnpair).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '휴대폰' })).toBeTruthy()

    fireEvent.click(within(dlg).getByRole('button', { name: '갤럭시 S25 끊기' }))
    confirm = screen.getByRole('alertdialog', { name: '‘갤럭시 S25’ 연결을 끊을까요?' })
    // Esc 는 확인 창만 닫는다
    fireEvent.keyDown(confirm, { key: 'Escape' })
    await settle()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('dialog', { name: '휴대폰' })).toBeTruthy()

    const row = within(dlg).getByRole('button', { name: '갤럭시 S25 끊기' })
    row.focus() // 누르면 그 단추에 초점이 간다(연 자리)
    fireEvent.click(row)
    confirm = screen.getByRole('alertdialog', { name: '‘갤럭시 S25’ 연결을 끊을까요?' })
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '끊기' })) })
    await settle()
    expect(api.phoneUnpair).toHaveBeenCalledWith('d1')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(dlg.textContent).toContain('아직 짝 맺은 휴대폰이 없어요')
    // [끊기] 줄이 없어졌고 [휴대폰 짝 맺기]는 막혀 있다 — 초점은 휴대폰 창으로(body 로 떨어지지 않게)
    expect(document.activeElement).toBe(dlg)
  })

  it('끊은 뒤 초점 — 연 줄이 없어지면 [휴대폰 짝 맺기]로', async () => {
    const now = Date.now()
    phone = {
      ...phone,
      settings: { ...phone.settings, enabled: true },
      tailscale: READY,
      url: URL_OPEN,
      devices: [{ id: 'd1', name: '갤럭시 S25', createdAt: now, lastSeen: now, push: true }],
    }
    await renderApp()
    const { dlg } = await openPhone()
    const row = within(dlg).getByRole('button', { name: '갤럭시 S25 끊기' })
    row.focus()
    fireEvent.click(row)
    const confirm = screen.getByRole('alertdialog', { name: '‘갤럭시 S25’ 연결을 끊을까요?' })
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '끊기' })) })
    await settle()
    expect(row.isConnected).toBe(false)
    expect(document.activeElement).toBe(within(dlg).getByRole('button', { name: '휴대폰 짝 맺기' }))
  })
})

describe('짝 맺기 창', () => {
  const ready = () => {
    phone = { ...phone, settings: { ...phone.settings, enabled: true }, tailscale: READY, url: URL_OPEN }
  }
  const startPair = async (dlg: HTMLElement) => {
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '휴대폰 짝 맺기' })) })
    await settle()
    return screen.getByRole('dialog', { name: '휴대폰 짝 맺기' })
  }

  it('짝 맺기 — QR·숫자, 닫으면 취소', async () => {
    ready()
    await renderApp()
    const { dlg } = await openPhone()
    const pair = await startPair(dlg)
    expect(api.phonePairStart).toHaveBeenCalledTimes(1)
    expect(pair.textContent).toContain('QR 을 휴대폰 카메라로 찍어 주세요. 홈 화면 앱(아이폰)에서는 오른쪽 숫자를 넣어요.')
    expect(pair.textContent).toContain('휴대폰에서도 Tailscale 이 켜져 있어야 주소가 열려요')
    expect((within(pair).getByRole('img', { name: '짝 맺기 QR' }) as HTMLImageElement).getAttribute('src')).toBe(QR)
    expect(pair.querySelector('.phn-pin')!.textContent).toBe('482 017')
    expect(pair.querySelector('.phn-left')!.textContent).toMatch(/^[45]:\d\d 남음 · 한 번만 쓸 수 있어요$/)
    await act(async () => { fireEvent.click(within(pair).getByRole('button', { name: '취소' })) })
    await settle()
    expect(api.phonePairCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: '휴대폰 짝 맺기' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '휴대폰' })).toBeTruthy()

    // Esc 도 취소 — 휴대폰 창은 남는다
    const again = await startPair(dlg)
    fireEvent.keyDown(again, { key: 'Escape' })
    await settle()
    expect(api.phonePairCancel).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog', { name: '휴대폰 짝 맺기' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '휴대폰' })).toBeTruthy()
  })

  it('[취소] 뒤 나가는 동안 — 짝이 닫혔다는 사건이 와도 결과로 바뀌지 않는다', async () => {
    ready()
    await renderApp()
    const { dlg } = await openPhone()
    allowMotion()
    const pair = await startPair(dlg)
    expect(pair.querySelector('.phn-pin')).not.toBeNull()
    // 취소 → main 이 짝을 닫고 pairing: null 사건(가짜 api 가 바로 보낸다) — 창은 아직 나가는 중
    await act(async () => { fireEvent.click(within(pair).getByRole('button', { name: '취소' })) })
    expect(api.phonePairCancel).toHaveBeenCalledTimes(1)
    expect(phone.pairing).toBeNull()
    expect(pair.isConnected).toBe(true)
    expect(pair.textContent).not.toContain('짝 맺기가 닫혔어요')
    expect(pair.textContent).not.toContain('다시 짝 맺기')
    expect(pair.querySelector('.phn-pin')).not.toBeNull()
    await waitFor(() => expect(pair.isConnected).toBe(false))
    expect(screen.getByRole('dialog', { name: '휴대폰' })).toBeTruthy()
  })

  it('닫는 중에 다시 열면(같은 창이 그 자리로 돌아옴) 새 짝 맺기로 — 취소한 숫자를 그대로 두지 않는다', async () => {
    ready()
    await renderApp()
    const { dlg } = await openPhone()
    allowMotion()
    const pair = await startPair(dlg)
    await act(async () => { fireEvent.click(within(pair).getByRole('button', { name: '취소' })) })
    expect(pair.isConnected).toBe(true)
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '휴대폰 짝 맺기' })) })
    await settle()
    expect(pair.isConnected).toBe(true)
    expect(api.phonePairStart).toHaveBeenCalledTimes(2)
    expect(phone.pairing).not.toBeNull()
    expect(pair.querySelector('.phn-pin')).not.toBeNull()
    // 새 짝이 살아 있다 — main 이 닫으면 결과로
    emit({ pairing: null })
    expect(pair.textContent).toContain('짝 맺기가 닫혔어요')
  })

  it('준비 중에 취소 — 늦게 온 시작 답이 나가는 창에 QR 을 다시 띄우지 않는다', async () => {
    ready()
    let answer!: () => void
    api.phonePairStart.mockImplementationOnce(
      () => new Promise(r => { answer = () => r({ qr: QR, pin: '482017', url: `${URL_OPEN}#pair=abc`, expiresAt: pairExpires }) }),
    )
    await renderApp()
    const { dlg } = await openPhone()
    allowMotion()
    const pair = await startPair(dlg)
    expect(pair.textContent).toContain('짝 맺기를 준비하는 중…')
    await act(async () => { fireEvent.click(within(pair).getByRole('button', { name: '취소' })) })
    expect(api.phonePairCancel).toHaveBeenCalledTimes(1)
    await act(async () => { answer() })
    expect(pair.isConnected).toBe(true)
    expect(pair.querySelector('.phn-pin')).toBeNull()
    expect(pair.querySelector('img')).toBeNull()
    await waitFor(() => expect(pair.isConnected).toBe(false))
  })

  it('결과는 처음부터 붙어 있던 빈 알림 자리(status)에 적는다 — 새로 붙는 자리는 읽히지 않을 수 있어서', async () => {
    ready()
    await renderApp()
    const { dlg } = await openPhone()
    const pair = await startPair(dlg)
    const [say, ...more] = within(pair).getAllByRole('status')
    expect(more).toEqual([])
    expect(say.textContent).toBe('')
    emit({ pairing: null })
    expect(within(pair).getAllByRole('status')).toEqual([say])
    expect(say.textContent).toContain('짝 맺기가 닫혔어요 — 다시 해 주세요')
    // 다시 — 비웠다가 결과에 또
    await act(async () => { fireEvent.click(within(pair).getByRole('button', { name: '다시 짝 맺기' })) })
    await settle()
    expect(say.textContent).toBe('')
    emit({ pairing: null, devices: [{ id: 'n1', name: '갤럭시 S25', createdAt: Date.now(), lastSeen: Date.now(), push: false }] })
    expect(within(pair).getAllByRole('status')).toEqual([say])
    expect(say.textContent).toContain('짝을 맺었어요')
    expect(say.textContent).toContain('이제 ‘갤럭시 S25’ 에서 두레를 열 수 있어요')
    // 결과 글은 한 번만 있다(읽기용 사본을 따로 두지 않는다)
    expect(within(pair).getAllByText('짝을 맺었어요')).toHaveLength(1)
  })

  it('짝 맺는 중에 휴대폰 연결이 꺼지면(트레이) — 꺼져서 닫았다는 글, 다시 짝 맺기 없음 · 닫으면 초점은 휴대폰 창', async () => {
    ready()
    await renderApp()
    const { dlg } = await openPhone()
    const pair = await startPair(dlg)
    emit({ settings: { ...phone.settings, enabled: false }, url: null, pairing: null })
    expect(pair.textContent).toContain('휴대폰 연결이 꺼져서 짝 맺기를 닫았어요')
    expect(pair.textContent).not.toContain('짝 맺기가 닫혔어요')
    expect(pair.querySelector('.phn-pin')).toBeNull()
    expect(within(pair).queryByRole('button', { name: '다시 짝 맺기' })).toBeNull()
    expect(within(pair).getByRole('status').textContent).toBe('휴대폰 연결이 꺼져서 짝 맺기를 닫았어요')
    const close = within(pair).getByRole('button', { name: '닫기' })
    expect(document.activeElement).toBe(close)
    await act(async () => { fireEvent.click(close) })
    await settle()
    expect(api.phonePairCancel).not.toHaveBeenCalled() // main 이 이미 닫았다
    expect(screen.queryByRole('dialog', { name: '휴대폰 짝 맺기' })).toBeNull()
    // [휴대폰 짝 맺기]는 막혔다 — 초점은 휴대폰 창으로
    expect((within(dlg).getByRole('button', { name: '휴대폰 짝 맺기' }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.activeElement).toBe(dlg)
  })

  it('주소가 닫혀도(켜짐인 채 url null) 같은 글 — 다시 짝 맺기 없음', async () => {
    ready()
    await renderApp()
    const { dlg } = await openPhone()
    const pair = await startPair(dlg)
    emit({ url: null, pairing: null })
    expect(pair.textContent).toContain('휴대폰 연결이 꺼져서 짝 맺기를 닫았어요')
    expect(within(pair).queryByRole('button', { name: '다시 짝 맺기' })).toBeNull()
  })

  it('짝이 맺어지면(pairing null + 새 기기) — 짝을 맺었어요, 취소를 부르지 않는다', async () => {
    ready()
    await renderApp()
    const { dlg } = await openPhone()
    const pair = await startPair(dlg)
    emit({ pairing: null, devices: [{ id: 'n1', name: '갤럭시 S25', createdAt: Date.now(), lastSeen: Date.now(), push: false }], online: ['n1'], connected: 1 })
    expect(pair.textContent).toContain('짝을 맺었어요')
    expect(pair.textContent).toContain('갤럭시 S25')
    expect(pair.querySelector('.phn-pin')).toBeNull()
    expect(pair.textContent).not.toContain('QR 을 휴대폰 카메라로 찍어 주세요') // 끝난 뒤엔 안내 대신 결과
    expect(document.activeElement).toBe(within(pair).getByRole('button', { name: '닫기' }))
    await act(async () => { fireEvent.click(within(pair).getByRole('button', { name: '닫기' })) })
    await settle()
    expect(api.phonePairCancel).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '휴대폰 짝 맺기' })).toBeNull()
  })

  it('새 기기 없이 닫히면(만료·틀림 상한) — 다시 짝 맺기', async () => {
    ready()
    await renderApp()
    const { dlg } = await openPhone()
    const pair = await startPair(dlg)
    emit({ pairing: null })
    expect(pair.textContent).toContain('짝 맺기가 닫혔어요 — 다시 해 주세요')
    expect(pair.querySelector('.phn-pin')).toBeNull()
    await act(async () => { fireEvent.click(within(pair).getByRole('button', { name: '다시 짝 맺기' })) })
    await settle()
    expect(api.phonePairStart).toHaveBeenCalledTimes(2)
    expect(pair.querySelector('.phn-pin')!.textContent).toBe('482 017')
  })

  it('남은 시간이 다 되면 사건이 늦어도 닫힌 것으로 — M:SS 로 센다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    pairExpires = Date.now() + 65_000
    ready()
    await renderApp()
    const { dlg } = await openPhone()
    const pair = await startPair(dlg)
    expect(pair.querySelector('.phn-left')!.textContent).toBe('1:05 남음 · 한 번만 쓸 수 있어요')
    act(() => { vi.advanceTimersByTime(6_000) })
    expect(pair.querySelector('.phn-left')!.textContent).toBe('0:59 남음 · 한 번만 쓸 수 있어요')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(pair.textContent).toContain('짝 맺기가 닫혔어요 — 다시 해 주세요')
    expect(document.activeElement).toBe(within(pair).getByRole('button', { name: '다시 짝 맺기' }))
  })

  it('남은 시간 글 — 5:00 을 넘지 않고 0:00 아래로 가지 않는다', async () => {
    const { leftText, pinText } = await import('../../src/renderer/shell/PhonePairDialog')
    expect(leftText(10_000 + 300_400, 10_000)).toBe('5:00') // 열 때 잰 시각이면 5분을 조금 넘는다
    expect(leftText(10_000 + 272_000, 10_000)).toBe('4:32')
    expect(leftText(10_000 + 1, 10_000)).toBe('0:01')
    expect(leftText(10_000, 20_000)).toBe('0:00')
    expect(pinText('482017')).toBe('482 017')
  })

  it('짝 맺기를 못 시작하면 까닭 — 다시 짝 맺기', async () => {
    ready()
    api.phonePairStart.mockRejectedValueOnce(new Error('휴대폰 연결이 아직 열리지 않았어요'))
    await renderApp()
    const { dlg } = await openPhone()
    const pair = await startPair(dlg)
    expect(within(pair).getByRole('alert').textContent).toBe('휴대폰 연결이 아직 열리지 않았어요')
    expect(within(pair).getByRole('button', { name: '다시 짝 맺기' })).toBeTruthy()
  })
})

describe('안드로이드 앱 칸', () => {
  const APP = { versionCode: 3, versionName: '0.2.0' }
  const qrText = vi.fn(async (_text: string, _opts?: unknown) => '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

  beforeEach(() => {
    qrText.mockClear()
    vi.doMock('qrcode', () => ({ default: { toString: qrText }, toString: qrText }))
  })
  afterEach(() => {
    vi.doUnmock('qrcode')
  })

  const section = (dlg: HTMLElement) => within(dlg).queryByRole('heading', { name: '안드로이드 앱' })
  const open = () => ({ settings: { ...phone.settings, enabled: true }, tailscale: READY, url: URL_OPEN, androidApp: APP })

  it('앱이 실려 있고 길이 열렸을 때만 칸이 보인다 — 두레 앱 · 판 · 안내 한 줄 · [앱 받기] · 순서는 짝 맺은 휴대폰 다음, 알림 · 전원 앞', async () => {
    phone = { ...phone, ...open() }
    await renderApp()
    const { dlg } = await openPhone()
    const head = section(dlg)!
    expect(head).toBeTruthy()
    const row = head.nextElementSibling as HTMLElement
    expect(row.textContent).toContain('두레 앱')
    expect(row.textContent).toContain('v0.2.0')
    expect(row.textContent).toContain('알림에 주소가 안 붙어요')
    expect(within(row).getByRole('button', { name: '앱 받기' })).toBeTruthy()
    const subs = Array.from(dlg.querySelectorAll('.phn-sub')).map(h => h.textContent)
    expect(subs).toEqual(['짝 맺은 휴대폰', '안드로이드 앱', '알림 · 전원'])
  })

  it('앱이 없으면(null) 칸이 없다 · 길이 닫혔으면(url null) 칸이 없다', async () => {
    phone = { ...phone, ...open(), androidApp: null }
    await renderApp()
    const { dlg } = await openPhone()
    expect(section(dlg)).toBeNull()
    emit({ androidApp: APP })
    expect(section(dlg)).toBeTruthy()
    emit({ url: null })
    expect(section(dlg)).toBeNull()
    expect(dlg.textContent).not.toContain('앱 받기')
  })

  it('[앱 받기] — 작은 창에 <origin>/dure.apk 의 QR 과 세 걸음 · Esc 는 그 창만 닫는다', async () => {
    phone = { ...phone, ...open(), url: 'https://fake-pc.tail0000.ts.net:8443/mobile.html' }
    await renderApp()
    const { dlg } = await openPhone()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '앱 받기' })) })
    await settle()
    const get = screen.getByRole('dialog', { name: '안드로이드 앱 받기' })
    expect(qrText).toHaveBeenCalledTimes(1)
    expect(qrText.mock.calls[0][0]).toBe('https://fake-pc.tail0000.ts.net:8443/dure.apk')
    expect(within(get).getByRole('img', { name: '두레 앱 받기 QR' }).getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(Array.from(get.querySelectorAll('ol li')).map(li => li.textContent)).toEqual([
      '휴대폰 카메라로 QR 을 찍어 앱을 받아요',
      "설치할 때 '출처를 알 수 없는 앱'을 허용해요",
      '크롬의 두레 화면에서 [두레 앱으로 열기]를 눌러요',
    ])
    fireEvent.keyDown(get, { key: 'Escape' })
    await settle()
    expect(screen.queryByRole('dialog', { name: '안드로이드 앱 받기' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '휴대폰' })).toBeTruthy()
  })

  it('길이 닫히면 열려 있던 작은 창도 닫힌다', async () => {
    phone = { ...phone, ...open() }
    await renderApp()
    const { dlg } = await openPhone()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '앱 받기' })) })
    await settle()
    emit({ url: null })
    await settle()
    expect(screen.queryByRole('dialog', { name: '안드로이드 앱 받기' })).toBeNull()
  })
})
