import { useEffect, useState } from 'react'

const read = (query: string) => (typeof window.matchMedia === 'function' ? window.matchMedia(query) : null)

/** 미디어 질의가 지금 맞는가 — 창 크기가 바뀌면 다시 그린다(matchMedia 가 없는 환경은 늘 false) */
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => read(query)?.matches ?? false)
  useEffect(() => {
    const mq = read(query)
    if (!mq) return
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}
