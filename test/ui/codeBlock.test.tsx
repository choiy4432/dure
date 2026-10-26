import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, cleanup, fireEvent, within } from '@testing-library/react'
import { Markdown } from '../../src/renderer/lib/Markdown'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const FENCE = '```'
const block = (lang: string, body: string) => render(<Markdown text={`앞 글\n\n${FENCE}${lang}\n${body}\n${FENCE}`} />).container.querySelector('.md-code') as HTMLElement

describe('코드 상자', () => {
  it.each(['', 'md', 'markdown', 'text', 'txt'])('글 상자(%s)는 줄을 바꿔 아래로 — 옆으로 밀지 않는다', lang => {
    expect(block(lang, '- v0.37.0 (2026-10-26) - 긴 한 줄').querySelector('pre')).toHaveClass('wrap')
  })

  it('코드(ts)는 들여쓰기가 깨지지 않게 옆으로 민다', () => {
    expect(block('ts', 'const a = 1').querySelector('pre')).not.toHaveClass('wrap')
  })

  it('오른쪽 위 복사 단추 — 끝 줄바꿈 뺀 원문을 클립보드에, 1.5초 동안 "복사했어요"', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async (_t: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const el = block('md', '### Added\n- 첫 줄\n- 둘째 줄')
    await act(async () => { fireEvent.click(within(el).getByRole('button', { name: '복사' })) })
    expect(writeText).toHaveBeenCalledWith('### Added\n- 첫 줄\n- 둘째 줄')
    expect(within(el).getByRole('button', { name: '복사했어요' })).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(1600) })
    expect(within(el).getByRole('button', { name: '복사' })).toBeTruthy()
  })

  it('클립보드를 못 쓰면 조용히 그대로 — 단추는 "복사" 그대로', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied') }) }, configurable: true })
    const el = block('', 'hello')
    await act(async () => { fireEvent.click(within(el).getByRole('button', { name: '복사' })) })
    expect(within(el).getByRole('button', { name: '복사' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
