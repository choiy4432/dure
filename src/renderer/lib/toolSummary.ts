import { josa } from './words'

export type ToolIcon = 'file' | 'edit' | 'run' | 'search' | 'web' | 'handoff' | 'question' | 'other'
export interface ToolSummary {
  verb: string
  target: string | null
  icon: ToolIcon
}

function field(input: unknown, key: string): string | null {
  if (input && typeof input === 'object') {
    const v = (input as Record<string, unknown>)[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

function lastPiece(path: string | null): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

export function toolSummary(name: string, input: unknown): ToolSummary {
  switch (name) {
    case 'Read':
      return { verb: '읽음', target: lastPiece(field(input, 'file_path')), icon: 'file' }
    case 'Write':
      return { verb: '만듦', target: lastPiece(field(input, 'file_path')), icon: 'file' }
    case 'Edit':
    case 'MultiEdit':
      return { verb: '수정', target: lastPiece(field(input, 'file_path')), icon: 'edit' }
    case 'NotebookEdit':
      return { verb: '수정', target: lastPiece(field(input, 'notebook_path') ?? field(input, 'file_path')), icon: 'edit' }
    case 'Bash':
    case 'PowerShell': {
      const cmd = field(input, 'command')
      return { verb: '실행', target: cmd ? cmd.split(/\r?\n/)[0].slice(0, 60) : null, icon: 'run' }
    }
    case 'Glob':
    case 'Grep':
      return { verb: '찾음', target: field(input, 'pattern'), icon: 'search' }
    case 'WebFetch':
      return { verb: '웹에서 찾아봄', target: field(input, 'url'), icon: 'web' }
    case 'WebSearch':
      return { verb: '웹에서 찾아봄', target: field(input, 'query'), icon: 'web' }
    case 'TodoWrite':
      return { verb: '할 일 정리', target: null, icon: 'other' }
    case 'Task':
    case 'Agent':
      return { verb: '서브에이전트에게 맡김', target: field(input, 'description'), icon: 'other' }
    case 'mcp__dure__send_message': {
      const to = field(input, 'to')
      return { verb: '넘김', target: to ? `${to} 에게` : null, icon: 'handoff' }
    }
    case 'mcp__dure__list_agents':
      return { verb: '동료 확인', target: null, icon: 'handoff' }
    case 'AskUserQuestion':
      return { verb: '물어봄', target: null, icon: 'question' }
    case 'Skill': {
      // 이름이 없는 옛 기록(엔진이 skill 칸을 남기기 전)은 아래 '그 밖' 과 같은 줄로
      const skill = field(input, 'skill')
      return skill ? { verb: '스킬 사용', target: skill, icon: 'other' } : { verb: '사용', target: name, icon: 'other' }
    }
    default: {
      const m = /^mcp__.+?__(.+)$/.exec(name)
      return { verb: '사용', target: m ? m[1] : name, icon: 'other' }
    }
  }
}

// 승인 요청 제목의 '무엇을 하려' — 하는 일 요약의 동사로 고른다. 이 표 한 곳에서만 정한다.
const INTENT: Record<string, string> = {
  수정: '파일을 고치려',
  만듦: '파일을 만들려',
  실행: '명령을 실행하려',
  읽음: '파일을 읽으려',
  찾음: '파일을 찾아보려',
  '웹에서 찾아봄': '웹에서 찾아보려',
  '할 일 정리': '할 일을 정리하려',
  '서브에이전트에게 맡김': '서브에이전트에게 일을 맡기려',
  넘김: '일을 넘기려',
  '동료 확인': '동료를 확인하려',
  물어봄: '물어보려',
  '스킬 사용': '스킬을 쓰려',
}
const INTENT_OTHER = '도구를 쓰려'

/** 승인 요청 제목 — '디자인이 파일을 고치려 해요'. 서브에이전트가 한 일이면 '디자인의 서브에이전트가 파일을 고치려 해요' */
export function requestTitle(agentName: string, toolName: string, input: unknown, fromSubagent = false): string {
  const { verb } = toolSummary(toolName, input)
  const intent = INTENT[verb] ?? INTENT_OTHER
  if (fromSubagent) return `${agentName}의 서브에이전트가 ${intent} 해요`
  return `${agentName}${josa(agentName, '이/가')} ${intent} 해요`
}

// 하는 일 동사의 진행형 — 서브에이전트 줄 둘째 줄('조사 읽는 중 · 도구 3번')에서 아직 끝나지 않은 일에 쓴다
const ONGOING: Record<string, string> = {
  읽음: '읽는 중',
  만듦: '만드는 중',
  수정: '고치는 중',
  실행: '실행하는 중',
  찾음: '찾는 중',
  '웹에서 찾아봄': '웹에서 찾는 중',
  '할 일 정리': '할 일 정리하는 중',
  '서브에이전트에게 맡김': '서브에이전트에게 맡기는 중',
  넘김: '넘기는 중',
  '동료 확인': '동료 확인하는 중',
  물어봄: '묻는 중',
  '스킬 사용': '스킬 쓰는 중',
  사용: '쓰는 중',
}

export function ongoing(verb: string): string {
  return ONGOING[verb] ?? `${verb} 중`
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const slash = (p: string) => p.replace(/\\/g, '/')

/** 에이전트 폴더 안이면 폴더 기준 경로, 아니면 전체 — 구분자는 '/' 로 */
function relativeTo(path: string, folder: string | undefined): string {
  const p = slash(path)
  if (!folder) return p
  const base = slash(folder).replace(/\/+$/, '') + '/'
  return p.toLowerCase().startsWith(base.toLowerCase()) ? p.slice(base.length) : p
}

/** 승인 요청의 대상 — 파일 경로(폴더 기준)나 명령 첫 줄. 잘림 없이 — 화면이 말줄임을 맡는다 */
export function requestTarget(toolName: string, input: unknown, folder?: string): string | null {
  if (FILE_TOOLS.has(toolName)) {
    const path = field(input, 'file_path') ?? field(input, 'notebook_path')
    return path ? relativeTo(path, folder) : null
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = field(input, 'command')
    return cmd ? cmd.split(/\r?\n/)[0] : null
  }
  return toolSummary(toolName, input).target
}
