import { useCallback, useState } from 'react'
import { errorMessage } from '../../lib/words'

/**
 * 카드 버튼의 엔진 호출 — 도는 동안 버튼을 막고, 실패하면 엔진 문구를 남긴다(다시 누를 수 있게).
 * after 'hold' = 성공하면 막은 채로 둔다 — 엔진 이벤트가 곧 카드를 치운다(두 번 눌리지 않게).
 */
export function useCall() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const call = useCallback((fn: () => Promise<unknown>, after: 'free' | 'hold' = 'free') => {
    setBusy(true)
    setError(null)
    fn().then(
      () => {
        if (after === 'free') setBusy(false)
      },
      e => {
        setBusy(false)
        setError(errorMessage(e))
      },
    )
  }, [])
  return { busy, error, call }
}
