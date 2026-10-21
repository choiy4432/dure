import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react'
import { ChatItem } from '../../src/renderer/panel/ChatItem'
import type { ActionLine, ChatLine, ClaudePart } from '../../src/renderer/state/transcript'

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

describe('ChatItem — 하는 일 "수정"을 펼치면 바뀐 줄(diff)', () => {
  const HUNK = { oldStart: 10, newStart: 10, lines: [' const a = 1', '-const b = 2', '+const b = 3', '+const c = 4', ' const d = 5'] }
  const DONE = 'The file a.ts has been updated successfully.'
  const edit = (over: Partial<ActionLine> = {}): ActionLine => ({
    id: 'e', verb: '수정', target: 'a.ts', icon: 'edit', allowed: false, denied: false, output: DONE, patch: [HUNK], ...over,
  })
  const line = (a: ActionLine): ChatLine => ({ kind: 'claude', text: '', actions: [a], at: 1, parts: [{ type: 'acts', actions: [a] }] })
  const open = (a: ActionLine) => {
    const r = render(<ChatItem line={line(a)} index={0} />)
    fireEvent.click(screen.getByRole('button', { name: /수정/ }))
    return r
  }
  const rows = (c: HTMLElement) => [...c.querySelectorAll('.act-out .df-l')] as HTMLElement[]

  it('앞뒤 줄 · - 줄 · + 줄이 차례대로, 옛/새 줄 번호와 함께 — 결과 글은 안 보인다', () => {
    const { container } = open(edit())
    const r = rows(container)
    expect(r.map(x => x.className)).toEqual(['df-l ctx', 'df-l del', 'df-l add', 'df-l add', 'df-l ctx'])
    // 앞 기호(-·+·빈칸)는 고정폭 글에 그대로 보인다(통합 diff 처럼)
    expect(r.map(x => x.querySelector('.df-t')!.textContent)).toEqual(HUNK.lines)
    // 앞뒤 줄은 둘 다 늘고, - 는 옛 줄만, + 는 새 줄만
    expect(r.map(x => [...x.querySelectorAll('.df-n')].map(n => n.textContent))).toEqual([
      ['10', '10'], ['11', ''], ['', '11'], ['', '12'], ['12', '13'],
    ])
    expect(screen.queryByText(DONE)).toBeNull()
    expect(container.querySelector('.act-out pre')).toBeNull()
    expect(screen.queryByText('전체는 길어서 생략')).toBeNull()
  })

  it('바뀐 종류는 색만이 아니라 읽는 말로도 — 지운 줄 · 더한 줄(앞뒤 줄엔 없음)', () => {
    const { container } = open(edit())
    const r = rows(container)
    expect(r.map(x => x.querySelector('.df-hid')?.textContent?.trim() ?? null)).toEqual([null, '지운 줄', '더한 줄', '더한 줄', null])
    // 줄 전체로 읽으면 종류 · 글 차례(번호 다음)
    expect(r[1].textContent).toBe('11지운 줄 -const b = 2')
  })

  it('묶음이 여럿이면 묶음마다 따로(사이에 나눔 줄) — 줄 번호는 묶음마다 처음부터', () => {
    const second = { oldStart: 40, newStart: 41, lines: ['-x', '+y'] }
    const { container } = open(edit({ patch: [HUNK, second] }))
    const groups = [...container.querySelectorAll('.act-out .df-h')]
    expect(groups).toHaveLength(2)
    expect([...groups[1].querySelectorAll('.df-n')].map(n => n.textContent)).toEqual(['40', '', '', '41'])
  })

  it('입력으로 만든 묶음(줄 번호 모름)엔 번호 칸이 없다', () => {
    const { container } = open(edit({ patch: [{ oldStart: null, newStart: null, lines: ['-old', '+new'] }] }))
    expect(rows(container).map(x => x.querySelector('.df-t')!.textContent)).toEqual(['-old', '+new'])
    expect(container.querySelectorAll('.act-out .df-n')).toHaveLength(0)
  })

  it('patchCut 이면 "전체는 길어서 생략"', () => {
    open(edit({ patchCut: true }))
    expect(screen.getByText('전체는 길어서 생략')).toBeInTheDocument()
  })

  it('거절된 수정은 지금처럼 결과 글', () => {
    const { container } = open(edit({ denied: true, output: '사용자가 거절했습니다.' }))
    expect(container.querySelector('.act-out .df')).toBeNull()
    expect(container.querySelector('.act-out pre')).toHaveTextContent('사용자가 거절했습니다.')
  })

  describe('접기 — 12줄 넘을 때만', () => {
    // jsdom 은 배치를 하지 않는다 — 줄 높이 18px · 묶음 사이 9px(위아래 4px + 1px 나눔 줄)로 상자 높이를 흉내 낸다.
    // 접힌 상자(lim)는 --clamp-lines 줄까지만 보인다
    const full = (el: HTMLElement) => el.querySelectorAll('.df-l').length * 18 + Math.max(0, el.querySelectorAll('.df-h').length - 1) * 9
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('clamp-box') ? full(this) : 0
      })
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        if (!this.classList.contains('clamp-box')) return 0
        const lim = this.classList.contains('lim') ? Number(this.style.getPropertyValue('--clamp-lines')) * 18 : Infinity
        return Math.min(full(this), lim)
      })
    })
    afterEach(() => vi.restoreAllMocks())
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `+줄 ${i + 1}`)

    it('4줄 diff 는 접지 않는다 — 더 보기 없음', () => {
      open(edit({ patch: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+c', ' d'] }] }))
      expect(screen.queryByRole('button', { name: '더 보기' })).toBeNull()
    })

    it('묶음 둘(모두 3줄)도 나눔 줄 몫까지 접지 않는다', () => {
      open(edit({ patch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }, { oldStart: 9, newStart: 9, lines: ['+c'] }] }))
      expect(screen.queryByRole('button', { name: '더 보기' })).toBeNull()
    })

    it('13줄이면 12줄로 접히고 더 보기', () => {
      const { container } = open(edit({ patch: [{ oldStart: 1, newStart: 1, lines: lines(13) }] }))
      expect(screen.getByRole('button', { name: '더 보기' })).toBeInTheDocument()
      expect((container.querySelector('.act-out .clamp-box') as HTMLElement).style.getPropertyValue('--clamp-lines')).toBe('12')
    })
  })

  it('바뀐 줄이 나중에 실려도 다시 그린다(같은 결과 글 · 새 줄 객체)', () => {
    const { container, rerender } = open(edit({ patch: undefined }))
    expect(container.querySelector('.act-out pre')).toHaveTextContent(DONE)
    rerender(<ChatItem line={line(edit())} index={0} />)
    expect(container.querySelector('.act-out .df')).not.toBeNull()
  })
})
