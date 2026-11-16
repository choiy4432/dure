import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react'

// 파워 모드 덮개 — 일하는 화면: 입력을 막지 않는다(삼키기·초점 붙잡기·inert·커서 숨김 없음).
// 나가기는 위 띠의 [나가기] 단추 · Esc 길게(글 입력 중이 아니고 떠 있는 창이 없을 때만). 층은 대화상자·찾기·메뉴·토스트 아래

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
const overlay = () => screen.getByRole('region', { name: '파워 모드' })
/** 덮개 밖(body 아래)에 붙이는 요소 — 시험이 끝나면 지운다 */
const outside = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) => {
  const el = document.createElement(tag)
  el.dataset.t = '1'
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.appendChild(el)
  return el
}

describe('PowerLayer — 덮개', () => {
  it('off — power.on 이 false 면 아무것도 안 그린다', async () => {
    await mount(false)
    expect(screen.queryByRole('region', { name: '파워 모드' })).toBeNull()
    expect(document.querySelector('.pw')).toBeNull()
  })

  it('이름 붙은 영역(application 아님) · 켤 때 초점이 덮개로 한 번 · 관제실 화면', async () => {
    const { view } = await mount()
    const el = overlay()
    expect(screen.queryByRole('application')).toBeNull()
    expect(document.activeElement).toBe(el)
    expect(view.baseElement.querySelector('[data-power-screen="control"]')).not.toBeNull()
  })

  it('켜져 있어도 바깥 body 자식에 inert 가 없다', async () => {
    const a = outside('div')
    await mount()
    const late = outside('div')
    await act(async () => { await Promise.resolve() })
    for (const el of Array.from(document.body.children)) expect(el).not.toHaveAttribute('inert')
    expect(a).not.toHaveAttribute('inert')
    expect(late).not.toHaveAttribute('inert')
  })

  it('덮개 밖 요소로 초점이 가도 덮개로 되돌리지 않는다(초점을 붙잡지 않는다)', async () => {
    await mount()
    const b = outside('button')
    b.focus()
    expect(document.activeElement).toBe(b)
  })

  const EVENTS: Array<[string, (el: Element) => unknown]> = [
    ['keydown', el => fireEvent.keyDown(el, { key: 'a' })],
    ['keyup', el => fireEvent.keyUp(el, { key: 'a' })],
    ['pointerdown', el => fireEvent.pointerDown(el)],
    ['click', el => fireEvent.click(el)],
    ['wheel', el => fireEvent.wheel(el)],
    ['contextmenu', el => fireEvent.contextMenu(el)],
  ]
  it.each(EVENTS)('켜져 있어도 %s 가 덮개 밖 document·window 리스너에 닿고 기본 동작도 그대로', async (type, fire) => {
    await mount()
    const onDoc = vi.fn()
    const onWin = vi.fn()
    document.addEventListener(type, onDoc)
    window.addEventListener(type, onWin)
    const notPrevented = fire(overlay())
    document.removeEventListener(type, onDoc)
    window.removeEventListener(type, onWin)
    expect(onDoc).toHaveBeenCalled()
    expect(onWin).toHaveBeenCalled()
    expect(notPrevented).toBe(true)
  })

  it('Ctrl+K 로 찾기가 열린다 — 진짜 useSearchShortcut', async () => {
    const { useSearchShortcut } = await import('../../src/renderer/shell/SearchPalette')
    const onOpen = vi.fn()
    function Probe() {
      useSearchShortcut(true, onOpen)
      return null
    }
    render(<Probe />)
    await mount()
    fireEvent.keyDown(overlay(), { key: 'k', ctrlKey: true })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('다른 키·클릭에 안내 글이 뜨지 않고 3000ms 가만히 있어도 커서를 숨기지 않는다', async () => {
    await mount()
    key('keydown', 'a')
    fireEvent.click(overlay())
    expect(screen.queryByText('Esc 를 길게 누르면 나가요')).toBeNull()
    await wait(3000)
    expect(overlay()).not.toHaveAttribute('data-idle')
  })

  it('onSettings 를 넘기면 위 띠에 [설정] — 누르면 onSettings · 안 넘기면 단추도 없다', async () => {
    const { getStore } = await import('../../src/renderer/state/store')
    const { PowerLayer } = await import('../../src/renderer/power/PowerLayer')
    await act(async () => { await getStore().setPower(true) })
    const onSettings = vi.fn()
    const view = render(<PowerLayer onSettings={onSettings} />)
    fireEvent.click(screen.getByRole('button', { name: '설정' }))
    expect(onSettings).toHaveBeenCalledTimes(1)
    view.rerender(<PowerLayer />)
    expect(screen.queryByRole('button', { name: '설정' })).toBeNull()
    expect(screen.getByRole('button', { name: '나가기' })).toBeInTheDocument()
  })

  it('[나가기] 단추를 누르면 setPower(false)', async () => {
    const { spy } = await mount()
    fireEvent.click(screen.getByRole('button', { name: '나가기' }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(false)
  })

  it('초점이 body 일 때 Esc 1500ms 면 setPower(false) 한 번 · 누르는 동안 나가는 중…', async () => {
    const { spy } = await mount()
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await wait(600)
    expect(screen.getByText('나가는 중…')).toBeInTheDocument()
    await wait(900)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(false)
  })

  it('Esc 는 삼키지 않는다 — 덮개 밖 리스너에 닿고 기본 동작도 그대로', async () => {
    await mount()
    const onDoc = vi.fn()
    document.addEventListener('keydown', onDoc)
    const notPrevented = fireEvent.keyDown(overlay(), { key: 'Escape' })
    document.removeEventListener('keydown', onDoc)
    expect(onDoc).toHaveBeenCalled()
    expect(notPrevented).toBe(true)
  })

  it('textarea 에 초점을 두고 Esc 1500ms → 안 꺼진다', async () => {
    const { spy } = await mount()
    const ta = outside('textarea')
    ta.focus()
    fireEvent.keyDown(ta, { key: 'Escape' })
    await wait(2000)
    expect(spy).not.toHaveBeenCalled()
    expect(screen.queryByText('나가는 중…')).toBeNull()
  })

  it('덮개 밖에 role="dialog" 가 열려 있으면 Esc 1500ms → 안 꺼진다 · 닫히면 다시 듣는다', async () => {
    const { spy } = await mount()
    const dlg = outside('div', { role: 'dialog' })
    key('keydown', 'Escape')
    await wait(2000)
    key('keyup', 'Escape')
    expect(spy).not.toHaveBeenCalled()
    dlg.remove()
    key('keydown', 'Escape')
    await wait(1500)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it.each(['menu', 'listbox'])('role="%s" 가 떠 있어도 Esc 길게는 듣지 않는다', async role => {
    const { spy } = await mount()
    outside('div', { role })
    key('keydown', 'Escape')
    await wait(2000)
    expect(spy).not.toHaveBeenCalled()
  })

  it('나가는 중(inert)인 창은 떠 있는 것으로 치지 않는다', async () => {
    const { spy } = await mount()
    outside('div', { role: 'dialog', inert: '' })
    key('keydown', 'Escape')
    await wait(1500)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('Esc 1499ms 누르고 떼면 안 나간다', async () => {
    const { spy } = await mount()
    key('keydown', 'Escape')
    await wait(1499)
    key('keyup', 'Escape')
    await wait(2000)
    expect(spy).not.toHaveBeenCalled()
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

  it('나가기가 실패하면 2000ms 동안 안내가 뜬다', async () => {
    const { store } = await mount()
    vi.spyOn(store, 'setPower').mockRejectedValue(new Error('x'))
    fireEvent.click(screen.getByRole('button', { name: '나가기' }))
    await wait(0)
    expect(screen.getByText('나가지 못했어요 — 다시 눌러 주세요')).toBeInTheDocument()
    await wait(2000)
    expect(screen.queryByText('나가지 못했어요 — 다시 눌러 주세요')).toBeNull()
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

describe('덮개 층', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
  const base = strip(fs.readFileSync(path.resolve('src/renderer/styles/base.css'), 'utf8'))
  const power = strip(fs.readFileSync(path.resolve('src/renderer/power/power.css'), 'utf8'))
  /** 선택자 규칙 블록의 z-index — 여러 블록이면 처음 것 */
  const zOf = (css: string, sel: string): number => {
    const re = new RegExp(`(?:^|\\n|\\})\\s*${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`, 'g')
    for (const m of css.matchAll(re)) {
      const z = /z-index:\s*(\d+)/.exec(m[1])
      if (z) return Number(z[1])
    }
    throw new Error(`${sel} 의 z-index 를 못 찾았다`)
  }

  it('덮개는 앱 틀(위 띠·상태 띠) 위, 떠 있는 것(대화상자·찾기·그림 보기·투어·토스트·메뉴·명령 목록) 아래', () => {
    const pw = zOf(power, '.pw')
    for (const s of ['.top', '.sbar']) expect({ s, above: pw > zOf(base, s) }).toEqual({ s, above: true })
    for (const s of ['.dlg-bd', '.pal-bd', '.iv-bd', '.tour', '.ut', '.pop', '.slash']) expect({ s, below: pw < zOf(base, s) }).toEqual({ s, below: true })
  })
})
