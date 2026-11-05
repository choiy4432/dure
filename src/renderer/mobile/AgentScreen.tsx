// 휴대폰 대화 화면(시안 A) — 화면 전체. 머리 ‹ · 아바타 · 이름 · 상태 알약 · ⋯(설정 판), 몸통은 PC 패널의 탭·고정 카드·대화·입력창 그대로
import { useEffect, useId, useRef, useState } from 'react'
import { CircleStop, Ellipsis, History } from 'lucide-react'
import type { AgentView } from '../../shared/ipcContract'
import { getStore, useDure } from '../state/store'
import { errorMessage, fieldError, initial, PAST } from '../lib/words'
import { AgentPanel, type PanelHeaderSlot } from '../panel/AgentPanel'
import { AutoSwitch, PanelBands, StatusPill, useHeaderView } from '../panel/PanelHeader'
import { ModelPicker } from '../panel/ModelPicker'
import { EffortControl } from '../panel/EffortControl'
import { LevelSwitch } from '../panel/LevelSwitch'
import { AgentMenu } from '../panel/AgentMenu'
import { useSendingFiles } from '../panel/drafts'
import { FormDialog } from '../shell/FormDialog'
import { MobileTop, OfflineBand, Sheet } from './parts'

/** 대화 화면 — 열린 대화 = 스토어의 고른 에이전트(다시 이어지면 이 기록을 다시 받는다). 고르기는 MobileApp 이 한다 */
export function AgentScreen({ onBack }: { onBack: () => void }) {
  return (
    <main className="m-scr m-agent">
      <AgentPanel header={slot => <PhoneHeader slot={slot} onBack={onBack} />} />
    </main>
  )
}

function PhoneHeader({ slot, onBack }: { slot: PanelHeaderSlot; onBack: () => void }) {
  const v = useHeaderView(slot.agentId)
  const [sheet, setSheet] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 입력창의 /model — 설정 판을 열고 그 안의 모델 목록을 연다
  useEffect(() => {
    if (slot.modelOpen) setSheet(true)
  }, [slot.modelOpen])
  if (!v) return null
  const { agent, status, look, host } = v
  const close = () => {
    setSheet(false)
    slot.onModelOpenChange(false)
  }
  const open = () => {
    setError(null) // 판을 다시 열면 지난 오류는 지운다(다시 해 보는 중)
    setSheet(true)
  }
  return (
    <>
      <MobileTop
        onBack={onBack}
        actions={
          <button type="button" className="m-ib" aria-label="에이전트 설정" aria-haspopup="dialog" onClick={open}>
            <Ellipsis className="i" size={20} aria-hidden="true" />
          </button>
        }
      >
        <span className="av b m-av" aria-hidden="true">
          {initial(agent.name)}
        </span>
        <div className="m-who">
          <h1 className="trunc">{agent.name}</h1>
          {agent.role && <span className="trunc">{agent.role}</span>}
        </div>
        <StatusPill agent={agent} look={look} />
      </MobileTop>
      <OfflineBand />
      {error && (
        <p className="ph-msg m-msg" role="alert">
          {error}
        </p>
      )}
      <PanelBands agent={agent} status={status} host={host} onError={setError} />
      <SettingsSheet open={sheet} agent={agent} status={status} slot={slot} onClose={close} onClosedError={setError} />
    </>
  )
}

/**
 * 설정 판 — 모델 · 노력 · 맡기는 정도(묻지 않고 실행이 허용됐을 때 세 칸, 아니면 자동) / 멈추기 · 지난 대화 /
 * 이름·역할 · 새 대화 · 재우기 · 항상 허용한 일 · 지우기(PC 메뉴와 같은 항목·확인 — 폴더 열기·내보내기는 PC 에서만).
 * 오류는 판이 열려 있으면 판 안에, 판을 닫는 일(재우기 · 새 대화 · 지우기 뒤 다시 받기)이 닫힌 뒤 실패하면 대화 머리의 오류 줄(onClosedError)에.
 * 판을 열 때마다 지난 오류·안내는 지운다
 */
