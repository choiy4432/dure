// 휴대폰 방 고르기의 재료 — 순수 모듈(화면·스토어를 import 하지 않는다). 기다리는 일 줄 · 방 줄의 수 · 연결된 PC 이름 · 받은 시각
import type { AgentId, PendingRequest, RelayMessage, RemoteIssue, Room, RoomId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { displayStatus, shownIssue } from '../state/selectors'

/** 기다리는 까닭 — 도구·계획·새 에이전트 승인 · 질문 · 에이전트끼리 넘기는 일(넘기는 메시지·이어 보내기 한도·붙잡힌 입력) · 서버 방 문제 */
export type WaitKind = 'approval' | 'question' | 'handoff' | 'remote'

/** 줄의 말 — 휴대폰 알림(main 의 phoneNotifier)과 같은 말 */
export const WAIT_WORD: Record<Exclude<WaitKind, 'remote'>, string> = {
  approval: '승인을 기다려요',
  question: '답을 기다려요',
  handoff: '넘기기 승인을 기다려요',
}

/** 서버 방 문제의 짧은 말 — 긴 글(remoteIssueText)은 대화의 안내 띠에 */
export function remoteWord(issue: RemoteIssue): string {
  if (issue.kind === 'disconnected') return '서버 연결이 끊겼어요'
  if (issue.kind === 'login') return '서버 로그인이 만료됐어요'
  return '서버에 문제가 있어요'
}

export interface WaitRow {
  agentId: AgentId
  name: string
  roomId: RoomId
  roomName: string
  kind: WaitKind
  what: string
  /** 기다리기 시작한 때 — 오래된 것이 위. 서버 문제는 때를 몰라 맨 뒤(에이전트 차례대로) */
  at: number
  /** 넘기는 메시지만 기다린다 — 대화의 메시지 탭에서 승인한다 */
  messagesOnly: boolean
}

interface Input {
  rooms: Room[]
  agents: AgentView[]
  requests: PendingRequest[]
  messages: RelayMessage[]
}

const LAST = Number.MAX_SAFE_INTEGER

/**
 * 기다리는 일 — 에이전트마다 한 줄(가장 급한 까닭 하나): 승인·질문 → 넘기기 → 서버 문제.
 * 넘기기 = 그 에이전트가 받을 넘기는 메시지(pending) · 이어 보내기 한도에 걸린 메시지(held) · 붙잡힌 입력(hold)
 */
export function waitingRows(s: Input): WaitRow[] {
  const rooms = new Map(s.rooms.map(r => [r.id, r]))
  const out: WaitRow[] = []
  for (const a of s.agents) {
    const room = rooms.get(a.roomId)
    if (!room) continue
    const base = { agentId: a.id, name: a.name, roomId: room.id, roomName: room.name, messagesOnly: false }
    const asks = s.requests.filter(r => r.agentId === a.id).sort((x, y) => x.createdAt - y.createdAt)
    if (asks.length > 0) {
      const kind = asks[0].kind === 'question' ? 'question' : 'approval'
      out.push({ ...base, kind, what: WAIT_WORD[kind], at: asks[0].createdAt })
      continue
    }
    const pending = s.messages.filter(m => m.to === a.id && m.roomId === a.roomId && m.state === 'pending')
    const held = s.messages.filter(m => m.to === a.id && m.roomId === a.roomId && m.state === 'held')
    if (pending.length > 0 || held.length > 0 || a.hold) {
      const times = [...pending, ...held].map(m => m.createdAt)
      if (a.hold) times.push(a.hold.since)
      out.push({ ...base, kind: 'handoff', what: WAIT_WORD.handoff, at: Math.min(...times), messagesOnly: held.length === 0 && !a.hold })
      continue
    }
    const issue = room.remote ? shownIssue(a, s.requests) : null
    if (issue) out.push({ ...base, kind: 'remote', what: remoteWord(issue), at: LAST })
  }
  // 같은 때면 에이전트 차례 그대로(sort 는 안정)
  return out.sort((x, y) => x.at - y.at)
}

export interface RoomLine {
  agents: number
  working: number
  /** 승인·질문·넘기기를 기다리는 에이전트 수(서버 문제는 따로) */
  waiting: number
  /** 서버 방 문제가 보이는 에이전트가 있다 */
  issue: boolean
}

/** 방 줄의 수 — 에이전트 N개 · 일하는 중 N · 기다림 N · 서버 문제 */
export function roomLine(s: Input, roomId: RoomId, rows: WaitRow[]): RoomLine {
  const here = s.agents.filter(a => a.roomId === roomId)
  return {
    agents: here.length,
    working: here.filter(a => displayStatus(a, s.requests) === 'working').length,
    waiting: rows.filter(r => r.roomId === roomId && r.kind !== 'remote').length,
    issue: rows.some(r => r.roomId === roomId && r.kind === 'remote'),
  }
}

/**
 * 연결된 PC 이름 — 휴대폰 주소의 첫 칸(Tailscale 이 PC 이름으로 만든 <PC이름>.<tailnet>.ts.net). IP·localhost 면 '내 PC'
 */
export function pcName(hostname: string): string {
  const h = hostname.trim()
  if (!h || h === 'localhost' || h.includes(':') || /^[\d.]+$/.test(h)) return '내 PC'
  return h.split('.')[0] || '내 PC'
}

const CLOCK = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' })

/** 받은 시각 — '오전 9:41' */
export function clockText(at: number): string {
  return CLOCK.format(at)
}
