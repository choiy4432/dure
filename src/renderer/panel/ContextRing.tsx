import { useCallback, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentId, ContextUsage } from '../../engine/types'
import { useDismiss } from '../lib/popover'
import { tokensText } from '../lib/words'

interface Props {
  agentId: AgentId
  name: string
  value: ContextUsage | null
  /** 일하는 중 — 요약은 일이 끝난 뒤에 */
  working: boolean
  onCompact: () => void
}

/** 링 지름 · 선 두께 · 반지름(px) */
const SIZE = 18
const STROKE = 2.5
const R = (SIZE - STROKE) / 2
const CIRC = 2 * Math.PI * R
/** 자동 요약 지점의 이만큼부터 앰버 */
const WARN_AT = 0.8

/** 입력창 아래 줄의 대화 공간 링 + 누르면 펼침(쓴 토큰 · 자동 요약 지점 · 지금 요약하기) */
export function ContextRing({ name, value, working, onCompact }: Props) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, wrap, close)

  if (!value) return null
  const { percent, total, max, autoCompactAt } = value
  const at = autoCompactAt ? Math.round((autoCompactAt / max) * 100) : null
  const warn = percent >= WARN_AT * (autoCompactAt ? (autoCompactAt / max) * 100 : 100)
  const fill = Math.min(100, Math.max(0, percent))

  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    setOpen(false)
    btn.current?.focus()
  }

  return (
    <span className={`ctx${warn ? ' warn' : ''}`} ref={wrap} onKeyDown={onKey}>
      <button
        ref={btn}
        type="button"
        className="ctx-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`대화 공간 ${percent}% 사용`}
        onClick={() => setOpen(o => !o)}
      >
        <svg className="ctx-ring" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle className="ctx-bg" cx={SIZE / 2} cy={SIZE / 2} r={R} />
          <circle
            className="ctx-fg"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            strokeDasharray={`${(CIRC * fill) / 100} ${CIRC}`}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </svg>
        <span className="ctx-n">{percent}%</span>
      </button>
      {open && (
        <div className="pop ctx-pop" role="dialog" aria-label={`대화 공간 · ${name}`}>
          <h3 className="ctx-h">
            대화 공간 <span>· {name}</span>
          </h3>
          <div className="ctx-row">
            <span>{percent}% 사용</span>
            <b>
              {tokensText(total)} / {tokensText(max)} 토큰
            </b>
          </div>
          <span className="ctx-bar">
            <span style={{ width: `${fill}%` }} />
          </span>
          <p className="ctx-note">
            {at !== null
              ? `${at}%가 되면 Claude 가 대화를 요약해서 이어 가요`
              : '자동 요약이 꺼져 있어요 — 가득 차기 전에 요약해 주세요'}
          </p>
          <button
            type="button"
            className="lk ctx-go"
            disabled={working}
            onClick={() => {
              setOpen(false)
              onCompact()
            }}
          >
            지금 요약하기
          </button>
          {working && <p className="ctx-note">일이 끝나면 요약할 수 있어요</p>}
        </div>
      )}
    </span>
  )
}
