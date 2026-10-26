import { describe, it, expect } from 'vitest'
import { stickyPromptIndex, promptText, STICKY_ZONE_PX } from '../../src/renderer/panel/turnStart'

// 화면 맨 위 = 100 — 그보다 위로 다 지나간 차례 시작 줄만 고정된다
describe('stickyPromptIndex', () => {
  const box = (index: number, top: number, bottom: number) => ({ index, top, bottom })

  it('화면 위로 다 지나간 마지막 차례 시작 줄', () => {
    expect(stickyPromptIndex([box(0, -400, -360), box(5, -120, -60), box(9, 300, 340)], 100)).toBe(5)
  })

  it('그 줄이 아직 조금이라도 보이면 없다', () => {
    expect(stickyPromptIndex([box(0, -400, -360), box(5, 60, 120)], 100)).toBeNull()
  })

  it('맨 아래가 화면 맨 위에 딱 닿으면 다 지나간 것', () => {
    expect(stickyPromptIndex([box(5, 40, 100)], 100)).toBe(5)
  })

  it('대화 맨 위(위로 지나간 차례 시작 줄이 없다)면 없다', () => {
    expect(stickyPromptIndex([box(2, 130, 170), box(7, 400, 440)], 100)).toBeNull()
    expect(stickyPromptIndex([], 100)).toBeNull()
  })

  it('다음 차례 시작 줄이 화면 안에 보여도 화면 맨 위에 걸친 차례의 것', () => {
    expect(stickyPromptIndex([box(3, -300, -250), box(8, 500, 560)], 100)).toBe(3)
  })

  it('고정 상자 자리(맨 위에서 zone 안)에 다른 차례 시작 줄이 보이면 없다 — 그 말로 간 바로 뒤 앞 차례 상자가 덮지 않게', () => {
    expect(stickyPromptIndex([box(3, -300, -250), box(8, 124, 164)], 100, 116)).toBeNull()
    expect(stickyPromptIndex([box(3, -300, -250), box(8, 215, 255)], 100, 116)).toBeNull()
    expect(stickyPromptIndex([box(3, -300, -250), box(8, 216, 256)], 100, 116)).toBe(3)
  })
})

describe('promptText', () => {
  it('내 말은 줄바꿈·겹친 빈칸을 한 칸으로', () => {
    expect(promptText({ kind: 'me', text: '헤더 높이 줄여 줘.\n\n  모바일도  같이', images: [], at: 1 })).toBe('헤더 높이 줄여 줘. 모바일도 같이')
  })

  it('글 없이 그림만 보냈으면 그림 수', () => {
    expect(promptText({ kind: 'me', text: '', images: ['a.png', null], at: 1 })).toBe('이미지 2장')
  })

  it('전달된 메시지는 마크다운 기호를 뗀 첫 줄', () => {
    expect(promptText({ kind: 'relay', from: '기획', text: '## 쿠폰 API\n- 코드를 보내면', at: 1 })).toBe('쿠폰 API')
  })
})

it('고정 자리 높이는 base.css .stk 와 같다(위 20 + 상자 40 + 아래 56)', () => {
  expect(STICKY_ZONE_PX).toBe(116)
})
