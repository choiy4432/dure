import { describe, it, expect } from 'vitest'
import { ago, elapsed, fieldError, josa, lasting, localSummary, resetText, tokensText, usageBarLabel, usageRowLabel } from '../../src/renderer/lib/words'

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

describe('elapsed — 작업 중 줄의 지난 시간(초까지)', () => {
  it('N초 · N분 N초 · N분 · N시간 N분', () => {
    expect(elapsed(0, 400)).toBe('0초')
    expect(elapsed(0, 12_400)).toBe('12초')
    expect(elapsed(0, 65_000)).toBe('1분 5초')
    expect(elapsed(0, 120_000)).toBe('2분')
    expect(elapsed(0, 60 * 60_000 + 2 * 60_000 + 5_000)).toBe('1시간 2분')
  })
  it('시계가 거꾸로면 0초', () => {
    expect(elapsed(5_000, 1_000)).toBe('0초')
  })
})

describe('localSummary — 아는 명령 출력은 한국어 한 줄로', () => {
  it('/compact 결과(훅 메시지가 붙어도) → 대화를 요약해서 줄였어요', () => {
    expect(localSummary('Compacted')).toBe('대화를 요약해서 줄였어요')
    expect(localSummary('Compacted PreCompact ["node.exe" "hook.js"] completed successfully')).toBe('대화를 요약해서 줄였어요')
  })
  it('모르는 출력은 null — 원문 그대로 보인다', () => {
    expect(localSummary('Total cost: $0.12')).toBeNull()
    expect(localSummary('Error: Compacted failed')).toBeNull()
  })
})

describe('사용량 말', () => {
  const now = new Date(2026, 9, 20, 12, 0, 0).getTime()
  const MIN = 60_000

  it('resetText — 남은 시간 경계', () => {
    expect(resetText(now + 30_000, now)).toBe('곧 초기화')
    expect(resetText(now - 5_000, now)).toBe('곧 초기화')
    expect(resetText(now + 10 * MIN, now)).toBe('10분 뒤 초기화')
    expect(resetText(now + 130 * MIN, now)).toBe('2시간 10분 뒤 초기화')
    expect(resetText(now + 180 * MIN, now)).toBe('3시간 뒤 초기화')
  })

  it('resetText — 하루 넘으면 로컬 날짜·요일·시각', () => {
    const at = new Date(2026, 9, 26, 18, 59).getTime()
    expect(resetText(at, now)).toBe('10월 26일(월) 18:59 초기화')
    expect(resetText(new Date(2026, 10, 3, 7, 5).getTime(), now)).toBe('11월 3일(화) 07:05 초기화')
  })

  it('usageBarLabel · usageRowLabel', () => {
    const w = (key: any, label: string) => ({ key, label, percent: 1, resetsAt: null })
    expect(usageBarLabel(w('session', '현재 세션'))).toBe('5시간')
    expect(usageBarLabel(w('week', '주간'))).toBe('1주')
    expect(usageBarLabel(w('model:fable', 'Fable'))).toBe('Fable')
    expect(usageRowLabel(w('session', 'x'))).toBe('5시간')
    expect(usageRowLabel(w('week', 'x'))).toBe('1주 · 모든 모델')
    expect(usageRowLabel(w('model:fable', 'Fable'))).toBe('1주 · Fable 전용')
  })
})

describe('tokensText', () => {
  it('1만 아래는 천 단위 쉼표', () => {
    expect(tokensText(3400)).toBe('3,400')
    expect(tokensText(9999)).toBe('9,999')
  })
  it('만 단위 — 10만 아래는 소수 한 자리(.0 은 뺌)', () => {
    expect(tokensText(12000)).toBe('1.2만')
    expect(tokensText(50000)).toBe('5만')
  })
  it('10만 이상은 반올림 정수', () => {
    expect(tokensText(340000)).toBe('34만')
    expect(tokensText(1000000)).toBe('100만')
  })
})
