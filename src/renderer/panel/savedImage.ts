import { useEffect, useState } from 'react'
import type { AgentId } from '../../engine/types'

/** 보여 줄 그림 — 입력창에 붙여 둔 것(url) 또는 보낸 뒤 저장한 것(기록의 file, 저장하기 전에 보낸 그림은 null) */
export type ViewerSource = { url: string } | { agentId: AgentId; file: string | null }

export type ImageState =
  | { state: 'loading' }
  | { state: 'ready'; src: string }
  /** old = 저장하기 전에 보낸 그림 · gone = 저장했는데 못 읽음(지워짐·읽기 실패) */
  | { state: 'missing'; why: 'old' | 'gone' }

/** 읽어 둔 그림 — 한 장이 수 MB 라 최근 것만. 같은 그림은 썸네일과 크게 보기가 한 번 읽은 것을 같이 쓴다 */
const KEPT_MAX = 40
const kept = new Map<string, Promise<string | null>>()

/** 테스트 — 읽어 둔 그림을 비운다 */
export function forgetSavedImages(): void {
  kept.clear()
}

function load(agentId: AgentId, file: string): Promise<string | null> {
  const key = `${agentId}/${file}`
  const hit = kept.get(key)
  if (hit) {
    // 최근에 쓴 것을 뒤로 — 넘치면 오래 안 쓴 것부터 버린다
    kept.delete(key)
    kept.set(key, hit)
    return hit
  }
  // 옛 preload 에 없는 길이어도 던지지 않고 실패한 약속으로
  const p = Promise.resolve().then(() => window.dure.image(agentId, file))
  kept.set(key, p)
  // 실패는 담아 두지 않는다 — 다음에 다시 읽는다
  p.catch(() => {
    if (kept.get(key) === p) kept.delete(key)
  })
  while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!)
  return p
}

const keyOf = (s: ViewerSource) => ('url' in s ? `u:${s.url}` : `s:${s.agentId}/${s.file ?? ''}`)

function startOf(s: ViewerSource): ImageState {
  if ('url' in s) return { state: 'ready', src: s.url }
  return s.file === null ? { state: 'missing', why: 'old' } : { state: 'loading' }
}

/** 그림 하나의 지금 상태 — 저장한 그림은 엔진에서 읽어 온다 */
export function useImageSource(source: ViewerSource): ImageState {
  const key = keyOf(source)
  const [got, setGot] = useState<{ key: string; value: ImageState } | null>(null)
  const agentId = 'url' in source ? null : source.agentId
  const file = 'url' in source ? null : source.file

  useEffect(() => {
    if (agentId === null || file === null) return
    let live = true
    load(agentId, file).then(
      (src) => live && setGot({ key, value: src ? { state: 'ready', src } : { state: 'missing', why: 'gone' } }),
      () => live && setGot({ key, value: { state: 'missing', why: 'gone' } }),
    )
    return () => {
      live = false
    }
  }, [key, agentId, file])

  // 다른 그림으로 바뀐 순간엔 옛 결과를 쓰지 않는다
  return got && got.key === key ? got.value : startOf(source)
}
