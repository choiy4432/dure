import { filePathTarget } from './toolSummary'

// 승인 카드의 글 만들기 — 쉬운 말 설명, 명령 줄 수, 칸별 자세히. 화면·IPC 를 모르는 순수 함수

function obj(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
}

/** 에이전트가 적은 '왜 하는지' 설명 — 첫 줄만, 200자 상한. 없으면 null */
export function requestWhy(input: unknown): string | null {
  const d = obj(input)?.description
  if (typeof d !== 'string') return null
  const first = d.trim().split(/\r?\n/)[0].trim()
  if (!first) return null
  return first.length > 200 ? first.slice(0, 200) + '…' : first
}

/** 명령 도구의 첫 줄과 그 뒤 줄 수(끝 빈 줄 제외) */
export function commandLines(toolName: string, input: unknown): { first: string; more: number } | null {
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return null
  const c = obj(input)?.command
  if (typeof c !== 'string' || c === '') return null
  const lines = c.split(/\r?\n/)
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop()
  return { first: lines[0], more: lines.length - 1 }
}

export type DetailRow = { label: string; value: string; mono: boolean }

const VALUE_MAX = 2000

const cap = (v: string) => (v.length > VALUE_MAX ? v.slice(0, VALUE_MAX - 1) + '…' : v)

/** 앞 n줄만, 더 있으면 끝에 '…' 한 줄 */
function head(v: string, n: number): string {
  const lines = v.split(/\r?\n/)
  return lines.length > n ? lines.slice(0, n).join('\n') + '\n…' : v
}

function duration(ms: number): string {
  const sec = Math.round(ms / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m === 0) return `${s}초`
  return s === 0 ? `${m}분` : `${m}분 ${s}초`
}

// 아는 칸 — 이 차례로 보여준다
const KNOWN = ['command', 'description', 'timeout', 'file_path', 'notebook_path', 'content', 'old_string', 'new_string', 'pattern', 'url', 'query']

/** 자세히 의 칸들 — 아는 칸은 쉬운 이름으로, 모르는 칸은 이름 그대로 JSON 으로 */
export function detailRows(toolName: string, input: unknown, folder?: string): DetailRow[] {
  void toolName
  const o = obj(input)
  if (!o) return []
  const rows: DetailRow[] = []
  const str = (k: string) => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : null)
  const push = (label: string, value: string, mono: boolean) => rows.push({ label, value: cap(value), mono })

  let v = str('command')
  if (v) push('명령', v, true)
  if ((v = str('description'))) push('설명', v, false)
  if (typeof o.timeout === 'number' && o.timeout > 0) push('제한 시간', duration(o.timeout), false)
  const path = filePathTarget(o, folder)
  if (path) push('파일', path, true)
  if ((v = str('content'))) push('내용', head(v, 20), true)
  if ((v = str('old_string'))) push('바꿀 글', head(v, 10), true)
  if ((v = str('new_string'))) push('새 글', head(v, 10), true)
  if ((v = str('pattern'))) push('찾을 것', v, true)
  if ((v = str('url'))) push('주소', v, true)
  if ((v = str('query'))) push('검색어', v, false)

  for (const k of Object.keys(o)) {
    if (KNOWN.includes(k)) continue
    let j = JSON.stringify(o[k])
    if (j === undefined) continue
    if (j.length > 200) j = j.slice(0, 200) + '…'
    push(k, j, true)
  }
  return rows
}
