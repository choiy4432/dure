import { describe, it, expect } from 'vitest'
import { ago, attachCount, FRESH_WORD, formatBytes, splitName, MESSAGE_WORD, PHASE_WORD, QUESTION_LINK, STATUS_LINE, STATUS_WORD, TOUR, elapsed, fieldError, josa, lasting, localSummary, modelText, modelVersionName, nodeModelLabel, resetText, tokensText, usageBarLabel, usageRowLabel } from '../../src/renderer/lib/words'

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

describe('formatBytes — 파일 크기(1024 단위, 소수 한 자리, .0 은 뗀다)', () => {
  it('512 B · 1.2 KB · 3.4 MB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1229)).toBe('1.2 KB')
    expect(formatBytes(Math.round(3.4 * 1024 * 1024))).toBe('3.4 MB')
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 MB')
    expect(formatBytes(100 * 1024 * 1024 + 1)).toBe('100 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB')
  })

  it('반올림하면 1024 가 되는 값은 다음 단위로', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 MB')
    expect(formatBytes(1024 ** 3 - 1)).toBe('1 GB')
  })
})

describe('splitName — 가운데 줄임용(앞은 말줄임, 끝은 남김)', () => {
  it('짧으면 나누지 않는다', () => {
    expect(splitName('a.pdf')).toEqual(['a.pdf', ''])
    expect(splitName('report-v2.pdf')).toEqual(['report-v2.pdf', ''])
  })

  it('길면 확장자와 그 앞 몇 글자를 끝에 둔다', () => {
    expect(splitName('2026-11-04 매우 긴 기획서 최종본.pdf')).toEqual(['2026-11-04 매우 긴 기획서', '최종본.pdf'])
    expect(splitName('very-long-file-name-without-extension')).toEqual(['very-long-file-name-without-ex', 'tension'])
  })

  it('나눈 자리의 빈칸은 뗀다 — 앞 조각 끝 · 끝 조각 앞(말줄임 뒤 빈칸이 겹치지 않게)', () => {
    expect(splitName('2026 3분기 마케팅 성과 보고서 최종본.pdf')).toEqual(['2026 3분기 마케팅 성과 보고서', '최종본.pdf'])
    expect(splitName('abcdefghijklmnopq rs.txt')).toEqual(['abcdefghijklmnopq', 'rs.txt'])
    expect(splitName('abcdefghijklmnopq  \u3000 rs.txt')).toEqual(['abcdefghijklmnopq', 'rs.txt'])
  })

  it('글자(서로게이트 짝)를 쪼개지 않는다', () => {
    const [head, tail] = splitName('그림 모음 😀😀😀😀😀😀😀.zip')
    expect(head + tail).toBe('그림 모음 😀😀😀😀😀😀😀.zip')
    expect(tail).toBe('😀😀😀.zip')
    // 이어 붙인 이모지(ZWJ)도 한 글자
    expect(splitName('abcdefghijklmnopq👨‍👩‍👧.zip')).toEqual(['abcdefghijklmno', 'pq👨‍👩‍👧.zip'])
  })
})

