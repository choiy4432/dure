// 휴대폰 판(RelationMap touch)의 화면 기억 — 순수 모듈. 대화를 열면 판이 내려갔다 다시 그려진다 — 그때 보던 자리로 돌아오게.
// 방마다 마지막 화면(움직임이 끝날 때 적는다)을 이번 실행 동안 기억한다. 없으면 맞춤, 대화에서 돌아왔으면 그 카드가 화면 안에 들게
import type { RoomId } from '../../engine/types'

export interface View {
  x: number
  y: number
  zoom: number
}
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface Area {
  width: number
  height: number
}
/** 카드가 들어야 할 칸 — 위 여백 · 양옆 · 아래(맞춤 단추 자리) */
export interface Pad {
  x: number
  top: number
  bottom: number
}

const views = new Map<RoomId, View>()

const finite = (v: View) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) && v.zoom > 0

/** 이 방의 지금 화면을 적는다 — 판이 움직임을 마칠 때마다(손가락 · 맞춤 · 화면 밖 알약) */
export function rememberView(roomId: RoomId, v: View): void {
  if (!finite(v)) return
  views.set(roomId, { x: v.x, y: v.y, zoom: v.zoom })
}

export function rememberedView(roomId: RoomId): View | null {
  return views.get(roomId) ?? null
}

/** 시험용 — 기억을 비운다 */
export function forgetViews(): void {
  views.clear()
}

/**
 * card(판 좌표)가 화면 안에 들게 — 이미 다 보이면 그대로. 밖인 쪽만(가로·세로 따로) 그 카드가 보이는 칸의 가운데 오게 옮긴다.
 * 배율은 그대로(두 손가락으로 정한 배율을 바꾸지 않는다)
 */
export function revealCard(v: View, card: Rect, area: Area, pad: Pad): View {
  const sx = card.x * v.zoom + v.x
  const sw = card.width * v.zoom
  const sy = card.y * v.zoom + v.y
  const sh = card.height * v.zoom
  let { x, y } = v
  if (sx < pad.x || sx + sw > area.width - pad.x) x = (area.width - sw) / 2 - card.x * v.zoom
  if (sy < pad.top || sy + sh > area.height - pad.bottom) y = pad.top + (area.height - pad.top - pad.bottom - sh) / 2 - card.y * v.zoom
  return x === v.x && y === v.y ? v : { x, y, zoom: v.zoom }
}

/** 판을 다시 그릴 때의 처음 화면 — 기억한 화면 → 없으면 맞춤. 돌아온 카드(card)가 있으면 그 카드가 보이게. 둘 다 없으면 null(아직 못 잼) */
export function firstView(o: { saved: View | null; fit: View | null; card: Rect | null; area: Area; pad: Pad }): View | null {
  const base = o.saved ?? o.fit
  if (!base) return null
  return o.card ? revealCard(base, o.card, o.area, o.pad) : base
}
