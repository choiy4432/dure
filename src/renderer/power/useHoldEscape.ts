import { useEffect, useRef, useState } from 'react'

/**
 * Esc 를 ms 동안 누르고 있으면 onDone 한 번. keydown(반복 무시)으로 시작, keyup·창 blur 로 취소.
 * progress 는 0→1 — 나가는 고리가 이걸 따라 찬다. 덮개 밖 리스너보다 먼저 보도록 window 캡처 단계에서 듣는다.
 */
export function useHoldEscape(o: { ms: number; onDone: () => void }): { progress: number } {
  const [progress, setProgress] = useState(0)
  const done = useRef(o.onDone)
  done.current = o.onDone
  const { ms } = o

  useEffect(() => {
    let start = 0
    let finish: ReturnType<typeof setTimeout> | undefined
    let tick: ReturnType<typeof setInterval> | undefined
    const cancel = () => {
      clearTimeout(finish)
      clearInterval(tick)
      finish = tick = undefined
      start = 0
      setProgress(0)
    }
    const onDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || start) return
      start = Date.now()
      tick = setInterval(() => setProgress(Math.min(1, (Date.now() - start) / ms)), 50)
      finish = setTimeout(() => {
        cancel()
        done.current()
      }, ms)
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', cancel)
      clearTimeout(finish)
      clearInterval(tick)
    }
  }, [ms])

  return { progress }
}
