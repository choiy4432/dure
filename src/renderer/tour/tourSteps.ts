// 안내 투어의 단계 — 모양(짚는 곳·문구)과 넘어가는 판정. React·스토어 없이 값만(설계 4.3 · 시안 tour-steps-v2)

import type { AgentId } from '../../engine/types'
import { TOUR } from '../lib/words'
import type { UiState } from '../state/store'

export type TourStepId = 'welcome' | 'room' | 'agent' | 'card' | 'composer' | 'controls' | 'todo' | 'settings-open' | 'settings' | 'done'

/**
 * 투어 카드 한 장 — kind: intro = 짚는 곳 없이 화면 전체(환영·끝) · do = 짚은 것을 직접 해야 넘어감 · ok = [확인했어요].
 * n = 카드 위 'n / 8'(없으면 null) · targets = 짚을 요소의 data-tour 값(있는 것만 합쳐 짚는다) · wait = do 단계의 '…하면 넘어가요'
 */
export type TourStep = {
  id: TourStepId
  kind: 'intro' | 'do' | 'ok'
  n: number | null
  targets: string[] /* data-tour 값 */
  title: string
  body: string
  list?: string[]
  wait?: string
}

/**
 * 진행 중인 투어 — 없으면 null. replay = 설정의 '안내 다시 보기'(방·에이전트가 이미 있다).
 * base = 그 단계를 시작할 때 잰 값(방 수 · 지금 방의 에이전트 수 · 고른 에이전트의 사람 말 수) — 직접 해 보기는 이보다 늘면 끝난다
 */
export type TourState = { step: TourStepId; replay: boolean; base: { rooms: number; agents: number; sent: number } } | null

export const TOUR_ORDER: TourStepId[] = ['welcome', 'room', 'agent', 'card', 'composer', 'controls', 'todo', 'settings-open', 'settings', 'done']

/** 고른 에이전트가 있어야 짚을 수 있는 단계 — 카드·입력창·멈추기와 자동 */
const AGENT_STEPS: ReadonlySet<TourStepId> = new Set(['card', 'composer', 'controls'])

/** 번호 — 시안 그대로: 설정 열기와 설정 안은 한 번호(7), 끝이 8. 환영은 없음 */
const NUMBER: Record<TourStepId, number | null> = {
  welcome: null, room: 1, agent: 2, card: 3, composer: 4, controls: 5, todo: 6, 'settings-open': 7, settings: 7, done: 8,
}

/**
 * 에이전트 추가 단추 — 빈 방의 '추가'(add-agent)와 관계도 오른쪽 아래(add-agent-map)는 한쪽만 보인다.
 * 둘 다 짚어 두면 방에 에이전트가 있든 없든 보이는 쪽을 짚는다(없어서 기다리기만 하지 않게)
 */
const ADD_AGENT = ['add-agent', 'add-agent-map']
const ADD_AGENT_REPLAY = ['add-agent-map', 'add-agent']

/** 그 단계의 카드 — replay 면 방·에이전트·입력창이 지금 있는 것을 짚는 [확인했어요] 단계(다른 짚는 곳·문구) */
export function stepFor(id: TourStepId, replay: boolean): TourStep {
  const n = NUMBER[id]
  switch (id) {
    case 'welcome':
      return { id, kind: 'intro', n, targets: [], ...TOUR.welcome }
    case 'room':
      return replay
        ? { id, kind: 'ok', n, targets: ['room-switcher'], ...TOUR.replay.room }
        : { id, kind: 'do', n, targets: ['new-room'], ...TOUR.room }
    case 'agent':
      return replay
        ? { id, kind: 'ok', n, targets: [...ADD_AGENT_REPLAY], ...TOUR.replay.agent }
        : { id, kind: 'do', n, targets: [...ADD_AGENT], ...TOUR.agent }
    case 'card':
      return { id, kind: 'ok', n, targets: ['agent-card'], ...TOUR.card }
    case 'composer':
      return replay
        ? { id, kind: 'ok', n, targets: ['composer'], ...TOUR.replay.composer }
        : { id, kind: 'do', n, targets: ['composer'], ...TOUR.composer }
    case 'controls':
      return { id, kind: 'ok', n, targets: ['stop', 'auto'], ...TOUR.controls }
    case 'todo':
      return { id, kind: 'ok', n, targets: ['todo', 'summary'], ...TOUR.todo }
    case 'settings-open':
      return { id, kind: 'do', n, targets: ['settings-gear'], ...TOUR.settingsOpen }
    case 'settings':
      return { id, kind: 'ok', n, targets: ['settings-dialog'], title: TOUR.settings.title, body: '', list: [...TOUR.settings.list] }
    case 'done':
      return { id, kind: 'intro', n, targets: [], ...TOUR.done }
  }
}

