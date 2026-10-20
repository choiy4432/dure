import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react'
import type { PlanUsage } from '../../src/engine/types'

let usage: PlanUsage | null
let narrow = false
let refreshUsage: ReturnType<typeof vi.fn>

const win = (key: any, label: string, percent: number, resetsAt: number | null = null) => ({ key, label, percent, resetsAt })
const three = (m = 81): PlanUsage => ({
  at: Date.now(),
  windows: [
    win('session', '현재 세션', 12, Date.now() + 130 * 60_000 + 30_000),
    win('week', '주간', 34, Date.now() + 3 * 86_400_000),
    win('model:fable', 'Fable', m, Date.now() + 3 * 86_400_000),
  ],
})

beforeEach(() => {
  vi.resetModules()
  narrow = false
  usage = null
  refreshUsage = vi.fn(async () => {})
  // 좁은 창 질문은 narrow 로, 움직임 줄이기 질문은 늘 맞다고(setup.ts 기본값과 같게 — 이 시험은 움직이지 않는다)
  window.matchMedia = ((q: string) => ({
    matches: q === '(prefers-reduced-motion: reduce)' ? true : narrow, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    onchange: null, dispatchEvent: () => false,
  })) as any
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 3, usage }),
    history: async () => [], on: () => () => {}, refreshUsage,
  }
})
afterEach(() => cleanup())

async function mount() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { UsageMeters } = await import('../../src/renderer/shell/UsageMeters')
  await act(async () => { await getStore().init() })
  return render(<UsageMeters />)
}

describe('UsageMeters', () => {
  it('usage 가 null 이면 아무것도 그리지 않는다', async () => {
    const { container } = await mount()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('세 칸 — 라벨·정수 %, 81 만 앰버', async () => {
    usage = three()
    await mount()
    for (const t of ['5시간', '12%', '1주', '34%', 'Fable', '81%']) expect(screen.getByText(t)).toBeTruthy()
    expect(screen.getByText('81%').closest('.usg')!.classList.contains('warn')).toBe(true)
    expect(screen.getByText('34%').closest('.usg')!.classList.contains('warn')).toBe(false)
  })

  it('79 는 앰버 아님 · 80 은 앰버', async () => {
    usage = three(79)
    const r = await mount()
    expect(screen.getByText('79%').closest('.usg')!.classList.contains('warn')).toBe(false)
    r.unmount()
    cleanup()
    vi.resetModules()
    usage = three(80)
    await mount()
    expect(screen.getByText('80%').closest('.usg')!.classList.contains('warn')).toBe(true)
  })

  it('100 이면 다 썼어요 · 위험', async () => {
    usage = three(100)
    await mount()
    const el = screen.getByText('다 썼어요')
    expect(el.closest('.usg')!.classList.contains('danger')).toBe(true)
  })

  it('좁은 창이면 가장 높은 칸 하나만', async () => {
    narrow = true
    usage = three()
    await mount()
    expect(screen.getByText('81%')).toBeTruthy()
    expect(screen.queryByText('12%')).toBeNull()
    expect(screen.queryByText('34%')).toBeNull()
  })

  it('누르면 dialog — 줄·초기화 문구·방금 기준 · refreshUsage 한 번 · Esc 로 닫힘', async () => {
    usage = three()
    await mount()
    const btn = screen.getByRole('button')
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fireEvent.click(btn) })
    const dlg = screen.getByRole('dialog')
    expect(dlg.textContent).toContain('사용량')
    expect(dlg.textContent).toContain('내 계정')
    expect(dlg.textContent).toContain('1주 · Fable 전용')
    expect(dlg.textContent).toContain('1주 · 모든 모델')
    expect(dlg.textContent).toContain('2시간 10분 뒤 초기화')
    expect(dlg.textContent).toContain('방금 기준')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(refreshUsage).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.keyDown(dlg, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('바깥을 누르면 닫힘 · resetsAt null 이면 초기화 줄 없음', async () => {
    usage = { at: Date.now(), windows: [win('session', 's', 5, null)] }
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(screen.getByRole('dialog').textContent).not.toContain('초기화')
    await act(async () => { fireEvent.pointerDown(document.body) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('100% 이상이면 펼침 줄에도 다 썼어요 — 위험 색, 막대와 같은 말', async () => {
    usage = three(100)
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    const dlg = screen.getByRole('dialog')
    const row = within(dlg).getByText('1주 · Fable 전용').closest('.usg-row') as HTMLElement
    expect(row.classList.contains('danger')).toBe(true)
    expect(row.querySelector('b')!.textContent).toBe('다 썼어요')
    expect(dlg.textContent).not.toContain('100%')
  })

  it('초기화 시각이 지난 창은 새 값이 올 때까지 중립 — 100% 여도 위험 색·다 썼어요 없이, 펼침 줄은 초기화됨 · 새로 확인 중', async () => {
    usage = {
      at: Date.now() - 10 * 60_000,
      windows: [win('session', '현재 세션', 100, Date.now() - 60_000), win('week', '주간', 34, Date.now() + 3 * 86_400_000)],
    }
    await mount()
    expect(screen.queryByText('다 썼어요')).toBeNull()
    const bar = screen.getByRole('button').querySelector('.usg') as HTMLElement
    expect(bar.textContent).toContain('5시간')
    expect(bar.classList.contains('danger')).toBe(false)
    expect(bar.classList.contains('warn')).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    const dlg = screen.getByRole('dialog')
    const row = within(dlg).getByText('5시간').closest('.usg-row') as HTMLElement
    expect(row.classList.contains('danger')).toBe(false)
    expect(row.classList.contains('warn')).toBe(false)
    expect(row.textContent).toContain('초기화됨 · 새로 확인 중')
    expect(row.textContent).not.toContain('다 썼어요')
    expect(dlg.textContent).not.toContain('곧 초기화')
  })

  it('좁은 창에서 고르는 가장 높은 칸은 초기화가 지나지 않은 칸', async () => {
    narrow = true
    usage = {
      at: Date.now(),
      windows: [win('session', '현재 세션', 100, Date.now() - 60_000), win('week', '주간', 34, Date.now() + 3 * 86_400_000)],
    }
    await mount()
    expect(screen.getByText('34%')).toBeTruthy()
    expect(screen.queryByText('100%')).toBeNull()
  })
})

