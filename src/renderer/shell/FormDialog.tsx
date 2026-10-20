import { useId, useRef, type FormEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { useMotion } from '../lib/presence'

interface Props {
  title: string
  /** 주 버튼 글 — 추가 · 저장 · 만들기 */
  submitLabel: string
  /** 칸이 다 차서 보낼 수 있는가 — 아니면 주 버튼이 막힌다(Enter 도) */
  canSubmit: boolean
  /** 보내는 중 — 버튼이 막히고 Esc·바깥 누르기·취소가 듣지 않는다 */
  busy: boolean
  onSubmit: () => void
  /** 취소 · Esc · 바깥 누르기 */
  onClose: () => void
  /** 어느 칸에도 맞지 않는 엔진 문구 — 버튼 위에 */
  error?: string | null
  children: ReactNode
}

/**
 * 입력 대화상자 틀(방 만들기·에이전트 추가·설정) — 확인 대화상자와 같은 막·면·그림자.
 * 열리면 첫 입력칸에 포커스, 포커스는 안에서만 돌고, 닫히면 연 자리로 돌아간다.
 */
export function FormDialog(props: Props) {
  return createPortal(<Frame {...props} />, document.body)
}

function Frame({ title, submitLabel, canSubmit, busy, onSubmit, onClose, error, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const submitButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  useMotion(backdrop, MOTION.backdrop)
  useMotion(ref, MOTION.dialog)

  const close = () => {
    if (!busy) onClose()
  }
  useDialogFocus(ref, close, box => box.querySelector<HTMLElement>('input:not(:disabled)'))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!canSubmit || busy) return
    // 버튼이 막히면 포커스가 body 로 떨어진다 — 그 전에 대화상자로 옮겨 둔다
    if (document.activeElement === submitButton.current) ref.current?.focus()
    onSubmit()
  }

  // 바깥(막)을 누르면 닫는다 — 대화상자 안에서 시작한 누름은 아니다
  const onBackdrop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) close()
  }

  return (
    <div ref={backdrop} className="dlg-bd" onPointerDown={onBackdrop}>
      <div
        ref={ref}
        className="dlg dlg-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <form onSubmit={submit} noValidate>
          <h2 id={titleId} className="dlg-t">
            {title}
          </h2>
          {children}
          {error && (
            <p className="dlg-err" role="alert">
              {error}
            </p>
          )}
          <div className="dlg-ab">
            <button type="button" className="btn sec" onClick={close} disabled={busy}>
              취소
            </button>
            <button ref={submitButton} type="submit" className="btn pri" disabled={!canSubmit || busy}>
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
