// 에이전트 수 → 궤도. ids[0] 이 핵, 나머지가 돈다. 순수 함수.

export type Orbit = { id: string; a: number; r: number; inc: number; node: number } // r 은 RA 의 배수

/** 궤도 기준 반지름(시안 값) — 칸 크기에서 */
export const orbitRA = (W: number, H: number): number => Math.min(W * 0.325, H * 0.9)
/** 바닥 격자 높이 */
export const FLOOR_Y = -46
/** 핵 높이 */
export const CORE_Y = 16

const START = 0.3
/** 시안 네 궤도의 기울기·교점 — 부호가 번갈아 서로 다른 면을 돈다 */
const INC = [0.16, -0.2, 0.14, -0.17]
const NODE = [0.4, 1.7, 3.0, 4.4]
/** 이보다 많으면 두 줄 */
const ONE_RING = 8
const RING_R: Record<'one' | 'two', [number, number]> = { one: [1, 0.93], two: [1, 0.72] }

export function layoutOrbits(ids: string[]): { core: string; orbits: Orbit[] } {
  const [core = '', ...rest] = ids
  const n = rest.length
  const radii = n > ONE_RING ? RING_R.two : RING_R.one
  return {
    core,
    orbits: rest.map((id, i) => ({
      id,
      a: START + (i * Math.PI * 2) / n,
      r: radii[i % 2],
      inc: INC[i % INC.length],
      node: NODE[i % NODE.length] + Math.floor(i / NODE.length) * 0.65,
    })),
  }
}

/** turn(지금까지 돈 각) 만큼 돈 궤도 위 점 */
export function worldOf(o: Orbit, RA: number, turn: number): [number, number, number] {
  return worldTo([0, 0, 0], o, RA, turn)
}

/** worldOf 를 out 에 — 매 프레임 고리용 */
export function worldTo(out: [number, number, number], o: Orbit, RA: number, turn: number): [number, number, number] {
  const a = o.a + turn
  const r = o.r * RA
  out[0] = Math.cos(a) * r
  out[1] = Math.sin(a - o.node) * r * Math.sin(o.inc)
  out[2] = Math.sin(a) * r
  return out
}
