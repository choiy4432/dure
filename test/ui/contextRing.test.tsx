import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ContextUsage } from '../../src/engine/types'
import { ContextRing } from '../../src/renderer/panel/ContextRing'

afterEach(() => cleanup())

const ctx = (percent: number, over: Partial<ContextUsage> = {}): ContextUsage => ({
  total: percent * 10_000, max: 1_000_000, percent, autoCompactAt: 967_000, at: 1, ...over,
})
const ring = (value: ContextUsage | null, working = false, onCompact = vi.fn()) =>
  render(<ContextRing agentId="w" name="웹 화면" value={value} working={working} onCompact={onCompact} />)
const btn = () => screen.getByRole('button', { name: /^대화 공간/ })

describe('ContextRing', () => {
  it('값이 없으면 아무것도 안 그린다', () => {
    const { container } = ring(null)
    expect(container).toBeEmptyDOMElement()
  })

  it('34% — 단추에 숫자, 앰버 아님', () => {
    ring(ctx(34))
    expect(btn()).toHaveAttribute('aria-label', '대화 공간 34% 사용')
    expect(btn()).toHaveTextContent('34%')
    expect(btn().closest('.ctx')).not.toHaveClass('warn')
  })

  it('자동 요약 지점의 80% 부터 앰버 — 77%는 아니고 78%는 맞다', () => {
    ring(ctx(77))
    expect(btn().closest('.ctx')).not.toHaveClass('warn')
    cleanup()
    ring(ctx(78))
    expect(btn().closest('.ctx')).toHaveClass('warn')
  })

  it('자동 요약이 꺼져 있으면 100% 기준 — 79% 아니고 80% 앰버', () => {
    ring(ctx(79, { autoCompactAt: null }))
    expect(btn().closest('.ctx')).not.toHaveClass('warn')
    cleanup()
    ring(ctx(80, { autoCompactAt: null }))
    expect(btn().closest('.ctx')).toHaveClass('warn')
  })

  it('누르면 펼침 — 토큰·안내', () => {
    ring(ctx(34))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(btn())
    const d = screen.getByRole('dialog', { name: '대화 공간 · 웹 화면' })
    expect(d).toHaveTextContent('34% 사용')
    expect(d).toHaveTextContent('34만 / 100만 토큰')
    expect(d).toHaveTextContent('97%가 되면 Claude 가 대화를 요약해서 이어 가요')
  })

  it('자동 요약이 꺼져 있으면 그 안내', () => {
    ring(ctx(34, { autoCompactAt: null }))
    fireEvent.click(btn())
    expect(screen.getByRole('dialog')).toHaveTextContent('자동 요약이 꺼져 있어요 — 가득 차기 전에 요약해 주세요')
  })

  it('일하는 중이면 [지금 요약하기] 막고 이유를 보인다', () => {
    const onCompact = vi.fn()
    ring(ctx(34), true, onCompact)
    fireEvent.click(btn())
    const b = screen.getByRole('button', { name: '지금 요약하기' })
    expect(b).toBeDisabled()
    expect(screen.getByRole('dialog')).toHaveTextContent('일이 끝나면 요약할 수 있어요')
    fireEvent.click(b)
    expect(onCompact).not.toHaveBeenCalled()
  })

  it('[지금 요약하기] — onCompact 한 번, 펼침 닫힘', () => {
    const onCompact = vi.fn()
    ring(ctx(34), false, onCompact)
    fireEvent.click(btn())
    expect(screen.getByRole('dialog')).not.toHaveTextContent('일이 끝나면')
    fireEvent.click(screen.getByRole('button', { name: '지금 요약하기' }))
    expect(onCompact).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Esc 로 닫고 링 단추로 돌아온다', () => {
    ring(ctx(34))
    fireEvent.click(btn())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(btn()).toHaveFocus()
  })

  it('바깥을 누르면 닫는다', () => {
    ring(ctx(34))
    fireEvent.click(btn())
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
