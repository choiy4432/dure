import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { AgentDescription, AgentId } from '../../engine/types'
import { getStore } from '../state/store'
import { errorMessage, modelText } from '../lib/words'
import { moveMenuFocus, useDismiss } from '../lib/popover'

/**
 * describe(id) 결과 — 패널이 에이전트마다 한 번 받아 둔다.
 * idle = 아직 안 받음. describe 는 claude 를 켜므로 고르기만으로는 부르지 않고, 목록을 열 때 받는다.
 */
export type Described =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; value: AgentDescription }
  | { state: 'error'; error: string }

interface Props {
  agentId: AgentId
  /** agent.model — null 이면 기본(default) */
  model: string | null
  description: Described
  /** 아직 안 받았으면 describe — 목록이 열릴 때 부른다(한 에이전트에 한 번) */
  onLoad: () => void
  /** 실패한 describe 다시 받기 */
  onRetry: () => void
  /** 밖에서 열고 닫을 때(입력창의 /model) — 주지 않으면 스스로 연다 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 모델을 못 바꿨을 때 엔진 문구 */
  onError?: (message: string) => void
}

/** 패널 머리의 모델 칩(시안 .chip) + 목록 */
export function ModelPicker({ agentId, model, description, onLoad, onRetry, open, onOpenChange, onError }: Props) {
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
  // 칩 이름은 describe 없이도 — 목록을 받았으면 모르는 값은 Claude 가 준 이름으로
  const label = modelText(current, models?.find(m => m.value === current)?.displayName).name

  // 목록이 열리면(칩·/model 어느 쪽이든) 그때 처음 describe
  useEffect(() => {
    if (isOpen && description.state === 'idle') onLoad()
  }, [isOpen, description.state, onLoad])

  // 열리면(또는 목록이 도착하면) 지금 모델로 포커스
  useEffect(() => {
    if (!isOpen) return
    const box = menu.current
    const el = box?.querySelector<HTMLElement>('[aria-checked="true"]') ?? box?.querySelector<HTMLElement>('button')
    el?.focus()
  }, [isOpen, description.state])

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
        aria-label={`모델 ${label}`}
        title="모델 고르기"
        onClick={() => setOpen(!isOpen)}
      >
        <span className="chip-l trunc">{label}</span>
        <ChevronDown className="i" aria-hidden="true" />
      </button>
      {isOpen && (
        <div
          ref={menu}
          className="pop"
          role="menu"
          aria-label="모델"
          aria-busy={description.state === 'idle' || description.state === 'loading' || undefined}
          onKeyDown={onKey}
        >
          {models ? (
            models.map(m => {
              const t = modelText(m.value, m.displayName)
              return (
                <button
                  key={m.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={m.value === current}
                  className="mi"
                  onClick={() => void pick(m.value)}
                >
                  <span className="mi-tx">
                    <span className="mi-t">{t.name}</span>
                    {t.description && <span className="mi-d">{t.description}</span>}
                  </span>
                  {m.value === current && <Check className="i mi-ck" aria-hidden="true" />}
                </button>
              )
            })
          ) : description.state === 'error' ? (
            <div className="pop-note">
              모델 목록을 받지 못했어요
              <button type="button" className="lk" onClick={onRetry}>
                다시 시도
              </button>
            </div>
          ) : (
            <p className="pop-note">모델 목록을 불러오는 중…</p>
          )}
        </div>
      )}
    </span>
  )
}
