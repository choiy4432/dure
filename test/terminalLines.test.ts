import { describe, it, expect } from 'vitest'
import { historyLines, linesOf, panesOf, pickPanes, PREFILL_MAX, type Line } from '../src/renderer/power/terminal/lines'
import type { AgentState, PowerAgent, ScreenEvent } from '../src/renderer/power/events'
import type { HistoryItem } from '../src/engine/types'

// 터미널 창 줄 — 진짜 화면 사건 하나 → 그 창의 줄(순수). 넘김은 보낸 이·받는 이 창 둘에 서로 다른 줄

const text = (ls: Line[]) => ls.map(l => l.parts.map(p => p.t).join('')).join('\n')
const names = (id: string) => ({ a: '알파', b: '베타' })[id] ?? id
const result = (over: Partial<Extract<ScreenEvent, { kind: 'result' }>> = {}): ScreenEvent => ({ kind: 'result', agentId: 'a', ok: true, text: '12줄 읽음', added: 0, removed: 0, diff: [], at: 1, ...over })

describe('터미널 창 줄', () => {
  it('tool_→_●_Tool(대상)', () => {
    const ls = linesOf({ kind: 'tool', agentId: 'a', tool: 'Read', target: 'src/x.ts', at: 1 }, names, 'a')
    expect(text(ls)).toBe('● Read(src/x.ts)')
    expect(ls[0].parts[0]).toEqual({ t: '●', c: 'ok' })
    expect(ls[0].parts.find(p => p.t === 'Read')).toEqual({ t: 'Read', b: true })
    // 긴 경로는 끝 두 조각(파일 이름이 보이게) · 명령은 그대로
    expect(text(linesOf({ kind: 'tool', agentId: 'a', tool: 'Read', target: 'C:\\work\\shop\\src\\order\\refund.ts', at: 1 }, names, 'a'))).toBe('● Read(…\\order\\refund.ts)')
    expect(text(linesOf({ kind: 'tool', agentId: 'a', tool: 'Bash', target: 'npm test -- src/a/b/c.ts', at: 1 }, names, 'a'))).toBe('● Bash(npm test -- src/a/b/c.ts)')
    // 다른 창엔 붙지 않는다
    expect(linesOf({ kind: 'tool', agentId: 'a', tool: 'Read', target: 'src/x.ts', at: 1 }, names, 'b')).toEqual([])
  })

  it('result_ok_→_흐린_한_줄_·_오류는_er', () => {
    expect(text(linesOf(result(), names, 'a'))).toBe('  ⎿  12줄 읽음')
    expect(linesOf(result(), names, 'a')[0].parts[0].c).toBe('dim')
    const bad = linesOf(result({ ok: false, text: '파일이 없어요' }), names, 'a')
    expect(text(bad)).toBe('  ⎿  파일이 없어요')
    expect(bad[0].parts[0].c).toBe('er')
    // 글도 바꾼 줄도 없으면 줄이 없다(지어내지 않는다)
    expect(linesOf(result({ text: '' }), names, 'a')).toEqual([])
    expect(linesOf(result(), names, 'b')).toEqual([])
  })

  it('diff_줄은_add/del', () => {
    const ev = result({ text: '파일을 고쳤어요', added: 2, removed: 1, diff: [{ sign: ' ', text: 'const a = 1' }, { sign: '-', text: 'return a' }, { sign: '+', text: 'return b' }, { sign: '+', text: 'return c' }] })
    const ls = linesOf(ev, names, 'a')
    expect(text(ls).split('\n')).toEqual([
      '  ⎿  파일을 고쳤어요 (+2 −1)',
      '       const a = 1',
      '     - return a',
      '     + return b',
      '     + return c',
    ])
    const color = (l: Line) => l.parts[l.parts.length - 1].c
    expect(ls.slice(1).map(color)).toEqual(['dim', 'del', 'add', 'add'])
    // 결과 줄의 +/− 수는 진짜 patch 의 수
    expect(ls[0].parts.map(p => p.t)).toContain('+2')
    expect(ls[0].parts.map(p => p.t)).toContain('−1')
    // 글이 비어도 바꾼 줄이 있으면 그린다
    expect(text(linesOf(result({ text: '', added: 1, diff: [{ sign: '+', text: 'x' }] }), names, 'a')).split('\n')).toEqual(['  ⎿  (+1 −0)', '     + x'])
  })

  it('say_→_글_줄', () => {
    const ls = linesOf({ kind: 'say', agentId: 'a', text: '재고 예약 순서를 확인했어요.', at: 1 }, names, 'a')
    expect(ls).toEqual([{ parts: [{ t: '재고 예약 순서를 확인했어요.' }] }])
    expect(linesOf({ kind: 'say', agentId: 'a', text: '말', at: 1 }, names, 'b')).toEqual([])
  })

  it('handoff_→_send_message(→_이름)_+_글', () => {
    const ev: ScreenEvent = { kind: 'handoff', from: 'a', to: 'b', text: '확인 부탁해요', at: 1 }
    const out = linesOf(ev, names, 'a')
    expect(text(out).split('\n')).toEqual(['● send_message(→ 베타)', '  ⎿  "확인 부탁해요"'])
    expect(out[0].parts[0]).toEqual({ t: '●', c: 'bl' })
    // 받는 이 창엔 보낸 이와 글 한 줄
    const got = linesOf(ev, names, 'b')
    expect(text(got)).toBe('← 알파: 확인 부탁해요')
    expect(got[0].parts[0].c).toBe('bl')
    // 둘 밖의 창엔 없다 · 붙는 창은 보낸 이와 받는 이
    expect(linesOf(ev, names, 'c')).toEqual([])
    expect(panesOf(ev)).toEqual(['a', 'b'])
    expect(panesOf({ kind: 'done', agentId: 'a', at: 1 })).toEqual(['a'])
  })

  it('done_→_✓_끝남', () => {
    expect(linesOf({ kind: 'done', agentId: 'a', at: 1 }, names, 'a')).toEqual([{ parts: [{ t: '✓ 끝남', c: 'ok' }] }])
    expect(linesOf({ kind: 'done', agentId: 'a', at: 1 }, names, 'b')).toEqual([])
  })
})

