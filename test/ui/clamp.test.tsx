import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Clamp } from '../../src/renderer/lib/Clamp'

// jsdom 에는 레이아웃이 없다 — 상자 높이를 흉내 낸다
let tall = false
beforeEach(() => {
  tall = false
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => (tall ? 200 : 40))
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 54)
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
})
