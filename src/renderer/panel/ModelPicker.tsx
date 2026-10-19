import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { AgentDescription, AgentId } from '../../engine/types'
import { getStore } from '../state/store'
import { errorMessage } from '../lib/words'
import { moveMenuFocus, useDismiss } from '../lib/popover'

/** describe(id) 결과 — 패널이 에이전트마다 한 번 받아 둔다 */
export type Described =
  | { state: 'loading' }
  | { state: 'ready'; value: AgentDescription }
  | { state: 'error'; error: string }

interface Props {
  agentId: AgentId
  /** agent.model — null 이면 기본(default) */
  model: string | null
  description: Described
  /** describe 다시 받기 */
  onRetry: () => void
  /** 밖에서 열고 닫을 때(입력창의 /model) — 주지 않으면 스스로 연다 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 모델을 못 바꿨을 때 엔진 문구 */
  onError?: (message: string) => void
}

/** 패널 머리의 모델 칩(시안 .chip) + 목록 */
export function ModelPicker({ agentId, model, description, onRetry, open, onOpenChange, onError }: Props) {
  const [innerOpen, setInnerOpen] = useState(false)
  const isOpen = open ?? innerOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInnerOpen(next)
      onOpenChange?.(next)
    },
    [open, onOpenChange],
  )
  const close = useCallback(() => setOpen(false), [setOpen])
  const wrap = useRef<HTMLSpanElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useDismiss(isOpen, wrap, close)

  const current = model ?? 'default'
  const models = description.state === 'ready' ? description.value.models : null
  const label = models ? (models.find(m => m.value === current)?.displayName || current) : '모델'

  // 열리면(또는 목록이 도착하면) 지금 모델로 포커스
  useEffect(() => {
    if (!isOpen) return
    const box = menu.current
    const el = box?.querySelector<HTMLElement>('[aria-checked="true"]') ?? box?.querySelector<HTMLElement>('button')
    el?.focus()
  }, [isOpen, description.state])

  const toggle = () => {
    // 목록을 못 받았으면 다시 받으며 연다 — 열린 목록이 '불러오는 중' 을 보여 준다
    if (description.state === 'error') {
      onRetry()
      setOpen(true)
      return
    }
    setOpen(!isOpen)
  }

  const pick = async (value: string) => {
    setOpen(false)
    chip.current?.focus()
    if (value === current) return
    try {
      await window.dure.setModel(agentId, value === 'default' ? null : value)
      await getStore().refresh()
    } catch (e) {
      onError?.(errorMessage(e))
    }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      chip.current?.focus()
      return
    }
    if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    moveMenuFocus(e)
  }

  return (
    <span className="mp" ref={wrap}>
      <button
        ref={chip}
        type="button"
        className="chip"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={models ? `모델 ${label}` : '모델'}
        aria-busy={description.state === 'loading' || undefined}
        title="모델 고르기"
        onClick={toggle}
      >
        <span className="chip-l trunc">{label}</span>
        <ChevronDown className="i" aria-hidden="true" />
      </button>
      {isOpen && (
        <div ref={menu} className="pop" role="menu" aria-label="모델" onKeyDown={onKey}>
          {models ? (
            models.map(m => (
              <button
                key={m.value}
                type="button"
                role="menuitemradio"
                aria-checked={m.value === current}
                className="mi"
                onClick={() => void pick(m.value)}
              >
                <span className="mi-tx">
                  <span className="mi-t">{m.displayName || m.value}</span>
                  {m.description && <span className="mi-d">{m.description}</span>}
                </span>
                {m.value === current && <Check className="i mi-ck" aria-hidden="true" />}
              </button>
            ))
          ) : description.state === 'loading' ? (
            <p className="pop-note">모델 목록을 불러오는 중…</p>
          ) : (
            <div className="pop-note">
              모델 목록을 받지 못했어요
              <button type="button" className="lk" onClick={onRetry}>
                다시 시도
              </button>
            </div>
          )}
        </div>
      )}
    </span>
  )
}
