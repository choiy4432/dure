import type { AgentId, EngineEventMap, RoomId } from '../../engine/types'
import type { PhoneDevice, PhoneSettings } from '../../shared/phoneTypes'
import { ASK_DELIVERY, FINISHED_DELIVERY, type Push, type PhoneNotice, type PushDelivery } from './push'

// 휴대폰 알림 판단 — main 이 엔진 사건을 직접 듣는다(창이 숨어 있거나 없어도 울려야 한다, 설계 §4.5).
// PC 의 Windows 알림(렌더러 useAttention)은 그대로 두고, 휴대폰에 필요한 규칙만 여기 따로 둔다.
// 🔴 알림 글은 '<에이전트 이름> · <짧은 말>' 뿐 — 명령·파일 경로·질문·메시지 글은 넣지 않는다

/** 알림 종류 — tag 에 들어간다 */
export type NoticeKind = 'approval' | 'question' | 'handoff' | 'finished'

/** 본문의 말(해요체) — 승인·질문·넘기기는 notify.asks, 끝남은 notify.finished */
export const NOTICE_WORDS: Readonly<Record<NoticeKind, string>> = Object.freeze({
  approval: '승인을 기다려요',
  question: '답을 기다려요',
  handoff: '넘기기 승인을 기다려요',
  finished: '일을 마쳤어요',
})

/** 이 판단이 엔진에서 쓰는 것 — 진짜 Engine 이 그대로 맞는다 */
export interface NotifierEngine {
  on(name: string, fn: (payload: any) => void): unknown
  off(name: string, fn: (payload: any) => void): unknown
  agents(): { id: AgentId; name: string }[]
  /** 보낼 차례를 기다리는 내 입력 수 — 있으면 차례가 끝나도 곧 다음 일을 한다 */
  heldInput(id: AgentId): number
}

export interface PhoneNotifierOptions {
  engine: NotifierEngine
  settings: () => PhoneSettings
  /** 짝 맺은 기기 — push(알림 구독 있음)인 것에만 보낸다 */
  devices: () => PhoneDevice[]
  /** PC 를 쓰고 있다(Windows 마지막 입력 뒤 2분 안 · 잠금 아님) — 그러면 휴대폰은 안 울린다. 못 읽으면(던지면) 안 쓰는 중으로 친다 */
  isPcInUse: () => boolean
  /** 그 기기가 지금 두레 화면을 보고 있다 — 그 기기엔 안 보낸다 */
  isVisible: (deviceId: string) => boolean
  push: Pick<Push, 'sendTo'>
  /** 기본 console.error — 알림 글·오류 글은 싣지 않는다 */
  log?: (...args: unknown[]) => void
  /** tag 번호의 시작(기본 Date.now — 두레를 다시 켜도 앞의 tag 와 겹치지 않게) */
  now?: () => number
}

/** 알림 하나의 글 — 네 칸만. url 의 에이전트 id 는 주소 조각으로 옮긴다 */
export function phoneNotice(agent: { id: AgentId; name: string }, kind: NoticeKind, seq: number): PhoneNotice {
  return {
    title: '두레',
    body: `${agent.name} · ${NOTICE_WORDS[kind]}`,
    tag: `dure-${agent.id}-${kind}-${seq}`,
    url: `/#agent=${encodeURIComponent(agent.id)}`,
  }
}

/**
 * 무엇이 울리나(같은 기다림은 한 번만 — 안 보낸 판단도 한 번으로 친다):
 * - 'request' 새 도구 승인·계획·에이전트 만들기 → 승인을 기다려요 · 질문 → 답을 기다려요(요청 id 로 한 번, 풀리면 잊는다)
 * - 'message' pending(넘기는 메시지 승인 기다림, 받는 에이전트) → 넘기기 승인을 기다려요(메시지 id 로 한 번)
 * - 'message' held(이어 보내기 한도) → 넘기기 승인을 기다려요 — 방마다 묶음 하나(한 번에 풀어 준다). 그 방에 걸린 게 다 풀린 뒤 다시 걸리면 또
 * - 'hold' 붙잡힌 입력 → 넘기기 승인을 기다려요 — 붙잡힐 때 한 번(항목이 늘어도 다시 안 울림), 풀린 뒤 다시 붙잡히면 또
 * - 'history' result(차례 끝) → 일을 마쳤어요 — 기다리던 내 입력이 남았으면(곧 다음 일을 한다) 안 보낸다
 * 안 보내는 때: 휴대폰으로 쓰기 꺼짐 · 그 종류의 알림 꺼짐 · PC 쓰는 중 · 그 기기가 화면을 보는 중 · 모르는 에이전트
 */
