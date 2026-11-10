// 찾기 · 옮기기(Ctrl+K)의 '에이전트 · 방' 묶음 — 이름·역할·폴더로 에이전트를, 이름으로 방을 찾는다(화면 안에서, 엔진을 부르지 않는다)

import type { AgentId, Room, RoomId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'

/** 찾기 비교 꼴 — 전각·반각(NFKC) · 대소문자 무시(엔진의 대화 찾기와 같은 규칙) */
export const fold = (s: string): string => s.normalize('NFKC').toLocaleLowerCase('ko')

/** 글자 수(코드 포인트) — 대화 찾기는 두 글자부터 */
export const charCount = (s: string): number => Array.from(s).length

/** 맞은 곳 — range 는 원래 글 안의 [시작, 끝). 접은 꼴의 길이가 달라지는 글(합자 등)은 자리를 옮길 수 없어 null(맞았지만 강조 없음) */
export interface Found {
  range: [number, number] | null
  /** 맨 앞에서 맞았다 — 이름이 앞부터 맞는 쪽을 먼저 */
  prefix: boolean
}

/** text 에서 fq(접은 찾을 말)가 맞은 곳 — 안 맞으면 null */
export function foundIn(text: string, fq: string): Found | null {
  if (!fq) return null
  const ft = fold(text)
  const at = ft.indexOf(fq)
  if (at < 0) return null
  return { range: ft.length === text.length ? [at, at + fq.length] : null, prefix: at === 0 }
}

export type NameRow =
  | { kind: 'agent'; agent: AgentView; room: Room | null; name: Found | null; role: Found | null; folder: Found | null }
  | { kind: 'room'; room: Room; agents: number; name: Found | null }

/** 묶음 이름의 갈래 — 빈 입력이면 최근 고른 에이전트(없으면 이 방 에이전트), 아니면 맞은 것 */
export type NamesTitle = 'recent' | 'room' | 'match'

const AGENTS_MAX = 8
const ROOMS_MAX = 5
const RECENT_SHOWN = 5

/**
 * 에이전트 · 방 묶음 — q(다듬은 찾을 말)가 비면 최근 고른 에이전트 몇 개(고른 적이 없으면 지금 방 에이전트).
 * 아니면 이름·역할·폴더가 맞는 에이전트 — 지금 방 먼저, 그다음 이름이 앞부터 맞음 · 이름 · 역할 · 폴더 차례, 같으면 이름 차례 —
 * 그리고 이름이 맞는 방(지금 방 먼저 · 앞부터 맞음 먼저 · 만든 차례)
 */
export function nameRows(
  agents: readonly AgentView[],
  rooms: readonly Room[],
  roomId: RoomId | null,
  q: string,
  recent: readonly AgentId[],
): { title: NamesTitle; rows: NameRow[] } {
  const roomOf = new Map(rooms.map(r => [r.id, r]))
  const agentRow = (a: AgentView, f: Pick<Extract<NameRow, { kind: 'agent' }>, 'name' | 'role' | 'folder'>): NameRow => ({
    kind: 'agent', agent: a, room: roomOf.get(a.roomId) ?? null, ...f,
  })
  const none = { name: null, role: null, folder: null }

  if (!q) {
    const byId = new Map(agents.map(a => [a.id, a]))
    const picked = recent.flatMap(id => (byId.has(id) ? [byId.get(id)!] : [])).slice(0, RECENT_SHOWN)
    if (picked.length > 0) return { title: 'recent', rows: picked.map(a => agentRow(a, none)) }
    const here = agents.filter(a => a.roomId === roomId).slice(0, RECENT_SHOWN)
    return { title: 'room', rows: here.map(a => agentRow(a, none)) }
  }

  const fq = fold(q)
  const found: { a: AgentView; f: { name: Found | null; role: Found | null; folder: Found | null }; rank: number }[] = []
  for (const a of agents) {
    const name = foundIn(a.name, fq)
    const role = foundIn(a.role, fq)
    const folder = foundIn(a.folder, fq)
    if (!name && !role && !folder) continue
    const rank = name ? (name.prefix ? 0 : 1) : role ? 2 : 3
    found.push({ a, f: { name, role, folder }, rank })
  }
  const here = (id: RoomId) => (id === roomId ? 0 : 1)
  found.sort((x, y) => here(x.a.roomId) - here(y.a.roomId) || x.rank - y.rank || x.a.name.localeCompare(y.a.name, 'ko'))

  const roomRows: { r: Room; name: Found; i: number }[] = []
  rooms.forEach((r, i) => {
    const name = foundIn(r.name, fq)
    if (name) roomRows.push({ r, name, i })
  })
  roomRows.sort((x, y) => here(x.r.id) - here(y.r.id) || Number(y.name.prefix) - Number(x.name.prefix) || x.i - y.i)

  return {
    title: 'match',
    rows: [
      ...found.slice(0, AGENTS_MAX).map(x => agentRow(x.a, x.f)),
      ...roomRows.slice(0, ROOMS_MAX).map((x): NameRow => ({ kind: 'room', room: x.r, agents: agents.filter(a => a.roomId === x.r.id).length, name: x.name })),
    ],
  }
}
