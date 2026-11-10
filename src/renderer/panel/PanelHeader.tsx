import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CircleAlert, Folder, Moon, ShieldAlert, Square, TriangleAlert, X } from 'lucide-react'
import type { AgentId } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { REMOTE_LOGIN_HELP, remoteIssueText } from '../../shared/remoteTexts'
import { getStore, useDure } from '../state/store'
import { displayStatus, restLook, shownIssue, type DisplayStatus } from '../state/selectors'
import { CHAT_PANEL as W, errorMessage, fieldError, initial, REST_WORD, SLEEP_HINT, STATUS_WORD } from '../lib/words'
import { folderText, splitTail } from '../lib/folder'
import { onPhone } from '../lib/phone'
import { ModelPicker, type Described } from './ModelPicker'
import { EffortControl } from './EffortControl'
import { AgentMenu } from './AgentMenu'
import { LevelSwitch } from './LevelSwitch'
import { Presence } from '../lib/presence'
import { ExpandBox } from '../lib/ExpandBox'
import { useSendingFiles } from './drafts'

/** 잘 끝난 일 한 줄(대화를 저장함)이 보이는 시간 */
const NOTICE_MS = 6000

// 상태 알약 — 작업 중 초록 · 내 승인 필요 앰버 · 쉬는 중 회색 · 멈춤 빨강
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

/** 머리가 그리는 에이전트 모습 — 상태(승인 기다림 포함) · 알약 모습 · 서버 방이면 그 서버. 휴대폰 대화 머리도 같은 것을 쓴다 */
export function useHeaderView(agentId: AgentId) {
  return useDure(s => {
    const agent = s.agents.find(a => a.id === agentId)
    // 서버 방이면 그 서버 — 안내 띠 글에 쓴다
    const host = agent ? s.rooms.find(r => r.id === agent.roomId)?.remote?.host ?? null : null
    if (!agent) return null
    const status = displayStatus(agent, s.requests)
    // 알약은 관계도 카드와 같은 말 — 서버 문제(끊김·로그인 만료 …)면 쉬는·잠듦이 아니라 멈춤(빨간 오류 띠는 엔진 오류만)
    const look: DisplayStatus = host && shownIssue(agent, s.requests) && status !== 'error' ? 'error' : status
    return { agent, status, look, host }
  })
}

/** 상태 알약 — 작업 중·승인 기다림·쉬는 중·멈춤 · 잠듦·깨우는 중·뒤에서 명령 도는 중(관계도 카드와 같은 말) */
export function StatusPill({ agent, look }: { agent: AgentView; look: DisplayStatus }) {
  const pill = PILL[look]
  const rest = restLook(agent, look)
  // 깨우는 중·뒤에서 명령 도는 중 — 차례는 아니지만 무언가 돈다: 같은 파란 알약
  const blue = rest === 'waking' || rest === 'background'
  return (
    <span
      className={`pill${blue ? ' wake' : pill.tone ? ` ${pill.tone}` : ''}`}
      title={rest === 'asleep' ? SLEEP_HINT : undefined}
    >
      {rest === 'asleep' ? (
        <Moon className="st-moon" size={13} aria-hidden="true" />
      ) : (
        <i className={`dot ${blue ? 'wake' : pill.dot}`} aria-hidden="true" />
      )}
      {rest ? REST_WORD[rest] : STATUS_WORD[look]}
    </span>
  )
}

/** 자동 스위치 — 받은 메시지를 바로 시작(묻지 않고 실행 허용이 꺼져 있을 때의 한 칸 스위치) */
export function AutoSwitch({ agent, onError }: { agent: AgentView; onError: (message: string | null) => void }) {
  const saving = useRef(false)
  const toggle = async () => {
    if (saving.current) return
    saving.current = true
    onError(null)
    try {
      await window.dure.updateAgent(agent.id, { auto: !agent.auto })
      await getStore().refresh()
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      saving.current = false
    }
  }
  return (
    <button
      type="button"
      className="sw"
      data-tour="auto"
      role="switch"
      aria-checked={agent.auto}
      title="받은 메시지를 바로 시작해요"
      onClick={toggle}
    >
      자동
      <span className="tg" aria-hidden="true" />
    </button>
  )
}

