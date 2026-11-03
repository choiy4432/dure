import { describe, it, expect } from 'vitest'
import { effectiveSetup } from '../../src/renderer/state/selectors'
import type { SetupState } from '../../src/shared/appTypes'

const needs: SetupState = { phase: 'needs', install: { state: 'todo' }, login: { state: 'locked' } }

describe('effectiveSetup — 화면이 따르는 준비 상태', () => {
  it('상태를 못 받았으면: claude 없음 → 설치 칸, 있음 → 준비됨', () => {
    expect(effectiveSetup({ phase: 'checking' }, true, true)).toEqual(needs)
    expect(effectiveSetup({ phase: 'checking' }, false, true)).toEqual({ phase: 'ready' })
  })
  it('받는 중(실패 아님)이면 확인 중 그대로', () => {
    expect(effectiveSetup({ phase: 'checking' }, true, false)).toEqual({ phase: 'checking' })
    expect(effectiveSetup({ phase: 'checking' }, false, false)).toEqual({ phase: 'checking' })
  })
  it('준비됨인데 claude 가 없다고 하면 준비 화면', () => {
    expect(effectiveSetup({ phase: 'ready' }, true, false)).toEqual(needs)
    expect(effectiveSetup({ phase: 'ready' }, false, false)).toEqual({ phase: 'ready' })
  })
  it('needs·relaunching 은 그대로', () => {
    const mid: SetupState = { phase: 'needs', install: { state: 'done', version: '1' }, login: { state: 'todo' } }
    expect(effectiveSetup(mid, true, false)).toBe(mid)
    expect(effectiveSetup({ phase: 'relaunching' }, true, true)).toEqual({ phase: 'relaunching' })
  })
})
