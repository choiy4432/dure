// 지난 대화 탭의 순수 도우미 — 날짜 줄 · 돌아가기를 막는 까닭 · 갈래 칠 새 에이전트 이름

import type { AgentView } from '../../shared/ipcContract'

const two = (n: number) => String(n).padStart(2, '0')
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/**
 * 지난 대화의 날짜(로컬 시간) — 같은 날 '오늘 14:20' · 전날 '어제 09:10' · 올해 '10월 30일 목' · 올해가 아니면 '2025년 10월 30일'.
 * 차례 수·'읽기만' 꼬리는 목록이 붙인다(읽기 띠엔 날짜만)
 */
export function pastDateLine(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  if (sameDay(d, n)) return `오늘 ${time}`
  // 달력의 전날 — 달·해가 바뀌는 날도 Date 가 맞춘다
  if (sameDay(d, new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1))) return `어제 ${time}`
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일 ${'일월화수목금토'[d.getDay()]}`
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`
}

/**
 * 이 대화로 돌아가기를 막는 까닭 — 일하는 중 → working · 승인·질문 기다림 → asking · 붙잡은 입력이나 기다리는 입력 → held · 없으면 null.
 * 엔진도 같은 조건이면 거절한다(그 글은 아래 줄에 그대로) — 화면은 단추를 미리 끈다
 */
export function resumeBlockOf(a: Pick<AgentView, 'status' | 'hold' | 'heldInput'>): 'working' | 'asking' | 'held' | null {
  if (a.status === 'working') return 'working'
  if (a.status === 'awaiting') return 'asking'
  if (a.hold || a.heldInput > 0) return 'held'
  return null
}

/** 이름 비교 — 엔진 이름 검사(store.ts norm)와 같게: 앞뒤 공백 · 대소문자 무시 */
const norm = (s: string) => s.trim().toLocaleLowerCase('ko')

/** 갈래 칠 새 에이전트 이름 — '<원래 이름> 2', 겹치면 3, 4… (taken = 같은 방의 이름들) */
export function nextAgentName(base: string, taken: string[]): string {
  const name = base.trim()
  const used = new Set(taken.map(norm))
  let n = 2
  while (used.has(norm(`${name} ${n}`))) n++
  return `${name} ${n}`
}
