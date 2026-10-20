import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { animate } from 'animejs'
import { ModelPicker } from '../../src/renderer/panel/ModelPicker'
import { allowMotion, fastMotion } from './motion'

vi.mock('animejs', async orig => {
  const m = await orig<typeof import('animejs')>()
  return { ...m, animate: vi.fn(m.animate) }
})

afterEach(() => {
  cleanup()
  vi.mocked(animate).mockClear()
})

const DESC = {
  state: 'ready' as const,
  value: { commands: [], permissionMode: 'default' as const, models: [{ value: 'default', displayName: 'Default' }] },
}

function mount(other: () => void = () => {}) {
  return render(
    <div>
      <ModelPicker agentId="w" model={null} description={DESC} onLoad={() => {}} onRetry={() => {}} />
      <button type="button" onClick={other}>
        다른 버튼
      </button>
    </div>,
  )
}
const chip = () => screen.getByRole('button', { name: /^모델/ })

describe('떠 있는 목록 움직임 — ModelPicker', () => {
  it('열면 220ms outQuint 로 떠오르고, 기준점은 왼쪽 위', () => {
    allowMotion()
    mount()
    fireEvent.click(chip())
    const pop = screen.getByRole('menu')
    const call = vi.mocked(animate).mock.calls.find(c => c[0] === pop)
    expect(call).toBeTruthy()
    const p = call![1] as any
    expect(p.opacity.from).toBe(0)
    expect(p.translateY.from).toBe(8)
    expect(p.scale.from).toBe(0.96)
    expect(p.duration).toBe(220)
    expect(p.ease).toBe('outQuint')
    expect(pop.style.transformOrigin).toBe('top left')
  })

  it('닫으면 150ms 동안 남아 누를 수 없고, 그동안 다른 칩은 바로 눌린다', async () => {
    allowMotion()
    const restore = fastMotion(1)
    const other = vi.fn()
    mount(other)
    fireEvent.click(chip())
    const pop = screen.getByRole('menu')
    fireEvent.keyDown(pop, { key: 'Escape' })
    const still = screen.getByRole('menu')
    expect(still).toBe(pop)
    expect(still.hasAttribute('inert')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '다른 버튼' }))
    expect(other).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull(), { timeout: 1500 })
    restore()
  })

  it('움직임 줄이기면 animate 를 부르지 않고 Esc 에 바로 사라진다', () => {
    mount()
    fireEvent.click(chip())
    act(() => {
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(animate).not.toHaveBeenCalled()
  })
})
