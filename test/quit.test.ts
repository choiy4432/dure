import { describe, it, expect } from 'vitest'
import { quitDecision } from '../src/main/quit'

describe('quitDecision', () => {
  it('보통 끄기 — 아직 시작 전이면 정리를 시작한다', () => {
    expect(quitDecision({ shutdownStarted: false, shutdownDone: false })).toBe('start')
  })
  it('설치 정리 중에 창을 닫으면 끝날 때까지 미룬다', () => {
    expect(quitDecision({ shutdownStarted: true, shutdownDone: false })).toBe('defer')
  })
  it('정리가 끝난 뒤(설치의 app.quit 포함)는 그대로 나간다', () => {
    expect(quitDecision({ shutdownStarted: true, shutdownDone: true })).toBe('proceed')
  })
})