export function createPhoneNotifier(o: PhoneNotifierOptions): { dispose(): void } {
  const log = o.log ?? console.error
  let seq = Math.max(0, Math.floor((o.now ?? Date.now)()))
  let disposed = false

  const asked = new Set<string>() // 알린(또는 판단한) 요청 id — 풀리면 뺀다
  const pendingSeen = new Set<string>() // 알린 pending 메시지 id — pending 이 아니게 되면 뺀다
  const heldByRoom = new Map<RoomId, Set<string>>() // 방마다 지금 held 인 메시지 id
  const holding = new Set<AgentId>() // 지금 붙잡혀 있는 에이전트
  const lastResult = new Map<AgentId, number>() // 에이전트마다 마지막으로 본 차례 끝의 시각

  const pcInUse = (): boolean => {
    try {
      return o.isPcInUse()
    } catch {
      return false // 못 읽으면 보낸다 — 자리를 비웠을 수 있다
    }
  }

  /** 한 번 판단 — 켜져 있고, 그 종류가 켜져 있고, PC 를 안 쓰고 있으면 화면을 안 보는 기기마다 보낸다 */
  const notify = (agentId: AgentId, kind: NoticeKind) => {
    const s = o.settings()
    if (!s.enabled) return
    if (kind === 'finished' ? !s.notify.finished : !s.notify.asks) return
    const agent = o.engine.agents().find((a) => a.id === agentId)
    if (!agent) return // 누를 곳이 없다
    if (pcInUse()) return
    const targets = o.devices().filter((d) => d.push && !o.isVisible(d.id))
    if (targets.length === 0) return
    const notice = phoneNotice(agent, kind, ++seq)
    const delivery: PushDelivery = kind === 'finished' ? FINISHED_DELIVERY : ASK_DELIVERY
    for (const d of targets) {
      void Promise.resolve()
        .then(() => o.push.sendTo(d.id, notice, delivery))
        .catch(() => log('[두레] 휴대폰 알림을 보내지 못했어요'))
    }
  }

  /** 엔진의 emit 안에서 돈다 — 무엇이 던져도 엔진으로 넘기지 않는다(로그엔 내용 없이) */
  const guarded = <K extends keyof EngineEventMap>(fn: (p: EngineEventMap[K]) => void) => (p: EngineEventMap[K]) => {
    if (disposed) return
    try {
      fn(p)
    } catch {
      log('[두레] 휴대폰 알림을 판단하지 못했어요')
    }
  }

  const handlers: { [K in keyof EngineEventMap]?: (p: EngineEventMap[K]) => void } = {
    request: guarded<'request'>((r) => {
      if (asked.has(r.id)) return
      asked.add(r.id)
      notify(r.agentId, r.kind === 'question' ? 'question' : 'approval')
    }),

    'request-resolved': guarded<'request-resolved'>((r) => {
      asked.delete(r.id)
    }),

    message: guarded<'message'>((m) => {
      if (m.state === 'pending') {
        if (!pendingSeen.has(m.id)) {
          pendingSeen.add(m.id)
          notify(m.to, 'handoff')
        }
      } else pendingSeen.delete(m.id)

      const held = heldByRoom.get(m.roomId) ?? new Set<string>()
      if (m.state === 'held') {
        const first = held.size === 0
        held.add(m.id)
        heldByRoom.set(m.roomId, held)
        if (first) notify(m.to, 'handoff')
      } else if (held.delete(m.id) && held.size === 0) heldByRoom.delete(m.roomId)
    }),

    hold: guarded<'hold'>(({ agentId, hold }) => {
      if (!hold) {
        holding.delete(agentId)
        return
      }
      if (holding.has(agentId)) return
      holding.add(agentId)
      notify(agentId, 'handoff')
    }),

    history: guarded<'history'>(({ agentId, item }) => {
      if (item.kind !== 'result' || lastResult.get(agentId) === item.t) return
      lastResult.set(agentId, item.t)
      if (o.engine.heldInput(agentId) > 0) return // 곧 기다리던 내 입력을 보낸다 — 아직 안 끝났다
      notify(agentId, 'finished')
    }),
  }

  for (const [name, fn] of Object.entries(handlers)) o.engine.on(name, fn)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const [name, fn] of Object.entries(handlers)) o.engine.off(name, fn)
      asked.clear()
      pendingSeen.clear()
      heldByRoom.clear()
      holding.clear()
      lastResult.clear()
    },
  }
}
