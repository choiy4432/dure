import { useId, useLayoutEffect, useRef, type RefObject } from 'react'
import { animate, utils } from 'animejs'
import { MOTION_MS, reducedMotion } from './motion'
import { setInert, usePresenceApi } from './presence'

// 접기·펼치기 — 높이로 이어진다(spec §3). 높이와 함께 위아래 안쪽 여백·윗 테두리도 같이 줄고 늘어, 0 에서 시작해도 상자 모양이 튀지 않는다.

const SIDES = ['paddingTop', 'paddingBottom', 'borderTopWidth'] as const
const KEBAB: Record<(typeof SIDES)[number], string> = {
  paddingTop: 'padding-top',
  paddingBottom: 'padding-bottom',
  borderTopWidth: 'border-top-width',
}
type Sizes = Record<'height' | (typeof SIDES)[number], number>

const ZERO: Sizes = { height: 0, paddingTop: 0, paddingBottom: 0, borderTopWidth: 0 }
const px = (n: number) => `${n}px`

/** 인라인 크기를 지운다 — 스타일시트 값(제 크기)으로 돌아간다 */
export function clearSize(el: HTMLElement): void {
  el.style.removeProperty('height')
  el.style.removeProperty('overflow')
  for (const k of SIDES) el.style.removeProperty(KEBAB[k])
}

/** 지금 보이는 크기 */
function current(el: HTMLElement): Sizes {
  const cs = getComputedStyle(el)
  return {
    height: el.offsetHeight,
    paddingTop: parseFloat(cs.paddingTop) || 0,
    paddingBottom: parseFloat(cs.paddingBottom) || 0,
    borderTopWidth: parseFloat(cs.borderTopWidth) || 0,
  }
}

/** from 에서 제 크기로 자란다(from 이 없으면 0 에서). 끝나면 인라인 크기를 지운다 */
export function growFrom(el: HTMLElement, from: Sizes | null, onDone?: () => void): void {
  const start = from ?? ZERO
  utils.remove(el)
  clearSize(el)
  const to = current(el)
  to.height = Math.max(el.scrollHeight, to.height)
  const props: Record<string, { from: string; to: string }> = {}
  for (const k of ['height', ...SIDES] as const) props[k] = { from: px(start[k]), to: px(to[k]) }
  el.style.overflow = 'hidden'
  animate(el, {
    ...props,
    duration: MOTION_MS.expand,
    ease: 'outQuint',
    onComplete: () => {
      clearSize(el)
      onDone?.()
    },
  })
}

/** 지금 크기에서 0 으로 접는다 */
export function shrink(el: HTMLElement, onDone: () => void): void {
  const start = current(el)
  utils.remove(el)
  el.style.overflow = 'hidden'
  const props: Record<string, { from: string; to: string }> = {}
  for (const k of ['height', ...SIDES] as const) props[k] = { from: px(start[k]), to: '0px' }
  animate(el, { ...props, duration: MOTION_MS.expand, ease: 'outCubic', onComplete: onDone })
}

/** 지금 크기 읽기 — Clamp 가 쓴다 */
export const readSize = current

/**
 * Presence 안의 펼친 내용 — 생기면 높이 0 → 제 높이, 나가면 → 0 (MOTION_MS.expand, 들어옴 outQuint · 나감 outCubic).
 * 움직이는 동안 overflow hidden, 끝나면 인라인 height 를 지운다. 나가는 동안은 inert · pointer-events: none,
 * 접히다가 다시 보이면 지금 높이에서 다시 자란다. 처음 그릴 때 있던 것·움직임 줄이기는 움직이지 않는다.
 */
export function useExpand(ref: RefObject<HTMLElement | null>): void {
  const ctx = usePresenceApi()
  const id = useId()
  const leaving = ctx?.leaving ?? false
  const live = useRef(ctx)
  live.current = ctx
  const enters = useRef<boolean | null>(null)
  const exiting = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ctx = live.current
    if (enters.current === null) enters.current = ctx ? ctx.entering() : false
    if (enters.current && !reducedMotion()) growFrom(el, null)
    const unregister = ctx?.register(id, MOTION_MS.expand)
    return () => {
      unregister?.()
      utils.remove(el)
    }
  }, [ref, id])

  useLayoutEffect(() => {
    const el = ref.current
    const ctx = live.current
    if (!ctx) return
    if (leaving) {
      exiting.current = true
      if (!el || reducedMotion()) {
        ctx.done(id)
        return
      }
      setInert(el, true)
      let live = true
      shrink(el, () => {
        if (live) ctx.done(id)
      })
      return () => {
        live = false
      }
    }
    if (!exiting.current) return
    exiting.current = false
    if (!el) return
    setInert(el, false)
    if (reducedMotion()) {
      utils.remove(el)
      clearSize(el)
      return
    }
    growFrom(el, current(el))
  }, [leaving, ref, id])
}
