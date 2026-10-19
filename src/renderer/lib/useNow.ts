import { useEffect, useState } from 'react'

/** 지금 시각 — every ms 마다 다시 그린다('방금' → '1분 전' 같은 말이 저절로 바뀌게) */
export function useNow(every = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(t)
  }, [every])
  return now
}