describe('창 고르기', () => {
  const ag = (i: number): PowerAgent => ({ id: `x${i}`, name: `n${i}`, role: '', color: '' })

  it('pickPanes_8명_중_기다림·일하는_중이_앞(무리_안에선_방_순서)_6명까지', () => {
    const agents = Array.from({ length: 8 }, (_, i) => ag(i))
    const state: Record<string, AgentState> = { x0: 'resting', x1: 'resting', x2: 'working', x3: 'resting', x4: 'resting', x5: 'awaiting', x6: 'resting', x7: 'working' }
    expect(pickPanes(agents, state).map(a => a.id)).toEqual(['x5', 'x2', 'x7', 'x0', 'x1', 'x3'])
    expect(pickPanes(agents.slice(0, 3), {}).map(a => a.id)).toEqual(['x0', 'x1', 'x2'])
    expect(pickPanes([], {})).toEqual([])
  })
})

describe('켤 때 깔 줄', () => {
  const items: HistoryItem[] = [
    { t: 1, kind: 'user', source: 'human', parts: [{ type: 'text', text: '고쳐 줘' }] },
    { t: 2, kind: 'assistant', blocks: [{ type: 'text', text: '먼저 볼게요.' }, { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'src/x.ts' } }] },
    { t: 3, kind: 'tool-result', toolUseId: 'u1', isError: false, text: '20줄', viaApproval: false },
    { t: 4, kind: 'assistant', blocks: [{ type: 'tool_use', id: 's1', name: 'Read', input: { file_path: 'sub.ts' } }], parent: 'p1' },
    { t: 5, kind: 'result', ok: true, subtype: 'success' },
  ]

  it('기록을_tap_과_같은_규칙으로_줄로(서브에이전트_줄은_빼고)_새_것이_끝', () => {
    expect(text(historyLines('a', items, names)).split('\n')).toEqual(['먼저 볼게요.', '● Read(src/x.ts)', '  ⎿  20줄', '✓ 끝남'])
    expect(historyLines('a', [], names)).toEqual([])
  })

  it('긴_기록은_마지막_PREFILL_MAX_줄만', () => {
    const many: HistoryItem[] = Array.from({ length: 500 }, (_, i) => ({ t: i, kind: 'assistant', blocks: [{ type: 'tool_use', id: `u${i}`, name: 'Read', input: { file_path: `f${i}.ts` } }] }))
    const ls = historyLines('a', many, names)
    expect(PREFILL_MAX).toBe(40)
    expect(ls).toHaveLength(40)
    expect(text(ls.slice(-1))).toBe('● Read(f499.ts)')
    expect(text(ls.slice(0, 1))).toBe('● Read(f460.ts)')
  })
})
