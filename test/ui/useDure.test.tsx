import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { Snapshot } from '../../src/shared/ipcContract'

const room = (id: string) => ({ id, name: id, createdAt: 1 })
let snapshot: Snapshot
beforeEach(() => {
  vi.resetModules()
  snapshot = { claudeMissing: false, rooms: [room('r1')], agents: [], messages: [], requests: [], autoChainLimit: 5, allowBypass: false, notify: { asks: true, finished: false }, usage: null }
  ;(window as any).dure = { snapshot: async () => snapshot, history: async () => [], on: () => () => {} }
})

describe('shallowEqual', () => {
  it('원시값·배열·객체 한 단계', async () => {
    const { shallowEqual } = await import('../../src/renderer/state/store')
    expect(shallowEqual(1, 1)).toBe(true)
    expect(shallowEqual(1, 2)).toBe(false)
    expect(shallowEqual([1, 2], [1, 2])).toBe(true)
    expect(shallowEqual([1, 2], [1, 3])).toBe(false)
    expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(shallowEqual({ a: {} }, { a: {} })).toBe(false)
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(shallowEqual([], {})).toBe(false)
    expect(shallowEqual(null, {})).toBe(false)
  })
})

describe('useDure', () => {
  it('새 객체를 돌려주는 선택자도 무한 루프 없이 값이 바뀔 때만 다시 그린다', async () => {
    const { useDure, getStore } = await import('../../src/renderer/state/store')
    let renders = 0
    function C() {
      const { n } = useDure(s => ({ n: s.rooms.length }))
      const list = useDure(s => s.rooms.map(r => r.id))
      renders++
      return <p>방 {n} · {list.join(',')}</p>
    }
    const store = getStore()
    await act(async () => { await store.init() })
    render(<C />)
    expect(screen.getByText('방 1 · r1')).toBeTruthy()
    const base = renders
    expect(base).toBeLessThan(4)
    await act(async () => { await store.refresh() }) // 같은 내용 → 다시 안 그림
    expect(renders).toBe(base)
    snapshot = { ...snapshot, rooms: [room('r1'), room('r2')] }
    await act(async () => { await store.refresh() })
    expect(screen.getByText('방 2 · r1,r2')).toBeTruthy()
    expect(renders).toBe(base + 1)
  })
})
