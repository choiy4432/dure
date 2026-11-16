import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'

// 파워 모드 덮개 — 켜져 있을 때만 그림 · Esc 길게 누르기로 나가기 · 다른 입력은 삼키고 힌트만

let setPowerMode: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  setPowerMode = vi.fn(async () => {})
  ;(window as any).dure = { setPowerMode, on: () => () => {} }
})
afterEach(() => {
  cleanup()
  document.body.querySelectorAll('[data-t]').forEach(n => n.remove())
  vi.doUnmock('../../src/renderer/power/ControlRoom')
  vi.useRealTimers()
})

async function mount(on = true) {
  const { getStore } = await import('../../src/renderer/state/store')
  const { PowerLayer } = await import('../../src/renderer/power/PowerLayer')
  const store = getStore()
  if (on) await act(async () => { await store.setPower(true) })
  const spy = vi.spyOn(store, 'setPower')
  const view = render(<PowerLayer />)
  return { store, spy, view }
}

const key = (type: 'keydown' | 'keyup', k: string, init: KeyboardEventInit = {}) => (type === 'keydown' ? fireEvent.keyDown : fireEvent.keyUp)(window, { key: k, ...init })
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('PowerLayer', () => {
  it('off — power.on 이 false 면 아무것도 안 그린다', async () => {
    await mount(false)
    expect(screen.queryByRole('application')).toBeNull()
  })

  it('shell — role application + 이름 + 초점 + 자리표 화면', async () => {
    const { view } = await mount()
    const app = screen.getByRole('application', { name: '파워 모드' })
    expect(document.activeElement).toBe(app)
    expect(document.body.contains(app)).toBe(true)
    expect(view.baseElement.querySelector('[data-power-screen="control"]')).not.toBeNull()
  })

  it('Esc 1499ms 누르고 떼면 안 나간다', async () => {
    const { spy } = await mount()
    key('keydown', 'Escape')
    await wait(1499)
    key('keyup', 'Escape')
    await wait(2000)
    expect(spy).not.toHaveBeenCalled()
  })

  it('Esc 1500ms 면 setPower(false) 한 번 · 누르는 동안 나가는 중…', async () => {
    const { spy } = await mount()
    key('keydown', 'Escape')
    await wait(600)
    expect(screen.getByText('나가는 중…')).toBeInTheDocument()
    await wait(900)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(false)
  })

  it('1400ms 에 떼고 다시 누르면 또 1500ms 가 필요하다', async () => {
    const { spy } = await mount()
    key('keydown', 'Escape')
    await wait(1400)
    key('keyup', 'Escape')
    key('keydown', 'Escape')
    await wait(1400)
    expect(spy).not.toHaveBeenCalled()
    await wait(100)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('window blur 면 취소', async () => {
    const { spy } = await mount()
    key('keydown', 'Escape')
    await wait(1000)
    fireEvent.blur(window)
    await wait(2000)
    expect(spy).not.toHaveBeenCalled()
    expect(screen.queryByText('나가는 중…')).toBeNull()
  })

  it('다른 키·클릭 → 힌트가 보였다가 2000ms 뒤 사라진다', async () => {
    await mount()
    expect(screen.queryByText('Esc 를 길게 누르면 나가요')).toBeNull()
    key('keydown', 'a')
    expect(screen.getByText('Esc 를 길게 누르면 나가요')).toBeInTheDocument()
    await wait(2000)
    expect(screen.queryByText('Esc 를 길게 누르면 나가요')).toBeNull()
    fireEvent.click(screen.getByRole('application'))
    expect(screen.getByText('Esc 를 길게 누르면 나가요')).toBeInTheDocument()
  })

  it('Ctrl+K 로 찾기 창이 안 열린다 — 진짜 useSearchShortcut', async () => {
    const { useSearchShortcut } = await import('../../src/renderer/shell/SearchPalette')
    const onOpen = vi.fn()
    function Probe() {
      useSearchShortcut(true, onOpen)
      return null
    }
    render(<Probe />)
    await mount()
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('꺼져 있으면 Ctrl+K 를 삼키지 않는다', async () => {
    const { useSearchShortcut } = await import('../../src/renderer/shell/SearchPalette')
    const onOpen = vi.fn()
    function Probe() {
      useSearchShortcut(true, onOpen)
      return null
    }
    render(<Probe />)
    await mount(false)
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('3000ms 가만히 있으면 커서가 숨고 움직이면 돌아온다', async () => {
    await mount()
    const app = screen.getByRole('application')
    expect(app).not.toHaveAttribute('data-idle')
    await wait(3000)
    expect(app).toHaveAttribute('data-idle')
    fireEvent.pointerMove(app)
    expect(app).not.toHaveAttribute('data-idle')
  })

  const EVENTS: Array<[string, (el: Element) => unknown]> = [
    ['keydown', el => fireEvent.keyDown(el, { key: 'a' })],
    ['keyup', el => fireEvent.keyUp(el, { key: 'a' })],
    ['pointerdown', el => fireEvent.pointerDown(el)],
    ['pointerup', el => fireEvent.pointerUp(el)],
    ['click', el => fireEvent.click(el)],
    ['wheel', el => fireEvent.wheel(el)],
    ['contextmenu', el => fireEvent.contextMenu(el)],
  ]
  describe.each(EVENTS)('삼키기 — %s', (type, fire) => {
    const probe = () => {
      const onDoc = vi.fn()
      const onWin = vi.fn()
      document.addEventListener(type, onDoc)
      window.addEventListener(type, onWin)
      return { onDoc, onWin, off: () => { document.removeEventListener(type, onDoc); window.removeEventListener(type, onWin) } }
    }
    it('켜져 있으면 덮개 밖 document·window 리스너에 안 닿는다', async () => {
      await mount()
      const p = probe()
      fire(document.body)
      p.off()
      expect(p.onDoc).not.toHaveBeenCalled()
      expect(p.onWin).not.toHaveBeenCalled()
    })
    it('꺼져 있으면 닿는다', async () => {
      await mount(false)
      const p = probe()
      fire(document.body)
      p.off()
      expect(p.onDoc).toHaveBeenCalled()
      expect(p.onWin).toHaveBeenCalled()
    })
  })

  it('Esc keydown 도 밖으로 새지 않고 기본 동작이 막힌다', async () => {
    await mount()
    const onDoc = vi.fn()
    document.addEventListener('keydown', onDoc)
    const notPrevented = fireEvent.keyDown(document.body, { key: 'Escape' })
    document.removeEventListener('keydown', onDoc)
    expect(onDoc).not.toHaveBeenCalled()
    expect(notPrevented).toBe(false)
  })

  it.each(['a', 'Tab', 'Enter', ' '])('키 %j 의 기본 동작이 막힌다', async k => {
    await mount()
    expect(fireEvent.keyDown(document.body, { key: k })).toBe(false)
  })

  it('클릭·휠·우클릭 기본 동작도 막힌다', async () => {
    await mount()
    expect(fireEvent.click(document.body)).toBe(false)
    expect(fireEvent.wheel(document.body)).toBe(false)
    expect(fireEvent.contextMenu(document.body)).toBe(false)
  })

  it('덮개 밖 요소에 초점이 가면 덮개로 되돌린다', async () => {
    await mount()
    const b = document.createElement('button')
    b.dataset.t = '1'
    document.body.appendChild(b)
    b.focus()
    expect(document.activeElement).toBe(screen.getByRole('application'))
  })

  it('켜진 동안 body 의 다른 자식은 inert · 꺼지면 원래대로 (원래 inert 였던 것은 그대로)', async () => {
    const a = document.createElement('div')
    const pre = document.createElement('div')
    a.dataset.t = pre.dataset.t = '1'
    pre.setAttribute('inert', '')
    document.body.append(a, pre)
    const { store } = await mount()
    const app = screen.getByRole('application')
    expect(a).toHaveAttribute('inert')
    expect(app).not.toHaveAttribute('inert')
    const late = document.createElement('div')
    late.dataset.t = '1'
    document.body.appendChild(late)
    await act(async () => { await Promise.resolve() })
    expect(late).toHaveAttribute('inert')
    await act(async () => { await store.setPower(false) })
    expect(a).not.toHaveAttribute('inert')
    expect(late).not.toHaveAttribute('inert')
    expect(pre).toHaveAttribute('inert')
  })

  it('나가기가 실패하면 2000ms 동안 안내가 뜬다', async () => {
    const { store } = await mount()
    vi.spyOn(store, 'setPower').mockRejectedValue(new Error('x'))
    key('keydown', 'Escape')
    await wait(1500)
    expect(screen.getByText('나가지 못했어요 — 다시 Esc 를 길게 눌러 주세요')).toBeInTheDocument()
    await wait(2000)
    expect(screen.queryByText('나가지 못했어요 — 다시 Esc 를 길게 눌러 주세요')).toBeNull()
  })

  it('Esc 를 누르는 동안 아래 화면은 다시 그려지지 않는다', async () => {
    let renders = 0
    vi.doMock('../../src/renderer/power/ControlRoom', () => ({ ControlRoom: () => { renders++; return <div data-power-screen="control" /> } }))
    await mount()
    const before = renders
    key('keydown', 'Escape')
    await wait(600)
    expect(screen.getByText('나가는 중…')).toBeInTheDocument()
    expect(renders).toBe(before)
  })

  it('움직임 줄이기면 stage 에 data-calm', async () => {
    const mm = (matches: boolean) => { window.matchMedia = ((q: string) => ({ matches, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as any }
    mm(true)
    const { view } = await mount()
    expect(view.baseElement.querySelector('.pw-stage')).toHaveAttribute('data-calm')
    cleanup()
    mm(false)
    const again = await mount()
    expect(again.view.baseElement.querySelector('.pw-stage')).not.toHaveAttribute('data-calm')
  })
})
