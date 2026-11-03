import { describe, it, expect } from 'vitest'
import { releaseHighlights } from '../src/main/releaseNotes'

describe('releaseHighlights', () => {
  it('HTML li 를 벗겨 앞에서부터', () => {
    expect(releaseHighlights('<h2>바뀐 점</h2><ul><li>첫 &amp; 둘</li>\n<li><b>셋</b></li></ul>')).toEqual(['첫 & 둘', '셋'])
  })
  it('마크다운 - 와 * 목록', () => {
    expect(releaseHighlights('# 제목\n- 하나\n\n* 둘\n문단\n  - 셋')).toEqual(['하나', '둘', '셋'])
  })
  it('배열(note 칸)', () => {
    expect(releaseHighlights([{ note: '- a' }, { note: null }, { note: '<li>b</li>' }])).toEqual(['a', 'b'])
  })
  it('4개면 3개 · max 로 바꾼다', () => {
    const md = '- 1\n- 2\n- 3\n- 4'
    expect(releaseHighlights(md)).toEqual(['1', '2', '3'])
    expect(releaseHighlights(md, 2)).toEqual(['1', '2'])
  })
  it('빈 항목은 버린다', () => {
    expect(releaseHighlights('<ul><li> </li><li>x</li></ul>\n- \n-')).toEqual(['x'])
  })
  it('null · undefined · 빈 글 → []', () => {
    expect(releaseHighlights(null)).toEqual([])
    expect(releaseHighlights(undefined)).toEqual([])
    expect(releaseHighlights('')).toEqual([])
  })
})
