import { useEffect, useRef, useState } from 'react'

/**
 * 길게 눌러 나간 그 Esc — 떼기 전까지 오는 자동 반복(repeat)은 아무 데도 닿지 않게 삼킨다.
 * 나가면 덮개가 사라지고, 아래 앱(다시 붙으며 커서를 가져간 입력창의 '멈추기' · 관계도의 '고르기 풀기')이 아직 누르고 있는 Esc 를 받게 되기 때문.
 * 훅이 덮개와 함께 치워진 뒤에도 남아야 해서 window 에 따로 단다 — 떼거나 · 새로 누르거나(반복 아님 — 떼기를 놓쳤다) · 창이 초점을 잃으면 스스로 떨어진다.
 */
function swallowHeldEscape(): void {
  const off = () => {
    window.removeEventListener('keydown', eat, true)
    window.removeEventListener('keyup', up, true)
    window.removeEventListener('blur', off)
  }
  const eat = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (!e.repeat) return off() // 새로 누른 것은 평소대로
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  const up = (e: KeyboardEvent) => {
    if (e.key === 'Escape') off()
  }
  window.addEventListener('keydown', eat, true)
  window.addEventListener('keyup', up, true)
  window.addEventListener('blur', off)
}

/**
 * Esc 를 ms 동안 누르고 있으면 onDone 한 번. keydown(반복 무시)으로 시작, keyup·창 blur 로 취소.
 * progress 는 0→1 — 나가는 고리가 이걸 따라 찬다.
 * 가로채지 않는다: window 의 거품 단계에서 듣기만 하고(막지도·멈추지도 않는다), 다른 곳이 이미 받은 Esc(기본 동작을 막았거나
 * 전파를 멈춘 것 — 대화상자·떠 있는 목록)와 enabled() 가 거짓인 때(글 입력 중 · 떠 있는 창)는 시작하지 않는다.
 * 하나만 삼킨다: 끝까지 눌러 onDone 을 부른 그 누름의 자동 반복(떼기 전까지 — swallowHeldEscape).
 */
export function useHoldEscape(o: { ms: number; onDone: () => void; enabled: () => boolean }): { progress: number } {
  const [progress, setProgress] = useState(0)
  const live = useRef(o)
  live.current = o
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
      if (e.key !== 'Escape' || e.repeat || start || e.defaultPrevented || !live.current.enabled()) return
      start = Date.now()
      tick = setInterval(() => setProgress(Math.min(1, (Date.now() - start) / ms)), 50)
      finish = setTimeout(() => {
        cancel()
        if (!live.current.enabled()) return // 누르는 사이 창이 떴으면 나가지 않는다
        swallowHeldEscape()
        live.current.onDone()
      }, ms)
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onDown)
    // 떼기는 캡처로 — 누가 전파를 멈춰도 고리가 남지 않게
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', cancel)
      clearTimeout(finish)
      clearInterval(tick)
    }
  }, [ms])

  return { progress }
}
