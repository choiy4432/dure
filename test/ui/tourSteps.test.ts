import { describe, it, expect } from 'vitest'
import { nextStep, stepFor, tourAdvance, tourAt, TOUR_ORDER, type TourState, type TourStepId } from '../../src/renderer/tour/tourSteps'
import { TOUR } from '../../src/renderer/lib/words'
import type { UiState } from '../../src/renderer/state/store'
import type { HistoryItem, Room } from '../../src/engine/types'
import type { AgentView } from '../../src/shared/ipcContract'

const room = (id: string): Room => ({ id, name: id, createdAt: 1 })
const agent = (id: string, roomId = 'r1') => ({ id, roomId }) as AgentView
/** tourAdvance 가 읽는 칸만 — 방·에이전트·지금 방·고른 에이전트·기록 */
const ui = (over: Partial<UiState> = {}): UiState =>
  ({ rooms: [], agents: [], roomId: null, selectedAgentId: null, history: {}, ...over }) as UiState
const human = (t = 1): HistoryItem => ({ t, kind: 'user', source: 'human', parts: [{ type: 'text', text: '안녕' }] })
const relayLine = (t = 1): HistoryItem => ({ t, kind: 'user', source: 'relay', parts: [{ type: 'text', text: '넘김' }] })
const tour = (step: TourStepId, base: Partial<NonNullable<TourState>['base']> = {}, replay = false): NonNullable<TourState> => ({
  step, replay, base: { rooms: 0, agents: 0, sent: 0, ...base },
})

describe('stepFor — 단계 모양', () => {
  it('순서 — 환영부터 끝까지', () => {
    expect(TOUR_ORDER).toEqual(['welcome', 'room', 'agent', 'card', 'composer', 'controls', 'todo', 'settings-open', 'settings', 'done'])
  })

  it('번호 — 환영은 없음, 1~6, 설정 둘은 7, 끝은 8(시안 tour-steps-v2)', () => {
    expect(TOUR_ORDER.map(id => stepFor(id, false).n)).toEqual([null, 1, 2, 3, 4, 5, 6, 7, 7, 8])
    expect(TOUR_ORDER.map(id => stepFor(id, true).n)).toEqual([null, 1, 2, 3, 4, 5, 6, 7, 7, 8])
  })

  it('직접 해 보기 단계 — 방·에이전트·입력창·설정 열기, 기다림 문구와 함께', () => {
    expect(stepFor('room', false)).toMatchObject({ kind: 'do', targets: ['new-room'], title: '방을 만들어 보세요', wait: '방을 만들면 넘어가요' })
    expect(stepFor('agent', false)).toMatchObject({ kind: 'do', title: '에이전트를 추가해 보세요', wait: '추가하면 넘어가요' })
    expect(stepFor('agent', false).targets).toContain('add-agent')
    expect(stepFor('composer', false)).toMatchObject({ kind: 'do', targets: ['composer'], title: '일을 시켜 보세요', wait: '보내면 넘어가요' })
    expect(stepFor('settings-open', false)).toMatchObject({ kind: 'do', targets: ['settings-gear'], title: '설정을 열어 보세요', wait: '열면 넘어가요' })
  })

  it('확인 단계·환영·끝', () => {
    expect(stepFor('welcome', false)).toMatchObject({ kind: 'intro', targets: [], title: '두레에 오신 걸 환영해요' })
    expect(stepFor('card', false)).toMatchObject({ kind: 'ok', targets: ['agent-card'], title: '에이전트 카드' })
    expect(stepFor('controls', false)).toMatchObject({ kind: 'ok', targets: ['stop', 'auto'], title: '멈추기 · 자동' })
    expect(stepFor('todo', false)).toMatchObject({ kind: 'ok', targets: ['todo', 'summary'], title: '할 일은 여기 모여요' })
    expect(stepFor('settings', false)).toMatchObject({ kind: 'ok', targets: ['settings-dialog'], title: '설정 안에는', list: TOUR.settings.list })
    expect(stepFor('settings', false).list).toHaveLength(5)
    expect(stepFor('done', false)).toMatchObject({ kind: 'intro', targets: [], title: '준비됐어요' })
    for (const id of TOUR_ORDER) if (stepFor(id, false).kind !== 'do') expect(stepFor(id, false).wait).toBeUndefined()
  })

  it('replay 면 room 이 ok·room-switcher', () => {
    expect(stepFor('room', true)).toEqual({
      id: 'room', kind: 'ok', n: 1, targets: ['room-switcher'],
      title: '방', body: '방은 프로젝트 하나예요. 여기서 방을 고르거나 새로 만들어요.',
    })
    // 에이전트·입력창도 지금 있는 것을 짚는 확인 단계로
    expect(stepFor('agent', true)).toMatchObject({ kind: 'ok', title: '에이전트 추가', body: '에이전트는 역할을 맡은 Claude 하나예요. 여기서 더 추가해요.' })
    expect(stepFor('agent', true).targets).toContain('add-agent-map')
    expect(stepFor('agent', true).wait).toBeUndefined()
    expect(stepFor('composer', true)).toMatchObject({ kind: 'ok', targets: ['composer'], title: '일 시키기', body: '여기에 하고 싶은 일을 쓰고 Enter 를 눌러요.' })
    // 나머지는 그대로
    for (const id of ['welcome', 'card', 'controls', 'todo', 'settings-open', 'settings', 'done'] as const) {
      expect(stepFor(id, true)).toEqual(stepFor(id, false))
    }
  })
})

