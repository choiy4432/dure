import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent,
} from 'react'
import { ArrowUp, Image as ImageIcon, X } from 'lucide-react'
import type { AgentId, UserPart } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { errorMessage } from '../lib/words'
import { IMAGE_TYPES, prepareImage } from '../lib/image'
import { ConfirmDialog } from '../shell/ConfirmDialog'
import type { Described } from './ModelPicker'
import { matchCommands, slashOptionId, SlashMenu, type SlashCommand } from './SlashMenu'

/** 본문 줄 높이(px, base.css 와 같다) — 입력창은 8줄까지 늘고 그 뒤로는 안에서 스크롤 */
const LINE_PX = 22
const MAX_LINES = 8

type Attached =
  | { key: number; state: 'loading' }
  | { key: number; state: 'ready'; mediaType: string; base64: string }

interface Props {
  agentId: AgentId
  name: string
  /** 에이전트마다 한 번 받아 두는 describe — 모델 목록과 같은 것 */
  description: Described
  /** 처음 / 를 쳤을 때 — 아직 안 받았으면 describe */
  onLoadCommands: () => void
  onRetryCommands: () => void
  /** /model — 패널 머리의 모델 목록을 연다 */
  onOpenModel: () => void
}

const hasFiles = (types: ArrayLike<string> | undefined) => Array.from(types ?? []).includes('Files')

