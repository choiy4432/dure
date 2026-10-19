import { describe, it, expect } from 'vitest'
import { buildTranscript } from '../../src/renderer/state/transcript'
import type { HistoryItem } from '../../src/engine/types'

const human = (text: string, t = 1): HistoryItem => ({ t, kind: 'user', source: 'human', parts: [{ type: 'text', text }] })
const asst = (blocks: any[], t = 2): HistoryItem => ({ t, kind: 'assistant', blocks })
const res = (id: string, text: string, isError = false, viaApproval = false, t = 3): HistoryItem => ({
  t, kind: 'tool-result', toolUseId: id, isError, text, viaApproval,
})

describe('buildTranscript', () => {
  it('assistant 연속 블록을 한 줄로 합치고 tool_use 와 결과를 짝짓는다', () => {
    const { lines } = buildTranscript(
      [
        human('hi'),
        asst([{ type: 'text', text: '봅니다' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x/f.ts' } }]),
        res('a', 'content'),
        asst([{ type: 'text', text: '끝' }]),
      ],
      undefined,
    )
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({ kind: 'claude', text: '봅니다\n\n끝' })
    const c = lines[1] as any
    expect(c.actions).toEqual([
      { id: 'a', verb: '읽음', target: 'f.ts', icon: 'file', allowed: true, denied: false, output: 'content' },
    ])
  })
  it('결과 없으면 진행 중', () => {
    const { lines } = buildTranscript([asst([{ type: 'tool_use', id: 'z', name: 'Bash', input: { command: 'ls' } }])], undefined)
    expect((lines[0] as any).actions[0]).toMatchObject({ output: '', allowed: false, denied: false, pending: true })
  })
  it('allowed / denied', () => {
    const { lines } = buildTranscript(
      [
        asst([
          { type: 'tool_use', id: '1', name: 'Bash', input: {} },
          { type: 'tool_use', id: '2', name: 'Bash', input: {} },
          { type: 'tool_use', id: '3', name: 'Bash', input: {} },
          { type: 'tool_use', id: '4', name: 'Bash', input: {} },
        ]),
        res('1', 'ok', false, true),
        res('2', '사용자가 거절했습니다.', true, true),
        res('3', 'boom', true, false),
        res('4', 'ok', false, false),
      ],
      undefined,
    )
    const a = (lines[0] as any).actions
    expect(a.map((x: any) => [x.allowed, x.denied])).toEqual([[false, false], [false, true], [false, false], [true, false]])
  })
  it('출력은 앞 2000자', () => {
    const { lines } = buildTranscript([asst([{ type: 'tool_use', id: 'q', name: 'Bash', input: {} }]), res('q', 'x'.repeat(5000))], undefined)
    expect((lines[0] as any).actions[0].output).toHaveLength(2000)
  })
  it('전달 머리를 떼고 보낸 이름만 남긴다', () => {
    const it: HistoryItem = {
      t: 5, kind: 'user', source: 'relay',
      parts: [{ type: 'text', text: '[두레 메시지 — 보낸 쪽: 기획(기획서 · 문구)]\n본문' }],
    }
    expect(buildTranscript([it], undefined).lines[0]).toEqual({ kind: 'relay', from: '기획', text: '본문', at: 5 })
  })
  it('이미지는 개수로, 알림·로컬 출력은 줄로', () => {
    const { lines } = buildTranscript(
      [
        { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: 'a' }, { type: 'image', mediaType: 'image/png', bytes: 3 }, { type: 'text', text: 'b' }] },
        { t: 2, kind: 'notice', text: '멈춤' },
        { t: 3, kind: 'local-output', text: 'out' },
      ],
      undefined,
    )
    expect(lines[0]).toEqual({ kind: 'me', text: 'a\n\nb', images: 1, at: 1 })
    expect(lines[1]).toEqual({ kind: 'notice', text: '멈춤', at: 2 })
    expect(lines[2]).toEqual({ kind: 'local', text: 'out', at: 3 })
  })
  it('1000항목 → 마지막 300줄, hiddenBefore 700, streaming 은 끝에 하나', () => {
    const items = Array.from({ length: 1000 }, (_, i) => human(`m${i}`, i))
    const { lines, hiddenBefore } = buildTranscript(items, '쓰는 중')
    expect(hiddenBefore).toBe(700)
    expect(lines).toHaveLength(301)
    expect(lines[0]).toMatchObject({ text: 'm700' })
    expect(lines[300]).toEqual({ kind: 'streaming', text: '쓰는 중' })
  })
})