describe('nextStep', () => {
  it('고른 에이전트가 있으면 순서대로, 끝 다음은 null', () => {
    const seen: TourStepId[] = []
    for (let id: TourStepId | null = 'welcome'; id; id = nextStep(id, { hasAgent: true })) seen.push(id)
    expect(seen).toEqual(TOUR_ORDER)
    expect(nextStep('done', { hasAgent: true })).toBeNull()
  })

  it('에이전트가 없으면 card·composer·controls 건너뜀', () => {
    expect(nextStep('agent', { hasAgent: false })).toBe('todo')
    expect(nextStep('card', { hasAgent: false })).toBe('todo')
    expect(nextStep('composer', { hasAgent: false })).toBe('todo')
    expect(nextStep('room', { hasAgent: false })).toBe('agent')
    expect(nextStep('todo', { hasAgent: false })).toBe('settings-open')
  })
})

describe('tourAdvance — 직접 해 보기 판정', () => {
  it('투어가 없으면 그대로 null', () => {
    expect(tourAdvance(null, ui(), null)).toEqual({ tour: null })
  })

  it('room — 방이 생기면 agent', () => {
    const t = tour('room')
    expect(tourAdvance(t, ui(), null)).toEqual({ tour: t })
    expect(tourAdvance(t, ui(), null).tour).toBe(t) // 바뀐 게 없으면 같은 값
    const s = ui({ rooms: [room('r1')], roomId: 'r1' })
    expect(tourAdvance(t, s, null)).toEqual({ tour: { step: 'agent', replay: false, base: { rooms: 1, agents: 0, sent: 0 } } })
  })

  it('agent — 생기면 card 와 그 에이전트를 고름', () => {
    const t = tour('agent', { rooms: 1, agents: 0 })
    const before = ui({ rooms: [room('r1')], roomId: 'r1' })
    expect(tourAdvance(t, before, null).tour).toBe(t)
    // 새 방 창이 떠 있는 동안에도 같은 판정 — 창 종류는 보지 않는다
    expect(tourAdvance(t, before, 'agent').tour).toBe(t)
    const after = ui({ rooms: [room('r1')], roomId: 'r1', agents: [agent('a1')] })
    expect(tourAdvance(t, after, 'agent')).toEqual({ tour: { step: 'card', replay: false, base: { rooms: 1, agents: 1, sent: 0 } }, select: 'a1' })
  })

  it('agent 가 끝나면 select 에 새 에이전트 — 지금 방에서 가장 늦게 생긴 것(다른 방 것은 아님)', () => {
    const t = tour('agent', { rooms: 2, agents: 1 })
    const s = ui({
      rooms: [room('r1'), room('r2')], roomId: 'r1', selectedAgentId: 'old',
      agents: [agent('old'), agent('x', 'r2'), agent('new'), agent('y', 'r2')],
      history: { new: [human()] },
    })
    const r = tourAdvance(t, s, null)
    expect(r.select).toBe('new')
    expect(r.tour).toEqual({ step: 'card', replay: false, base: { rooms: 2, agents: 2, sent: 1 } }) // base 는 새 에이전트 기준
  })

  it('composer — 사람 말 하나 → controls (다른 에이전트가 넘긴 말은 아님)', () => {
    const t = tour('composer', { rooms: 1, agents: 1, sent: 0 })
    const base = { rooms: [room('r1')], roomId: 'r1', agents: [agent('a1')], selectedAgentId: 'a1' }
    expect(tourAdvance(t, ui(base), null).tour).toBe(t) // 기록을 아직 안 불러왔다
    expect(tourAdvance(t, ui({ ...base, history: { a1: [] } }), null).tour).toBe(t)
    expect(tourAdvance(t, ui({ ...base, history: { a1: [relayLine()] } }), null).tour).toBe(t)
    const r = tourAdvance(t, ui({ ...base, history: { a1: [relayLine(), human(2)] } }), null)
    expect(r).toEqual({ tour: { step: 'controls', replay: false, base: { rooms: 1, agents: 1, sent: 1 } } })
  })

  it('composer — 단계를 시작할 때 이미 있던 말은 세지 않는다', () => {
    const t = tour('composer', { rooms: 1, agents: 1, sent: 2 })
    const s = (n: number) => ui({ rooms: [room('r1')], roomId: 'r1', agents: [agent('a1')], selectedAgentId: 'a1', history: { a1: Array.from({ length: n }, (_, i) => human(i)) } })
    expect(tourAdvance(t, s(2), null).tour).toBe(t)
    expect(tourAdvance(t, s(3), null).tour?.step).toBe('controls')
  })

  it('settings-open — 설정 창이 열리면 settings', () => {
    const t = tour('settings-open', { rooms: 1, agents: 1 })
    const s = ui({ rooms: [room('r1')], roomId: 'r1', agents: [agent('a1')], selectedAgentId: 'a1' })
    expect(tourAdvance(t, s, null).tour).toBe(t)
    expect(tourAdvance(t, s, 'room').tour).toBe(t)
    expect(tourAdvance(t, s, 'settings')).toEqual({ tour: { step: 'settings', replay: false, base: { rooms: 1, agents: 1, sent: 0 } } })
  })

  it('settings — 창이 닫히면 done', () => {
    const t = tour('settings', { rooms: 1, agents: 1 })
    const s = ui({ rooms: [room('r1')], roomId: 'r1', agents: [agent('a1')], selectedAgentId: 'a1' })
    expect(tourAdvance(t, s, 'settings').tour).toBe(t)
    expect(tourAdvance(t, s, null)).toEqual({ tour: { step: 'done', replay: false, base: { rooms: 1, agents: 1, sent: 0 } } })
  })

  it('확인 단계·환영·끝은 저절로 넘어가지 않는다', () => {
    const s = ui({ rooms: [room('r1')], roomId: 'r1', agents: [agent('a1')], selectedAgentId: 'a1', history: { a1: [human()] } })
    for (const step of ['welcome', 'card', 'controls', 'todo', 'done'] as const) {
      const t = tour(step)
      expect(tourAdvance(t, s, null).tour).toBe(t)
    }
  })

  it('다시 보기 — room·agent·composer 는 확인 단계라 방·에이전트·말이 늘어도 그대로', () => {
    const s = ui({ rooms: [room('r1'), room('r2')], roomId: 'r1', agents: [agent('a1'), agent('a2')], selectedAgentId: 'a1', history: { a1: [human(), human()] } })
    for (const step of ['room', 'agent', 'composer'] as const) {
      const t = tour(step, {}, true)
      expect(tourAdvance(t, s, null).tour).toBe(t)
    }
    // 설정 두 단계는 다시 보기여도 창으로 넘어간다
    expect(tourAdvance(tour('settings-open', {}, true), s, 'settings').tour).toMatchObject({ step: 'settings', replay: true })
  })
})

