import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { FolderOpen } from 'lucide-react'
import type { RoomId } from '../../engine/types'
import { getStore, useDure, type ForkDraft } from '../state/store'
import { errorMessage, fieldError, FORK_DIALOG, REMOTE } from '../lib/words'
import { placeMissing } from '../map/layout'
import { markFresh } from '../map/freshNodes'
import { FormDialog } from './FormDialog'
import { RemoteCheckLine, ServerTag, useRemoteCheck } from './RemoteCheck'

type Field = 'folder' | 'name' | 'other'

/** 엔진 문구가 어느 칸의 것인가 — '폴더를 찾을 수 없습니다: …' · '이미 있는 이름입니다: …' · '이름을 입력하세요' */
function fieldOf(message: string): Field {
  if (message.startsWith('폴더')) return 'folder'
  if (message.includes('이름')) return 'name'
  return 'other'
}

interface Props {
  roomId: RoomId
  /** 있으면 갈래 모드 — 지난 대화를 새 에이전트로 이어 간다(폴더는 원래 에이전트와 같게 고정) */
  fork?: ForkDraft
  onClose: () => void
}

/**
 * 에이전트 추가 — 폴더 · 이름 · 역할 한 줄. 셋 다 있어야 추가, 엔진 오류는 그 칸 아래(이름 겹침은 해요체 안내로).
 * 서버 방이면 폴더 = 서버 경로 입력칸 + 확인(checkRemoteFolder) — 확인이 된 뒤에만 추가, 저장하는 폴더는 서버가 펼친 경로.
 * 갈래는 어느 방이든 폴더 고정.
 */
