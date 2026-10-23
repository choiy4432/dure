import { useSyncExternalStore } from 'react'
import type { AgentId } from '../../engine/types'
import { getStore } from '../state/store'

/** 입력창에 붙인 이미지 — 준비 중이거나, 보낼 글(base64)과 미리보기 주소(object URL)를 가진 것 */
export type Attached =
  | { key: number; state: 'loading' }
  | { key: number; state: 'ready'; mediaType: string; base64: string; url: string }

/** 에이전트 하나의 쓰던 입력 — 이번 실행 동안만(저장하지 않는다) */
export interface Draft {
  text: string
  attached: Attached[]
  /** '계획 먼저' — 다음 한 번만 계획부터 세우게 보낸다 */
  plan: boolean
}

export const EMPTY_DRAFT: Draft = { text: '', attached: [], plan: false }

// 에이전트마다 쓰던 입력 — 카드를 오가며 입력창이 다시 그려져도 남는다. 준비가 늦게 끝난 이미지도 그 에이전트 것으로 들어간다
const drafts = new Map<AgentId, Draft>()
const listeners = new Set<() => void>()
let seq = 0
let watching = false

const urlsOf = (d: Draft) => new Set(d.attached.flatMap(a => (a.state === 'ready' ? [a.url] : [])))

/** 붙인 이미지마다 다른 열쇠 — 입력창이 다시 그려져도 앞의 것과 겹치지 않게 */
export const nextAttachKey = (): number => ++seq

export function getDraft(id: AgentId): Draft {
  return drafts.get(id) ?? EMPTY_DRAFT
}

/** 쓰던 입력을 바꾼다 — 빠진 이미지(지움·보냄·버림)의 미리보기 주소는 그 자리에서 놓아 준다 */
export function updateDraft(id: AgentId, fn: (d: Draft) => Draft): void {
  const before = getDraft(id)
  const after = fn(before)
  if (after === before) return
  const kept = urlsOf(after)
  for (const url of urlsOf(before)) if (!kept.has(url)) URL.revokeObjectURL(url)
  if (after.text === '' && after.attached.length === 0 && !after.plan) drafts.delete(id)
  else drafts.set(id, after)
  watchAgents()
  listeners.forEach(fn => fn())
}

/** 에이전트가 지워지면(방을 지워도) 그 쓰던 입력을 버린다 — 스토어의 에이전트 목록을 본다 */
function watchAgents(): void {
  if (watching) return
  watching = true
  const store = getStore()
  store.subscribe(() => {
    if (drafts.size === 0) return
    const alive = new Set(store.getState().agents.map(a => a.id))
    for (const id of [...drafts.keys()]) if (!alive.has(id)) updateDraft(id, () => EMPTY_DRAFT)
  })
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useDraft(id: AgentId): Draft {
  return useSyncExternalStore(subscribe, () => getDraft(id))
}
