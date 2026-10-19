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
      return { verb: '도우미에게 맡김', target: field(input, 'description'), icon: 'other' }
    case 'mcp__dure__send_message': {
      const to = field(input, 'to')
      return { verb: '넘김', target: to ? `${to} 에게` : null, icon: 'handoff' }
    }
    case 'mcp__dure__list_agents':
      return { verb: '동료 확인', target: null, icon: 'handoff' }
    case 'AskUserQuestion':
      return { verb: '물어봄', target: null, icon: 'question' }
    default: {
      const m = /^mcp__.+?__(.+)$/.exec(name)
      return { verb: '사용', target: m ? m[1] : name, icon: 'other' }
    }
  }
}