function SettingsSheet({ open, agent, status, slot, onClose, onClosedError }: {
  open: boolean
  agent: AgentView
  status: string
  slot: PanelHeaderSlot
  onClose: () => void
  onClosedError: (message: string | null) => void
}) {
  const allowBypass = useDure(s => s.allowBypass)
  const sendingFiles = useSendingFiles(agent.id)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [editing, setEditing] = useState(false)
  const canStop = (status === 'working' || status === 'awaiting' || sendingFiles) && !stopping
  const isOpen = useRef(open)
  isOpen.current = open
  useEffect(() => {
    if (!open) return
    setError(null)
    setNotice(null)
  }, [open])
  /** 오류를 보일 곳 — 열린 판, 이미 닫혔으면 대화 머리(null = 지우기) */
  const report = (message: string | null) => {
    if (isOpen.current) setError(message)
    else onClosedError(message)
  }

  const stop = async () => {
    setError(null)
    setStopping(true)
    try {
      await window.dure.interrupt(agent.id)
      onClose()
    } catch (e) {
      report(errorMessage(e))
    } finally {
      setStopping(false)
    }
  }

  const showPast = () => {
    getStore().setPanelTab(agent.id, 'past')
    onClose()
  }

  return (
    <>
      <Sheet
        open={open}
        title={`${agent.name} 설정`}
        onClose={onClose}
        head={
          <>
            <span className="av b m-av" aria-hidden="true">
              {initial(agent.name)}
            </span>
            <span className="m-who">
              <b className="trunc">{agent.name}</b>
              {agent.role && <span className="trunc">{agent.role}</span>}
            </span>
          </>
        }
      >
        {error && (
          <p className="ph-msg m-msg" role="alert">
            {error}
          </p>
        )}
        {!error && notice && (
          <p className="ph-msg ok m-msg" role="status">
            {notice}
          </p>
        )}
        <div className="m-set">
          <div className="m-set-row">
            <span className="m-set-l">모델</span>
            <ModelPicker
              agentId={agent.id}
              model={agent.model}
              description={slot.description}
              onLoad={slot.onLoadDescription}
              onRetry={slot.onRetryDescribe}
              open={slot.modelOpen}
              onOpenChange={slot.onModelOpenChange}
              onError={report}
            />
          </div>
          <div className="m-set-row">
            <span className="m-set-l">노력</span>
            <EffortControl
              agentId={agent.id}
              effort={agent.effort}
              effortNow={agent.effortNow}
              model={agent.model}
              description={slot.description}
              onLoad={slot.onLoadDescription}
              onRetry={slot.onRetryDescribe}
              onError={report}
            />
          </div>
          <div className="m-set-row">
            <span className="m-set-l">
              {allowBypass ? '맡기는 정도' : '받은 메시지 바로 시작'}
              <span className="m-set-d">{allowBypass ? '끔 · 자동 · 묻지 않고 실행' : '묻지 않고 실행은 PC 설정에서 허용하면 골라요'}</span>
            </span>
            {allowBypass ? <LevelSwitch agent={agent} onError={report} /> : <AutoSwitch agent={agent} onError={report} />}
          </div>
        </div>
        <div className="am-list">
          <button type="button" className="mi" disabled={!canStop} onClick={() => void stop()}>
            <CircleStop className="i" aria-hidden="true" />
            멈추기
          </button>
          <button type="button" className="mi" disabled={agent.pastCount === 0} onClick={showPast}>
            <History className="i" aria-hidden="true" />
            <span className="mi-tx">{PAST.tab}</span>
            {agent.pastCount > 0 && <span className="mi-n">{agent.pastCount}</span>}
          </button>
        </div>
        <AgentMenu agent={agent} inline onEdit={() => setEditing(true)} onError={report} onNotice={setNotice} onDone={onClose} />
      </Sheet>
      {editing && <EditAgentDialog agent={agent} onClose={() => setEditing(false)} />}
    </>
  )
}

/** 이름·역할 바꾸기 — 휴대폰은 머리가 좁아 대화상자로. 이름 겹침은 해요체 안내로 */
function EditAgentDialog({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const [name, setName] = useState(agent.name)
  const [role, setRole] = useState(agent.role)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const submit = async () => {
    const next = { name: name.trim(), role: role.trim() }
    if (next.name === agent.name && next.role === agent.role) return onClose()
    setBusy(true)
    setError(null)
    try {
      await window.dure.updateAgent(agent.id, next)
      await getStore().refresh().catch(() => {})
      onClose()
    } catch (e) {
      setError(fieldError(errorMessage(e)))
      setBusy(false)
    }
  }
  return (
    <FormDialog title="이름·역할 바꾸기" submitLabel="저장" canSubmit={name.trim() !== ''} busy={busy} onSubmit={() => void submit()} onClose={onClose}>
      <div className="fld">
        <label className="fld-l" htmlFor={`${id}-n`}>
          이름
        </label>
        <input
          id={`${id}-n`}
          className="inp"
          value={name}
          onChange={e => {
            setName(e.target.value)
            setError(null)
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-e` : undefined}
          autoComplete="off"
        />
        {error && (
          <p className="fe" id={`${id}-e`}>
            {error}
          </p>
        )}
      </div>
      <div className="fld">
        <label className="fld-l" htmlFor={`${id}-r`}>
          역할
        </label>
        <input id={`${id}-r`} className="inp" placeholder="예: 기획서 · 문구" value={role} onChange={e => setRole(e.target.value)} autoComplete="off" />
      </div>
    </FormDialog>
  )
}
