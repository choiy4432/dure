import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ChatItem } from '../../src/renderer/panel/ChatItem'
import type { ChatLine } from '../../src/renderer/state/transcript'

const act = (id: string) => ({ id, verb: '읽음', target: `${id}.ts`, icon: 'file' as const, allowed: true, denied: false, output: 'x' })

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
