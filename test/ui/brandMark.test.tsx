import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BrandMark } from '../../src/renderer/shell/BrandMark'
import markFile from '../../resources/icon/dure-mark.svg?raw'

afterEach(() => cleanup())

/** 길(d)·원(cx cy r) — 그림 모양만, 색·굵기는 뺀다 */
function shapes(root: ParentNode) {
  return [
    ...[...root.querySelectorAll('path')].map(p => `path ${p.getAttribute('d')}`),
    ...[...root.querySelectorAll('circle')].map(c => `circle ${c.getAttribute('cx')} ${c.getAttribute('cy')} ${c.getAttribute('r')}`),
  ]
}

describe('BrandMark — 위 띠 두레 마크', () => {
  it('읽는 이름 "두레", 판 없이 currentColor 로만 칠한다', () => {
    const { container } = render(<BrandMark />)
    const svg = screen.getByRole('img', { name: '두레' })
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    const paints = [...container.querySelectorAll('path, circle')].flatMap(el => [el.getAttribute('fill'), el.getAttribute('stroke')])
    expect(paints.filter(v => v && v !== 'none' && v !== 'currentColor')).toEqual([])
  })

  it('resources/icon/dure-mark.svg 와 같은 모양 — 한쪽만 고치면 깨진다', () => {
    const doc = new DOMParser().parseFromString(markFile, 'image/svg+xml')
    const { container } = render(<BrandMark />)
    expect(shapes(container)).toEqual(shapes(doc))
  })
})
