import { describe, it, expect } from 'vitest'
import { buildTranscript } from '../../src/renderer/state/transcript'
import { DENY } from '../../src/shared/denyTexts'
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
  it('boundary(새 대화)를 만나면 그 앞 줄은 버린다 — 다시 켠 뒤의 기록과 같은 화면', () => {
    const { lines } = buildTranscript(
      [human('옛 말', 1), asst([{ type: 'text', text: '옛 답' }], 2), { t: 3, kind: 'boundary' }, human('새 말', 4)],
      undefined,
    )
    expect(lines).toEqual([{ kind: 'me', text: '새 말', images: 0, at: 4 }])
    expect(buildTranscript([human('옛 말', 1), { t: 2, kind: 'boundary' }], undefined).lines).toEqual([])
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
    expect((lines[0] as any).actions[0].truncated).toBe(true)
  })
  it('잘리지 않은 출력엔 잘림 표시가 없다(2000자 딱 맞아도)', () => {
    const { lines } = buildTranscript([asst([{ type: 'tool_use', id: 'q', name: 'Bash', input: {} }]), res('q', 'x'.repeat(2000))], undefined)
    expect((lines[0] as any).actions[0].truncated).toBeUndefined()
  })
  it('전달 머리를 떼고 보낸 이름만 남긴다', () => {
    const it: HistoryItem = {
      t: 5, kind: 'user', source: 'relay',
      parts: [{ type: 'text', text: '[두레 메시지 — 보낸 쪽: 기획(기획서 · 문구)]\n본문' }],
    }
    expect(buildTranscript([it], undefined).lines[0]).toEqual({ kind: 'relay', from: '기획', text: '본문', at: 5 })
  })
  it('역할 안에 괄호가 있어도 이름만 남긴다', () => {
    const it: HistoryItem = {
      t: 5, kind: 'user', source: 'relay',
      parts: [{ type: 'text', text: '[두레 메시지 — 보낸 쪽: 기획(API(내부))]\n본문\n둘째 줄' }],
    }
    expect(buildTranscript([it], undefined).lines[0]).toEqual({ kind: 'relay', from: '기획', text: '본문\n둘째 줄', at: 5 })
  })
  it('머리를 못 읽어도 relay 출처면 relay 줄(이름 빈 값, 본문 통째)', () => {
    const it: HistoryItem = { t: 6, kind: 'user', source: 'relay', parts: [{ type: 'text', text: '머리 없는 글' }] }
    expect(buildTranscript([it], undefined).lines[0]).toEqual({ kind: 'relay', from: '', text: '머리 없는 글', at: 6 })
  })
  it.each(Object.values(DENY))('거절 문구 %s 는 denied', (msg) => {
    const { lines } = buildTranscript([asst([{ type: 'tool_use', id: 'd', name: 'Bash', input: {} }]), res('d', msg, true)], undefined)
    expect((lines[0] as any).actions[0]).toMatchObject({ denied: true, allowed: false })
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