/** 입력창(시안 .cmp/.box) — 글·이미지 보내기, / 명령 */
export function Composer({ agentId, name, description, onLoadCommands, onRetryCommands, onOpenModel }: Props) {
  const heldInput = useDure(s => s.agents.find(a => a.id === agentId)?.heldInput ?? 0)
  const [text, setText] = useState('')
  const [attached, setAttached] = useState<Attached[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const [askClear, setAskClear] = useState(false)
  const [dragging, setDragging] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const filePick = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  const listId = useId()

  // / 명령 — '/' 로 시작하고 아직 띄어 쓰지 않았을 때만 목록
  const query = /^\/(\S*)$/.exec(text)?.[1] ?? null
  const slashing = query !== null
  const items = slashing && description.state === 'ready' ? matchCommands(description.value.commands, query) : []
  const menuOpen = slashing && !dismissed && (description.state !== 'ready' || items.length > 0)
  const current = Math.min(active, items.length - 1)

  useEffect(() => {
    if (slashing) onLoadCommands()
  }, [slashing, onLoadCommands])

  // 글에 맞춰 높이를 — 2줄부터 8줄까지
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    if (el.scrollHeight === 0) return // 배치가 없는 곳(테스트)
    const max = LINE_PX * MAX_LINES
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [text])

  const images = attached.filter((a): a is Extract<Attached, { state: 'ready' }> => a.state === 'ready')
  const preparing = attached.length - images.length
  const canSend = !busy && preparing === 0 && (text.trim() !== '' || images.length > 0)

  const edit = (next: string) => {
    setText(next)
    setDismissed(false)
    setActive(0)
    setError(null)
  }

  const send = async () => {
    if (!canSend) return
    const parts: UserPart[] = images.map(i => ({ type: 'image', mediaType: i.mediaType, base64: i.base64 }))
    if (text.trim() !== '') parts.push({ type: 'text', text: text.trim() })
    setBusy(true)
    setError(null)
    try {
      // 보낸 말은 기록(history 이벤트)으로 목록에 붙는다 — 일하는 중이면 엔진이 차례를 기다리게 둔다
      await window.dure.sendUser(agentId, parts)
      setText('')
      setAttached([])
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const pick = (c: SlashCommand) => {
    if (c.name === 'model') {
      setText('')
      onOpenModel()
    } else if (c.name === 'clear') {
      setText('')
      setAskClear(true)
    } else {
      edit(`/${c.name} `)
      area.current?.focus()
    }
  }

  const renew = async () => {
    await window.dure.newConversation(agentId) // 실패하면 대화상자에 문구
    setAskClear(false)
    await getStore().refresh().catch(e => setError(errorMessage(e)))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중 Enter 는 글자를 맺는 것 — 보내지 않는다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (menuOpen) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDismissed(true)
        return
      }
      if (items.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const n = items.length
          setActive(e.key === 'ArrowDown' ? (current + 1) % n : current <= 0 ? n - 1 : current - 1)
          return
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          pick(items[current])
          return
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const addFiles = (files: File[]) => {
    if (files.length === 0) return
    setError(null)
    for (const file of files) {
      const key = ++seq.current
      setAttached(a => [...a, { key, state: 'loading' }])
      void prepareImage(file).then(r => {
        if ('error' in r) {
          setAttached(a => a.filter(x => x.key !== key))
          setError(r.error)
        } else {
          setAttached(a => a.map(x => (x.key === key ? { key, state: 'ready', mediaType: r.mediaType, base64: r.base64 } : x)))
        }
      })
    }
  }

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []))
    e.target.value = '' // 같은 파일을 다시 골라도 알 수 있게
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData
    const files = Array.from(cd?.files ?? [])
    // 글이 함께 오면(표·문서 복사는 그림도 같이 온다) 글로 둔다
    if (files.length === 0 || Array.from(cd.types ?? []).includes('text/plain')) return
    e.preventDefault()
    addFiles(files)
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e.dataTransfer?.types)) return
    e.preventDefault()
    setDragging(true)
  }
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragging(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }

  let shown = 0
  return (
    <div className="cmp">
      <div
        className={`box${dragging ? ' drop' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {menuOpen && (
          <SlashMenu
            id={listId}
            description={description}
            items={items}
            active={current}
            onPick={pick}
            onHover={setActive}
            onRetry={onRetryCommands}
          />
        )}
        {attached.length > 0 && (
          <div className="atts">
            {attached.map(a =>
              a.state === 'loading' ? (
                <span key={a.key} className="att wait" role="status" aria-label="이미지 준비 중" />
              ) : (
                <span key={a.key} className="att">
                  <img src={`data:${a.mediaType};base64,${a.base64}`} alt={`붙인 이미지 ${++shown}`} />
                  <button
                    type="button"
                    className="att-x"
                    aria-label="이미지 지우기"
                    title="지우기"
                    onClick={() => setAttached(list => list.filter(x => x.key !== a.key))}
                  >
                    <X className="i" size={12} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                </span>
              ),
            )}
          </div>
        )}
        <textarea
          ref={area}
          rows={2}
          value={text}
          readOnly={busy}
          placeholder={`${name}에게 일 시키기… ( / 명령 )`}
          aria-label={`${name}에게 보낼 메시지`}
          aria-autocomplete="list"
          aria-controls={menuOpen ? listId : undefined}
          aria-activedescendant={menuOpen && items.length > 0 ? slashOptionId(listId, current) : undefined}
          onChange={e => edit(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="tb">
          <button
            type="button"
            className="ib"
            title="이미지 붙여 넣기"
            aria-label="이미지 붙여 넣기"
            onClick={() => filePick.current?.click()}
          >
            <ImageIcon className="i" aria-hidden="true" />
          </button>
          <input ref={filePick} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden onChange={onPick} />
          <span className="tb-sp" />
          {heldInput > 0 && <span className="held-in">보낼 차례를 기다리는 입력 {heldInput}개</span>}
          <button type="button" className="send" aria-label="보내기" title="보내기" disabled={!canSend} onClick={() => void send()}>
            <ArrowUp className="i" aria-hidden="true" />
          </button>
        </div>
      </div>
      {error && (
        <p className="cmp-err" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={askClear}
        title="지금까지 대화를 접고 새로 시작할까요?"
        confirmLabel="새로 시작"
        onConfirm={renew}
        onCancel={() => setAskClear(false)}
      />
    </div>
  )
}
