import { useId, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AgentView } from '../../shared/ipcContract'
import { getStore } from '../state/store'
import { errorMessage, josa } from '../lib/words'
import { toolNoun } from '../lib/toolSummary'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { Presence, useMotion } from '../lib/presence'

interface Props {
  open: boolean
  agent: AgentView
  onClose: () => void
}

/** '항상 허용한 일' — 승인 카드에서 '앞으로 … 묻지 않기' 로 쌓인 도구를 보고 하나씩 되돌린다 */
export function AlwaysAllowDialog(props: Props) {
  return <Presence show={props.open}>{createPortal(<Dialog {...props} />, document.body)}</Presence>
}

function Dialog({ agent, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  useMotion(backdrop, MOTION.backdrop)
  useMotion(ref, MOTION.dialog)

  useDialogFocus(ref, onClose, box => box.querySelector<HTMLElement>('[data-undo], [data-close]'))

  // 되돌리기는 이벤트를 보내지 않는다 — 끝나면 스냅샷을 다시 받아 목록을 바꾼다
  const undo = async (tool: string) => {
    setError(null)
    setBusy(tool)
    try {
      await window.dure.revokeAlwaysAllow(agent.id, tool)
      await getStore().refresh()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const onBackdrop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div ref={backdrop} className="dlg-bd" onPointerDown={onBackdrop}>
      <div ref={ref} className="dlg" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId} className="dlg-t">
          {agent.name}
          {josa(agent.name, '이/가')} 묻지 않고 하는 일
        </h2>
        <p className="dlg-d">여기 있는 일은 승인 없이 바로 해요. 되돌리면 다음부터 다시 물어요.</p>
        {agent.bypass && <p className="dlg-d aa-bypass">지금은 묻지 않음이 켜져 있어 모든 일을 묻지 않아요</p>}
        {agent.alwaysAllow.length === 0 ? (
          <div className="aa-empty">
            <p className="aa-empty-t">묻지 않고 하는 일이 없어요</p>
            <p className="aa-empty-d">승인 카드의 '앞으로 … 묻지 않기'로 생겨요</p>
          </div>
        ) : (
          <ul className="aa-list">
            {agent.alwaysAllow.map(tool => (
              <li key={tool} className="aa-row">
                <span className="aa-noun">{toolNoun(tool)}</span>
                <span className="aa-name">{tool}</span>
                <button type="button" className="btn sec sm" data-undo disabled={busy !== null} onClick={() => undo(tool)}>
                  되돌리기
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="dlg-err">{error}</p>}
        <div className="dlg-ab">
          <button type="button" className="btn sec" data-close onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}
