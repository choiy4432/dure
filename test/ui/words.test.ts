import { describe, it, expect } from 'vitest'
import { ago, fieldError, josa, lasting } from '../../src/renderer/lib/words'

describe('fieldError — 엔진 오류를 칸 아래 안내로', () => {
  it('이름 겹침은 해요체로, 다음 할 일까지 — 받침 따라 이라는/라는, 모르면 (이)라는', () => {
    expect(fieldError('이미 있는 이름입니다: 기획')).toBe('‘기획’이라는 에이전트가 이미 있어요. 다른 이름을 써 주세요.')
    expect(fieldError('이미 있는 이름입니다: 디자이너')).toBe('‘디자이너’라는 에이전트가 이미 있어요. 다른 이름을 써 주세요.')
    expect(fieldError('이미 있는 이름입니다: Web')).toBe('‘Web’(이)라는 에이전트가 이미 있어요. 다른 이름을 써 주세요.')
  })

  it('다른 오류는 그대로', () => {
    expect(fieldError('폴더를 찾을 수 없습니다: C:\\gone')).toBe('폴더를 찾을 수 없습니다: C:\\gone')
    expect(fieldError('이름을 입력하세요')).toBe('이름을 입력하세요')
  })
})

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
