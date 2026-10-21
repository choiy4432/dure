import { describe, it, expect } from 'vitest'
import { buildSubagentTree } from '../../src/renderer/state/subagents'
import type { HistoryItem } from '../../src/engine/types'

const human = (text: string, t = 1): HistoryItem => ({ t, kind: 'user', source: 'human', parts: [{ type: 'text', text }] })
const relay = (text: string, t = 1): HistoryItem => ({ t, kind: 'user', source: 'relay', parts: [{ type: 'text', text }] })
const asst = (blocks: any[], t = 2, parent?: string): HistoryItem => ({ t, kind: 'assistant', blocks, ...(parent ? { parent } : {}) })
const agent = (id: string, description = '조사') => ({ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'p' } })
const read = (id: string, f = 'f.ts') => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `/x/${f}` } })
const start = (id: string, parentTaskId: string | null = null, t = 3): HistoryItem => ({
  t, kind: 'subagent-start', toolUseId: id, taskId: `task-${id}`, description: `설명 ${id}`, subagentType: null, parentTaskId,
})
const end = (id: string, status: 'completed' | 'failed' | 'stopped' = 'completed', summary = '보고 글', t = 9): HistoryItem => ({
  t, kind: 'subagent-end', toolUseId: id, taskId: `task-${id}`, status, summary, toolUses: 5, durationMs: 4000,
})
const result = (id: string, text = 'ok', isError = false, parent?: string): HistoryItem => ({
  t: 5, kind: 'tool-result', toolUseId: id, isError, text, viaApproval: false, ...(parent ? { parent } : {}),
})
const turnEnd: HistoryItem = { t: 10, kind: 'result', ok: true, subtype: 'success' }

