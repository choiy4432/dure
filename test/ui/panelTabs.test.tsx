import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { PanelTabs } from '../../src/renderer/panel/PanelTabs'
import type { PanelTab } from '../../src/renderer/state/store'

// 패널 탭 줄 — 넘쳐 가려진 탭이 있는 쪽 끝만 흐린다(fade-l · fade-r). jsdom 엔 배치가 없어 줄의 크기·스크롤·탭 자리를 갈아 끼운다

const TABS: PanelTab[] = ['chat', 'subagents', 'messages', 'past']
// 탭 하나 100px · 사이 4px · 줄 양옆 안쪽 10px — 다 들어가면 432px
const TAB_W = 100
const offsetOf = (t: PanelTab) => 10 + TABS.indexOf(t) * (TAB_W + 4)

let size = { scroll: 432, client: 432 }
let left = 0
let resized: (() => void)[] = []

beforeEach(() => {
  size = { scroll: 432, client: 432 }
  left = 0
  resized = []
  const isRow = (el: Element) => el.classList.contains('ptabs')
  const tabOf = (el: Element) => (el.getAttribute('id') ?? '').replace(/^t-/, '') as PanelTab
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) { return isRow(this) ? size.scroll : 0 })
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) { return isRow(this) ? size.client : 0 })
  vi.spyOn(Element.prototype, 'scrollLeft', 'get').mockImplementation(function (this: Element) { return isRow(this) ? left : 0 })
  vi.spyOn(Element.prototype, 'scrollLeft', 'set').mockImplementation(function (this: Element, v: number) {
    if (isRow(this)) left = Math.max(0, Math.min(v, size.scroll - size.client)) // 브라우저처럼 0 ~ 끝으로 묶는다
  })
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'tab' ? offsetOf(tabOf(this)) : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'tab' ? TAB_W : 0
  })
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { resized.push(cb) }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Tabs({ tab = 'chat', tabs = TABS }: { tab?: PanelTab; tabs?: PanelTab[] }) {
  return (
    <PanelTabs
      tab={tab}
      tabs={tabs}
      subagents={{ total: 2, running: false }}
      messages={{ total: 1, attention: false }}
      past={3}
      base="t"
      onChange={() => {}}
    />
  )
}
const row = () => screen.getByRole('tablist')
const fades = () => ['fade-l', 'fade-r'].filter(c => row().classList.contains(c))
const scrollTo = (x: number) => {
  left = x
  fireEvent.scroll(row())
}

describe('패널 탭 줄 — 넘칠 때 가려진 쪽 끝을 흐린다', () => {
  it('다 들어가면 흐리지 않는다', () => {
    render(<Tabs />)
    expect(fades()).toEqual([])
  })

  it('넘치면 가려진 탭이 있는 쪽만 — 처음은 오른쪽, 가운데는 양쪽, 끝은 왼쪽', () => {
    size = { scroll: 432, client: 300 }
    render(<Tabs />)
    expect(fades()).toEqual(['fade-r'])
    scrollTo(60)
    expect(fades()).toEqual(['fade-l', 'fade-r'])
    scrollTo(132)
    expect(fades()).toEqual(['fade-l'])
    scrollTo(0)
    expect(fades()).toEqual(['fade-r'])
  })

  it('패널 너비가 바뀌면 다시 잰다', () => {
    size = { scroll: 432, client: 300 }
    render(<Tabs />)
    expect(fades()).toEqual(['fade-r'])
    size = { scroll: 432, client: 432 }
    act(() => resized.forEach(cb => cb()))
    expect(fades()).toEqual([])
    size = { scroll: 432, client: 200 }
    act(() => resized.forEach(cb => cb()))
    expect(fades()).toEqual(['fade-r'])
  })

  it('탭이 늘어 넘치기 시작하면 다시 잰다', () => {
    size = { scroll: 228, client: 300 }
    const r = render(<Tabs tabs={['chat', 'past']} />)
    expect(fades()).toEqual([])
    size = { scroll: 432, client: 300 }
    r.rerender(<Tabs />)
    expect(fades()).toEqual(['fade-r'])
  })

  it('고른 탭은 흐린 자리 밖으로 끌어온다 — 끝 탭이면 끝까지 밀려 오른쪽 흐림이 없다', () => {
    size = { scroll: 432, client: 300 }
    const r = render(<Tabs />)
    r.rerender(<Tabs tab="past" />)
    expect(left).toBe(132)
    expect(fades()).toEqual(['fade-l'])
    r.rerender(<Tabs tab="subagents" />)
    expect(left).toBe(offsetOf('subagents') - 24) // 왼쪽 흐림 폭만큼 더
    expect(fades()).toEqual(['fade-l', 'fade-r'])
    r.rerender(<Tabs tab="chat" />)
    expect(left).toBe(0)
    expect(fades()).toEqual(['fade-r'])
  })

  it('그려지지 않은 줄(숨은 칸)은 재지 않고 지난 값을 둔다', () => {
    size = { scroll: 432, client: 300 }
    render(<Tabs />)
    expect(fades()).toEqual(['fade-r'])
    const rects = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [] as unknown as DOMRectList)
    size = { scroll: 0, client: 0 }
    act(() => resized.forEach(cb => cb()))
    expect(fades()).toEqual(['fade-r'])
    rects.mockRestore()
  })
})