describe('tourAdvance — 짚던 것이 사라지면', () => {
  it('방이 사라지면 room 단계로', () => {
    const empty = ui()
    for (const step of ['agent', 'card', 'composer', 'controls', 'todo', 'settings-open', 'settings', 'done'] as const) {
      expect(tourAdvance(tour(step, { rooms: 1, agents: 1 }), empty, null)).toEqual({ tour: { step: 'room', replay: false, base: { rooms: 0, agents: 0, sent: 0 } } })
    }
    // 다시 보기여도 짚을 방 단추가 없다 — 직접 만드는 단계로
    expect(tourAdvance(tour('todo', { rooms: 1 }, true), empty, null).tour).toEqual({ step: 'room', replay: false, base: { rooms: 0, agents: 0, sent: 0 } })
    expect(tourAdvance(tour('room', { rooms: 1 }, true), empty, null).tour).toEqual({ step: 'room', replay: false, base: { rooms: 0, agents: 0, sent: 0 } })
    // 환영·직접 만드는 room 은 그대로
    const w = tour('welcome')
    expect(tourAdvance(w, empty, null).tour).toBe(w)
    const r = tour('room')
    expect(tourAdvance(r, empty, null).tour).toBe(r)
  })

  it('카드·입력창·멈추기 단계에서 방에 에이전트가 없어지면 agent 단계로', () => {
    const s = ui({ rooms: [room('r1')], roomId: 'r1', agents: [agent('z', 'r2')] })
    for (const step of ['card', 'composer', 'controls'] as const) {
      expect(tourAdvance(tour(step, { rooms: 1, agents: 1 }), s, null)).toEqual({ tour: { step: 'agent', replay: false, base: { rooms: 1, agents: 0, sent: 0 } } })
    }
  })

  it('고른 에이전트만 사라지면 그 방의 가장 늦게 생긴 에이전트를 다시 고르고 그 단계 그대로', () => {
    const s = ui({ rooms: [room('r1')], roomId: 'r1', agents: [agent('a1'), agent('a2')], selectedAgentId: 'gone', history: { a2: [human()] } })
    expect(tourAdvance(tour('composer', { rooms: 1, agents: 3, sent: 0 }), s, null)).toEqual({
      tour: { step: 'composer', replay: false, base: { rooms: 1, agents: 2, sent: 1 } }, select: 'a2',
    })
  })
})

describe('tourAt', () => {
  it('지금 값으로 base 를 잰다 — 에이전트를 주면 그 에이전트의 사람 말 수', () => {
    const s = ui({ rooms: [room('r1')], roomId: 'r1', agents: [agent('a1'), agent('a2')], selectedAgentId: 'a1', history: { a1: [human(), relayLine()], a2: [human(), human()] } })
    expect(tourAt('card', false, s)).toEqual({ step: 'card', replay: false, base: { rooms: 1, agents: 2, sent: 1 } })
    expect(tourAt('card', true, s, 'a2')).toEqual({ step: 'card', replay: true, base: { rooms: 1, agents: 2, sent: 2 } })
  })
})
