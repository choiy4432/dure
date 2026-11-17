import { describe, expect, it } from 'vitest'
import { IDLE, inK, jumpK, landK, outK, startTransition, stepTransition, type Phase, type Transition } from '../src/renderer/power/orbit/transition'

// 관계도 방 옮기기 전환 — 순수 상태 기계. 빨려 들기(out) → 도약(jump) → 펼쳐지기(in), 약 1.5초. 움직임 줄이기면 흐려졌다 나타나기 0.6초

const DT = 1 / 60
const go = (o: Partial<{ toRoom: string | null; toName: string; hasOut: boolean; hasIn: boolean; calm: boolean }> = {}) =>
  ({ toRoom: 'r2', toName: '결제', hasOut: true, hasIn: true, calm: false, ...o })

type Step = { at: number; tr: Transition; swap: boolean; done: boolean }
/** 60fps 로 sec 초 — 걸음마다 지난 시간(초)과 결과 */
function run(tr: Transition, sec: number, calm = false): Step[] {
  const out: Step[] = []
  let at = 0
  for (let i = 0; i < Math.round(sec * 60); i++) {
    const r = stepTransition(tr, DT, calm)
    at += DT
    tr = r.tr
    out.push({ at, tr, swap: r.swap, done: r.done })
  }
  return out
}
const last = (s: Step[]) => s[s.length - 1].tr
/** 지난 시간 at 까지 돌린 뒤의 상태 */
const after = (tr: Transition, sec: number, calm = false) => last(run(tr, sec, calm))

