import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { errorMessage } from '../lib/words'

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

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** 앱 안 확인 대화상자 — 브라우저 confirm 대신. 열려 있는 동안 포커스는 안에서만 돈다 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null
  return createPortal(<Dialog {...props} />, document.body)
}

function Dialog({ title, body, confirmLabel, cancelLabel = '취소', danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const bodyId = useId()

  // 열리면 안으로 포커스(위험한 확인은 취소에 먼저), 닫히면 연 자리로 돌려준다
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>(danger ? '[data-cancel]' : '[data-confirm]')?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [danger])

  const cancel = () => {
    if (!busy) onCancel()
  }

  const confirm = async () => {
    setError(null)
    const done: unknown = onConfirm()
    if (!(done instanceof Promise)) return
    setBusy(true)
    try {
      await done
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      cancel()
      return
    }
    if (e.key !== 'Tab') return
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const at = document.activeElement
    if (e.shiftKey && (at === first || !ref.current?.contains(at))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (at === last || !ref.current?.contains(at))) {
      e.preventDefault()
      first.focus()
    }
  }

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
        onKeyDown={onKey}
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
          <button type="button" className={`btn ${danger ? 'dng' : 'pri'}`} data-confirm onClick={confirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
