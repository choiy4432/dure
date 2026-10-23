import { describe, it, expect } from 'vitest'
import { windowTitle, askNotice, finishedNotice, announceAsk, announceMessage, badgeText } from '../../src/renderer/shell/attentionText'
import type { PendingRequest } from '../../src/engine/types'

const req = (over: Partial<PendingRequest>): PendingRequest => ({
  id: 'q1', agentId: 'a', toolName: 'Edit', input: { file_path: 'C:/w/src/a.ts' }, kind: 'permission', createdAt: 1, ...over,
})
const agent = { name: '디자인', folder: 'C:/w' }

describe('windowTitle', () => {
  it('네 경우', () => {
    expect(windowTitle(3, '여름 캠페인')).toBe('(3) 두레 — 여름 캠페인')
    expect(windowTitle(0, '여름 캠페인')).toBe('두레 — 여름 캠페인')
    expect(windowTitle(0, null)).toBe('두레')
    expect(windowTitle(2, null)).toBe('(2) 두레')
  })
})

describe('askNotice', () => {
  it('승인: 제목은 requestTitle, 본문은 대상', () => {
    const n = askNotice(req({}), agent)
    expect(n.title).toBe('디자인이 파일을 고치려 해요')
    expect(n.body).toBe('src/a.ts')
  })
  it('질문: 제목은 질문이 있어요, 본문은 첫 질문 글', () => {
    const input = { questions: [{ question: '어느 색으로 할까요?\n파랑과 빨강 중에', header: '색', options: [{ label: '파랑', description: '' }], multiSelect: false }] }
    const n = askNotice(req({ kind: 'question', toolName: 'AskUserQuestion', input }), agent)
    expect(n).toEqual({ title: '디자인에게 질문이 있어요', body: '어느 색으로 할까요?' })
  })
  it('새 에이전트 만들기: 이름 · 역할', () => {
    const input = { name: '리서치', role: '자료 조사', folder: 'C:/w', task: null }
    const n = askNotice(req({ kind: 'create-agent', toolName: 'mcp__dure__create_agent', input }), agent)
    expect(n.body).toBe('리서치 · 자료 조사')
    expect(n.title).toContain('디자인')
    expect(askNotice(req({ kind: 'create-agent', toolName: 'x', input: { name: '리서치', role: '' } }), agent).body).toBe('리서치')
  })
})

describe('finishedNotice', () => {
  it('조사 이/가, 본문은 마지막 글 첫 줄', () => {
    expect(finishedNotice('디자인', '다 했어요\n두 번째 줄')).toEqual({ title: '디자인이 일을 끝냈어요', body: '다 했어요' })
    expect(finishedNotice('카피', null)).toEqual({ title: '카피가 일을 끝냈어요', body: '' })
  })
})

describe('읽어 줄 글', () => {
  it('announceAsk · announceMessage', () => {
    expect(announceAsk(req({}), '디자인')).toBe('디자인이 승인을 기다려요')
    expect(announceAsk(req({ kind: 'question' }), '디자인')).toBe('디자인에게 질문이 있어요')
    expect(announceAsk(req({ kind: 'create-agent' }), '디자인')).toBe('디자인이 새 에이전트를 만들려 해요')
    expect(announceMessage('카피')).toBe('카피에게 메시지가 왔어요')
  })
})

describe('badgeText', () => {
  it('0 → null, 1~9, 10 이상은 9+', () => {
    expect(badgeText(0)).toBeNull()
    expect(badgeText(5)).toBe('5')
    expect(badgeText(9)).toBe('9')
    expect(badgeText(12)).toBe('9+')
  })
})

describe('계획 알림', () => {
  const plan = { kind: 'plan', toolName: 'ExitPlanMode', input: { plan: '\n# 헤더 줄이기\n1. …' } } as const
  it('askNotice — 첫 비지 않은 줄, 앞 # 과 공백 뺌', () => {
    expect(askNotice(req({ ...plan }), { name: '웹', folder: 'C:/w' })).toEqual({ title: '웹이 계획을 세웠어요', body: '헤더 줄이기' })
  })
  it('announceAsk — 같은 제목', () => {
    expect(announceAsk(req({ ...plan }), '웹')).toBe('웹이 계획을 세웠어요')
  })
})
