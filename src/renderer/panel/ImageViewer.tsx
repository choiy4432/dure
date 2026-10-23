import { useEffect, useLayoutEffect, useRef, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-react'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { Presence, useLeaving, useMotion } from '../lib/presence'
import { IMAGE_GONE, IMAGE_OLD } from '../lib/words'
import { useImageSource, type ViewerSource } from './savedImage'

export type { ViewerSource }

interface Props {
  open: boolean
  sources: ViewerSource[]
  /** 보고 있는 그림 — 부르는 쪽이 들고 있다(넘기면 onIndex) */
  index: number
  onIndex: (i: number) => void
  /** 닫기 버튼 · Esc · 막 누르기 */
  onClose: () => void
}

/** 그림 크게 보기 — 앱 위 흐린 막에 한 장씩. 여러 장이면 ‹ › 와 ← → 로 넘긴다. 열려 있는 동안 초점은 안에서만 돈다 */
export function ImageViewer(props: Props) {
  return <Presence show={props.open && props.sources.length > 0}>{createPortal(<Viewer {...props} />, document.body)}</Presence>
}

function Viewer({ sources, index, onIndex, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  useMotion(box, MOTION.backdrop)
  useMotion(stage, MOTION.dialog)
  useDialogFocus(box, onClose, b => b.querySelector<HTMLElement>('[data-close]'))

  const n = sources.length
  // 보던 그림이 빠져도(입력창에서 지움) 남은 범위 안에서
  const at = Math.min(Math.max(index, 0), n - 1)
  const go = (i: number) => {
    if (i >= 0 && i < n && i !== at) onIndex(i)
  }

  // ← → — 문서에서 받는다(초점이 어디 있든). 나가는 동안은 듣지 않는다
  const live = useRef({ at, go })
  useLayoutEffect(() => {
    live.current = { at, go }
  })
  const leaving = useLeaving()
  useEffect(() => {
    if (leaving || n < 2) return
    const onKey = (e: KeyboardEvent) => {
      const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      if (!step) return
      e.preventDefault()
      live.current.go(live.current.at + step)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [leaving, n])

  // 그림·버튼 밖(막)을 누르면 닫는다
  const onBackdrop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget || e.target === stage.current) onClose()
  }

  return (
    <div ref={box} className="iv-bd" role="dialog" aria-modal="true" aria-label="이미지 보기" tabIndex={-1} onPointerDown={onBackdrop}>
      <div ref={stage} className="iv-stage">
        <Shown key={at} source={sources[at]} label={`이미지 ${at + 1}/${n}`} />
      </div>
      {n > 1 && (
        <>
          <button type="button" className="iv-nav prev" aria-label="이전 이미지" title="이전 (←)" disabled={at === 0} onClick={() => go(at - 1)}>
            <ChevronLeft className="i" size={20} aria-hidden="true" />
          </button>
          <button type="button" className="iv-nav next" aria-label="다음 이미지" title="다음 (→)" disabled={at === n - 1} onClick={() => go(at + 1)}>
            <ChevronRight className="i" size={20} aria-hidden="true" />
          </button>
          <p className="iv-count" aria-live="polite">
            {at + 1} / {n}
          </p>
        </>
      )}
      <button type="button" className="iv-x" data-close aria-label="닫기" title="닫기 (Esc)" onClick={onClose}>
        <X className="i" size={18} aria-hidden="true" />
      </button>
    </div>
  )
}

/** 보고 있는 한 장 — 읽는 중·볼 수 없음은 그림 자리에 안내 */
function Shown({ source, label }: { source: ViewerSource; label: string }) {
  const s = useImageSource(source)
  if (s.state === 'ready') return <img className="iv-img" src={s.src} alt={label} draggable={false} />
  if (s.state === 'loading') return <div className="iv-note wait" role="status" aria-label={`${label} 불러오는 중`} />
  return (
    <div className="iv-note">
      <ImageOff className="i" size={20} aria-hidden="true" />
      <p>{s.why === 'old' ? IMAGE_OLD : IMAGE_GONE}</p>
    </div>
  )
}
