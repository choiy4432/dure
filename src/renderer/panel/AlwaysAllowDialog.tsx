import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AgentView } from '../../shared/ipcContract'
import { errorMessage, josa } from '../lib/words'
import { toolNoun } from '../lib/toolSummary'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { Presence, PresenceList, useMotion } from '../lib/presence'

interface Props {
  open: boolean
  agent: AgentView
  onClose: () => void
}

/** 되돌린 뒤 초점을 옮길 곳 — 남은 줄의 [되돌리기](그 도구) 또는 [닫기] */
type FocusTo = { tool: string } | 'close'

/** '항상 허용한 일' — 승인 카드에서 '앞으로 … 묻지 않기' 로 쌓인 도구를 보고 하나씩 되돌린다 */
export function AlwaysAllowDialog(props: Props) {
  return <Presence show={props.open}>{createPortal(<Dialog {...props} />, document.body)}</Presence>
}

function Dialog({ agent, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focusTo, setFocusTo] = useState<FocusTo | null>(null)
  const titleId = useId()
  useMotion(backdrop, MOTION.backdrop)
  useMotion(ref, MOTION.dialog)

  useDialogFocus(ref, onClose, box => box.querySelector<HTMLElement>('[data-undo], [data-close]'))

  // 되돌린 줄은 나가며 inert 가 되고 누르던 단추는 막혀 있었다 — 초점이 body 로 떨어지지 않게 다음 줄(마지막이면 앞 줄)이나 [닫기]로
  useEffect(() => {
    if (!focusTo || busy !== null) return
    const box = ref.current
    if (!box) return
    const target =
      focusTo === 'close'
        ? box.querySelector<HTMLElement>('[data-close]')
        : [...box.querySelectorAll<HTMLElement>('[data-undo]')].find(b => b.dataset.undo === focusTo.tool && !b.closest('[inert]'))
    target?.focus()
    setFocusTo(null)
  }, [focusTo, busy])

  // 목록은 엔진의 always-allow 사건으로 바뀐다(스냅샷을 다시 받지 않는다) — 이 대화상자는 늘 지금 에이전트를 읽는다
  const undo = async (tool: string) => {
    const list = agent.alwaysAllow
    const at = list.indexOf(tool)
    const rest = list.filter(t => t !== tool)
    const next = rest[at] ?? rest[at - 1]
    setError(null)
    setBusy(tool)
    try {
      await window.dure.revokeAlwaysAllow(agent.id, tool)
      setFocusTo(next !== undefined ? { tool: next } : 'close')
    } catch (e) {
      setError(errorMessage(e))
      setFocusTo({ tool })
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
            {/* 되돌린 줄은 MOTION.line 으로 나간다 — 마지막 줄이면 목록 대신 빈 안내가 바로 선다 */}
            <PresenceList>
              {agent.alwaysAllow.map(tool => (
                <Row key={tool} tool={tool} disabled={busy !== null} onUndo={() => void undo(tool)} />
              ))}
            </PresenceList>
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

/** 늘 허용한 도구 한 줄 — 도구 뜻 · 영문 이름 · [되돌리기] */
function Row({ tool, disabled, onUndo }: { tool: string; disabled: boolean; onUndo: () => void }) {
  const ref = useRef<HTMLLIElement>(null)
  useMotion(ref, MOTION.line)
  return (
    <li ref={ref} className="aa-row">
      <span className="aa-noun">{toolNoun(tool)}</span>
      <span className="aa-name">{tool}</span>
      <button type="button" className="btn sec sm" data-undo={tool} disabled={disabled} onClick={onUndo}>
        되돌리기
      </button>
    </li>
  )
}
