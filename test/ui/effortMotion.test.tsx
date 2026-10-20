import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { animate } from 'animejs'
import type { AgentDescription, EffortLevel } from '../../src/engine/types'
import { EffortControl } from '../../src/renderer/panel/EffortControl'
import { allowMotion, fastMotion } from './motion'

vi.mock('animejs', async orig => {
  const m = await orig<typeof import('animejs')>()
  return { ...m, animate: vi.fn(m.animate) }
})

const ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const DESC: AgentDescription = {
  commands: [],
  permissionMode: 'default',
  models: [{ value: 'default', displayName: 'Default', supportsEffort: true, effortLevels: ALL }],
}

beforeEach(() => {
  ;(window as any).dure = { setEffort: vi.fn(async () => {}) }
  // jsdom 에는 토큰 변수가 없다 — 색 움직임을 보이게 채운다
  document.documentElement.style.setProperty('--primary', 'rgb(10, 20, 30)')
  document.documentElement.style.setProperty('--border-strong', 'rgb(200, 200, 200)')
})
afterEach(() => {
  cleanup()
  vi.mocked(animate).mockClear()
  document.documentElement.style.removeProperty('--primary')
  document.documentElement.style.removeProperty('--border-strong')
})

const ui = (effortNow: EffortLevel | null) => (
  <div className="pnl">
    <EffortControl
      agentId="w"
      effort={null}
      effortNow={effortNow}
      model={null}
      description={{ state: 'ready', value: DESC }}
      onLoad={() => {}}
      onRetry={() => {}}
    />
  </div>
)
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const chip = () => screen.getByRole('button', { name: /^effort/ })
const bars = () => Array.from(chip().querySelectorAll<HTMLElement>('.eff-bars i'))
const knob = () => document.querySelector<HTMLElement>('.eff-knob')!
const fill = () => document.querySelector<HTMLElement>('.eff-fill')!
const barCalls = () => vi.mocked(animate).mock.calls.filter(c => bars().includes(c[0] as HTMLElement))

describe('effort 움직임', () => {
  it('펼침을 처음 열 때 손잡이·채움은 움직이지 않고 그 자리에 있다', () => {
    allowMotion()
    render(ui('high'))
    fireEvent.click(chip())
    expect(vi.mocked(animate).mock.calls.some(c => c[0] === knob() || c[0] === fill())).toBe(false)
    expect(knob().style.left).toBe('50%')
    expect(fill().style.width).toBe('50%')
  })

  it('단계가 바뀌면 손잡이 left·채움 width 가 220ms outQuint 로', () => {
    allowMotion()
    render(ui('high'))
    fireEvent.click(chip())
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' })
    const k = vi.mocked(animate).mock.calls.find(c => c[0] === knob())
    const f = vi.mocked(animate).mock.calls.find(c => c[0] === fill())
    expect(k![1]).toMatchObject({ left: '75%', duration: 220, ease: 'outQuint' })
    expect(f![1]).toMatchObject({ width: '75%', duration: 220, ease: 'outQuint' })
  })

  it('칩 막대: high → max 면 4·5번째가 0·35ms 차례로 색이 바뀌고 0.45 에서 커진다', () => {
    allowMotion()
    const { rerender } = render(ui('high'))
    expect(barCalls()).toHaveLength(0)
    rerender(ui('max'))
    const calls = barCalls()
    expect(calls.map(c => bars().indexOf(c[0] as HTMLElement))).toEqual([3, 4])
    const [a, b] = calls.map(c => c[1] as any)
    expect(a.delay).toBe(0)
    expect(b.delay).toBe(35)
    for (const p of [a, b]) {
      expect(p.backgroundColor.duration).toBe(200)
      expect(p.backgroundColor.to).toBe('rgb(10, 20, 30)')
      expect(p.scaleY.from).toBe(0.45)
      expect(p.scaleY.duration).toBe(260)
    }
  })

  it('칩 막대: max → low 면 위 칸부터 5·4·3·2 가 0·35·70·105ms, 크기 변화 없음', () => {
    allowMotion()
    const { rerender } = render(ui('max'))
    rerender(ui('low'))
    const calls = barCalls()
    expect(calls.map(c => bars().indexOf(c[0] as HTMLElement))).toEqual([4, 3, 2, 1])
    expect(calls.map(c => (c[1] as any).delay)).toEqual([0, 35, 70, 105])
    for (const c of calls) {
      expect((c[1] as any).scaleY).toBeUndefined()
      expect((c[1] as any).backgroundColor.to).toBe('rgb(200, 200, 200)')
    }
  })

  it('막대 움직임이 끝나면 인라인 색을 지운다 — 켜짐은 on 클래스가 정본', async () => {
    allowMotion()
    const restore = fastMotion()
    const { rerender } = render(ui('high'))
    rerender(ui('max'))
    await waitFor(() => expect(bars()[4].style.backgroundColor).toBe(''), { timeout: 1500 })
    expect(bars()[4].style.transform).toBe('')
    expect(bars()[4].classList.contains('on')).toBe(true)
    restore()
  })

  it('막대가 움직이는 중에 거듭 바뀌어도(max ↔ low, 60ms 간격) 다 끝나면 인라인 transform·색이 남지 않는다', async () => {
    allowMotion()
    const { rerender } = render(ui('low'))
    // 오르는 막대(세로 크기 260ms)가 끝나기 전에 내리고, 내리는 색(200ms)이 끝나기 전에 다시 올린다
    for (const level of ['max', 'low', 'max', 'low', 'max', 'low', 'max', 'low'] as const) {
      rerender(ui(level))
      await sleep(60)
    }
    const restore = fastMotion()
    await sleep(300) // 20배 — 가장 긴 막대(105ms 뒤 260ms)의 몇 배
    restore()
    for (const b of bars()) {
      expect(b.style.transform).toBe('')
      expect(b.style.backgroundColor).toBe('')
    }
    expect(bars().map(b => b.classList.contains('on'))).toEqual([true, false, false, false, false])
  })

  it('키를 빠르게 여러 번 → 손잡이는 마지막 단계에서 멈춘다', async () => {
    allowMotion()
    const restore = fastMotion()
    render(ui('high'))
    fireEvent.click(chip())
    const s = screen.getByRole('slider')
    fireEvent.keyDown(s, { key: 'ArrowRight' })
    fireEvent.keyDown(s, { key: 'ArrowRight' })
    await waitFor(() => expect(knob().style.left).toBe('100%'), { timeout: 1500 })
    restore()
  })

  it('움직임 줄이기면 animate 를 부르지 않는다 — 손잡이 left 는 바로 그 단계', () => {
    const { rerender } = render(ui('high'))
    fireEvent.click(chip())
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' })
    expect(knob().style.left).toBe('75%')
    expect(fill().style.width).toBe('75%')
    rerender(ui('max'))
    expect(animate).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ left: expect.anything() }))
    expect(barCalls()).toHaveLength(0)
  })
})
