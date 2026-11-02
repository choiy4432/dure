import { describe, it, expect } from 'vitest'
import { conversationMarkdown, exportFileName } from '../../src/renderer/lib/exportConversation'
import type { HistoryItem } from '../../src/engine/types'
import { DENY } from '../../src/shared/denyTexts'

const T = new Date(2026, 9, 28, 14, 3).getTime()
const MIN = 60_000
const NOW = new Date(2026, 9, 28, 16, 12).getTime()
const agent = { name: '웹 화면', role: '프론트 구현' }

const items: HistoryItem[] = [
  { t: T, kind: 'user', source: 'human', parts: [{ type: 'text', text: '이거 고쳐 줘' }, { type: 'image', mediaType: 'image/png', bytes: 1, file: 'a.png' }] },
  { t: T + MIN, kind: 'assistant', blocks: [{ type: 'text', text: '고칠게요.' }, { type: 'tool_use', id: 'u1', name: 'Edit', input: { file_path: 'C:/w/src/App.tsx', old_string: 'a', new_string: 'b' } }] },
  { t: T + MIN, kind: 'tool-result', toolUseId: 'u1', isError: false, text: 'ok', viaApproval: false },
  { t: T + MIN, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'rm -rf build' } }] },
  { t: T + MIN, kind: 'tool-result', toolUseId: 'u2', isError: true, text: DENY.userDenied, viaApproval: false },
  { t: T + MIN, kind: 'assistant', blocks: [{ type: 'text', text: '**끝났어요**' }] },
  { t: T + MIN, kind: 'result', ok: true, subtype: 'success' },
  { t: T + 2 * MIN, kind: 'user', source: 'relay', parts: [{ type: 'text', text: '[두레 메시지 — 보낸 쪽: 기획(기획서)]\n시안 봐 줘' }] },
  { t: T + 3 * MIN, kind: 'notice', text: '멈췄어요' },
  { t: T + 24 * 60 * MIN, kind: 'user', source: 'human', parts: [{ type: 'text', text: '다음 날' }] },
]

describe('conversationMarkdown — 지금 대화를 마크다운으로(대화창과 같은 줄)', () => {
  it('머리 · 차례마다 누가·언제 · 답 글과 하는 일 줄 · 받은 메시지 · 알림 — 날짜는 바뀔 때만', () => {
    expect(conversationMarkdown({ agent, items, now: NOW })).toBe(
      [
        '# 웹 화면 — 대화',
        '',
        '- 역할: 프론트 구현',
        '- 내보낸 때: 2026년 10월 28일 16:12',
        '',
        '### 나 · 10월 28일 14:03',
        '',
        '이거 고쳐 줘',
        '',
        '[그림 1장]',
        '',
        '### Claude · 14:04',
        '',
        '고칠게요.',
        '',
        '- 수정 `App.tsx`',
        '- 실행 `rm -rf build` — 거절됨',
        '',
        '**끝났어요**',
        '',
        '### 기획에게서 온 메시지 · 14:05',
        '',
        '시안 봐 줘',
        '',
        '> 멈췄어요',
        '',
        '### 나 · 10월 29일 14:03',
        '',
        '다음 날',
        '',
      ].join('\n'),
    )
  })

  it('역할이 없으면 역할 줄을 뺀다 · 대화가 비었으면 null', () => {
    const md = conversationMarkdown({ agent: { name: 'A', role: '' }, items: items.slice(0, 1), now: NOW })!
    expect(md).not.toContain('- 역할')
    expect(md.startsWith('# A — 대화\n\n- 내보낸 때: ')).toBe(true)
    expect(conversationMarkdown({ agent, items: [], now: NOW })).toBeNull()
    expect(conversationMarkdown({ agent, items: [{ t: T, kind: 'result', ok: true, subtype: 'success' }], now: NOW })).toBeNull()
  })

  it('대상에 백틱이 들어 있어도 코드 조각이 깨지지 않는다', () => {
    const md = conversationMarkdown({
      agent, now: NOW,
      items: [{ t: T, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'u', name: 'Bash', input: { command: 'echo `date`' } }] }],
    })!
    expect(md).toContain('- 실행 `` echo `date` ``')
  })

  it('명령 출력(/model 등)은 코드 상자 — 글 안에 ``` 가 있으면 더 긴 울타리', () => {
    const md = conversationMarkdown({ agent, now: NOW, items: [{ t: T, kind: 'local-output', text: 'a\n```\nb' }] })!
    expect(md).toContain('````\na\n```\nb\n````')
  })
})

describe('exportFileName', () => {
  it('<이름>-대화-<YYYY-MM-DD>.md', () => {
    expect(exportFileName('웹 화면', NOW)).toBe('웹 화면-대화-2026-10-28.md')
  })
})
