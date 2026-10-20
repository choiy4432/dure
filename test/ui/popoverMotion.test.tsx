import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { useCallback, useRef, useState } from 'react'
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

describe('떠 있는 창 움직임 — 관계도 엣지의 두 에이전트 메시지 창(PairPopover)', () => {
  beforeEach(() => {
    vi.resetModules()
    const snapshot = {
      claudeMissing: false, rooms: [{ id: 'r1', name: '방', createdAt: 1 }],
      agents: [
        { id: 'a', roomId: 'r1', name: '기획', role: '역할', folder: 'C:/w', sessionId: 's', started: true, auto: false, model: null, alwaysAllow: [], pos: { x: 64, y: 64 }, color: null, effort: null, lastContext: null, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, heldInput: 0 },
        { id: 'b', roomId: 'r1', name: '웹 화면', role: '역할', folder: 'C:/w', sessionId: 's', started: true, auto: false, model: null, alwaysAllow: [], pos: { x: 400, y: 64 }, color: null, effort: null, lastContext: null, effortNow: null, modelNow: null, status: 'idle', errorText: null, bypass: false, heldInput: 0 },
      ],
      messages: [{ id: 'm1', roomId: 'r1', from: 'a', to: 'b', text: '첫 메시지', createdAt: Date.now(), state: 'delivered', updatedAt: Date.now() }],
      requests: [], autoChainLimit: 3, usage: null,
    }
    ;(window as any).dure = { snapshot: async () => snapshot, history: async () => [], on: () => () => {} }
  })

  /** 관계도(MapCanvas)처럼 — 창은 Presence 안, 닫으면(pair = null) 마지막 모습으로 남아 나간다 */
  async function mount(other: () => void = () => {}) {
    const { getStore } = await import('../../src/renderer/state/store')
    const { PairPopover } = await import('../../src/renderer/map/RelationMap')
    const { Presence } = await import('../../src/renderer/lib/presence')
    await act(async () => { await getStore().init() })
    const closed = vi.fn()
    function Map() {
      const [open, setOpen] = useState(false)
      const bounds = useRef<HTMLDivElement>(null)
      const onClose = useCallback(() => {
        closed()
        setOpen(false)
      }, [])
      return (
        <div ref={bounds}>
          <p>바깥</p>
          <button type="button" onClick={() => setOpen(true)}>
            라벨
          </button>
          <button type="button" onClick={other}>
            다른 버튼
          </button>
          <Presence show={open}>{open && <PairPopover key="a>b" at={{ a: 'a', b: 'b', x: 10, y: 10 }} bounds={bounds} onClose={onClose} />}</Presence>
        </div>
      )
    }
    render(<Map />)
    const label = screen.getByRole('button', { name: '라벨' })
    label.focus()
    fireEvent.click(label)
    return { closed, label, pm: () => document.querySelector<HTMLElement>('.pm') }
  }

  it('열면 다른 떠 있는 목록처럼 220ms outQuint 로 떠오르고, 기준점은 왼쪽 위(창은 누른 자리의 오른쪽 아래에 left·top 으로 놓인다)', async () => {
    allowMotion()
    const { pm } = await mount()
    const el = pm()!
    expect(el).toBe(screen.getByRole('dialog', { name: '기획 · 웹 화면 사이에 오간 메시지' }))
    const call = vi.mocked(animate).mock.calls.find(c => c[0] === el)
    expect(call).toBeTruthy()
    const p = call![1] as any
    expect(p.opacity.from).toBe(0)
    expect(p.translateY.from).toBe(8)
    expect(p.scale.from).toBe(0.96)
    expect(p.duration).toBe(220)
    expect(p.ease).toBe('outQuint')
    expect(el.style.transformOrigin).toBe('top left')
    expect(document.activeElement).toBe(el) // 열리면 창으로 초점 — 지금과 같다
  })

  it('Esc 로 닫으면 초점은 바로 라벨로, 창은 150ms 동안 남아 누를 수 없다 — 그동안 Esc·바깥 누르기는 다시 닫지도 초점을 옮기지도 않는다', async () => {
    allowMotion()
    const restore = fastMotion(1)
    const other = vi.fn()
    const { closed, label, pm } = await mount(other)
    const el = pm()!
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(label) // 닫는 순간 — 움직임이 끝날 때가 아니라
    expect(pm()).toBe(el)
    expect(el.hasAttribute('inert')).toBe(true)
    expect(el.style.pointerEvents).toBe('none')
    // 나가는 중인 창은 키·누르기를 듣지 않는다
    const next = screen.getByRole('button', { name: '다른 버튼' })
    next.focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(screen.getByText('바깥'))
    expect(closed).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(next)
    fireEvent.click(next)
    expect(other).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(pm()).toBeNull(), { timeout: 1500 })
    restore()
  })

  it('움직임 줄이기면 animate 를 부르지 않고 Esc 에 바로 사라진다', async () => {
    const { closed, label, pm } = await mount()
    expect(pm()).not.toBeNull()
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(pm()).toBeNull()
    expect(document.activeElement).toBe(label)
    expect(animate).not.toHaveBeenCalled()
  })
})
