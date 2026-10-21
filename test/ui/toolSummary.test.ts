import { describe, it, expect } from 'vitest'
import { requestTarget, requestTitle, toolSummary } from '../../src/renderer/lib/toolSummary'

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
  it('스킬은 이름까지 — 이름이 없으면(옛 기록) 도구 이름', () => {
    expect(toolSummary('Skill', { skill: 'superpowers:brainstorming', args: '긴 인자' })).toEqual({ verb: '스킬 사용', target: 'superpowers:brainstorming', icon: 'other' })
    expect(toolSummary('Skill', {})).toEqual({ verb: '사용', target: 'Skill', icon: 'other' })
    expect(requestTitle('기획', 'Skill', { skill: 'pdf' })).toBe('기획이 스킬을 쓰려 해요')
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

describe('requestTitle', () => {
  it('하는 일 요약의 동사로 "<이름>이 <무엇>하려 해요"', () => {
    expect(requestTitle('디자인', 'Edit', { file_path: 'a.css' })).toBe('디자인이 파일을 고치려 해요')
    expect(requestTitle('디자인', 'MultiEdit', {})).toBe('디자인이 파일을 고치려 해요')
    expect(requestTitle('서버', 'Write', { file_path: 'a.ts' })).toBe('서버가 파일을 만들려 해요')
    expect(requestTitle('서버', 'Bash', { command: 'npm test' })).toBe('서버가 명령을 실행하려 해요')
    expect(requestTitle('서버', 'PowerShell', { command: 'dir' })).toBe('서버가 명령을 실행하려 해요')
    expect(requestTitle('기획', 'WebFetch', { url: 'https://x.y' })).toBe('기획이 웹에서 찾아보려 해요')
  })

  it('모르는 도구는 "도구를 쓰려"', () => {
    expect(requestTitle('기획', 'mcp__figma__get_file', {})).toBe('기획이 도구를 쓰려 해요')
  })
})

describe('requestTarget', () => {
  it('파일은 에이전트 폴더 기준 경로(슬래시로), 폴더 밖이면 전체 경로', () => {
    expect(requestTarget('Write', { file_path: 'C:\\w\\src\\styles\\tokens.css' }, 'C:\\w')).toBe('src/styles/tokens.css')
    expect(requestTarget('Edit', { file_path: 'c:/W/src/a.ts' }, 'C:\\w\\')).toBe('src/a.ts')
    expect(requestTarget('Edit', { file_path: 'D:/other/a.ts' }, 'C:\\w')).toBe('D:/other/a.ts')
    expect(requestTarget('Edit', { file_path: 'C:/wx/a.ts' }, 'C:/w')).toBe('C:/wx/a.ts')
    expect(requestTarget('NotebookEdit', { notebook_path: '/p/n.ipynb' }, '/p')).toBe('n.ipynb')
  })

  it('명령은 첫 줄 전체, 그 밖은 하는 일 요약의 대상', () => {
    expect(requestTarget('Bash', { command: 'npm run build -- --mode production --watch\nrm x' })).toBe('npm run build -- --mode production --watch')
    expect(requestTarget('mcp__figma__get_file', {})).toBe('get_file')
    expect(requestTarget('TodoWrite', {})).toBeNull()
  })
})