/** 머리 아래 띠 — 서버 방 문제 · 엔진 오류 · 묻지 않음 경고(닫으면 그 에이전트에선 다시 뜨지 않는다) */
export function PanelBands({ agent, status, host, onError }: {
  agent: AgentView
  status: DisplayStatus
  host: string | null
  onError: (message: string | null) => void
}) {
  const issue = host ? agent.remoteIssue : null
  // 묻지 않음 경고 닫기 — 그 에이전트에 저장해 다시 띄우지 않는다(주황 테두리·스위치로는 계속 보인다)
  const closeNotice = async () => {
    onError(null)
    try {
      await window.dure.updateAgent(agent.id, { bypassNoticeClosed: true })
      await getStore().refresh()
    } catch (e) {
      onError(errorMessage(e))
    }
  }
  return (
    <>
      {/* 서버 방 문제(로그인 만료·끊김·접속 실패 …) — 로그인은 제목 + 할 일 두 줄, 나머지는 한 줄. 일하는 도중 생겨도 읽히게 status */}
      {issue && host && (
        <div className="band warn rmt" role="status">
          <TriangleAlert className="i" aria-hidden="true" />
          <div className="band-tx">
            <span className="band-t">{remoteIssueText(host, issue)}</span>
            {issue.kind === 'login' && <span className="band-h">{REMOTE_LOGIN_HELP}</span>}
          </div>
        </div>
      )}
      {status === 'error' && (
        <div className="band err">
          <CircleAlert className="i" aria-hidden="true" />
          <div className="band-tx">
            <span className="band-t">{agent.errorText || '오류로 멈췄어요'}</span>
            <span className="band-h">다음에 일을 시키면 다시 켜져요</span>
          </div>
        </div>
      )}
      {/* 닫거나 묻지 않음이 꺼지면 높이로 접히며 사라지고, 켜지면 펼쳐진다(움직임 줄이기면 바로) */}
      <Presence show={agent.bypass && !agent.bypassNoticeClosed}>
        <ExpandBox as="div" outer="band-xp" className="band warn">
          <ShieldAlert className="i" aria-hidden="true" />
          <span className="band-t">
            {agent.bypassBySettings ? '이 에이전트는 묻지 않고 실행해요 (Claude 설정의 전부 허용)' : '이 에이전트는 묻지 않고 실행해요'}
          </span>
          <button type="button" className="ib band-x" aria-label="경고 닫기" title="닫으면 이 에이전트에선 다시 뜨지 않아요" onClick={closeNotice}>
            <X className="i" size={14} aria-hidden="true" />
          </button>
        </ExpandBox>
      </Presence>
    </>
  )
}

