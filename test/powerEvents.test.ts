import { describe, it, expect, vi, afterEach } from 'vitest'
import { batched, BATCH_MAX, oneLine, tailPath, type ScreenEvent } from '../src/renderer/power/events'
import { historyEvents, TEXT_MAX } from '../src/renderer/power/tap'
import type { HistoryItem } from '../src/engine/types'

// 화면 사건 층 — 한 줄 글자(oneLine) · 듣기(tap)가 진짜 기록을 자르는 규칙 · 모아 넘기기(batched) 상한

const tool = (name: string, input: unknown): HistoryItem => ({ t: 1, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'u', name, input }] })

describe('oneLine', () => {
  it('oneLine 은 줄바꿈을 칸으로, 길면 …', () => {
    expect(oneLine('a\nb', 10)).toBe('a b')
    const s = oneLine('x'.repeat(2000), 60)
    expect(s.length).toBe(60)
    expect(s.endsWith('…')).toBe(true)
  })

  it('oneLine 은 max 를 넘지 않는다(0 이하는 빈 문자열)', () => {
    expect(oneLine('abc', 0)).toBe('')
    expect(oneLine('abc', -3)).toBe('')
    expect(oneLine('abc', 1).length).toBeLessThanOrEqual(1)
    expect(oneLine('abcdef', 3).length).toBe(3)
  })

  it('긴_진짜_도구_대상은_듣기를_지나면_80자이고_…로_끝난다', () => {
    const [ev] = historyEvents('a', tool('Read', { file_path: `C:\\work\\${'긴폴더\\'.repeat(100)}끝.ts` }), 1)
    if (ev.kind !== 'tool') throw new Error('tool 이 아니다')
    expect(TEXT_MAX).toBe(80)
    expect(ev.target.length).toBe(80)
    expect(ev.target.endsWith('…')).toBe(true)
  })
})

describe('tailPath', () => {
  it('경로는_끝_두_조각_빈칸이_있으면(명령)_그대로', () => {
    expect(tailPath('C:\\work\\shop\\src\\order\\refund.ts')).toBe('…\\order\\refund.ts')
    expect(tailPath('src/a/b/c.ts')).toBe('…/b/c.ts')
    expect(tailPath('src/a.ts')).toBe('src/a.ts')
    expect(tailPath('npm test -- src/a/b/c.ts')).toBe('npm test -- src/a/b/c.ts')
  })

  it('주소(://)는_경로로_자르지_않는다_—_한_줄·80자_상한은_듣기에서_그대로', () => {
    expect(tailPath('https://example.com/a/b/c')).toBe('https://example.com/a/b/c')
    expect(tailPath('file:///C:/work/shop/a.ts')).toBe('file:///C:/work/shop/a.ts')
    const [ev] = historyEvents('a', tool('mcp__web__fetch', { path: `https://example.com/${'a/'.repeat(100)}\nnext` }), 1)
    if (ev.kind !== 'tool') throw new Error('tool 이 아니다')
    expect(tailPath(ev.target)).toBe(ev.target)
    expect(ev.target.startsWith('https://example.com/')).toBe(true)
    expect(ev.target.length).toBe(TEXT_MAX)
    expect(ev.target).not.toMatch(/[\r\n]/)
  })
})

describe('듣기 — 진짜 기록을 자르는 규칙', () => {
  it('도구_이름도_한_줄_40자까지', () => {
    const [ev] = historyEvents('a', tool(`mcp__x__${'n'.repeat(200)}\nsecond`, {}), 1)
    if (ev.kind !== 'tool') throw new Error('tool 이 아니다')
    expect(ev.tool.length).toBe(40)
    expect(ev.tool).not.toMatch(/[\r\n]/)
    expect(ev.tool.endsWith('…')).toBe(true)
    const [short] = historyEvents('a', tool('Read', {}), 1)
    expect(short).toMatchObject({ kind: 'tool', tool: 'Read' })
  })

  it('patch_의_줄_끝_표시(\\_No_newline_at_end_of_file)는_앞뒤_줄이_되지_않는다', () => {
    const item: HistoryItem = {
      t: 1, kind: 'tool-result', toolUseId: 'u', isError: false, text: '고침', viaApproval: false,
      patch: [{ oldStart: 1, newStart: 1, lines: [' 그대로', '-옛 끝', '\\ No newline at end of file', '+새 끝', '\\ No newline at end of file'] }],
    }
    const [ev] = historyEvents('a', item, 1)
    if (ev.kind !== 'result') throw new Error('result 가 아니다')
    expect(ev.diff).toEqual([
      { sign: ' ', text: '그대로' },
      { sign: '-', text: '옛 끝' },
      { sign: '+', text: '새 끝' },
    ])
    expect({ added: ev.added, removed: ev.removed }).toEqual({ added: 1, removed: 1 })
  })

  it('답_글은_앞부분만_훑는다(긴_글의_뒤쪽_문단은_보지_않는다)', () => {
    // 첫 문단이 아주 길면 그 뒤 문단은 훑는 범위 밖 — 첫 줄 하나만
    const long: HistoryItem = { t: 1, kind: 'assistant', blocks: [{ type: 'text', text: `${'가'.repeat(200_000)}\n\n뒤 문단\n\n또 뒤` }] }
    const evs = historyEvents('a', long, 1)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'say' })
    if (evs[0].kind !== 'say') throw new Error('say 가 아니다')
    expect(evs[0].text.length).toBe(80)
    // 문단이 많아도 셋에서 멈춘다(글 블록 여럿이면 합쳐 셋)
    const many: HistoryItem = { t: 1, kind: 'assistant', blocks: [{ type: 'text', text: Array.from({ length: 5000 }, (_, i) => `문단 ${i}`).join('\n\n') }] }
    expect(historyEvents('a', many, 1).map(e => (e.kind === 'say' ? e.text : e.kind))).toEqual(['문단 0', '문단 1', '문단 2'])
  })
})

describe('batched', () => {
  afterEach(() => { vi.useRealTimers() })

  it('한_번에_BATCH_MAX_를_넘게_쌓이면_새_것_BATCH_MAX_개만_넘긴다', () => {
    vi.useFakeTimers()
    let emit: (ev: ScreenEvent) => void = () => {}
    const got: ScreenEvent[][] = []
    const off = batched(fn => ((emit = fn), () => {}), evs => got.push(evs), 100)
    const n = BATCH_MAX + 50
    for (let i = 0; i < n; i++) emit({ kind: 'done', agentId: `a${i}`, at: i })
    expect(got).toEqual([])
    vi.advanceTimersByTime(100)
    expect(got).toHaveLength(1)
    expect(got[0]).toHaveLength(BATCH_MAX)
    expect(got[0][0]).toMatchObject({ agentId: 'a50' })
    expect(got[0][BATCH_MAX - 1]).toMatchObject({ agentId: `a${n - 1}` })
    off()
    expect(vi.getTimerCount()).toBe(0)
  })
})
