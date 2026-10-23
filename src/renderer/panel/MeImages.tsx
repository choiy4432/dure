import { useMemo, useState } from 'react'
import { ImageOff } from 'lucide-react'
import type { AgentId } from '../../engine/types'
import { IMAGE_GONE, IMAGE_OLD } from '../lib/words'
import { ImageViewer } from './ImageViewer'
import { useImageSource, type ViewerSource } from './savedImage'

/** 말풍선에 보이는 썸네일 수 — 넘치면 마지막 칸이 '+N'(그 칸부터 크게) */
const SHOWN_MAX = 4

/** 내 말풍선의 그림 — 작은 썸네일 줄, 누른 그림부터 크게 */
export function MeImages({ agentId, files }: { agentId?: AgentId; files: (string | null)[] }) {
  const [at, setAt] = useState<number | null>(null)
  const sources = useMemo<ViewerSource[]>(() => files.map(file => ({ agentId: agentId ?? '', file })), [agentId, files])
  const n = files.length
  const tiles = Math.min(n, SHOWN_MAX)
  return (
    <div className="me-ims">
      {sources.slice(0, tiles).map((source, i) => {
        const more = n > SHOWN_MAX && i === SHOWN_MAX - 1 ? n - (SHOWN_MAX - 1) : 0
        return (
          <Thumb
            key={i}
            source={source}
            label={`이미지 ${i + 1}/${n} 크게 보기${more ? ` · ${more}장 더` : ''}`}
            more={more}
            onOpen={() => setAt(i)}
          />
        )
      })}
      <ImageViewer open={at !== null} sources={sources} index={at ?? 0} onIndex={setAt} onClose={() => setAt(null)} />
    </div>
  )
}

function Thumb({ source, label, more, onOpen }: { source: ViewerSource; label: string; more: number; onOpen: () => void }) {
  const s = useImageSource(source)
  const why = s.state === 'missing' ? (s.why === 'old' ? IMAGE_OLD : IMAGE_GONE) : undefined
  const cls = s.state === 'ready' ? 'me-th' : s.state === 'loading' ? 'me-th wait' : 'me-th empty'
  return (
    <button type="button" className={cls} aria-label={label} title={why} onClick={onOpen}>
      {s.state === 'ready' && <img src={s.src} alt="" draggable={false} />}
      {s.state === 'missing' && <ImageOff className="i" size={16} aria-hidden="true" />}
      {more > 0 && (
        <span className="me-more" aria-hidden="true">
          +{more}
        </span>
      )}
    </button>
  )
}
