import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CircleAlert, ShieldAlert, Square } from 'lucide-react'
import type { AgentId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { getStore, useDure } from '../state/store'
import { displayStatus, type DisplayStatus } from '../state/selectors'
import { errorMessage, initial, STATUS_WORD } from '../lib/words'
import { ModelPicker, type Described } from './ModelPicker'
import { AgentMenu } from './AgentMenu'

// 상태 알약 — 작업 중 초록 · 승인 기다림 앰버 · 대기 회색 · 멈춤 빨강
const PILL: Record<DisplayStatus, { tone: string; dot: string }> = {
  working: { tone: 'w', dot: 'g' },
  awaiting: { tone: 'p', dot: 'a' },
  idle: { tone: '', dot: 's' },
  stopped: { tone: '', dot: 's' },
  error: { tone: 'e', dot: 'r' },
}

interface Props {
  agentId: AgentId
  description: Described
  /** 모델 목록이 열릴 때 — 아직 안 받았으면 describe */
  onLoadDescription: () => void
  onRetryDescribe: () => void
  /** 모델 목록을 밖에서 열고 닫을 때(입력창의 /model) */
  modelOpen?: boolean
  onModelOpenChange?: (open: boolean) => void
}

/** 패널 머리(시안 .ph) — 아바타·이름·역할·멈추기·메뉴 / 상태 알약·모델 칩·자동 스위치 + 오류·묻지 않음 띠 */
export function PanelHeader({ agentId, description, onLoadDescription, onRetryDescribe, modelOpen, onModelOpenChange }: Props) {
  const v = useDure(s => {
    const agent = s.agents.find(a => a.id === agentId)
    return agent ? { agent, status: displayStatus(agent, s.requests) } : null
  })
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const savingAuto = useRef(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)

  // 바꾸기를 마치면 포커스를 메뉴 버튼으로 — 버튼은 입력칸이 닫힌 뒤에야 다시 생긴다
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    menuButton.current?.focus()
  }, [editing])

  if (!v) return null
  const { agent, status } = v
  const pill = PILL[status]
  const canStop = (status === 'working' || status === 'awaiting') && !stopping

  const stop = async () => {
    setError(null)
    setStopping(true)
    try {
      await window.dure.interrupt(agent.id)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStopping(false)
    }
  }

  const toggleAuto = async () => {
    if (savingAuto.current) return
    savingAuto.current = true
    setError(null)
    try {
      await window.dure.updateAgent(agent.id, { auto: !agent.auto })
      await getStore().refresh()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      savingAuto.current = false
    }
  }

  const doneEditing = () => {
    refocus.current = true
    setEditing(false)
  }

  return (
    <>
      <div className="ph">
        <div className={`ph-row${editing ? ' ph-row-edit' : ''}`}>
          <span className="av b" aria-hidden="true">
            {initial(agent.name)}
          </span>
          {editing ? (
            <NameEdit agent={agent} onDone={doneEditing} />
          ) : (
            <>
              <div className="ph-id">
                <h2 className="pn trunc" title={agent.name}>
                  {agent.name}
                </h2>
                {agent.role && (
                  <div className="pr trunc" title={agent.role}>
                    {agent.role}
                  </div>
                )}
              </div>
              <div className="ph-acts">
                <button type="button" className="btn sec" disabled={!canStop} onClick={stop}>
                  <Square className="i ph-stop" size={11} strokeWidth={1.2} absoluteStrokeWidth aria-hidden="true" />
                  멈추기
                </button>
                <AgentMenu agent={agent} onEdit={() => setEditing(true)} onError={setError} buttonRef={menuButton} />
              </div>
            </>
          )}
        </div>
        <div className="ph-row ph-r2">
          <span className={`pill${pill.tone ? ` ${pill.tone}` : ''}`}>
            <i className={`dot ${pill.dot}`} aria-hidden="true" />
            {STATUS_WORD[status]}
          </span>
          <ModelPicker
            agentId={agent.id}
            model={agent.model}
            description={description}
            onLoad={onLoadDescription}
            onRetry={onRetryDescribe}
            open={modelOpen}
            onOpenChange={onModelOpenChange}
            onError={setError}
          />
          <button
            type="button"
            className="sw"
            role="switch"
            aria-checked={agent.auto}
            title="받은 메시지를 바로 시작해요"
            onClick={toggleAuto}
          >
            자동
            <span className="tg" aria-hidden="true" />
          </button>
        </div>
        {error && (
          <p className="ph-msg" role="alert">
            {error}
          </p>
        )}
      </div>
      {status === 'error' && (
        <div className="band err">
          <CircleAlert className="i" aria-hidden="true" />
          <div className="band-tx">
            <span className="band-t">{agent.errorText || '오류로 멈췄어요'}</span>
            <span className="band-h">
              <b>다시 시도</b> · 다음에 일을 시키면 다시 켜져요
            </span>
          </div>
        </div>
      )}
      {agent.bypass && (
        <div className="band warn">
          <ShieldAlert className="i" aria-hidden="true" />
          <span className="band-t">이 에이전트는 묻지 않고 실행해요 (Claude 설정의 전부 허용)</span>
        </div>
      )}
    </>
  )
}

/** 이름·역할 바꾸기 — 머리의 같은 자리에서. 엔진 오류(이름 겹침 등)는 칸 아래 그대로 */
function NameEdit({ agent, onDone }: { agent: AgentView; onDone: () => void }) {
  const [name, setName] = useState(agent.name)
  const [role, setRole] = useState(agent.role)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInput.current?.focus()
    nameInput.current?.select()
  }, [])

  const save = async () => {
    if (busy) return
    const next = { name, role: role.trim() }
    if (next.name === agent.name && next.role === agent.role) {
      onDone()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.dure.updateAgent(agent.id, next)
      await getStore().refresh()
      onDone()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onDone()
    }
  }

  return (
    <>
      <div className="ph-edit">
        <input
          ref={nameInput}
          className="inp inp-n"
          aria-label="이름"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={onKey}
          aria-invalid={error ? true : undefined}
        />
        <input
          className="inp"
          aria-label="역할"
          placeholder="예: 기획서 · 문구"
          value={role}
          onChange={e => setRole(e.target.value)}
          onKeyDown={onKey}
        />
        {error && <p className="fe">{error}</p>}
      </div>
      <div className="ph-acts ph-acts-top">
        <button type="button" className="btn sec sm" onClick={onDone}>
          취소
        </button>
        <button type="button" className="btn pri sm" disabled={busy} onClick={() => void save()}>
          저장
        </button>
      </div>
    </>
  )
}