/** 패널 머리(시안 .ph) — 아바타·이름·역할·멈추기·메뉴 / 상태 알약·모델 칩·자동 스위치(허용이 켜져 있으면 끔·자동·묻지 않음 세 칸) + 서버 문제·오류·묻지 않음 띠 */
export function PanelHeader({ agentId, description, onLoadDescription, onRetryDescribe, modelOpen, onModelOpenChange }: Props) {
  const v = useHeaderView(agentId)
  const allowBypass = useDure(s => s.allowBypass)
  // 첨부를 보내는 중(사본·서버 올리기, 몇 분 걸릴 수 있다) — 쉬는 에이전트여도 멈추기로 끊는다(서버 방은 올리기를 끊고 글·칩은 입력창에 남는다)
  const sendingFiles = useSendingFiles(agentId)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 잘 끝난 일 한 줄(대화를 저장함) — 잠깐 보이고 사라진다. 오류가 있으면 오류가 먼저
  const [notice, setNotice] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])

  // 바꾸기를 마치면 포커스를 메뉴 버튼으로 — 버튼은 입력칸이 닫힌 뒤에야 다시 생긴다
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    menuButton.current?.focus()
  }, [editing])

  if (!v) return null
  const { agent, status, look, host } = v
  const canStop = (status === 'working' || status === 'awaiting' || sendingFiles) && !stopping

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
                {agent.folder && <FolderLine agentId={agent.id} folder={agent.folder} host={host} onError={setError} onNotice={setNotice} />}
              </div>
              <div className="ph-acts">
                <button type="button" className="btn sec" data-tour="stop" disabled={!canStop} onClick={stop}>
                  <Square className="i ph-stop" size={11} strokeWidth={1.2} absoluteStrokeWidth aria-hidden="true" />
                  멈추기
                </button>
                <AgentMenu agent={agent} onEdit={() => setEditing(true)} onError={setError} onNotice={setNotice} buttonRef={menuButton} />
              </div>
            </>
          )}
        </div>
        <div className="ph-row ph-r2">
          <StatusPill agent={agent} look={look} />
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
          <EffortControl
            agentId={agent.id}
            effort={agent.effort}
            effortNow={agent.effortNow}
            model={agent.model}
            description={description}
            onLoad={onLoadDescription}
            onRetry={onRetryDescribe}
            onError={setError}
          />
          {allowBypass ? <LevelSwitch agent={agent} onError={setError} /> : <AutoSwitch agent={agent} onError={setError} />}
        </div>
        {error && (
          <p className="ph-msg" role="alert">
            {error}
          </p>
        )}
        {!error && notice && (
          <p className="ph-msg ok" role="status">
            {notice}
          </p>
        )}
      </div>
      <PanelBands agent={agent} status={status} host={host} onError={setError} />
    </>
  )
}

/**
 * 작업 폴더 줄(시안 ② A) — 이름·역할 아래 [폴더 SVG] 경로(mono · 가운데 말줄임: 앞이 줄고 마지막 마디는 남는다).
 * 누르면 폴더 열기(… 메뉴의 폴더 열기와 같은 openAgentFolder), 오른쪽 클릭은 경로 복사.
 * 서버 방은 `호스트:경로`(이 PC 에서 열 수 없다) · 휴대폰은 PC 탐색기를 열 수 없다 — 누르기도 복사
 */
function FolderLine({ agentId, folder, host, onError, onNotice }: {
  agentId: AgentId
  folder: string
  host: string | null
  onError: (message: string | null) => void
  onNotice: (message: string | null) => void
}) {
  const path = folderText(folder, host)
  const canOpen = !host && !onPhone()
  const { head, tail } = splitTail(path)
  const copy = async () => {
    onError(null)
    try {
      await navigator.clipboard.writeText(path)
      onNotice(W.copied)
    } catch {
      onError(W.copyFailed)
    }
  }
  const open = () => {
    onError(null)
    window.dure.openAgentFolder(agentId).catch(e => onError(errorMessage(e)))
  }
  return (
    <button
      type="button"
      className="ph-fd"
      aria-label={canOpen ? W.openFolder(path) : W.copyPath(path)}
      title={`${path}\n${canOpen ? W.openHint : W.remoteHint}`}
      onClick={canOpen ? open : () => void copy()}
      onContextMenu={e => {
        e.preventDefault()
        void copy()
      }}
    >
      <Folder className="i" size={13} aria-hidden="true" />
      {head && <span className="ph-fd-h">{head}</span>}
      <span className="ph-fd-t">{tail}</span>
    </button>
  )
}

/** 이름·역할 바꾸기 — 머리의 같은 자리에서. 엔진 오류는 칸 아래(이름 겹침은 해요체 안내로) */
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
      setError(fieldError(errorMessage(e))) // 이름 겹침은 추가 대화상자와 같은 해요체 안내로
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
