import { describe, it, expect } from 'vitest'
import { ago, josa, lasting } from '../../src/renderer/lib/words'

describe('josa', () => {
  it('받침이 있으면 앞 것, 없으면 뒤 것', () => {
    expect(josa('디자인', '이/가')).toBe('이')
    expect(josa('서버', '이/가')).toBe('가')
    expect(josa('기획', '과/와')).toBe('과')
    expect(josa('웹 화면', '과/와')).toBe('과')
    expect(josa('디자이너', '과/와')).toBe('와')
    expect(josa('서버', '을/를')).toBe('를')
  })

  it('숫자는 읽는 소리로, 모르는 글자는 둘 다', () => {
    expect(josa('팀1', '이/가')).toBe('이') // 일
    expect(josa('팀2', '이/가')).toBe('가') // 이
    expect(josa('web', '이/가')).toBe('이(가)')
    expect(josa('', '이/가')).toBe('이(가)')
  })
})

describe('ago', () => {
  it('방금 · N분 전 · N시간 전 · N일 전', () => {
    expect(ago(0, 59_000)).toBe('방금')
    expect(ago(1_000, 0)).toBe('방금') // 시계가 조금 앞서 있어도
    expect(ago(0, 60_000)).toBe('1분 전')
    expect(ago(0, 59 * 60_000)).toBe('59분 전')
    expect(ago(0, 60 * 60_000)).toBe('1시간 전')
    expect(ago(0, 24 * 60 * 60_000)).toBe('1일 전')
  })
})

describe('lasting', () => {
  it('방금 시작 · N분째 · N시간째', () => {
    expect(lasting(0, 30_000)).toBe('방금 시작')
    expect(lasting(0, 3 * 60_000 + 5_000)).toBe('3분째')
    expect(lasting(0, 2 * 60 * 60_000)).toBe('2시간째')
  })
})
