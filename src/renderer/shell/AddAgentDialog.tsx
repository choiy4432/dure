import { useId, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { RoomId } from '../../engine/types'
import { getStore } from '../state/store'
import { errorMessage, fieldError } from '../lib/words'
import { placeMissing } from '../map/layout'
import { markFresh } from '../map/freshNodes'
import { FormDialog } from './FormDialog'

type Field = 'folder' | 'name' | 'other'

/** 엔진 문구가 어느 칸의 것인가 — '폴더를 찾을 수 없습니다: …' · '이미 있는 이름입니다: …' · '이름을 입력하세요' */
function fieldOf(message: string): Field {
  if (message.startsWith('폴더')) return 'folder'
  if (message.includes('이름')) return 'name'
  return 'other'
}

interface Props {
  roomId: RoomId
  onClose: () => void
}

/** 에이전트 추가 — 폴더 · 이름 · 역할 한 줄. 셋 다 있어야 추가, 엔진 오류는 그 칸 아래(이름 겹침은 해요체 안내로) */
export function AddAgentDialog({ roomId, onClose }: Props) {
  const [folder, setFolder] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [error, setError] = useState<{ field: Field; message: string } | null>(null)
  const picking = useRef(false)
  const [busy, setBusy] = useState(false)
  const folderButton = useRef<HTMLButtonElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const id = useId()
  const errorId = `${id}-e`

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

  const submit = async () => {
    if (!folder) return
    setBusy(true)
    setError(null)
    const store = getStore()
    let agentId: string
    try {
      const agent = await window.dure.addAgent({ roomId, name: name.trim(), role: role.trim(), folder })
      agentId = agent.id
      markFresh(agent.id)
      // 자리 — 이 방의 카드와 겹치지 않는 첫 칸(관계도가 같은 셈으로 정하는 자리)을 새로 받기 전에 한 번 저장.
      // 저장된 자리로 오므로 관계도가 {0,0} 을 보고 또 정해 저장하지 않는다. 실패하면 관계도가 대신 정한다.
      const seats = store.getState().agents.filter(a => a.roomId === roomId).map(a => ({ id: a.id, pos: a.pos }))
      const pos = placeMissing([...seats, { id: agent.id, pos: agent.pos }]).get(agent.id)
      if (pos) await window.dure.updateAgent(agent.id, { pos }).catch(e => console.error('두레: 새 에이전트 자리를 저장하지 못했어요', e))
    } catch (e) {
      // 어느 칸인지는 엔진 원문으로 가리고, 보이는 글은 해요체 안내로(이름 겹침)
      const raw = errorMessage(e)
      const field = fieldOf(raw)
      setError({ field, message: fieldError(raw) })
      setBusy(false)
      if (field === 'folder') folderButton.current?.focus()
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

  const canSubmit = folder !== null && name.trim() !== '' && role.trim() !== ''
  const folderError = errorOf('folder')
  const nameError = errorOf('name')

  return (
    <FormDialog
      title="에이전트 추가"
      submitLabel="추가"
      canSubmit={canSubmit}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
      error={errorOf('other')}
    >
      <div className="fld">
        <span className="fld-l" id={`${id}-fl`}>
          폴더
        </span>
        <div className="fld-row">
          <span
            id={`${id}-fp`}
            className={`fld-path${folder ? ' f' : ''}${folderError ? ' bad' : ''}`}
            title={folder ?? undefined}
          >
            {folder ?? '아직 고르지 않았어요'}
          </span>
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
        </div>
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
