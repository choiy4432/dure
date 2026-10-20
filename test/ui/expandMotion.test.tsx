import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { animate } from 'animejs'
import { Presence } from '../../src/renderer/lib/presence'
import { useExpand } from '../../src/renderer/lib/expand'
import { Clamp } from '../../src/renderer/lib/Clamp'
import { Empty } from '../../src/renderer/shell/Empty'
import { allowMotion, fastMotion } from './motion'

vi.mock('animejs', async orig => {
  const m = await orig<typeof import('animejs')>()
  return { ...m, animate: vi.fn(m.animate) }
})

// jsdom 에는 레이아웃이 없다 — 상자 높이를 흉내 낸다
let offset = 60
beforeEach(() => {
  offset = 60
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => 120)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => offset)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 54)
})
afterEach(() => {
  cleanup()
  vi.mocked(animate).mockClear()
  vi.restoreAllMocks()
})

function Body() {
  const ref = useRef<HTMLDivElement>(null)
  useExpand(ref)
  return (
    <div ref={ref} data-testid="body">
      내용
    </div>
  )
}
function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)}>
        토글
      </button>
      <Presence show={open}>
        <Body />
      </Presence>
    </div>
  )
}

const callFor = (el: Element) => vi.mocked(animate).mock.calls.find(c => c[0] === el)

