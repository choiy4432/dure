import { useRef } from 'react'
import { CirclePause } from 'lucide-react'
import type { RoomId } from '../../../engine/types'
import { useCall } from './useCall'
import { useMotion } from '../../lib/presence'
import { MOTION } from '../../lib/motion'

/** 자동 상한 카드 — 자동 전달이 상한만큼 이어져 멈춘 방에 한 장. [계속] 이면 기다리던 메시지를 다 보낸다 */
export function HeldChainCard({ roomId, limit }: { roomId: RoomId; limit: number }) {
  const { busy, error, call } = useCall()
  const root = useRef<HTMLElement>(null)
  useMotion(root, MOTION.line)
  const text = `자동 전달이 ${limit}번 이어졌어요 — 계속할까요?`
  return (
    <section ref={root} className="pin ask hc" aria-label={text}>
      <div className="held">
        <CirclePause className="i held-ic" aria-hidden="true" />
        <b className="ask-t">{text}</b>
        <button
          type="button"
          className="btn pri sm"
          disabled={busy}
          onClick={() => call(() => window.dure.continueHeld(roomId), 'hold')}
        >
          계속
        </button>
      </div>
      {error && (
        <p className="pin-err" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
