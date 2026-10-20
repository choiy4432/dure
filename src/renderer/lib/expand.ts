import { useId, useLayoutEffect, useRef, type RefObject } from 'react'
import { animate, utils } from 'animejs'
import { MOTION_MS, reducedMotion } from './motion'
import { setInert, usePresenceApi } from './presence'

// 접기·펼치기 — 높이만 움직인다(spec §3). 꾸밈이 있는 요소는 바깥 상자(.xp) 안에 두어 여백·테두리가 따로 튀지 않는다.

const px = (n: number) => `${n}px`

/** 인라인 크기를 지운다 — 스타일시트 값(제 크기)으로 돌아간다 */
export function clearSize(el: HTMLElement): void {
  el.style.removeProperty('height')
  el.style.removeProperty('overflow')
}

/** 지금 보이는 높이 */
export function readSize(el: HTMLElement): number {
  return el.offsetHeight
}

/** from 에서 제 크기로 자란다(from 이 없으면 0 에서). 끝나면 인라인 크기를 지운다 */
export function growFrom(el: HTMLElement, from: number | null, onDone?: () => void): void {
  utils.remove(el)
  clearSize(el)
  const to = Math.max(el.scrollHeight, el.offsetHeight)
  el.style.overflow = 'hidden'
  animate(el, {
    height: { from: px(from ?? 0), to: px(to) },
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
  const start = el.offsetHeight
  utils.remove(el)
  el.style.overflow = 'hidden'
  animate(el, { height: { from: px(start), to: '0px' }, duration: MOTION_MS.expand, ease: 'outCubic', onComplete: onDone })
}

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
    growFrom(el, readSize(el))
  }, [leaving, ref, id])
}
