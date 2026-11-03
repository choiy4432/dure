import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'

let claudeUpdate: 'idle' | 'running' | 'done'

beforeEach(() => {
  vi.resetModules()
  claudeUpdate = 'idle'
  window.matchMedia = ((q: string) => ({
    matches: q === '(prefers-reduced-motion: reduce)', media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    onchange: null, dispatchEvent: () => false,
  })) as any
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: false, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 3, usage: null }),
    history: async () => [], on: () => () => {}, refreshUsage: async () => {},
    claudeUpdateState: async () => claudeUpdate,
  }
})
afterEach(() => cleanup())

async function mount() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { StatusBar } = await import('../../src/renderer/shell/StatusBar')
  await act(async () => { await getStore().init() })
  return render(<StatusBar />)
}

describe('StatusBar', () => {
  it('claudeUpdate running 이면 오른쪽에 claude 최신으로 바꾸는 중…', async () => {
    claudeUpdate = 'running'
    await mount()
    expect(screen.getByText('claude 최신으로 바꾸는 중…')).toBeTruthy()
  })

  it('done 이면 없다', async () => {
    claudeUpdate = 'done'
    await mount()
    expect(screen.queryByText('claude 최신으로 바꾸는 중…')).toBeNull()
  })
})
