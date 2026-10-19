import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { errorMessage } from '../lib/words'
import { useDialogFocus } from '../lib/dialog'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  body?: string
  confirmLabel: string
  cancelLabel?: string
  /** 되돌릴 수 없는 일(지우기) — 확인 버튼이 빨강, 처음 포커스는 취소에 */
  danger?: boolean
  /**
   * 약속을 돌려주면 끝날 때까지 버튼을 막고, 실패하면 그 문구를 대화상자 안에 보여 준다.
   * 닫는 건 부르는 쪽이 open 을 false 로 바꿔서 한다.
   */
  onConfirm: () => void | Promise<void>
  /** 취소 · Esc · 바깥 누르기 */
  onCancel: () => void
}

/** 앱 안 확인 대화상자 — 브라우저 confirm 대신. 열려 있는 동안 포커스는 안에서만 돈다 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null
  return createPortal(<Dialog {...props} />, document.body)
}

function Dialog({ title, body, confirmLabel, cancelLabel = '취소', danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const bodyId = useId()

  const cancel = () => {
    if (!busy) onCancel()
  }

  // 열리면 안으로 포커스(위험한 확인은 취소에 먼저), 닫히면 연 자리로 돌려준다 · Esc 는 기다리는 동안 무시
  useDialogFocus(ref, cancel, box => box.querySelector<HTMLElement>(danger ? '[data-cancel]' : '[data-confirm]'))

  const confirm = async () => {
    setError(null)
    const done: unknown = onConfirm()
    if (!(done instanceof Promise)) return
    // 버튼이 막히면 포커스가 body 로 떨어진다 — 그 전에 대화상자로 옮겨 둔다
    ref.current?.focus()
    setBusy(true)
    try {
      await done
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  // 기다림이 끝났는데 아직 열려 있으면(실패) 확인 버튼으로 포커스를 돌려준다
  const wasBusy = useRef(false)
  useEffect(() => {
    if (busy) {
      wasBusy.current = true
      return
    }
    if (!wasBusy.current) return
    wasBusy.current = false
    confirmButton.current?.focus()
  }, [busy])

  // 바깥(막)을 누르면 닫는다 — 대화상자 안에서 시작한 누름은 아니다
  const onBackdrop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) cancel()
  }

  return (
    <div className="dlg-bd" onPointerDown={onBackdrop}>
      <div
        ref={ref}
        className="dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={body ? bodyId : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <h2 id={titleId} className="dlg-t">
          {title}
        </h2>
        {body && (
          <p id={bodyId} className="dlg-d">
            {body}
          </p>
        )}
        {error && <p className="dlg-err">{error}</p>}
        <div className="dlg-ab">
          <button type="button" className="btn sec" data-cancel onClick={cancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            ref={confirmButton}
            type="button"
            className={`btn ${danger ? 'dng' : 'pri'}`}
            data-confirm
            onClick={confirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
