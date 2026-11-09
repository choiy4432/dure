import { describe, it, expect } from 'vitest'
import { ANDROID_PACKAGE } from '../src/shared/androidApp'
import { ANDROID_REAL_PACKAGE, androidProblem, notesProblem, releaseArgs, show } from '../scripts/releaseLib.mjs'

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

describe('androidProblem', () => {
  const version = { versionCode: 2, versionName: '1.1.0' }
  const apk = { ...version, packageName: 'io.github.choiy4432.dure' }
  it('맞으면 null', () => expect(androidProblem({ apkInfo: apk, version })).toBeNull())
  it('앱 파일이 없으면', () => expect(androidProblem({ apkInfo: null, version })).toMatch(/앱 파일/))
  it('판이 android/version.json 과 다르면', () => {
    expect(androidProblem({ apkInfo: { ...apk, versionCode: 1 }, version })).toMatch(/version\.json/)
    expect(androidProblem({ apkInfo: { ...apk, versionName: '1.0.0' }, version })).toMatch(/version\.json/)
  })
  it('시험 패키지·모르는 패키지면', () => {
    expect(androidProblem({ apkInfo: { ...apk, packageName: 'io.github.choiy4432.dure.test' }, version })).toMatch(/패키지/)
    expect(androidProblem({ apkInfo: { ...apk, packageName: 'x.y' }, version })).toMatch(/패키지/)
  })
})

it('릴리스 가드의 진짜 패키지 이름은 앱의 ANDROID_PACKAGE 와 같다', () => expect(ANDROID_REAL_PACKAGE).toBe(ANDROID_PACKAGE))
