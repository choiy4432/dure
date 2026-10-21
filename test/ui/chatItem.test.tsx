import { describe, it, expect, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import { ChatItem } from '../../src/renderer/panel/ChatItem'
import type { ChatLine, ClaudePart } from '../../src/renderer/state/transcript'

const act = (id: string) => ({ id, verb: '읽음', target: `${id}.ts`, icon: 'file' as const, allowed: true, denied: false, output: 'x' })

afterEach(() => cleanup())

describe('ChatItem — Claude 답', () => {
  it('parts 차례대로 그린다 — 하는 일 상자가 먼저면 글보다 위에', () => {
    const line: ChatLine = {
      kind: 'claude', text: '다 했어요', actions: [act('a')], at: 1,
      parts: [{ type: 'acts', actions: [act('a')] }, { type: 'text', text: '다 했어요' }],
    }
    const { container } = render(<ChatItem line={line} index={0} />)
    const acts = container.querySelector('.acts')!
    const md = container.querySelector('.md')!
    expect(acts.compareDocumentPosition(md) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('글 · 하는 일 · 글 이면 상자가 두 글 사이에', () => {
    const line: ChatLine = {
      kind: 'claude', text: '봅니다\n\n끝', actions: [act('a')], at: 1,
      parts: [{ type: 'text', text: '봅니다' }, { type: 'acts', actions: [act('a')] }, { type: 'text', text: '끝' }],
    }
    const { container } = render(<ChatItem line={line} index={0} />)
    const order = [...container.querySelector('.ci-claude')!.children].map((el) => (el.classList.contains('acts') ? '일' : el.classList.contains('md') ? `글:${el.textContent}` : el.className))
    expect(order).toEqual(['who', '글:봅니다', '일', '글:끝'])
  })
})

type Subs = Extract<ClaudePart, { type: 'subagents' }>
const subs = (over: Partial<Subs> = {}): Subs => ({
  type: 'subagents', key: 'A', ids: ['A', 'B', 'C'], description: null, counts: { running: 1, done: 1, bad: 1 }, ...over,
})
// 새 객체로 — 기록이 하나 늘 때마다 줄 객체가 새로 만들어지는 것과 같게
const answer = (part: Subs): ChatLine => ({
  kind: 'claude', text: '나눠서 맡길게요', actions: [], at: 1, parts: [{ type: 'text', text: '나눠서 맡길게요' }, { ...part, counts: { ...part.counts } }],
})

describe('ChatItem — 서브에이전트 요약 줄', () => {
  it('여럿이면 하는 일 상자 한 줄 — Bot 아이콘 · "서브에이전트 3개에게 맡김" · 상태별 개수(점 + 수) · 오른쪽 화살표', () => {
    render(<ChatItem line={answer(subs())} index={0} agentId="w" />)
    const row = screen.getByRole('button', { name: /서브에이전트 3개에게 맡김/ })
    expect(row.closest('ul')).toHaveClass('acts')
    expect(row.closest('ul')!.children).toHaveLength(1)
    expect(row.firstElementChild).toHaveClass('lucide-bot')
    expect(within(row).getByText('서브에이전트 3개에게 맡김')).toBeInTheDocument()
    // 개수 — 도는 중 초록 · 끝 회색 · 실패 빨강 점 + 수, 읽는 이름은 한 줄로
    const counts = within(row).getByRole('img', { name: '도는 중 1, 끝 1, 실패 1' })
    expect([...counts.children].map(c => [c.querySelector('.dot')!.className, c.textContent])).toEqual([['dot g', '1'], ['dot s', '1'], ['dot r', '1']])
    expect(counts.querySelectorAll('.dot[aria-hidden="true"]')).toHaveLength(3)
    expect(row.lastElementChild).toHaveClass('lucide-arrow-right')
    expect(row.lastElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(row).toHaveAccessibleName('서브에이전트 3개에게 맡김 도는 중 1, 끝 1, 실패 1')
  })

  it('0 인 묶음은 빼고 — 차례는 늘 도는 중 · 끝 · 실패', () => {
    render(<ChatItem line={answer(subs({ ids: ['A', 'B', 'C', 'D', 'E'], counts: { running: 0, done: 3, bad: 2 } }))} index={0} agentId="w" />)
    const counts = screen.getByRole('img', { name: '끝 3, 실패 2' })
    expect([...counts.children].map(c => c.textContent)).toEqual(['3', '2'])
    expect(counts.querySelector('.dot.g')).toBeNull()
  })

  it('하나면 설명(본문 글꼴, 말줄임) + "서브에이전트에게 맡김"', () => {
    render(<ChatItem line={answer(subs({ ids: ['A'], description: 'A사 랜딩 문구 조사', counts: { running: 1, done: 0, bad: 0 } }))} index={0} agentId="w" />)
    const row = screen.getByRole('button', { name: 'A사 랜딩 문구 조사 서브에이전트에게 맡김 도는 중 1' })
    const what = within(row).getByText('A사 랜딩 문구 조사')
    expect(what).toHaveClass('trunc')
    expect(what).not.toHaveClass('f') // 파일·명령 이름(mono)이 아니다
    expect(row).toHaveAttribute('title', 'A사 랜딩 문구 조사')
    expect(within(row).getByText('서브에이전트에게 맡김')).toBeInTheDocument()
    expect(row).not.toHaveTextContent('1개')
  })

  it('하나인데 설명이 없으면 "서브에이전트에게 맡김"만', () => {
    render(<ChatItem line={answer(subs({ ids: ['A'], description: null, counts: { running: 0, done: 1, bad: 0 } }))} index={0} agentId="w" />)
    expect(screen.getByRole('button')).toHaveAccessibleName('서브에이전트에게 맡김 끝 1')
  })

  it('개수가 바뀌면 다시 그린다(같은 줄 번호 · 새 줄 객체)', () => {
    const { rerender } = render(<ChatItem line={answer(subs())} index={0} agentId="w" />)
    expect(screen.getByRole('img')).toHaveAccessibleName('도는 중 1, 끝 1, 실패 1')
    rerender(<ChatItem line={answer(subs({ counts: { running: 0, done: 2, bad: 1 } }))} index={0} agentId="w" />)
    expect(screen.getByRole('img')).toHaveAccessibleName('끝 2, 실패 1')
  })

  it('하나의 설명이 바뀌어도 다시 그린다', () => {
    const one = subs({ ids: ['A'], description: '조사', counts: { running: 1, done: 0, bad: 0 } })
    const { rerender } = render(<ChatItem line={answer(one)} index={0} agentId="w" />)
    rerender(<ChatItem line={answer({ ...one, description: 'A사 랜딩 문구 조사' })} index={0} agentId="w" />)
    expect(screen.getByRole('button')).toHaveAccessibleName('A사 랜딩 문구 조사 서브에이전트에게 맡김 도는 중 1')
  })

  it('어느 에이전트의 대화인지 모르면 누를 수 없다', () => {
    render(<ChatItem line={answer(subs())} index={0} />)
    expect(screen.getByRole('button', { name: /서브에이전트 3개에게 맡김/ })).toBeDisabled()
  })
})
