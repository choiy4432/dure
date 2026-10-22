export interface Viewport { x: number; y: number; zoom: number }

/**
 * 누르기만 하고 놓은 것(빈 곳 눌러 고르기 풀기)도 React Flow 는 움직임 시작으로 알린다 —
 * 실제로 화면이 달라졌을 때만 '직접 옮겼다' 로 센다. 위치는 1px 넘게, 확대는 조금이라도.
 */
export function movedEnough(a: Viewport, b: Viewport): boolean {
  return Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 || a.zoom !== b.zoom
}

/** 화면 맞춤을 일으킨 사건 */
export type FitReason = 'resize' | 'count' | 'fit-all' | 'user-move' | 'room'

export interface FitState {
  /** 사용자가 직접 확대·옮긴 뒤로 다시 맞춘 적이 없다 */
  userMoved: boolean
}

/**
 * 사건 하나를 받아 다음 상태와 지금 자동 맞춤을 할지 정한다.
 * 직접 옮긴 화면은 창 크기가 바뀌어도 건드리지 않고(손으로 맞춘 것을 되돌리면 안 된다),
 * 카드 수가 바뀌었거나 '모두 보기' 를 누르면 다시 자동으로 따라간다.
 */
export function fitPolicy(state: FitState, reason: FitReason): { state: FitState; fit: boolean } {
  switch (reason) {
    case 'user-move':
      return { state: { userMoved: true }, fit: false }
    case 'resize':
      return { state, fit: !state.userMoved }
    case 'count':
    case 'room':
      return { state: { userMoved: false }, fit: true }
    case 'fit-all':
      // '모두 보기' 가 이미 맞췄다 — 또 맞추면 움직임이 두 번 된다
      return { state: { userMoved: false }, fit: false }
  }
}
