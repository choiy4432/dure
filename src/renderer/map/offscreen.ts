import type { AgentId } from '../../engine/types'

export type Side = 'left' | 'right' | 'top' | 'bottom'
export interface OffTarget { id: AgentId; x: number; y: number; w: number; h: number; ask: boolean }
export interface View { x: number; y: number; zoom: number; width: number; height: number }

// 같은 수일 때 앞선 쪽이 이긴다 — 늘 같은 쪽을 보여 알약이 깜빡이며 바뀌지 않게
const ORDER: Side[] = ['right', 'bottom', 'left', 'top']

/**
 * 화면 밖에 있는 할 일 카드를 가장 많은 쪽 하나로 묶어 알려 준다 — 없으면 null.
 * 한 장이라도 조금 걸쳐 보이면 밖이 아니다(보이는데 알약까지 띄우면 중복이라)
 */
export function offscreen(
  targets: OffTarget[], view: View,
): { side: Side; count: number; first: AgentId; ask: boolean } | null {
  const by: Record<Side, { id: AgentId; gap: number }[]> = { right: [], bottom: [], left: [], top: [] }
  let ask = false
  let count = 0
  for (const t of targets) {
    const sx = t.x * view.zoom + view.x
    const sy = t.y * view.zoom + view.y
    const sw = t.w * view.zoom
    const sh = t.h * view.zoom
    // 닿기만 한 것은 보이는 면적이 없으니 밖 — 엄격한 부등호
    const visible = sx < view.width && sx + sw > 0 && sy < view.height && sy + sh > 0
    if (visible) continue
    count++
    if (t.ask) ask = true
    const dx = sx + sw / 2 - view.width / 2
    const dy = sy + sh / 2 - view.height / 2
    // 가로로 더 멀면 좌우, 아니면 위아래. 간격 = 그 쪽 화면 가장자리에서 카드까지(작을수록 가깝다)
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) by.right.push({ id: t.id, gap: sx - view.width })
      else by.left.push({ id: t.id, gap: -(sx + sw) })
    } else if (dy > 0) by.bottom.push({ id: t.id, gap: sy - view.height })
    else by.top.push({ id: t.id, gap: -(sy + sh) })
  }
  if (count === 0) return null
  let side = ORDER[0]
  for (const s of ORDER) if (by[s].length > by[side].length) side = s
  const first = by[side].reduce((a, b) => (b.gap < a.gap ? b : a)).id
  return { side, count, first, ask }
}