describe('buildSubagentTree', () => {
  it('차례 셋 — 사람 말·받은 메시지·스스로 시작', () => {
    const { turns } = buildSubagentTree(
      [
        human('첫 부탁\n둘째 줄'),
        asst([agent('A')]),
        start('A'),
        end('A'),
        turnEnd,
        relay('[두레 메시지 — 보낸 쪽: 기획(PM)]\n자료 부탁'),
        asst([agent('B')]),
        start('B'),
        end('B'),
        turnEnd,
        asst([agent('C')]),
        start('C'),
        end('C'),
      ],
      new Set(),
    )
    expect(turns.map((t) => t.key)).toEqual(['A', 'B', 'C'])
    expect(turns[0].opener).toEqual({ kind: 'human', text: '첫 부탁\n둘째 줄', from: '' })
    expect(turns[1].opener).toEqual({ kind: 'relay', text: '자료 부탁', from: '기획' })
    expect(turns[2].opener.kind).toBe('auto')
  })

  it('같은 차례의 노드는 한 차례에 모인다', () => {
    const { turns, total } = buildSubagentTree([human('x'), asst([agent('A'), agent('B')]), start('A'), start('B')], new Set(['A', 'B']))
    expect(turns).toHaveLength(1)
    expect(turns[0].nodes.map((n) => n.id)).toEqual(['A', 'B'])
    expect(total).toBe(2)
  })

  it('안쪽 노드는 parentTaskId 로 자식이 되고, 줄이 없으면 hidden, total·running 은 안쪽까지', () => {
    const { turns, total, running } = buildSubagentTree(
      [
        human('x'),
        asst([agent('A')]),
        start('A'),
        asst([{ type: 'text', text: '손주를 맡길게' }, agent('B')], 4, 'A'),
        start('B', 'task-A'),
        asst([agent('C')], 4, 'A'),
        start('C', 'task-A'),
        end('C'),
      ],
      new Set(['A', 'B']),
    )
    const a = turns[0].nodes[0]
    expect(a.children.map((c) => c.id)).toEqual(['B', 'C'])
    expect(a.children[0]).toMatchObject({ hidden: true, status: 'running', steps: [] })
    expect(a.hidden).toBe(false)
    expect(a.steps).toEqual([{ type: 'text', text: '손주를 맡길게' }])
    expect(total).toBe(3)
    expect(running).toBe(2)
  })

  it('끝 기록 없음 + running 비어 있음 = 끊김, running 에 있으면 도는 중', () => {
    const items = [human('x'), asst([agent('A'), agent('B')]), start('A'), start('B')]
    const lost = buildSubagentTree(items, new Set()).turns[0].nodes
    expect(lost.map((n) => n.status)).toEqual(['lost', 'lost'])
    const live = buildSubagentTree(items, new Set(['A'])).turns[0].nodes
    expect(live.map((n) => n.status)).toEqual(['running', 'lost'])
  })

  it('last·toolUses·report·steps — 끝 기록의 값이 우선', () => {
    const { turns } = buildSubagentTree(
      [
        human('x'),
        asst([agent('A')]),
        start('A'),
        asst([{ type: 'text', text: '봅니다' }, read('r1', 'a.ts')], 4, 'A'),
        result('r1', 'AAA', false, 'A'),
        asst([read('r2', 'b.ts')], 5, 'A'),
        end('A', 'completed', '다 봤어요'),
      ],
      new Set(),
    )
    const n = turns[0].nodes[0]
    expect(n.steps.map((s) => s.type)).toEqual(['text', 'act', 'act'])
    expect(n.last).toMatchObject({ id: 'r2', verb: '읽음', target: 'b.ts', pending: true })
    expect(n.toolUses).toBe(5)
    expect(n.report).toBe('다 봤어요')
    expect(n).toMatchObject({ status: 'done', taskId: 'task-A', description: '설명 A', startedAt: 3, endedAt: 9 })
  })

  it('끝 기록이 없으면 도구 수는 센 수, 빈 보고는 null', () => {
    const { turns } = buildSubagentTree([human('x'), asst([agent('A')]), start('A'), asst([read('r1'), read('r2')], 4, 'A'), end('A', 'stopped', '')], new Set())
    expect(turns[0].nodes[0]).toMatchObject({ status: 'stopped', report: null, toolUses: 5 })
    const open = buildSubagentTree([human('x'), asst([agent('A')]), start('A'), asst([read('r1'), read('r2')], 4, 'A')], new Set(['A']))
    expect(open.turns[0].nodes[0].toolUses).toBe(2)
  })

  it('멈춘 뒤에 도착한 parent 결과는 걸음에 붙고 상태는 그대로', () => {
    const { turns } = buildSubagentTree(
      [human('x'), asst([agent('A')]), start('A'), asst([read('r1')], 4, 'A'), end('A', 'stopped'), result('r1', '늦은 결과', false, 'A')],
      new Set(),
    )
    const n = turns[0].nodes[0]
    expect(n.status).toBe('stopped')
    expect(n.last).toMatchObject({ id: 'r1', output: '늦은 결과', allowed: true })
    expect(n.last?.pending).toBeUndefined()
  })

  it('옛 기록(시작 없음) — 결과로 상태, 보고 없음, 안내 글은 어디에도 없다', () => {
    const { turns } = buildSubagentTree(
      [human('x'), asst([agent('A'), agent('B')]), result('A', 'Async agent launched…'), result('B', '[Subagent hand-back] x', true)],
      new Set(),
    )
    const [a, b] = turns[0].nodes
    expect(a).toMatchObject({ status: 'done', report: null, taskId: null, startedAt: null, description: '조사', hidden: false })
    expect(b.status).toBe('failed')
    expect(JSON.stringify(turns)).not.toMatch(/Async agent launched|Subagent hand-back/)
  })

  it('boundary 앞 기록은 버린다', () => {
    const { turns, total } = buildSubagentTree([human('x'), asst([agent('A')]), start('A'), { t: 5, kind: 'boundary' }, human('y'), asst([agent('B')]), start('B')], new Set(['B']))
    expect(turns.map((t) => t.key)).toEqual(['B'])
    expect(total).toBe(1)
  })
})
