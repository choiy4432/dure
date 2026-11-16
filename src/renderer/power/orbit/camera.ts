// 관계도 카메라 — 3D 점을 2D 화면으로(시안 orbit3.proj). 순수 함수, DOM 없음.
// 좌표: x 오른쪽 · y 위 · z 안쪽. yaw 는 y 축으로 돌기, e 는 내려다보는 기울기.

export type Cam = { yaw: number; e: number; D: number; zoom: number; cx: number; cy: number }
export type Proj = { x: number; y: number; f: number; d: number }

/** 원근 거리(시안 값) */
export const CAM_D = 1400
/** 기울기 e = base + swing·sin(0.13t) − syncDip·동기화 */
export const TILT = { base: 0.56, swing: 0.1, syncDip: 0.14 } as const
/** 당기기 zoom = 1 + swing·sin(0.17t) + sync·동기화 */
export const ZOOM = { swing: 0.035, sync: 0.05 } as const
/** 동기화 때 화면 흔들림 최대(px) */
export const SHAKE_PX = 4
/** 화면 가운데에서 핵을 조금 내려 둔다(px) */
export const CENTER_DROP = 14

// 한 프레임 안에서 yaw·e 는 그대로라 삼각함수를 매번 다시 구하지 않는다
let kYaw = NaN
let cYaw = 1
let sYaw = 0
let kE = NaN
let cE = 1
let sE = 0

/** out 에 투영을 써 넣는다 — 수천 점을 그리는 고리에서 객체를 새로 만들지 않으려고 */
export function projectTo(out: Proj, c: Cam, x: number, y: number, z: number): Proj {
  if (c.yaw !== kYaw) {
    kYaw = c.yaw
    cYaw = Math.cos(kYaw)
    sYaw = Math.sin(kYaw)
  }
  if (c.e !== kE) {
    kE = c.e
    cE = Math.cos(kE)
    sE = Math.sin(kE)
  }
  const X = x * cYaw - z * sYaw
  const Z = x * sYaw + z * cYaw
  const up = y * cE + Z * sE
  const d = Z * cE - y * sE
  const f = (c.D / (c.D + d)) * c.zoom
  out.x = c.cx + X * f
  out.y = c.cy - up * f
  out.f = f
  out.d = d
  return out
}

export function project(c: Cam, x: number, y: number, z: number): { x: number; y: number; f: number; d: number } {
  return projectTo({ x: 0, y: 0, f: 0, d: 0 }, c, x, y, z)
}

/** 반지름 r 공 안에서 얼마나 앞쪽인가 — 0(맨 뒤) ~ 1(맨 앞) */
export function near(p: { d: number }, r: number): number {
  const v = 1 - (p.d + r) / (2 * r)
  return v < 0 ? 0 : v > 1 ? 1 : v
}
