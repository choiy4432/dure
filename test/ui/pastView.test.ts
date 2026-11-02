import { describe, it, expect } from 'vitest'
import { nextAgentName, pastDateLine, resumeBlockOf } from '../../src/renderer/panel/pastView'

// 지난 대화 탭의 순수 도우미 — 날짜 줄 · 돌아가기 막힘 · 갈래 이름

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()

describe('pastDateLine — 오늘·어제·올해·지난해', () => {
  const now = at(2026, 11, 2, 16, 0)

  it('같은 날이면 오늘 + 시각', () => {
    expect(pastDateLine(at(2026, 11, 2, 14, 20), now)).toBe('오늘 14:20')
    expect(pastDateLine(at(2026, 11, 2, 0, 5), now)).toBe('오늘 00:05')
  })

  it('전날이면 어제 + 시각 — 해가 바뀐 어제도', () => {
    expect(pastDateLine(at(2026, 11, 1, 9, 10), now)).toBe('어제 09:10')
    expect(pastDateLine(at(2025, 12, 31, 23, 50), at(2026, 1, 1, 0, 10))).toBe('어제 23:50')
  })

  it('올해면 M월 D일 + 요일 한 글자', () => {
    expect(pastDateLine(at(2026, 10, 30, 11, 0), now)).toBe('10월 30일 금')
    expect(pastDateLine(at(2026, 10, 31, 23, 59), now)).toBe('10월 31일 토')
  })

  it('올해가 아니면 YYYY년 M월 D일', () => {
    expect(pastDateLine(at(2025, 10, 30, 11, 0), now)).toBe('2025년 10월 30일')
  })
})

describe('resumeBlockOf — 돌아가기를 막는 까닭', () => {
  const idle = { status: 'idle' as const, hold: null, heldInput: 0 }

  it('일하는 중 → working · 승인 기다림 → asking', () => {
    expect(resumeBlockOf({ ...idle, status: 'working' })).toBe('working')
    expect(resumeBlockOf({ ...idle, status: 'awaiting' })).toBe('asking')
  })

  it('붙잡아 둔 입력 · 기다리는 입력 → held', () => {
    expect(resumeBlockOf({ ...idle, hold: { since: 1, items: [] } })).toBe('held')
    expect(resumeBlockOf({ ...idle, heldInput: 2 })).toBe('held')
  })

  it('쉬는 중·멈춤 → 막지 않는다', () => {
    expect(resumeBlockOf(idle)).toBeNull()
    expect(resumeBlockOf({ ...idle, status: 'stopped' })).toBeNull()
    expect(resumeBlockOf({ ...idle, status: 'error' })).toBeNull()
  })
})

describe('nextAgentName — <원래 이름> 2, 겹치면 3, 4…', () => {
  it('비어 있으면 2', () => {
    expect(nextAgentName('웹 화면', [])).toBe('웹 화면 2')
  })

  it('있는 이름을 건너뛴다', () => {
    expect(nextAgentName('웹 화면', ['웹 화면', '웹 화면 2'])).toBe('웹 화면 3')
  })

  it('대소문자·앞뒤 공백은 같은 이름으로 본다(엔진 이름 검사와 같게)', () => {
    expect(nextAgentName('Web', ['web', ' WEB 2 ', 'web 3'])).toBe('Web 4')
    expect(nextAgentName('  웹 화면 ', ['웹 화면 2'])).toBe('웹 화면 3')
  })
})
