import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'
import type { AgentDescription, EffortLevel } from '../../src/engine/types'
import { EffortControl } from '../../src/renderer/panel/EffortControl'
import type { Described } from '../../src/renderer/panel/ModelPicker'

const ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const DESC: AgentDescription = {
  commands: [],
  permissionMode: 'default',
  models: [
    { value: 'default', displayName: 'Default', supportsEffort: true, effortLevels: ALL },
    { value: 'haiku', displayName: 'Haiku' },
    { value: 'small', displayName: 'Small', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
  ],
}
const ready = (value: AgentDescription = DESC): Described => ({ state: 'ready', value })

let setEffort: ReturnType<typeof vi.fn>
beforeEach(() => {
  setEffort = vi.fn(async () => {})
  ;(window as any).dure = { setEffort }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

interface Over {
  effort?: EffortLevel | null
  effortNow?: EffortLevel | null
  model?: string | null
  description?: Described
  onLoad?: () => void
  onError?: (m: string) => void
}
const mount = (o: Over = {}) =>
  render(
    <div className="pnl">
      <EffortControl
        agentId="w"
        effort={o.effort ?? null}
        effortNow={o.effortNow ?? null}
        model={o.model ?? null}
        description={o.description ?? ready()}
        onLoad={o.onLoad ?? (() => {})}
        onRetry={() => {}}
        onError={o.onError}
      />
    </div>,
  )
const chip = () => screen.getByRole('button', { name: /^effort/ })
const open = () => fireEvent.click(chip())
const slider = () => screen.getByRole('slider')
const key = (k: string) => fireEvent.keyDown(slider(), { key: k })
const filled = () => chip().querySelectorAll('.eff-bars i.on').length

describe('EffortControl — 칩', () => {
  it('지금 쓰는 값(effortNow)이 있으면 그 이름, 막대는 그 단계까지', () => {
    mount({ effort: 'low', effortNow: 'high' })
    expect(chip().textContent).toBe('high')
    expect(filled()).toBe(3)
  })

  it('지금 값이 없으면 내가 정한 값', () => {
    mount({ effort: 'low' })
    expect(chip().textContent).toBe('low')
    expect(filled()).toBe(1)
  })

  it("둘 다 없으면 '내 설정' — 막대는 모두 회색", () => {
    mount()
    expect(chip().textContent).toBe('내 설정')
    expect(filled()).toBe(0)
  })

  it('패널이 400px 보다 좁으면 이름을 숨기고 aria-label·title 에 남긴다', () => {
    let cb: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(c: () => void) { cb = c }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    let width = 500
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width } as DOMRect))
    const { container } = mount({ effortNow: 'high' })
    expect(container.querySelector('.eff.narrow')).toBeNull()
    width = 360
    act(() => cb())
    expect(container.querySelector('.eff.narrow')).not.toBeNull()
    expect(chip().getAttribute('aria-label')).toBe('effort high')
    expect(chip().getAttribute('title')).toBe('effort high')
  })

  it('describe 를 받은 뒤 effort 를 못 정하는 모델이면 칩이 흐리다', () => {
    mount({ model: 'haiku', effortNow: 'high' })
    expect(chip().classList.contains('dim')).toBe(true)
  })
})

describe('EffortControl — 펼침', () => {
  it('열면 아직 안 받은 describe 를 한 번 부른다', () => {
    const onLoad = vi.fn()
    mount({ description: { state: 'idle' }, onLoad })
    expect(onLoad).not.toHaveBeenCalled()
    open()
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it('받는 중·실패 문구', () => {
    const { unmount } = mount({ description: { state: 'loading' } })
    open()
    expect(screen.getByText('불러오는 중…')).toBeTruthy()
    unmount()
    mount({ description: { state: 'error', error: 'x' } })
    open()
    expect(screen.getByRole('button', { name: '다시 받기' })).toBeTruthy()
  })

  it('제목·부제 · 슬라이더 값과 눈금 이름 다섯', () => {
    mount({ effortNow: 'high' })
    open()
    expect(screen.getByRole('dialog', { name: '생각하는 정도(effort)' })).toBeTruthy()
    expect(screen.getByText('높을수록 꼼꼼하지만 느리고 사용량을 더 써요')).toBeTruthy()
    expect(slider().getAttribute('aria-valuemin')).toBe('0')
    expect(slider().getAttribute('aria-valuemax')).toBe('4')
    expect(slider().getAttribute('aria-valuenow')).toBe('2')
    expect(slider().getAttribute('aria-valuetext')).toBe('high')
    const ticks = Array.from(document.querySelectorAll('.eff-tick')).map(t => t.textContent)
    expect(ticks).toEqual(ALL)
  })

  it('→ 두 번 빠르게 — 화면은 바로 max, 300ms 뒤 setEffort 한 번(max 만)', () => {
    vi.useFakeTimers()
    mount({ effortNow: 'high' })
    open()
    key('ArrowRight')
    key('ArrowRight')
    expect(slider().getAttribute('aria-valuetext')).toBe('max')
    expect(chip().textContent).toBe('max')
    expect(setEffort).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(299) })
    expect(setEffort).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(setEffort).toHaveBeenCalledTimes(1)
    expect(setEffort).toHaveBeenCalledWith('w', 'max')
  })

  it('max 에서 → 는 그대로 · Home 은 low · End 는 max', () => {
    vi.useFakeTimers()
    mount({ effortNow: 'max' })
    open()
    key('ArrowRight')
    expect(slider().getAttribute('aria-valuenow')).toBe('4')
    key('Home')
    expect(slider().getAttribute('aria-valuetext')).toBe('low')
    key('ArrowLeft')
    expect(slider().getAttribute('aria-valuenow')).toBe('0')
    key('End')
    expect(slider().getAttribute('aria-valuetext')).toBe('max')
  })

  it('눈금 이름을 눌러도 고른다', () => {
    vi.useFakeTimers()
    mount({ effortNow: 'high' })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'low' }))
    expect(slider().getAttribute('aria-valuetext')).toBe('low')
    act(() => { vi.advanceTimersByTime(300) })
    expect(setEffort).toHaveBeenCalledWith('w', 'low')
  })

  it('Esc 로 닫고 칩으로 돌아간다', () => {
    mount({ effortNow: 'high' })
    open()
    key('Escape')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(chip())
  })

  it('effort 를 못 정하는 모델 → 안내만, 슬라이더 없음', () => {
    mount({ model: 'haiku' })
    open()
    expect(screen.getByText('이 모델은 effort 를 정할 수 없어요')).toBeTruthy()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('모델의 effortLevels 에 없는 눈금은 흐리고 건너뛴다', () => {
    vi.useFakeTimers()
    mount({ model: 'small', effortNow: 'high' })
    open()
    expect(screen.getByRole('button', { name: 'xhigh' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'max' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'high' }).getAttribute('aria-disabled')).toBeNull()
    key('ArrowRight')
    expect(slider().getAttribute('aria-valuetext')).toBe('high')
    fireEvent.click(screen.getByRole('button', { name: 'max' }))
    expect(slider().getAttribute('aria-valuetext')).toBe('high')
    act(() => { vi.advanceTimersByTime(300) })
    expect(setEffort).not.toHaveBeenCalled()
  })

  it('보내기가 실패하면 엔진 문구를 onError 로', async () => {
    setEffort.mockRejectedValueOnce(new Error('지금은 못 바꿔요'))
    const onError = vi.fn()
    mount({ effortNow: 'high', onError })
    open()
    vi.useFakeTimers()
    key('ArrowLeft')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(onError).toHaveBeenCalledWith('지금은 못 바꿔요')
  })
})
