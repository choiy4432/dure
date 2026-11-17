// 관계도 방 옮기기 전환 — 순수 상태 기계(DOM·시계 없음). 세 토막, 약 1.5초:
//   빨려 들기 out(0~0.45) → 도약 jump(0.45~0.9) → [0.9 에 새 방 노드로 바꿔 끼움] → 펼쳐지기 in(0.9~1.5).
// 빨려 들기 진행(outK)은 도약 안으로 0.1초 더 이어져 0.55초에 1 이 된다(카드가 핵에 닿기 직전에 도약이 시작된다).
// t 는 지금 토막 안에서 흐른 시간(초, 평소 빠르기). 움직임 줄이기(calm)는 같은 시계를 빨리 돌려 흐려짐 0.3초 → 나타남 0.3초로 끝내고
// 도약 토막을 건너뛴다 — 그래서 진행도(outK·jumpK·inK)는 phase 와 t 만 보면 된다. 그리기·자리 잡기는 진행도만 읽는다.
// 전환 중에 또 방이 바뀌면(startTransition): 바꿔 끼우기 전(out·jump)이면 진행은 그대로 갈 방만 바꾸고,
// 바꿔 끼운 뒤(in)면 지금 화면의 카드를 넣는 빨려 들기부터 다시 — 두 방의 카드가 섞여 보이지 않는다.

export type Phase = 'idle' | 'out' | 'jump' | 'in'
export type Transition = { phase: Phase; t: number; toRoom: string | null; toName: string; hasOut: boolean; hasIn: boolean }

/** 토막 길이(초) — out 은 도약이 시작되는 0.45 까지, 그 진행(outK)은 outFull(0.55)에 1 */
export const TR = { out: 0.45, outFull: 0.55, jump: 0.45, in: 0.6 } as const
/** 움직임 줄이기 — 옛 카드 흐려짐 · 새 카드 나타남(초) */
export const TR_CALM = { out: 0.3, in: 0.3 } as const
/** 펼칠 때 카드마다 늦게 출발하는 간격(초) — 핵(첫 에이전트)부터 차례로 부채처럼. 많으면 줄여 늦는 몫을 펼침 시간의 40% 안에 */
export const STAGGER = 0.04
const STAGGER_BUDGET = 0.4

export const IDLE: Transition = { phase: 'idle', t: 0, toRoom: null, toName: '', hasOut: false, hasIn: false }

/** 바꿔 끼우기 전 — 화면의 카드는 아직 옛 방 것 */
export const beforeSwap = (tr: Transition): boolean => tr.phase === 'out' || tr.phase === 'jump'

/**
 * 방이 바뀌었다 — hasOut: 지금 화면에 카드가 있다(빨아들일 것) · hasIn: 갈 방에 에이전트가 있다(펼칠 것).
 * 바꿔 끼우기 전이면 이어 가고, 아니면(쉬는 중 · 펼치는 중) 지금 카드를 넣는 것부터. 카드가 없으면 펼치기만, 둘 다 없으면 할 일이 없다
 */
export function startTransition(cur: Transition, o: { toRoom: string | null; toName: string; hasOut: boolean; hasIn: boolean; calm: boolean }): Transition {
  const to = { toRoom: o.toRoom, toName: o.toName, hasIn: o.hasIn }
  if (beforeSwap(cur)) return { ...cur, ...to }
  if (o.hasOut) return { phase: 'out', t: 0, ...to, hasOut: true }
  if (o.hasIn) return { phase: 'in', t: 0, ...to, hasOut: false }
  return { ...IDLE, ...to }
}

type Step = { tr: Transition; swap: boolean; done: boolean }
const idleAfter = (tr: Transition): Transition => ({ ...IDLE, toRoom: tr.toRoom, toName: tr.toName })

/** 빨려 들기·도약이 끝났다 — 새 방 노드로 바꿔 끼우고, 펼칠 것이 없으면(빈 방으로) 그대로 끝 */
function arrive(tr: Transition, over: number): Step {
  if (!tr.hasIn) return { tr: idleAfter(tr), swap: true, done: true }
  return { tr: { ...tr, phase: 'in', t: over }, swap: true, done: false }
}

/** 한 걸음(dt 초) — swap: 이 걸음에 새 방 노드로 바꿔 끼운다 · done: 이 걸음에 전환이 끝났다 */
export function stepTransition(tr: Transition, dt: number, calm: boolean): Step {
  if (tr.phase === 'idle') return { tr, swap: false, done: false }
  if (tr.phase === 'out') {
    // 움직임 줄이기는 빨려 들기 진행이 1 이 될 때(outFull)까지 0.3초에 가고 도약 없이 바로 바꿔 끼운다
    const end = calm ? TR.outFull : TR.out
    const t = tr.t + dt * (calm ? TR.outFull / TR_CALM.out : 1)
    if (t < end) return { tr: { ...tr, t }, swap: false, done: false }
    if (calm) return arrive(tr, 0)
    return { tr: { ...tr, phase: 'jump', t: t - end }, swap: false, done: false }
  }
  if (tr.phase === 'jump') {
    const t = tr.t + dt
    if (t < TR.jump) return { tr: { ...tr, t }, swap: false, done: false }
    return arrive(tr, t - TR.jump)
  }
  const t = tr.t + dt * (calm ? TR.in / TR_CALM.in : 1)
  // 빈 방에서 온 전환(빨려 들기 없음)은 펼치기의 첫 걸음에 바꿔 끼운다
  const swap = !tr.hasOut && tr.t === 0 && t > 0
  if (t < TR.in) return { tr: { ...tr, t }, swap, done: false }
  return { tr: idleAfter(tr), swap, done: true }
}

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v)

/** 0→1 빨려 들기 진행 — 도약 안에서 0.55초에 1, 바꿔 끼운 뒤로는 1 */
export function outK(tr: Transition): number {
  if (tr.phase === 'out') return clamp01(tr.t / TR.outFull)
  if (tr.phase === 'jump') return clamp01((TR.out + tr.t) / TR.outFull)
  return tr.phase === 'in' ? 1 : 0
}

/** 0→1→0 도약 세기 — 도약 토막 안의 종 모양(sin). 움직임 줄이기엔 도약 토막이 없어 늘 0 */
export function jumpK(tr: Transition): number {
  return tr.phase === 'jump' ? Math.sin(Math.PI * clamp01(tr.t / TR.jump)) : 0
}

/** 0→1 펼쳐지기 진행 — 바꿔 끼우기 전엔 0, 쉬는 중엔 1(다 자리 잡은 평소 상태) */
export function inK(tr: Transition): number {
  if (tr.phase === 'in') return clamp01(tr.t / TR.in)
  return tr.phase === 'idle' ? 1 : 0
}

/**
 * 펼칠 때 i 번째 카드(0 = 핵)의 진행 — 전체 진행 k 에서 i·간격만큼 늦게 출발해 모두 펼치기 안에 자리 잡는다(부채처럼 차례로).
 * n 은 카드 수. 많으면 간격을 줄여 마지막 카드도 펼침 시간의 60% 이상을 쓴다
 */
export function landK(k: number, i: number, n: number): number {
  const stag = n > 1 ? Math.min(STAGGER, (TR.in * STAGGER_BUDGET) / (n - 1)) : 0
  const dur = TR.in - stag * (n - 1)
  return clamp01((k * TR.in - i * stag) / dur)
}
