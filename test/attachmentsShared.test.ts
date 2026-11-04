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
    expect(opensAsDocument('C:\\x\\20261104-120000-.txt')).toBe(true)
  })
  it('허용 목록(문서·그림·소리·영상·zip)만 기본 앱으로 연다 — 대소문자 없이', () => {
    const docs = [
      'pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      'odt', 'ods', 'odp', 'hwp', 'hwpx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif',
      'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'zip',
    ]
    for (const ext of docs) {
      expect(opensAsDocument(`C:\\x\\20261104-120000-a.${ext}`), ext).toBe(true)
      expect(opensAsDocument(`C:\\x\\20261104-120000-a.${ext.toUpperCase()}`), ext).toBe(true)
    }
  })
  it('허용 목록에 없으면 탐색기 — 프로젝트·디스크 이미지·코드·웹 페이지·svg(스크립트)·xml·7z·실행 종류 …', () => {
    for (const ext of [
      'sln', 'csproj', 'vcxproj', 'iso', 'img', 'vhd', 'vhdx', 'vsto', 'py', 'ts', 'js', 'html', 'htm', 'svg', 'xml', '7z', 'rar', 'ico',
      'env', 'exe', 'bat', 'cmd', 'ps1', 'lnk', 'url', 'msi', 'reg', 'sh', 'rdp', 'mht', 'pfx', 'theme', 'appinstaller', 'library-ms', 'jar',
    ]) {
      expect(opensAsDocument(`C:\\x\\20261104-120000-a.${ext}`), ext).toBe(false)
    }
    // 겹 확장자·오른쪽에서 왼쪽 글자로 가린 이름은 마지막 확장자로
    expect(opensAsDocument('C:\\x\\20261104-120000-보고서.pdf.exe')).toBe(false)
    expect(opensAsDocument('C:\\x\\20261104-120000-\u202Efdp.exe')).toBe(false)
    expect(opensAsDocument('C:\\x\\20261104-120000-run.exe.pdf')).toBe(true)
  })
})