export function AddAgentDialog({ roomId, fork, onClose }: Props) {
  const remote = useDure(s => s.rooms.find(r => r.id === roomId)?.remote ?? null)
  const serverMode = remote !== null && !fork
  const [folder, setFolder] = useState<string | null>(fork?.folder ?? null)
  const [path, setPath] = useState('')
  const [name, setName] = useState(fork?.name ?? '')
  const [role, setRole] = useState(fork?.role ?? '')
  const [error, setError] = useState<{ field: Field; message: string } | null>(null)
  const picking = useRef(false)
  const [busy, setBusy] = useState(false)
  const folderButton = useRef<HTMLButtonElement>(null)
  const pathInput = useRef<HTMLInputElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const id = useId()
  const errorId = `${id}-e`
  const checkId = `${id}-c`
  const { check, start, reset, settled } = useRemoteCheck(
    () => remote?.host ?? '',
    async target => {
      const r = await window.dure.checkRemoteFolder(roomId, target)
      return r.ok ? { ok: true, value: r.folder, claudeVersion: r.claudeVersion } : r
    },
  )

  const errorOf = (f: Field) => (error?.field === f ? error.message : null)
  const clear = (f: Field) => setError(e => (e?.field === f ? null : e))

  // 고르는 창이 떠 있는 동안 또 열지 않는다 — 버튼을 막으면 포커스가 body 로 떨어지므로 막지 않고 무시한다
  const pick = async () => {
    if (picking.current) return
    picking.current = true
    try {
      const path = await window.dure.pickFolder()
      if (path) {
        setFolder(path)
        clear('folder')
      }
    } catch (e) {
      setError({ field: 'folder', message: errorMessage(e) })
    } finally {
      picking.current = false
    }
  }

  // 서버 폴더 — 지금 칸과 맞는 확인만 보인다(칸을 바꾸면 확인이 풀린다)
  const target = path.trim()
  const shown = check.state !== 'idle' && check.target === target ? check : { state: 'idle' as const }
  const serverFolder = shown.state === 'ok' ? shown.value : null

  const checkFolder = () => {
    if (target && !settled(target)) start(target)
  }

  // Enter — 확인이 됐으면 그대로 추가(대화상자 보내기), 아니면 확인
  const onPathKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || serverFolder !== null) return
    e.preventDefault()
    checkFolder()
  }

  const submit = async () => {
    const chosen = serverMode ? serverFolder : folder
    if (!chosen) return
    setBusy(true)
    setError(null)
    const store = getStore()
    let agentId: string
    try {
      const agent = fork
        ? await window.dure.forkAgent({ from: fork.from, key: fork.key, name: name.trim(), role: role.trim() })
        : await window.dure.addAgent({ roomId, name: name.trim(), role: role.trim(), folder: chosen })
      agentId = agent.id
      markFresh(agent.id)
      // 자리 — 이 방의 카드와 겹치지 않는 첫 칸(관계도가 같은 셈으로 정하는 자리)을 새로 받기 전에 한 번 저장.
      // 저장된 자리로 오므로 관계도가 {0,0} 을 보고 또 정해 저장하지 않는다. 실패하면 관계도가 대신 정한다.
      const seats = store.getState().agents.filter(a => a.roomId === roomId).map(a => ({ id: a.id, pos: a.pos }))
      // 갈래는 원래 에이전트 카드 가까이(by) — placeNear 는 agent-added 사건이 채우는 맵이라, 같은 셈(placeMissing by)을 여기서 직접
      const pos = placeMissing([...seats, { id: agent.id, pos: agent.pos, by: fork?.from }]).get(agent.id)
      if (pos) await window.dure.updateAgent(agent.id, { pos }).catch(e => console.error('두레: 새 에이전트 자리를 저장하지 못했어요', e))
    } catch (e) {
      // 어느 칸인지는 엔진 원문으로 가리고, 보이는 글은 해요체 안내로(이름 겹침)
      const raw = errorMessage(e)
      const field = fieldOf(raw)
      setError({ field, message: fieldError(raw) })
      setBusy(false)
      if (field === 'folder') (serverMode ? pathInput : folderButton).current?.focus()
      else if (field === 'name') nameInput.current?.focus()
      return
    }
    // 에이전트는 생겼다 — 새로 받지 못해도 대화상자는 닫는다(다시 누르면 이름이 겹친다)
    try {
      await store.refresh()
      store.selectAgent(agentId)
    } catch (e) {
      console.error('두레: 에이전트를 추가한 뒤 상태를 받지 못했어요', e)
    }
    onClose()
  }

  const canSubmit = (serverMode ? serverFolder !== null : folder !== null) && name.trim() !== '' && role.trim() !== ''
  const folderError = errorOf('folder')
  const nameError = errorOf('name')
  const pathDescribed = [shown.state !== 'idle' && checkId, folderError && errorId].filter(Boolean).join(' ') || undefined

  return (
    <FormDialog
      title={fork ? FORK_DIALOG.title : '에이전트 추가'}
      submitLabel="추가"
      canSubmit={canSubmit}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
      error={errorOf('other')}
    >
      <div className="fld">
        <div className="fld-lr">
          {serverMode ? (
            <label className="fld-l" htmlFor={`${id}-fi`}>
              폴더
            </label>
          ) : (
            <span className="fld-l" id={`${id}-fl`}>
              폴더
            </span>
          )}
          {remote && <ServerTag host={remote.host} />}
        </div>
        {serverMode ? (
          <>
            <div className="fld-row">
              <input
                ref={pathInput}
                id={`${id}-fi`}
                className="inp mono"
                placeholder={REMOTE.folderExample}
                value={path}
                onChange={e => {
                  setPath(e.target.value)
                  clear('folder')
                  if (!settled(e.target.value.trim())) reset()
                }}
                onKeyDown={onPathKey}
                aria-invalid={folderError ? true : undefined}
                aria-describedby={pathDescribed}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="btn sec" onClick={checkFolder} disabled={busy || !target}>
                {REMOTE.check}
              </button>
            </div>
            <RemoteCheckLine id={checkId} check={shown} okText={REMOTE.folderOk} />
          </>
        ) : (
          <div className="fld-row">
            <span
              id={`${id}-fp`}
              className={`fld-path${folder ? ' f' : ''}${remote ? ' mono' : ''}${folderError ? ' bad' : ''}`}
              title={folder ?? undefined}
            >
              {folder ?? '아직 고르지 않았어요'}
            </span>
            {!fork && (
              <button
                ref={folderButton}
                type="button"
                className="btn sec"
                onClick={() => void pick()}
                disabled={busy}
                aria-describedby={`${id}-fl ${id}-fp${folderError ? ` ${errorId}` : ''}`}
              >
                <FolderOpen className="i" aria-hidden="true" />
                폴더 고르기
              </button>
            )}
          </div>
        )}
        {fork && <p className="fld-note">{FORK_DIALOG.folderNote}</p>}
        {folderError && (
          <p className="fe" id={errorId}>
            {folderError}
          </p>
        )}
      </div>
      <div className="fld">
        <label className="fld-l" htmlFor={`${id}-n`}>
          이름
        </label>
        <input
          ref={nameInput}
          id={`${id}-n`}
          className="inp"
          value={name}
          onChange={e => {
            setName(e.target.value)
            clear('name')
          }}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? errorId : undefined}
          autoComplete="off"
        />
        {nameError && (
          <p className="fe" id={errorId}>
            {nameError}
          </p>
        )}
      </div>
      <div className="fld">
        <label className="fld-l" htmlFor={`${id}-r`}>
          역할
        </label>
        <input
          id={`${id}-r`}
          className="inp"
          placeholder="예: 기획서 · 문구"
          value={role}
          onChange={e => setRole(e.target.value)}
          autoComplete="off"
        />
      </div>
    </FormDialog>
  )
}