describe('접기·펼치기 높이', () => {
  it('하는 일 펼치기: 높이 0 에서 제 높이로 260ms outQuint, 끝나면 인라인 height 없음', async () => {
    allowMotion()
    const restore = fastMotion(50)
    render(<Harness />)
    fireEvent.click(screen.getByText('토글'))
    const body = screen.getByTestId('body')
    const p = callFor(body)![1] as any
    expect(p.height).toEqual({ from: '0px', to: '120px' })
    expect(p.duration).toBe(260)
    expect(p.ease).toBe('outQuint')
    expect(body.style.overflow).toBe('hidden')
    await waitFor(() => expect(body.style.height).toBe(''))
    expect(body.style.overflow).toBe('')
    restore()
  })

  it('하는 일 접기: 260ms 동안 남아 inert, 높이 0 으로 간 뒤 사라짐', async () => {
    allowMotion()
    const restore = fastMotion(50)
    render(<Harness />)
    fireEvent.click(screen.getByText('토글'))
    await waitFor(() => expect(screen.getByTestId('body').style.height).toBe(''))
    vi.mocked(animate).mockClear()
    fireEvent.click(screen.getByText('토글'))
    const body = screen.getByTestId('body')
    expect(body.hasAttribute('inert')).toBe(true)
    expect(body.style.pointerEvents).toBe('none')
    const p = callFor(body)![1] as any
    expect(p.height).toEqual({ from: '60px', to: '0px' })
    expect(p.duration).toBe(260)
    expect(p.ease).toBe('outCubic')
    await waitFor(() => expect(screen.queryByTestId('body')).toBeNull(), { timeout: 1500 })
    restore()
  })

  it('처음 그릴 때 있던 것은 움직이지 않는다', () => {
    allowMotion()
    render(
      <Presence show>
        <Body />
      </Presence>,
    )
    expect(callFor(screen.getByTestId('body'))).toBeUndefined()
  })

  it('긴 메시지 더 보기: lim 은 바로 빠지고 높이가 접힌 높이 → 전체 높이로 260ms', async () => {
    allowMotion()
    const restore = fastMotion(50)
    const { container } = render(<Clamp>길어요</Clamp>)
    const box = container.querySelector('.clamp-box') as HTMLElement
    expect(box).toHaveClass('lim')
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
    expect(box).not.toHaveClass('lim')
    const p = callFor(box)![1] as any
    expect(p.height).toEqual({ from: '60px', to: '120px' })
    expect(p.duration).toBe(260)
    await waitFor(() => expect(box.style.height).toBe(''))
    restore()
  })

  it('긴 메시지 접기: 높이가 줄어든 뒤에야 clamped(흐림)가 다시 붙는다', async () => {
    allowMotion()
    const restore = fastMotion(1)
    const { container } = render(<Clamp>길어요</Clamp>)
    const box = container.querySelector('.clamp-box') as HTMLElement
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
    await waitFor(() => expect(box.style.height).toBe(''), { timeout: 2000 })
    vi.mocked(animate).mockClear()
    fireEvent.click(screen.getByRole('button', { name: '접기' }))
    expect(box).not.toHaveClass('clamped')
    expect(box).not.toHaveClass('lim')
    expect(callFor(box)).toBeTruthy()
    await waitFor(() => expect(box).toHaveClass('clamped'), { timeout: 2000 })
    expect(box).toHaveClass('lim')
    expect(box.style.height).toBe('')
    restore()
  })

  it('움직임 줄이기면 지금처럼 바로 펼치고 접힌다', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('토글'))
    expect(screen.getByTestId('body')).toBeTruthy()
    fireEvent.click(screen.getByText('토글'))
    expect(screen.queryByTestId('body')).toBeNull()

    const { container } = render(<Clamp>길어요</Clamp>)
    const box = container.querySelector('.clamp-box') as HTMLElement
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
    expect(box).not.toHaveClass('lim')
    fireEvent.click(screen.getByRole('button', { name: '접기' }))
    expect(box).toHaveClass('clamped')
    expect(box).toHaveClass('lim')

    render(<Empty kind="load" detail="boom" />)
    fireEvent.click(screen.getByRole('button', { name: /자세히/ }))
    expect(document.querySelector('.empty-x')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /자세히/ }))
    expect(document.querySelector('.empty-x')).toBeNull()
    expect(animate).not.toHaveBeenCalled()
  })

  it('Empty 자세히: 펼치면 .empty-x 가 높이로 자란다', () => {
    allowMotion()
    render(<Empty kind="load" detail="boom" />)
    fireEvent.click(screen.getByRole('button', { name: /자세히/ }))
    const p = callFor(document.querySelector('.empty-x')!.parentElement!)![1] as any
    expect(p.height.from).toBe('0px')
  })

  it('접히는 도중 다시 보이면 같은 노드가 지금 높이에서 제 높이로 다시 자란다', () => {
    allowMotion()
    const restore = fastMotion(1)
    render(<Harness />)
    fireEvent.click(screen.getByText('토글'))
    const body = screen.getByTestId('body')
    fireEvent.click(screen.getByText('토글')) // 접기 시작
    expect(body.hasAttribute('inert')).toBe(true)
    offset = 30 // 접히는 중 지금 높이
    vi.mocked(animate).mockClear()
    fireEvent.click(screen.getByText('토글')) // 다시 열기
    expect(screen.getByTestId('body')).toBe(body)
    expect(body.hasAttribute('inert')).toBe(false)
    const p = callFor(body)![1] as any
    expect(p.height).toEqual({ from: '30px', to: '120px' })
    restore()
  })

  it('긴 메시지 접기가 끝나는 순간: 인라인 높이를 지울 때 이미 lim 이 붙어 있다(한 프레임도 제한 없이 그려지지 않는다)', async () => {
    allowMotion()
    const restore = fastMotion(50)
    const { container } = render(<Clamp>길어요</Clamp>)
    const box = container.querySelector('.clamp-box') as HTMLElement
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }))
    await waitFor(() => expect(box.style.height).toBe(''))
    fireEvent.click(screen.getByRole('button', { name: '접기' }))
    const seen: boolean[] = []
    const orig = CSSStyleDeclaration.prototype.removeProperty
    vi.spyOn(CSSStyleDeclaration.prototype, 'removeProperty').mockImplementation(function (this: CSSStyleDeclaration, name: string) {
      if (name === 'height' && this === box.style) seen.push(box.classList.contains('lim'))
      return orig.call(this, name)
    })
    await waitFor(() => expect(box).toHaveClass('clamped'), { timeout: 2000 })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
    restore()
  })
})