/** 다음 단계 — 고른 에이전트가 없으면 카드·입력창·멈추기를 건너뛴다. 끝 다음은 null */
export function nextStep(id: TourStepId, ctx: { hasAgent: boolean }): TourStepId | null {
  for (let i = TOUR_ORDER.indexOf(id) + 1; i < TOUR_ORDER.length; i++) {
    const next = TOUR_ORDER[i]
    if (!ctx.hasAgent && AGENT_STEPS.has(next)) continue
    return next
  }
  return null
}

/** 지금 방의 에이전트 — 만든 순서(엔진이 붙인 순서 그대로라 끝이 가장 늦게 생긴 것) */
const roomAgents = (s: UiState) => (s.roomId === null ? [] : s.agents.filter(a => a.roomId === s.roomId))

/** 그 에이전트에게 사람이 보낸 말 수 — 기록을 아직 안 불러왔으면 0. 다른 에이전트가 넘긴 말(relay)은 세지 않는다 */
const sentBy = (s: UiState, id: AgentId | null) =>
  id === null ? 0 : (s.history[id] ?? []).filter(it => it.kind === 'user' && it.source === 'human').length

/** 그 단계를 지금 시작한다 — base 를 지금 값으로 잰다(agentId 를 주면 그 에이전트의 말 수, 아니면 고른 에이전트) */
export function tourAt(step: TourStepId, replay: boolean, s: UiState, agentId: AgentId | null = s.selectedAgentId): NonNullable<TourState> {
  return { step, replay, base: { rooms: s.rooms.length, agents: roomAgents(s).length, sent: sentBy(s, agentId) } }
}

/**
 * 상태가 바뀔 때마다(창이 열리고 닫힘 포함) — 직접 해 보기가 끝났으면 다음 단계로, 짚던 것이 사라졌으면 알맞은 단계로.
 * 바뀐 게 없으면 받은 t 그대로. select = 골라야 할 에이전트(agent 단계가 끝남 · 고른 에이전트가 사라짐)
 */
export function tourAdvance(t: TourState, s: UiState, dialog: string | null): { tour: TourState; select?: AgentId } {
  if (!t) return { tour: null }
  // 방이 다 사라졌다 — 방 만들기부터. 다시 보기여도 짚을 방 단추가 없으니 직접 만드는 단계로
  if (s.rooms.length === 0 && t.step !== 'welcome' && (t.step !== 'room' || t.replay)) return { tour: tourAt('room', false, s) }
  const inRoom = roomAgents(s)
  const selected = inRoom.some(a => a.id === s.selectedAgentId) ? s.selectedAgentId : null
  // 카드·입력창·멈추기를 짚는데 고른 에이전트가 없다 — 방에 에이전트가 없으면 추가부터, 있으면 가장 늦게 생긴 것을 다시 고른다
  if (AGENT_STEPS.has(t.step) && selected === null) {
    if (inRoom.length === 0) return { tour: tourAt('agent', t.replay, s) }
    const pick = inRoom[inRoom.length - 1].id
    return { tour: tourAt(t.step, t.replay, s, pick), select: pick }
  }
  const doing = stepFor(t.step, t.replay).kind === 'do'
  let finished = false
  switch (t.step) {
    case 'room': finished = doing && s.rooms.length > t.base.rooms; break
    case 'agent': finished = doing && inRoom.length > t.base.agents; break
    case 'composer': finished = doing && sentBy(s, selected) > t.base.sent; break
    case 'settings-open': finished = dialog === 'settings'; break
    // 설정 안 — [확인했어요]는 카드만 닫고, 사용자가 설정 창을 닫으면 끝
    case 'settings': finished = dialog !== 'settings'; break
  }
  if (!finished) return { tour: t }
  if (t.step === 'agent') {
    // 새 에이전트를 골라 패널을 연다 — 지금 방에서 가장 늦게 생긴 것
    const pick = inRoom[inRoom.length - 1].id
    return { tour: tourAt(nextStep('agent', { hasAgent: true })!, t.replay, s, pick), select: pick }
  }
  const next = nextStep(t.step, { hasAgent: selected !== null })
  return { tour: next === null ? null : tourAt(next, t.replay, s) }
}
