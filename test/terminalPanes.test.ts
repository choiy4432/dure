import { describe, it, expect } from 'vitest'
import { createPanes, highlight, type Line } from '../src/renderer/power/terminal/panes'
import type { ScreenEvent } from '../src/renderer/power/events'

const text = (ls: Line[]) => ls.map(l => l.parts.map(p => p.t).join('')).join('\n')
const run = (seed: number) => {
  const p = createPanes(seed)
  const out: string[] = []
  for (let i = 0; i < 120; i++) out.push(text(p.agent(null)), text(p.tests()), text(p.diff()), JSON.stringify(p.typing()), JSON.stringify(p.subs(4, i)), text(p.subsLog()), text(p.system()))
  return out
}

describe('터미널 창 줄', () => {
  it('같은_씨앗이면_같은_줄', () => {
    expect(run(5)).toEqual(run(5))
    expect(run(5)).not.toEqual(run(6))
  })

  it('agent(진짜_tool)_은_그_도구와_대상을_담는다', () => {
    const ev: ScreenEvent = { kind: 'tool', agentId: 'a', tool: 'Edit', target: 'src/real/one.ts', real: true, at: 1 }
    const ls = createPanes(1).agent(ev)
    expect(ls[0].parts.map(p => p.t)).toContain('Edit')
    expect(text([ls[0]])).toContain('src/real/one.ts')
    expect(text([ls[1]])).toContain('⎿')
  })

  it('agent(진짜_넘김)_은_send_message_와_받는_이와_글', () => {
    const ev: ScreenEvent = { kind: 'handoff', from: 'a', to: 'b', text: '확인 부탁해요', real: true, at: 1 }
    const ls = createPanes(1, { nameOf: id => (id === 'b' ? '베타' : id) }).agent(ev, 'a')
    expect(text(ls)).toContain('send_message(→ 베타)')
    expect(text(ls)).toContain('확인 부탁해요')
  })

  it('agent(null)_은_채움_줄', () => {
    const p = createPanes(3)
    const all: Line[] = []
    for (let i = 0; i < 80; i++) {
      const ls = p.agent(null)
      expect(ls.length).toBeGreaterThan(0)
      all.push(...ls)
    }
    const t = text(all)
    expect(t).toContain('생각 중…')
    expect(t).toContain('⎿')
    expect(t).toContain('●')
  })

  it('생각_줄은_같은_key_로_제자리를_바꾸고_끝나면_지운다', () => {
    const p = createPanes(3)
    const all: Line[] = []
    for (let i = 0; i < 80; i++) all.push(...p.agent(null))
    expect(all.some(l => l.key === 'think' && !l.end)).toBe(true)
    expect(all.some(l => l.key === 'think' && l.end)).toBe(true)
  })

  it('diff_의_+_줄은_add_−_줄은_del', () => {
    const p = createPanes(2)
    const ls: Line[] = []
    for (let i = 0; i < 80; i++) ls.push(...p.diff())
    const plus = ls.filter(l => l.parts[0]?.t.startsWith('+') && !l.parts[0].t.startsWith('+++'))
    const minus = ls.filter(l => l.parts[0]?.t.startsWith('-') && !l.parts[0].t.startsWith('---'))
    expect(plus.length).toBeGreaterThan(3)
    expect(minus.length).toBeGreaterThan(1)
    expect(plus.every(l => l.parts[0].c === 'add')).toBe(true)
    expect(minus.every(l => l.parts[0].c === 'del')).toBe(true)
  })

  it('typing_은_한_파일을_다_치면_done', () => {
    const p = createPanes(4)
    let first = ''
    let n = 0
    let lastLine = 0
    for (; n < 5000; n++) {
      const r = p.typing()
      if (r.idle) continue
      first ||= r.file
      lastLine = r.line
      expect(r.text.length).toBeLessThanOrEqual(90)
      if (r.done) {
        expect(r.file).toBe(first)
        expect(r.lineDone).toBe(true)
        break
      }
    }
    expect(n).toBeLessThan(5000)
    expect(lastLine).toBeGreaterThan(10)
    // 다음 파일로 넘어간다
    let next = ''
    for (let i = 0; i < 200 && !next; i++) {
      const r = p.typing()
      if (!r.idle) next = r.file
    }
    expect(next).not.toBe(first)
  })

  it('subs_는_n_개만_두_줄씩', () => {
    expect(createPanes(1).subs(2).lines).toHaveLength(4)
    expect(createPanes(1).subs(4).rows).toHaveLength(4)
  })

  it('system_은_CPU_막대_8개와_프로세스_표', () => {
    const ls = createPanes(1).system()
    expect(text(ls.slice(0, 4))).toMatch(/\|/)
    expect(text(ls)).toContain('Mem')
    expect(ls.some(l => l.hd)).toBe(true)
    expect(createPanes(1).system(4).length).toBe(ls.length)
  })

  it('highlight_는_예약어_문자열_숫자_주석을_나눈다', () => {
    const cs = (s: string) => highlight(s).map(p => (p.c ? [p.t, p.c] : [p.t]))
    expect(cs("const a = 'x' + 12")).toEqual([['const', 'vi'], [' a = '], ["'x'", 'gn'], [' + '], ['12', 'am']])
    expect(cs('// 주석 const')).toEqual([['// 주석 const', 'dim']])
  })
})
