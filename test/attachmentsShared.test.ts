import { describe, expect, it } from 'vitest'
import { opensAsDocument } from '../src/shared/attachments'

describe('opensAsDocument', () => {
  it('윈도 경로의 폴더 이름에 점이 있어도 파일 이름의 확장자로만 가른다', () => {
    expect(opensAsDocument('C:\\Users\\a.b\\AppData\\Roaming\\Dure\\attachments\\x\\20261104-120000-확장자없음')).toBe(false)
    expect(opensAsDocument('C:\\Users\\a.b\\AppData\\Roaming\\Dure\\attachments\\x\\20261104-120000-run.BAT')).toBe(false)
    expect(opensAsDocument('C:\\Users\\a.b\\AppData\\Roaming\\Dure\\attachments\\x\\20261104-120000-보고서.pdf')).toBe(true)
    expect(opensAsDocument('/home/a.b/x/20261104-120000-notes.md')).toBe(true)
  })
  it('끝이 점이거나 점으로만 시작하는 이름은 확장자가 없는 것으로', () => {
    expect(opensAsDocument('C:\\x\\name.')).toBe(false)
    expect(opensAsDocument('C:\\x\\.bashrc')).toBe(false)
    expect(opensAsDocument('C:\\x\\20261104-120000-.env')).toBe(true)
  })
})