describe('attachCount — 글 없는 입력의 그림·첨부 수', () => {
  it('그림만 · 첨부만 · 둘 다', () => {
    expect(attachCount(2, 0)).toBe('그림 2장')
    expect(attachCount(0, 3)).toBe('첨부 3개')
    expect(attachCount(1, 2)).toBe('그림 1장 · 첨부 2개')
    expect(attachCount(0, 0)).toBe('')
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

describe('nodeModelLabel — 관계도 카드의 모델 이름', () => {
  it('지금 풀린 모델이 있으면 그 버전 이름', () => {
    expect(nodeModelLabel(null, 'claude-opus-5-5')).toBe('Opus 5.5')
    expect(nodeModelLabel('sonnet', 'claude-opus-5-5')).toBe('Opus 5.5')
  })
  it('없으면 고른 모델 — 버전 id 면 버전, 별명이면 계열 이름', () => {
    expect(nodeModelLabel('opus', null)).toBe('Opus')
    expect(nodeModelLabel('claude-opus-4-8', null)).toBe('Opus 4.8')
  })
  it('둘 다 없거나 읽을 수 없으면 기본 모델', () => {
    expect(nodeModelLabel(null, null)).toBe('기본 모델')
    expect(nodeModelLabel(null, 'weird')).toBe('기본 모델')
  })
})

describe('modelVersionName · modelText — 모델 이름에 버전', () => {
  it('모델 id 에서 이름+버전', () => {
    expect(modelVersionName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelVersionName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelVersionName('claude-opus-5')).toBe('Opus 5')
    expect(modelVersionName('claude-opus-5[1m]')).toBe('Opus 5 (긴 대화)')
    expect(modelVersionName('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelVersionName('gpt-4')).toBeNull()
  })

  it('default 는 기본 (추천) + 뒤의 모델 버전', () => {
    expect(modelText('default', 'Default (recommended)', 'claude-opus-5-5')).toEqual({ name: '기본 (추천)', description: 'Opus 5.5 · 평소 쓰기 좋은 모델' })
    expect(modelText('default')).toEqual({ name: '기본 (추천)', description: '평소 쓰기 좋은 모델' })
  })

  it('별칭은 버전이 붙은 이름 — 목록을 받기 전엔 계열 이름만, 옛 claude 도 같은 규칙', () => {
    expect(modelText('opus', 'Opus 5.5', 'claude-opus-5-5').name).toBe('Opus 5.5')
    expect(modelText('opus').name).toBe('Opus')
    expect(modelText('opus', 'Opus', 'claude-opus-5').name).toBe('Opus 5')
    expect(modelText('opus[1m]', 'Opus (1M context)', 'claude-opus-5[1m]').name).toBe('Opus 5 (긴 대화)')
    expect(modelText('fable').description).toBe('가장 어렵고 오래 걸리는 일에 맞는 모델')
  })

  it('버전 고정 모델은 이름은 버전, 설명은 계열', () => {
    expect(modelText('claude-opus-4-8', 'Opus 4.8', 'claude-opus-4-8')).toEqual({ name: 'Opus 4.8', description: '어려운 일에 가장 똑똑한 모델' })
  })
})

it('B1 상태·메시지·단계 말', () => {
  expect(STATUS_WORD).toEqual({ working: '작업 중', awaiting: '내 승인 필요', idle: '쉬는 중', stopped: '쉬는 중', error: '멈춤' })
  expect(STATUS_LINE).toEqual({ working: '작업 중…', awaiting: '내 승인 필요', idle: '쉬는 중', stopped: '쉬는 중', error: '오류로 멈췄어요' })
  expect(MESSAGE_WORD).toEqual({ delivered: '전달됨', pending: '내 확인 필요', held: '자동 멈춤', queued: '끝나면 전달', dismissed: '버림' })
  expect(PHASE_WORD.requesting).toBe('Claude 답 받는 중…')
  expect(FRESH_WORD).toBe('끝남 · 새 결과')
  expect(QUESTION_LINK).toBe('내 답 필요 · 패널에서 답하기')
})

it('투어 문구 — 문구 표 그대로', () => {
  expect(TOUR.count(3)).toBe('3 / 8')
  expect([TOUR.end, TOUR.ok, TOUR.start, TOUR.later]).toEqual(['투어 끝내기', '확인했어요', '시작하기', '나중에 볼게요'])
  expect(TOUR.welcome).toEqual({ title: '두레에 오신 걸 환영해요', body: '여러 Claude 에이전트가 한 방에서 일을 주고받아요. 방 하나와 에이전트 하나를 만들며 1분 동안 둘러봐요.' })
  expect(TOUR.room).toEqual({ title: '방을 만들어 보세요', body: '방은 프로젝트 하나예요. 그 일을 할 에이전트들이 한 방에 모여요.', wait: '방을 만들면 넘어가요' })
  expect(TOUR.agent).toEqual({ title: '에이전트를 추가해 보세요', body: '에이전트는 역할을 맡은 Claude 하나예요. 일할 폴더와 역할(예: 랜딩 페이지 구현)을 정해요.', wait: '추가하면 넘어가요' })
  expect(TOUR.card.body).toBe('지금 무엇을 하는지(작업 중·쉬는 중·내 승인 필요) 보여요. 누르면 오른쪽에 대화가 열리고, 끌어서 옮길 수 있어요. 에이전트끼리 일을 넘기면 카드 사이에 선이 생겨요.')
  expect(TOUR.composer).toEqual({ title: '일을 시켜 보세요', body: '여기에 하고 싶은 일을 쓰고 Enter. 예: "이 폴더에 뭐가 있는지 알려 줘"', wait: '보내면 넘어가요' })
  expect(TOUR.controls.body).toBe('멈추기 — 일하는 도중 언제든 멈춰요. 자동 — 다른 에이전트가 넘긴 일을 바로 할지(켬), 내가 보고 시킬지(끔, 기본).')
  expect(TOUR.todo.body).toBe("내 승인이 필요하거나 다른 에이전트가 보낸 메시지가 오면 '할 일'에 숫자가 붙어요. 창이 뒤에 있어도 Windows 알림으로 알려 줘요.")
  expect(TOUR.settingsOpen).toEqual({ title: '설정을 열어 보세요', body: '테마·알림·에이전트를 얼마나 맡길지처럼 두레 전체에 걸리는 것들이 여기 있어요.', wait: '열면 넘어가요' })
  expect(TOUR.settings.list).toEqual([
    '화면 테마 — 라이트 · 다크 · Windows 따라감',
    '쉬는 에이전트 재우기 — 오래 쉬면 내려서 메모리를 비워요. 말을 걸면 이어서 깨어나요',
    '자동 전달 상한 — 자동 켠 에이전트끼리 사람 확인 없이 주고받는 횟수',
    '묻지 않고 실행 허용 — 켜면 에이전트마다 승인 없이 실행하게 할 수 있어요. 믿을 수 있는 폴더에서만 쓰세요',
    'Windows 알림 — 두레 창이 가려져 있어도, 승인이나 질문이 오거나 일이 끝나면 Windows 알림으로 알려 줘요',
    '휴대폰 — 밖에서 휴대폰으로 에이전트 일을 보고 승인해요',
  ])
  expect(TOUR.done).toEqual({ title: '준비됐어요', body: '에이전트를 더 추가해 서로 일을 넘기게 해 보세요. 안내는 설정에서 다시 볼 수 있어요.' })
  expect(TOUR.approval).toEqual({ badge: '처음 한 번', title: '승인이 필요해요', body: '파일을 만들거나 고치고, 명령을 실행하기 전엔 이렇게 물어요. 허용·거절하거나 패널에서 자세히 보세요.' })
})
