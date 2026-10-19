import { describe, it, expect } from 'vitest'
import { toolSummary } from '../../src/renderer/lib/toolSummary'

describe('toolSummary', () => {
  it('파일 도구는 마지막 조각만', () => {
    expect(toolSummary('Read', { file_path: 'C:\\a\\b\\c.ts' })).toEqual({ verb: '읽음', target: 'c.ts', icon: 'file' })
    expect(toolSummary('Write', { file_path: '/a/b/d.md' })).toEqual({ verb: '만듦', target: 'd.md', icon: 'file' })
    for (const n of ['Edit', 'MultiEdit']) expect(toolSummary(n, { file_path: '/x/y.ts' })).toEqual({ verb: '수정', target: 'y.ts', icon: 'edit' })
    expect(toolSummary('NotebookEdit', { notebook_path: '/x/n.ipynb' }).target).toBe('n.ipynb')
  })
  it('실행은 첫 줄 앞 60자', () => {
    expect(toolSummary('Bash', { command: 'ls -la\nrm x' })).toEqual({ verb: '실행', target: 'ls -la', icon: 'run' })
    expect(toolSummary('PowerShell', { command: 'a'.repeat(100) }).target).toBe('a'.repeat(60))
  })
  it('찾기·웹·그 밖', () => {
    expect(toolSummary('Grep', { pattern: 'foo' })).toEqual({ verb: '찾음', target: 'foo', icon: 'search' })
    expect(toolSummary('Glob', { pattern: '*.ts' }).verb).toBe('찾음')
    expect(toolSummary('WebFetch', { url: 'https://x.y' })).toEqual({ verb: '웹에서 찾아봄', target: 'https://x.y', icon: 'web' })
    expect(toolSummary('WebSearch', { query: '두레' }).target).toBe('두레')
    expect(toolSummary('TodoWrite', {})).toMatchObject({ verb: '할 일 정리', target: null })
    expect(toolSummary('Task', { description: '조사' })).toMatchObject({ verb: '도우미에게 맡김', target: '조사' })
    expect(toolSummary('Agent', { description: '조사' }).verb).toBe('도우미에게 맡김')
    expect(toolSummary('AskUserQuestion', {})).toEqual({ verb: '물어봄', target: null, icon: 'question' })
  })
  it('두레 도구', () => {
    expect(toolSummary('mcp__dure__send_message', { to: '기획', text: 'x' })).toEqual({ verb: '넘김', target: '기획 에게', icon: 'handoff' })
    expect(toolSummary('mcp__dure__list_agents', {})).toMatchObject({ verb: '동료 확인', target: null, icon: 'handoff' })
  })
  it('모르는 도구와 잘못된 입력', () => {
    expect(toolSummary('mcp__x__y', {})).toEqual({ verb: '사용', target: 'y', icon: 'other' })
    expect(toolSummary('Foo', null)).toEqual({ verb: '사용', target: 'Foo', icon: 'other' })
    expect(toolSummary('Read', null).target).toBeNull()
  })
})
