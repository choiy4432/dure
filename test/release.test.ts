import { describe, it, expect } from 'vitest'
import { notesProblem, releaseArgs, show } from '../scripts/releaseLib.mjs'

describe('releaseArgs', () => {
  it('제목은 한 칸, 파일 셋, 노트 경로는 공백이 있어도 한 칸', () => {
    const notes = 'C:\\tmp\\my notes & 100%.md'
    const a = releaseArgs('0.1.0', notes)
    expect(a.slice(0, 3)).toEqual(['release', 'create', 'v0.1.0'])
    expect(a.slice(3, 6)).toEqual(['dist/Dure-Setup-0.1.0.exe', 'dist/Dure-Setup-0.1.0.exe.blockmap', 'dist/latest.yml'])
    expect(a[a.indexOf('--title') + 1]).toBe('두레 0.1.0')
    expect(a[a.indexOf('--notes-file') + 1]).toBe(notes)
    expect(a).toHaveLength(10)
  })
  it('show 는 공백·특수문자 인자를 따옴표로 감싼다', () => {
    expect(show('gh', ['--title', '두레 0.1.0', 'a&b', 'plain'])).toBe('gh --title "두레 0.1.0" "a&b" plain')
  })
})

describe('notesProblem', () => {
  it('통과', () => expect(notesProblem('- 고침')).toBeNull())
  it('거부', () => {
    expect(notesProblem('고침')).toMatch(/목록/)
    expect(notesProblem('- @someone')).toMatch(/@/)
    expect(notesProblem('- C:\\Users\\x')).toMatch(/경로/)
  })
})
