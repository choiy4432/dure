import { describe, it, expect, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useFrameValue } from '../../src/renderer/lib/useFrameValue'

afterEach(() => cleanup())
const frames = () => act(async () => { await new Promise(r => setTimeout(r, 60)) })

function Probe({ text }: { text: string }) {
  return <p data-testid="t">{useFrameValue(text)}</p>
}

describe('useFrameValue', () => {
  it('StrictMode(켜기·끄기·다시 켜기)에서도 마지막 값까지 따라간다', async () => {
    const { rerender } = render(<StrictMode><Probe text="하나" /></StrictMode>)
    await frames()
    for (const t of ['하나 둘', '하나 둘 셋', '하나 둘 셋 넷']) rerender(<StrictMode><Probe text={t} /></StrictMode>)
    await frames()
    expect(screen.getByTestId('t').textContent).toBe('하나 둘 셋 넷')
  })

  it('첫 그리기가 StrictMode 첫 장 직후여도 멈추지 않는다', async () => {
    const { rerender } = render(<StrictMode><Probe text="처음" /></StrictMode>)
    rerender(<StrictMode><Probe text="처음 바뀜" /></StrictMode>) // 장이 오기 전에 바로 바뀐다
    await frames()
    expect(screen.getByTestId('t').textContent).toBe('처음 바뀜')
  })
})
