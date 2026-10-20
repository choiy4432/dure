import { useLayoutEffect, useRef, type RefObject } from 'react'
import { animate, utils } from 'animejs'
import { reducedMotion } from './motion'

// 값이 바뀌면 바뀐 값까지 이어서 차는 막대·호. 처음 들어온 null 아닌 값은 바로 그 값으로 보인다.
// 움직임 줄이기면 animate 없이 값이 바뀐 커밋에서 바로 쓴다.

/** 채움 span 의 width(%) — React style 로 쓰지 않고 이 훅이 쓴다 */
export function useMeterWidth(ref: RefObject<HTMLElement | null>, percent: number, ms: number): void {
  const shown = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const was = shown.current
    shown.current = percent
    if (was === null || was === percent || reducedMotion()) {
      utils.remove(el)
      el.style.width = `${percent}%`
      return
    }
    animate(el, { width: [`${was}%`, `${percent}%`], duration: ms, ease: 'outQuint' })
  }, [ref, percent, ms])
  useLayoutEffect(() => () => void (ref.current && utils.remove(ref.current)), [ref])
}

/** 0~100 값을 write 로 내보낸다 — 처음 값은 바로, 바뀌면 ms 동안 이어서 */
export function useTweenValue(percent: number, ms: number, write: (v: number) => void): void {
  const shown = useRef<number | null>(null)
  const state = useRef({ v: percent })
  const put = useRef(write)
  put.current = write
  useLayoutEffect(() => {
    const was = shown.current
    shown.current = percent
    const o = state.current
    if (was === null || was === percent || reducedMotion()) {
      utils.remove(o)
      o.v = percent
      put.current(percent)
      return
    }
    animate(o, { v: percent, duration: ms, ease: 'outQuint', onUpdate: () => put.current(o.v) })
  }, [percent, ms])
  useLayoutEffect(() => {
    const o = state.current
    return () => void utils.remove(o)
  }, [])
}
