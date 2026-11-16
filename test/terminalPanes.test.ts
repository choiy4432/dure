import { describe, it, expect } from 'vitest'
import { eventLines, highlight, type Line } from '../src/renderer/power/terminal/panes'
import type { ScreenEvent } from '../src/renderer/power/events'

const text = (ls: Line[]) => ls.map(l => l.parts.map(p => p.t).join('')).join('\n')
const names = (id: string) => ({ a: '알파', b: '베타' })[id] ?? id

describe('터미널 창 줄', () => {
  it('진짜_tool_은_그_도구와_대상을_담는다(지어낸_결과_줄은_없다)', () => {
    const ev: ScreenEvent = { kind: 'tool', agentId: 'a', tool: 'Edit', target: 'src/real/one.ts', at: 1 }
    const ls = eventLines(ev, 'a', names)
    expect(ls).toHaveLength(1)
    expect(ls[0].parts.map(p => p.t)).toContain('Edit')
    expect(text(ls)).toBe('● Edit(src/real/one.ts)')
  })

  it('진짜_결과는_첫_줄을_오류면_빨강으로', () => {
    const ok: ScreenEvent = { kind: 'result', agentId: 'a', ok: true, text: '12줄 읽음', added: 0, removed: 0, diff: [], at: 1 }
    const bad: ScreenEvent = { ...ok, ok: false, text: '파일이 없어요' }
    expect(text(eventLines(ok, 'a', names))).toBe('  ⎿  12줄 읽음')
    expect(eventLines(ok, 'a', names)[0].parts[0].c).toBe('dim')
    expect(eventLines(bad, 'a', names)[0].parts[0].c).toBe('er')
    expect(eventLines({ ...ok, text: '' }, 'a', names)).toEqual([])
  })

  it('진짜_넘김은_send_message_와_받는_이와_글', () => {
    const ev: ScreenEvent = { kind: 'handoff', from: 'a', to: 'b', text: '확인 부탁해요', at: 1 }
    expect(text(eventLines(ev, 'a', names))).toContain('send_message(→ 베타)')
    expect(text(eventLines(ev, 'a', names))).toContain('확인 부탁해요')
    expect(text(eventLines(ev, 'b', names))).toContain('send_message(← 알파)')
  })

  it('차례_끝은_끝남_한_줄_답_글은_아직_안_그린다', () => {
    expect(text(eventLines({ kind: 'done', agentId: 'a', at: 1 }, 'a', names))).toBe('✓ 끝남')
    expect(eventLines({ kind: 'say', agentId: 'a', text: '말', at: 1 }, 'a', names)).toEqual([])
  })

  it.todo('diff_의_+_줄은_add_−_줄은_del')

  it('highlight_는_예약어_문자열_숫자_주석을_나눈다', () => {
    const cs = (s: string) => highlight(s).map(p => (p.c ? [p.t, p.c] : [p.t]))
    expect(cs("const a = 'x' + 12")).toEqual([['const', 'vi'], [' a = '], ["'x'", 'gn'], [' + '], ['12', 'am']])
    expect(cs('// 주석 const')).toEqual([['// 주석 const', 'dim']])
  })
})
