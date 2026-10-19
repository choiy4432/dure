import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SplitView, clampRatio, SPLIT_KEY } from '../../src/renderer/shell/SplitView'

// jsdom 은 배치를 계산하지 않는다 — 나눔 화면 너비를 흉내 낸다
function fakeWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: 800, width, height: 800, toJSON: () => ({}),
  } as DOMRect)
}

/** 관계도 쪽 칸의 px 너비(flex-basis % × 전체), 패널 = 나머지 - 경계선 1px */
function widths(container: HTMLElement, total: number) {
  const map = container.querySelector<HTMLElement>('.sv-map')!
  const left = (parseFloat(map.style.flexBasis) / 100) * total
  return { left, right: total - left - 1 }
}

function setup(width = 1280, props: Partial<Parameters<typeof SplitView>[0]> = {}) {
  fakeWidth(width)
  const r = render(<SplitView left={<div>관계도 칸</div>} right={<div>패널 칸</div>} {...props} />)
  return { ...r, sep: screen.getByRole('separator') }
}

function drag(sep: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(sep, { clientX: from, pointerId: 1, button: 0 })
  fireEvent.pointerMove(sep, { clientX: to, pointerId: 1 })
  fireEvent.pointerUp(sep, { clientX: to, pointerId: 1 })
}

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('clampRatio', () => {
  it('0.5~0.8 안, 관계도 ≥ 400px · 패널 ≥ 360px', () => {
    expect(clampRatio(0.62, 1440)).toBe(0.62)
    expect(clampRatio(0.1, 3000)).toBe(0.5)
    expect(clampRatio(0.99, 3000)).toBe(0.8)
    const hi = clampRatio(1, 1280)
    expect(1280 - hi * 1280 - 1).toBeGreaterThanOrEqual(360)
    expect(clampRatio(0, 1280) * 1280).toBeGreaterThanOrEqual(400)
  })
})

describe('SplitView', () => {
  it('두 칸을 그리고 기본 비율은 62 : 38', () => {
    const { sep, container } = setup(1440)
    expect(screen.getByText('관계도 칸')).toBeTruthy()
    expect(screen.getByText('패널 칸')).toBeTruthy()
    expect(sep.getAttribute('aria-valuenow')).toBe('62')
    expect(widths(container, 1440).left).toBeCloseTo(0.62 * 1440)
  })

  it('1280 폭에서 경계선을 끝까지 끌어도 패널 ≥ 360 · 관계도 ≥ 400', () => {
    const { sep, container } = setup(1280)
    drag(sep, 794, 1280)
    let w = widths(container, 1280)
    expect(w.right).toBeGreaterThanOrEqual(360)
    expect(w.left).toBeGreaterThanOrEqual(400)
    expect(w.right).toBeLessThan(361) // 끝까지 갔다

    drag(sep, 919, 0)
    w = widths(container, 1280)
    expect(w.left).toBeGreaterThanOrEqual(400)
    expect(w.left).toBeCloseTo(0.5 * 1280) // 0.5 아래로는 안 간다
    expect(w.right).toBeGreaterThanOrEqual(360)
  })

  it('넓은 창에서도 비율은 0.8 을 넘지 않는다', () => {
    const { sep, container } = setup(3000)
    drag(sep, 1860, 3000)
    expect(widths(container, 3000).left).toBeCloseTo(0.8 * 3000)
    expect(sep.getAttribute('aria-valuenow')).toBe('80')
  })

  it('끌기를 놓으면 비율을 dure.split 에 저장한다', () => {
    const { sep } = setup(1280)
    drag(sep, 794, 768)
    expect(localStorage.getItem(SPLIT_KEY)).toBe('0.6')
    expect(sep.getAttribute('aria-valuenow')).toBe('60')
  })

  it('저장된 비율로 시작하고, 이상한 값은 기본값·범위로', () => {
    localStorage.setItem(SPLIT_KEY, '0.7')
    let r = setup(1440)
    expect(r.sep.getAttribute('aria-valuenow')).toBe('70')
    r.unmount()
    localStorage.setItem(SPLIT_KEY, '글자')
    r = setup(1440)
    expect(r.sep.getAttribute('aria-valuenow')).toBe('62')
    r.unmount()
    localStorage.setItem(SPLIT_KEY, '0.95')
    r = setup(1440)
    expect(r.sep.getAttribute('aria-valuenow')).toBe('75') // (1440-361)/1440 ≈ 0.749
  })

  it('경계선에 포커스 → ←/→ 로 2%씩, 범위 끝에서 멈춘다', () => {
    const { sep } = setup(1280)
    expect(sep.tabIndex).toBe(0)
    sep.focus()
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(sep.getAttribute('aria-valuenow')).toBe('64')
    expect(localStorage.getItem(SPLIT_KEY)).toBe('0.64')
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(sep.getAttribute('aria-valuenow')).toBe('60')
    for (let i = 0; i < 20; i++) fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(sep.getAttribute('aria-valuenow')).toBe('72') // 패널 360px 에서 멈춤
    for (let i = 0; i < 20; i++) fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(sep.getAttribute('aria-valuenow')).toBe('50')
    fireEvent.keyDown(sep, { key: 'Enter' }) // 다른 키는 무시
    expect(sep.getAttribute('aria-valuenow')).toBe('50')
  })

  it('localStorage 가 막혀도(읽기·쓰기 throw) 그대로 동작한다', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('막힘') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('막힘') })
    // 처리기 안에서 던진 오류는 React 가 창의 error 이벤트로 알린다 — 하나도 없어야 한다
    const errors: unknown[] = []
    const onError = (e: ErrorEvent) => { errors.push(e.error); e.preventDefault() }
    window.addEventListener('error', onError)
    try {
      const { sep, container } = setup(1280)
      expect(sep.getAttribute('aria-valuenow')).toBe('62')
      drag(sep, 794, 1280)
      expect(widths(container, 1280).right).toBeGreaterThanOrEqual(360)
      expect(sep.classList.contains('drag')).toBe(false)
      fireEvent.keyDown(sep, { key: 'ArrowLeft' })
      expect(sep.getAttribute('aria-valuenow')).toBe('70')
      expect(errors).toEqual([])
    } finally {
      window.removeEventListener('error', onError)
    }
  })

  it('ratio 를 받으면 그 값을 쓰고 바뀐 값은 onRatio 로 알린다', () => {
    const onRatio = vi.fn()
    const { sep } = setup(1440, { ratio: 0.55, onRatio })
    expect(sep.getAttribute('aria-valuenow')).toBe('55')
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(onRatio).toHaveBeenLastCalledWith(0.57)
  })
})
