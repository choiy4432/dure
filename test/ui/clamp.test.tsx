import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Clamp } from '../../src/renderer/lib/Clamp'

// jsdom 에는 레이아웃이 없다 — 상자 높이를 흉내 낸다.
// 숨은 상자(display:none 안)는 Chromium 처럼 — 높이가 모두 0, 그려진 자리(getClientRects)가 없다
let tall = false
let hidden = false
beforeEach(() => {
  tall = false
  hidden = false
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => (hidden ? 0 : tall ? 200 : 40))
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => (hidden ? 0 : 54))
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
    () => (hidden ? [] : [{ x: 0, y: 0, width: 300, height: 54, top: 0, left: 0, right: 300, bottom: 54 }]) as unknown as DOMRectList,
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const boxOf = (c: HTMLElement) => c.querySelector('.clamp-box') as HTMLElement

describe('Clamp', () => {
  it('짧은 내용: 버튼도 흐림도 없다', () => {
    const { container } = render(<Clamp>짧아요</Clamp>)
    expect(screen.queryByRole('button')).toBeNull()
    expect(boxOf(container)).not.toHaveClass('clamped')
  })

  it('긴 내용: 더 보기 버튼 + 접힌 클래스, 누르면 접기로 바뀌고 클래스가 빠진다', () => {
    tall = true
    const { container } = render(<Clamp>길어요</Clamp>)
    const btn = screen.getByRole('button', { name: '더 보기' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(btn).toHaveAttribute('aria-controls', boxOf(container).id)
    expect(boxOf(container)).toHaveClass('clamped')
    fireEvent.click(btn)
    const back = screen.getByRole('button', { name: '접기' })
    expect(back).toHaveAttribute('aria-expanded', 'true')
    expect(boxOf(container)).not.toHaveClass('clamped')
    fireEvent.click(back)
    expect(screen.getByRole('button', { name: '더 보기' })).toBeInTheDocument()
    expect(boxOf(container)).toHaveClass('clamped')
  })

  it('흐려진 상자를 눌러도 펼쳐진다', () => {
    tall = true
    const { container } = render(<Clamp>길어요</Clamp>)
    fireEvent.click(boxOf(container))
    expect(screen.getByRole('button', { name: '접기' })).toBeInTheDocument()
  })

  it('안의 링크를 누르면 펼치지 않는다', () => {
    tall = true
    const { container } = render(
      <Clamp>
        <a href="#x">링크</a>
      </Clamp>,
    )
    fireEvent.click(screen.getByText('링크'))
    expect(screen.getByRole('button', { name: '더 보기' })).toBeInTheDocument()
    expect(boxOf(container)).toHaveClass('clamped')
  })

  it('lines 는 CSS 변수로 간다(기본 3)', () => {
    const { container, rerender } = render(<Clamp>a</Clamp>)
    expect(boxOf(container).style.getPropertyValue('--clamp-lines')).toBe('3')
    rerender(<Clamp lines={5}>a</Clamp>)
    expect(boxOf(container).style.getPropertyValue('--clamp-lines')).toBe('5')
  })

  it('마크다운 상자(clamp-md)는 문단 사이 여백 둘(16px)만큼 더 — 한 줄 문단 셋은 접지 않는다(실제 배치는 e2e 8단계)', async () => {
    const fsName: string = 'node:fs'
    const css: string = (await import(/* @vite-ignore */ fsName)).readFileSync('src/renderer/styles/base.css', 'utf8')
    expect(css).toMatch(/\.clamp-box\.clamp-md\s*\{[^}]*--clamp-pad:\s*16px/)
    expect(css).toMatch(/\.md p,[^{]*\{[^}]*margin:\s*8px 0 0/) // 그 16px 의 근거 — 문단 사이 8px
  })

  it('상자 크기가 바뀌면 다시 잰다 — 좁아져서 넘치면 버튼이 생긴다', () => {
    let fire: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { fire = cb }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    render(<Clamp>가변</Clamp>)
    expect(screen.queryByRole('button')).toBeNull()
    tall = true
    fire()
    return screen.findByRole('button', { name: '더 보기' }).finally(() => vi.unstubAllGlobals())
  })

  describe('숨은 칸(패널 탭이 그려 둔 채 숨긴 대화·지도)', () => {
    let fire: () => void = () => {}
    beforeEach(() => {
      vi.stubGlobal('ResizeObserver', class {
        constructor(cb: () => void) { fire = cb }
        observe() {}
        unobserve() {}
        disconnect() {}
      })
    })
    afterEach(() => vi.unstubAllGlobals())

    it('숨으면(크기 0) 재지 않는다 — 더 보기·흐림이 그대로, 다시 보여도 그대로', () => {
      tall = true
      const { container, rerender } = render(<Clamp>길어요</Clamp>)
      expect(screen.getByRole('button', { name: '더 보기' })).toBeInTheDocument()
      hidden = true
      act(() => fire()) // 숨는 순간 — 상자가 0×0 이 된다
      expect(screen.getByRole('button', { name: '더 보기' })).toBeInTheDocument()
      expect(boxOf(container)).toHaveClass('clamped')
      rerender(<Clamp>길어요 — 숨은 동안 바뀐 글</Clamp>) // 숨은 동안 내용이 바뀌어도
      expect(screen.getByRole('button', { name: '더 보기' })).toBeInTheDocument()
      expect(boxOf(container)).toHaveClass('clamped')
      hidden = false
      act(() => fire()) // 다시 보인다
      expect(screen.getByRole('button', { name: '더 보기' })).toBeInTheDocument()
      expect(boxOf(container)).toHaveClass('clamped')
    })

    it('숨은 채 처음 그려지면 보일 때 잰다', () => {
      tall = true
      hidden = true
      const { container } = render(<Clamp>길어요</Clamp>)
      expect(screen.queryByRole('button')).toBeNull()
      hidden = false
      act(() => fire())
      expect(screen.getByRole('button', { name: '더 보기' })).toBeInTheDocument()
      expect(boxOf(container)).toHaveClass('clamped')
    })

    it('보이는 동안엔 그대로 잰다 — 넓어져 안 넘치면 버튼·흐림이 빠진다', () => {
      tall = true
      const { container } = render(<Clamp>가변</Clamp>)
      expect(screen.getByRole('button', { name: '더 보기' })).toBeInTheDocument()
      tall = false
      act(() => fire())
      expect(screen.queryByRole('button')).toBeNull()
      expect(boxOf(container)).not.toHaveClass('clamped')
    })
  })
})
