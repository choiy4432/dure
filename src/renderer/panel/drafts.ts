import { useSyncExternalStore } from 'react'
import type { AgentId } from '../../engine/types'
import { getStore } from '../state/store'

/**
 * 입력창에 붙인 것 — 그림(준비 중이거나, 보낼 글(base64)과 미리보기 주소(object URL)를 가진 것) 또는 파일 칩.
 * 파일은 바이트를 옮기지 않고 경로만 — 엔진이 보낼 때 사본을 만든다. error 가 있으면(100MB 넘음) 보내기를 막는다.
 * 휴대폰은 파일에 PC 경로가 없어 붙일 때 PC 로 올린다 — 올리는 동안 uploading(path 는 빈칸, 보내기를 막는다), 다 올리면 받은 PC 경로
 */
export type Attached =
  | { key: number; state: 'loading' }
  | { key: number; state: 'ready'; mediaType: string; base64: string; url: string }
  | { key: number; state: 'file'; name: string; bytes: number; path: string; error?: string; uploading?: true }

/** 에이전트 하나의 쓰던 입력 — 이번 실행 동안만(저장하지 않는다) */
export interface Draft {
  text: string
  attached: Attached[]
  /** '계획 먼저' — 다음 한 번만 계획부터 세우게 보낸다 */
  plan: boolean
  /**
   * 보내는 중 — 'files' 면 첨부가 든 보내기(사본·서버 올리기, 몇 분 걸릴 수 있다). 다른 카드로 갔다 와도 그대로라
   * 그동안 같은 입력을 또 보내지 않는다
   */
  sending?: 'text' | 'files'
  /** 보내는 중인 칩의 열쇠 — 이 칩들만 빼기를 막는다(보내는 사이 새로 붙인 칩은 뺄 수 있다) */
  sent?: number[]
  /** 입력창 아래 오류 줄 — 보내는 사이 다른 카드로 갔어도 돌아오면 보인다 */
  error?: string
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
  if (after.text === '' && after.attached.length === 0 && !after.plan && !after.sending && !after.error) drafts.delete(id)
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

/** 첨부가 든 보내기가 도는 중인가 — 패널 머리의 멈추기(쉬는 에이전트여도 올리기를 끊을 수 있게). 글자를 칠 때마다 다시 그리지 않게 참·거짓만 */
export function useSendingFiles(id: AgentId): boolean {
  return useSyncExternalStore(subscribe, () => getDraft(id).sending === 'files')
}
