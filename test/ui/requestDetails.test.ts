import { describe, it, expect } from 'vitest'
import { commandLines, detailRows, requestWhy } from '../../src/renderer/lib/requestDetails'

describe('requestDetails', () => {
  it('requestWhy 는 설명 첫 줄', () => {
    expect(requestWhy({ description: '의존성을 설치하고 빌드·시험해요\n둘째' })).toBe('의존성을 설치하고 빌드·시험해요')
    expect(requestWhy({})).toBeNull()
    expect(requestWhy({ description: 'a'.repeat(300) })).toBe('a'.repeat(200) + '…')
  })
  it('commandLines', () => {
    expect(commandLines('Bash', { command: 'npm install\nnpm run build\nnpm test\n' })).toEqual({ first: 'npm install', more: 2 })
    expect(commandLines('Write', { command: 'x' })).toBeNull()
  })
  it('detailRows 순서·모르는 칸', () => {
    expect(detailRows('Bash', { command: 'a\nb', description: '설명', timeout: 120000, extra: { k: 1 } }, 'C:/w')).toEqual([
      { label: '명령', value: 'a\nb', mono: true },
      { label: '설명', value: '설명', mono: false },
      { label: '제한 시간', value: '2분', mono: false },
      { label: 'extra', value: '{"k":1}', mono: true },
    ])
    expect(detailRows('Bash', { timeout: 30000 })[0].value).toBe('30초')
    expect(detailRows('Bash', { timeout: 90000 })[0].value).toBe('1분 30초')
    expect(detailRows('Bash', '글')).toEqual([])
  })
  it('파일은 폴더 기준', () => {
    expect(detailRows('Edit', { file_path: 'C:\\w\\src\\a.ts' }, 'C:/w')).toEqual([{ label: '파일', value: 'src/a.ts', mono: true }])
  })
  it('내용은 앞 20줄 + …, 값 2000자 상한', () => {
    const c = Array.from({ length: 25 }, (_, i) => `l${i}`).join('\n')
    const v = detailRows('Write', { content: c })[0].value
    expect(v.split('\n')).toHaveLength(21)
    expect(v.endsWith('\n…')).toBe(true)
    expect(detailRows('Bash', { command: 'x'.repeat(5000) })[0].value.length).toBeLessThanOrEqual(2000)
    const o = detailRows('Edit', { old_string: Array(12).fill('a').join('\n') })[0].value
    expect(o.split('\n')).toHaveLength(11)
  })
  it('아는 칸이라도 못 그리면 JSON 칸으로 — 사라지지 않는다', () => {
    expect(detailRows('Bash', { command: 5 })).toEqual([{ label: 'command', value: '5', mono: true }])
    expect(detailRows('Bash', { description: '' })).toEqual([{ label: 'description', value: '""', mono: true }])
    expect(detailRows('Bash', { timeout: 0 })).toEqual([{ label: 'timeout', value: '0', mono: true }])
    expect(detailRows('Write', { file_path: 5 })).toEqual([{ label: 'file_path', value: '5', mono: true }])
  })
  it('양수 제한 시간은 0초로 읽히지 않는다', () => {
    expect(detailRows('Bash', { timeout: 400 })[0].value).toBe('1초')
  })
})
