import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'

let calls: string[]
let update: any
let agents: any[]

beforeEach(() => {
  vi.resetModules()
  calls = []
  agents = []
  update = { kind: 'idle' }
  ;(window as any).dure = {
    snapshot: async () => ({ claudeMissing: false, rooms: [], agents, messages: [], requests: [], autoChainLimit: 3, usage: null }),
    history: async () => [], on: () => () => {}, refreshUsage: async () => {},
    updateState: async () => update,
    downloadUpdate: async () => { calls.push('download') },
    installUpdate: async () => { calls.push('install') },
    openReleasePage: async () => { calls.push('page') },
  }
})
afterEach(() => cleanup())

const AVAILABLE = { kind: 'available', version: '0.2.0', current: '0.1.0', highlights: ['하나', '둘', '셋'], url: 'u' }
const ag = (id: string, status: string) => ({ id, roomId: 'r', status })

async function mount() {
  const { getStore } = await import('../../src/renderer/state/store')
  const { UpdateToast } = await import('../../src/renderer/shell/UpdateToast')
  await act(async () => { await getStore().init() })
  return { ...render(<UpdateToast />), store: getStore() }
}

describe('UpdateToast', () => {
  it('available: 제목·버전·바뀐 점 3줄, 업데이트 → downloadUpdate, 모두 보기 → openReleasePage', async () => {
    update = AVAILABLE
    await mount()
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText('새 버전이 나왔어요')).toBeTruthy()
    expect(screen.getByText('두레 0.2.0 · 지금 0.1.0')).toBeTruthy()
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual(['하나', '둘', '셋'])
    fireEvent.click(screen.getByRole('button', { name: '업데이트' }))
    fireEvent.click(screen.getByRole('button', { name: '모두 보기' }))
    expect(calls).toEqual(['download', 'page'])
  })

  it('바뀐 점이 없으면 목록을 그리지 않는다', async () => {
    update = { ...AVAILABLE, highlights: [] }
    await mount()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('downloading: 받고 있어요 · 64%', async () => {
    update = { kind: 'downloading', version: '0.2.0', percent: 64 }
    await mount()
    expect(screen.getByText('받고 있어요 · 64%')).toBeTruthy()
    expect(screen.getByText('받는 동안 계속 써도 돼요')).toBeTruthy()
  })

  it('ready: 일하는 에이전트 2 → 노란 줄, 지금 다시 켜기 → installUpdate', async () => {
    update = { kind: 'ready', version: '0.2.0' }
    agents = [ag('a', 'working'), ag('b', 'awaiting'), ag('c', 'idle')]
    await mount()
    expect(screen.getByText('업데이트 준비됐어요')).toBeTruthy()
    expect(screen.getByText('다시 켜면 새 버전(0.2.0)으로 바뀌어요')).toBeTruthy()
    expect(screen.getByText(/2명이 멈춰요/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '지금 다시 켜기' }))
    expect(calls).toEqual(['install'])
  })

  it('ready: 일하는 에이전트가 0 이면 노란 줄이 없다', async () => {
    update = { kind: 'ready', version: '0.2.0' }
    agents = [ag('c', 'idle')]
    await mount()
    expect(screen.queryByText(/멈춰요/)).toBeNull()
  })

  it.each(['끌 때 할게요', '나중에', '닫기'])('%s → 숨김', async name => {
    update = name === '나중에' ? AVAILABLE : { kind: 'ready', version: '0.2.0' }
    const { store } = await mount()
    fireEvent.click(screen.getByRole('button', { name }))
    expect(store.getState().app.toastHidden).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('받기 실패 줄과 다시 시도 — 원문 message 는 보이지 않는다', async () => {
    update = { kind: 'error', message: 'net::ERR\nstack', version: '0.2.0' }
    await mount()
    expect(screen.getByText('받지 못했어요')).toBeTruthy()
    expect(screen.queryByText(/ERR/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(calls).toEqual(['download'])
  })

  it('설치 실패 문구면 그 줄과 지금 다시 켜기', async () => {
    update = { kind: 'error', message: '업데이트를 설치하지 못했어요', version: '0.2.0' }
    await mount()
    expect(screen.getByText('업데이트를 설치하지 못했어요')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '지금 다시 켜기' }))
    expect(calls).toEqual(['install'])
  })

  it.each([
    ['none', { kind: 'none' }], ['idle', { kind: 'idle' }], ['checking', { kind: 'checking' }], ['dev', { kind: 'dev' }],
    ['확인 실패(version null)', { kind: 'error', message: 'x', version: null }],
  ])('%s 이면 안 보인다', async (_n, u) => {
    update = u
    await mount()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