describe('관계도 전환 — 상태 기계', () => {
  it('idle_에서_시작하면_out', () => {
    const tr = startTransition(IDLE, go())
    expect(tr).toEqual({ phase: 'out', t: 0, toRoom: 'r2', toName: '결제', hasOut: true, hasIn: true })
    expect([outK(tr), jumpK(tr), inK(tr)]).toEqual([0, 0, 0])
    // 아무 일도 없으면 그대로 — 진행도는 평소 상태(펼쳐진 채)
    expect(stepTransition(IDLE, DT, false)).toEqual({ tr: IDLE, swap: false, done: false })
    expect([outK(IDLE), jumpK(IDLE), inK(IDLE)]).toEqual([0, 0, 1])
  })

  it('0.55s_에_outK_1', () => {
    const s = run(startTransition(IDLE, go()), 0.7)
    const at = (sec: number) => s.find(x => x.at >= sec - 1e-9)!.tr
    expect(outK(at(0.3))).toBeGreaterThan(0.4)
    expect(outK(at(0.3))).toBeLessThan(0.7)
    expect(outK(at(0.5))).toBeLessThan(1)
    expect(outK(at(0.55))).toBeCloseTo(1, 5)
    expect(outK(at(0.7))).toBe(1)
    // 줄곧 오르기만 한다
    for (let i = 1; i < s.length; i++) expect(outK(s[i].tr)).toBeGreaterThanOrEqual(outK(s[i - 1].tr))
  })

  it('swap_은_한_번_0.9s_언저리', () => {
    const s = run(startTransition(IDLE, go()), 2)
    const swaps = s.filter(x => x.swap)
    expect(swaps).toHaveLength(1)
    expect(Math.abs(swaps[0].at - 0.9)).toBeLessThanOrEqual(DT + 1e-9)
    // 바꿔 끼우기 전엔 펼침이 없고, 뒤엔 빨려 들기가 끝나 있다
    for (const x of s) if (x.at < swaps[0].at) expect(inK(x.tr)).toBe(0)
    expect(outK(swaps[0].tr)).toBe(1)
    // 도약 세기는 0 → 1 → 0 (바꿔 끼우는 자리에서 다시 0)
    const peak = Math.max(...s.map(x => jumpK(x.tr)))
    expect(peak).toBeGreaterThan(0.98)
    expect(jumpK(swaps[0].tr)).toBe(0)
    expect(jumpK(s.find(x => x.at >= 0.3)!.tr)).toBe(0)
  })

  it('1.5s_에_done_idle', () => {
    const s = run(startTransition(IDLE, go()), 2)
    const done = s.filter(x => x.done)
    expect(done).toHaveLength(1)
    expect(Math.abs(done[0].at - 1.5)).toBeLessThanOrEqual(DT + 1e-9)
    expect(done[0].tr.phase).toBe('idle')
    for (const x of s) if (x.at < done[0].at - 1e-9) expect(x.tr.phase).not.toBe('idle')
    expect(inK(s.find(x => x.at >= 1.2)!.tr)).toBeGreaterThan(0.3)
    expect(inK(s.find(x => x.at >= 1.2)!.tr)).toBeLessThan(0.7)
    expect(last(s).phase).toBe('idle')
  })

  it('out_없는_전환(빈_방에서)은_jump_없이_in_만', () => {
    const tr = startTransition(IDLE, go({ hasOut: false }))
    expect(tr.phase).toBe('in')
    expect(inK(tr)).toBe(0)
    const s = run(tr, 1)
    expect(new Set(s.map(x => x.tr.phase))).toEqual(new Set<Phase>(['in', 'idle']))
    expect(s.every(x => jumpK(x.tr) === 0)).toBe(true)
    // 새 방 노드는 첫 걸음에 바꿔 끼우고, 0.6초 펼쳐진 뒤 끝
    expect(s.filter(x => x.swap).map(x => x.at)).toEqual([s[0].at])
    const done = s.filter(x => x.done)
    expect(done).toHaveLength(1)
    expect(Math.abs(done[0].at - 0.6)).toBeLessThanOrEqual(DT + 1e-9)
  })

  it('in_없는_전환(빈_방으로)은_out·jump_뒤_done', () => {
    const s = run(startTransition(IDLE, go({ hasIn: false, toRoom: 'empty', toName: '빈 방' })), 2)
    expect(s.some(x => x.tr.phase === 'in')).toBe(false)
    expect(s.some(x => x.tr.phase === 'jump')).toBe(true)
    const swap = s.filter(x => x.swap)
    const done = s.filter(x => x.done)
    // 빈 방으로 바꿔 끼우기와 끝이 같은 걸음 — 도약이 끝나는 0.9초
    expect(swap).toHaveLength(1)
    expect(done).toHaveLength(1)
    expect(done[0].at).toBe(swap[0].at)
    expect(Math.abs(done[0].at - 0.9)).toBeLessThanOrEqual(DT + 1e-9)
    expect(done[0].tr.phase).toBe('idle')
  })

  it('out_도중_새_전환_→_진행은_이어지고_toRoom_만_바뀐다', () => {
    const mid = after(startTransition(IDLE, go()), 0.3)
    expect(mid.phase).toBe('out')
    const re = startTransition(mid, go({ toRoom: 'r3', toName: '배포' }))
    expect(re).toEqual({ ...mid, toRoom: 'r3', toName: '배포' })
    expect(outK(re)).toBe(outK(mid))
    // 도약 중에도 — 진행은 그대로, 갈 방만
    const jump = after(startTransition(IDLE, go()), 0.7)
    expect(jump.phase).toBe('jump')
    const re2 = startTransition(jump, go({ toRoom: 'r4', toName: '검토', hasIn: false }))
    expect(re2).toEqual({ ...jump, toRoom: 'r4', toName: '검토', hasIn: false })
    expect(jumpK(re2)).toBe(jumpK(jump))
    // 이어 간 전환도 바꿔 끼우기는 한 번
    expect(run(re, 2).filter(x => x.swap)).toHaveLength(1)
  })

  it('in_도중_새_전환_→_out_부터_다시(지금_카드를_넣고)', () => {
    const unfolding = after(startTransition(IDLE, go()), 1.2)
    expect(unfolding.phase).toBe('in')
    const re = startTransition(unfolding, go({ toRoom: 'r3', toName: '배포' }))
    expect(re).toEqual({ phase: 'out', t: 0, toRoom: 'r3', toName: '배포', hasOut: true, hasIn: true })
    // 처음부터 다시 — 한 번 더 바꿔 끼우고 1.5초에 끝
    const s = run(re, 2)
    expect(s.filter(x => x.swap)).toHaveLength(1)
    expect(Math.abs(s.find(x => x.done)!.at - 1.5)).toBeLessThanOrEqual(DT + 1e-9)
  })

  it('calm_이면_jumpK_는_늘_0_이고_전체_0.6s', () => {
    const s = run(startTransition(IDLE, go({ calm: true })), 1, true)
    expect(s.every(x => jumpK(x.tr) === 0)).toBe(true)
    expect(s.some(x => x.tr.phase === 'jump')).toBe(false)
    const swap = s.filter(x => x.swap)
    const done = s.filter(x => x.done)
    expect(swap).toHaveLength(1)
    expect(Math.abs(swap[0].at - 0.3)).toBeLessThanOrEqual(DT + 1e-9)
    expect(outK(swap[0].tr)).toBe(1)
    expect(done).toHaveLength(1)
    expect(Math.abs(done[0].at - 0.6)).toBeLessThanOrEqual(DT + 1e-9)
    // 빈 방에서도 0.3초 · 빈 방으로도 0.3초
    expect(Math.abs(run(startTransition(IDLE, go({ calm: true, hasOut: false })), 1, true).find(x => x.done)!.at - 0.3)).toBeLessThanOrEqual(DT + 1e-9)
    expect(Math.abs(run(startTransition(IDLE, go({ calm: true, hasIn: false })), 1, true).find(x => x.done)!.at - 0.3)).toBeLessThanOrEqual(DT + 1e-9)
  })

  it('펼칠_때_카드는_핵부터_차례로_늦게_출발해_모두_제때_자리_잡는다', () => {
    expect(landK(0, 0, 5)).toBe(0)
    expect(landK(1, 4, 5)).toBe(1)
    // 핵(0)이 먼저, 그다음 차례로 — 같은 순간이면 앞 카드가 더 나와 있다
    for (let i = 1; i < 5; i++) expect(landK(0.4, i, 5)).toBeLessThan(landK(0.4, i - 1, 5))
    // 많아도 마지막 카드의 펼침 시간이 너무 짧아지지 않는다(늦게 출발하는 몫에 상한)
    const n = 12
    const start = (i: number) => { let k = 0; while (landK(k, i, n) === 0 && k < 1) k += 0.001; return k }
    expect(1 - start(n - 1)).toBeGreaterThan(0.55)
  })
})
