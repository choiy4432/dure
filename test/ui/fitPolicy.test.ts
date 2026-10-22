import { describe, it, expect } from 'vitest'
import { fitPolicy, type FitState } from '../../src/renderer/map/fitPolicy'

const fresh: FitState = { userMoved: false }

describe('fitPolicy', () => {
  it('처음 resize 는 맞춘다', () => {
    expect(fitPolicy(fresh, 'resize')).toEqual({ state: { userMoved: false }, fit: true })
  })
  it('user-move 는 멈춤 표시만 하고 맞추지 않는다', () => {
    expect(fitPolicy(fresh, 'user-move')).toEqual({ state: { userMoved: true }, fit: false })
  })
  it('user-move 뒤 resize 는 맞추지 않는다', () => {
    const { state } = fitPolicy(fresh, 'user-move')
    expect(fitPolicy(state, 'resize')).toEqual({ state: { userMoved: true }, fit: false })
  })
  it('fit-all·count 뒤 resize 는 다시 맞춘다', () => {
    for (const reason of ['fit-all', 'count'] as const) {
      const { state } = fitPolicy({ userMoved: true }, reason)
      expect(state.userMoved).toBe(false)
      expect(fitPolicy(state, 'resize').fit).toBe(true)
    }
  })
  it('fit-all 은 이미 맞췄으니 또 맞추지 않고, count·room 은 맞춘다', () => {
    expect(fitPolicy({ userMoved: true }, 'fit-all').fit).toBe(false)
    expect(fitPolicy({ userMoved: true }, 'count')).toEqual({ state: { userMoved: false }, fit: true })
    expect(fitPolicy({ userMoved: true }, 'room')).toEqual({ state: { userMoved: false }, fit: true })
  })
})
