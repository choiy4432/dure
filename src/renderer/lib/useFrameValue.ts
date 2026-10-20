import { useEffect, useRef, useState } from 'react'

/**
 * 값이 쏟아져 들어와도 화면용 값은 한 장(animation frame)에 한 번만 바꾼다 — 흐르는 글을 마크다운으로
 * 읽는 비용을 프레임당 한 번으로 묶는다. 마지막 값은 반드시 다음 장에 반영된다. rAF 가 없으면 바로.
 */
export function useFrameValue<T>(value: T): T {
  const [shown, setShown] = useState(value)
  const latest = useRef(value)
  const frame = useRef<number | null>(null)
  latest.current = value

  useEffect(() => {
    if (typeof requestAnimationFrame === 'undefined') {
      setShown(value)
      return
    }
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      setShown(latest.current)
    })
  }, [value])

  useEffect(() => () => {
    if (frame.current !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame.current)
  }, [])

  return shown
}
