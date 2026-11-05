import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent,
} from 'react'
import { ArrowUp, FileText, FileX, ListChecks, Paperclip, X } from 'lucide-react'
import type { AgentId, UserPart } from '../../engine/types'
import { ATTACH_MAX_BYTES, ATTACH_TOO_BIG } from '../../shared/attachments'
import { getStore, useDure } from '../state/store'
import { displayStatus } from '../state/selectors'
import { ContextRing } from './ContextRing'
import { ATTACH_FOLDER, ATTACH_NO_PATH, ATTACH_SENDING, ATTACH_UPLOADING, ATTACH_WORD, errorMessage, formatBytes, RENEW_CONFIRM } from '../lib/words'
import { phoneUpload } from '../lib/phone'
import { isImageType, prepareImage } from '../lib/image'
import { ConfirmDialog } from '../shell/ConfirmDialog'
import type { Described } from './ModelPicker'
import { matchCommands, slashOptionId, SlashMenu, type SlashEntry } from './SlashMenu'
import { Presence } from '../lib/presence'
import { ImageViewer } from './ImageViewer'
import { getDraft, nextAttachKey, updateDraft, useDraft, type Attached } from './drafts'
import { FileName } from './MeFiles'

/** 본문 줄 높이(px, base.css 와 같다) — 입력창은 8줄까지 늘고 그 뒤로는 안에서 스크롤 */
const LINE_PX = 22
const MAX_LINES = 8
/** 두레가 직접 처리하는 명령 — 목록을 거치든 직접 치든 Claude 에 보내지 않는다 */
const OWN_COMMAND = /^\/(clear|model)(?:\s+([\s\S]*))?$/

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
  /** 보내졌을 때 — 대화 목록을 맨 아래로(내 말이 보이게) */
  onSent?: (agentId: AgentId) => void
}

const hasFiles = (types: ArrayLike<string> | undefined) => Array.from(types ?? []).includes('Files')

/**
 * 끌어다 놓은 파일 — 폴더는 뺀다. 폴더도 files 에 크기 0 의 File 로 끼어 오고(0 B 칩이 된다), items 의 같은 차례(kind 'file')에서
 * webkitGetAsEntry 로 폴더인지 안다(놓는 동안에만 읽힌다). items 를 못 읽으면 files 그대로
 */
function droppedFiles(dt: DataTransfer | null): { files: File[]; folders: number } {
  const files = Array.from(dt?.files ?? [])
  const entries = Array.from(dt?.items ?? []).filter(i => i.kind === 'file')
  if (entries.length !== files.length) return { files, folders: 0 }
  const folder = entries.map(i => i.webkitGetAsEntry?.()?.isDirectory === true)
  return { files: files.filter((_, i) => !folder[i]), folders: folder.filter(Boolean).length }
}

type FileChip = Extract<Attached, { state: 'file' }>

/**
 * 디스크 파일이면 파일 칩 — 바이트는 옮기지 않고 경로만(엔진이 보낼 때 사본을 만든다). 경로를 모르면(붙여 넣은 내용 등) null.
 * 100MB 를 넘으면 칩에 오류를 달아 보내기를 막는다(정확히 100MB 는 보낸다 — 엔진이 다시 잰다)
 */
function fileChip(key: number, file: File): FileChip | null {
  const path = window.dure.pathForFile(file)
  if (!path) return null
  return { key, state: 'file', name: file.name, bytes: file.size, path, ...(file.size > ATTACH_MAX_BYTES ? { error: ATTACH_TOO_BIG } : {}) }
}

/**
 * 휴대폰의 파일 칩 — 휴대폰 파일엔 PC 경로가 없어 붙일 때 PC 의 받은 폴더로 올린다(올리는 동안 '올리는 중…', 보내기는 막힘).
 * 100MB 를 넘으면 올리지 않고 PC 처럼 오류 칩. PC 창이면 null(경로를 모르는 파일은 지금처럼 안내)
 */
function uploadChip(key: number, file: File): FileChip | null {
  if (!phoneUpload()) return null
  const base = { key, state: 'file' as const, name: file.name, bytes: file.size, path: '' }
  return file.size > ATTACH_MAX_BYTES ? { ...base, error: ATTACH_TOO_BIG } : { ...base, uploading: true }
}

/**
 * 입력창(시안 .cmp/.box) — 글·그림·파일 보내기, / 명령.
 * 쓰던 글과 붙인 것(그림·파일 칩)·보내는 중·오류 줄은 에이전트마다 drafts 에 둔다 — 다른 카드로 갔다 와도 그대로(이번 실행 동안만).
 * 파일 첨부: 지금 받는 그림(IMAGE_TYPES)은 그림 길(미리보기·줄여 보내기), 그 밖·그림 길로 못 가는 그림은 파일 칩(경로 줄로 보낸다)
 */
export function Composer({ agentId, name, description, onLoadCommands, onRetryCommands, onOpenModel, onSent }: Props) {
  const heldInput = useDure(s => s.agents.find(a => a.id === agentId)?.heldInput ?? 0)
  const lastContext = useDure(s => s.agents.find(a => a.id === agentId)?.lastContext ?? null)
  // 일하는 중이거나 승인을 기다리는 중 — 그동안은 요약하지 않는다(차례가 끝난 뒤에)
  const working = useDure(s => {
    const a = s.agents.find(x => x.id === agentId)
    if (!a) return false
    const d = displayStatus(a, s.requests)
    return d === 'working' || d === 'awaiting'
  })
  const planMode = useDure(s => s.agents.find(a => a.id === agentId)?.planMode ?? false)
  const { text, attached, plan, sending, sent: inFlight, error: draftError } = useDraft(agentId)
  // 켬 = 에이전트가 이미 계획 모드이거나 다음 한 번을 계획부터로 정해 둔 것
  const planOn = planMode || plan
  const setText = (next: string) => updateDraft(agentId, d => (d.text === next ? d : { ...d, text: next }))
  const setAttached = (fn: (list: Attached[]) => Attached[]) => updateDraft(agentId, d => ({ ...d, attached: fn(d.attached) }))
  // 칩 빼기 — 오류 줄도 지운다(뺀 파일의 보내기 실패 글이 남지 않게)
  const remove = (key: number) => updateDraft(agentId, d => ({ ...d, attached: d.attached.filter(x => x.key !== key), error: undefined }))
  // 보내는 중인 칩만 뺄 수 없다 — 빼도 그 파일은 간다(뺀 줄 알게 하지 않는다). 보내는 사이 새로 붙인 칩은 뺄 수 있다
  const going = (key: number) => inFlight?.includes(key) ?? false
  // 오류 줄도 그 에이전트의 입력에 — 몇 분 걸린 보내기가 다른 카드에 가 있는 사이 실패해도 돌아오면 보인다
  const error = draftError ?? null
  const setError = (e: string | null) => updateDraft(agentId, d => ((d.error ?? null) === e ? d : { ...d, error: e ?? undefined }))
  /** 크게 보고 있는 붙인 그림(준비가 끝난 것 가운데 몇 번째) */
  const [viewing, setViewing] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const [askClear, setAskClear] = useState(false)
  const [dragging, setDragging] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const filePick = useRef<HTMLInputElement>(null)
  const chipBox = useRef<HTMLDivElement>(null)
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
  const files = attached.filter((a): a is FileChip => a.state === 'file')
  const preparing = attached.filter(a => a.state === 'loading').length

  // 칩을 붙이면 새 칩이 보이게 — 칸이 넘쳐 안에서 스크롤할 때 새 칩·보내기를 막는 오류 칩(100MB 넘음)이 아래에 숨지 않게.
  // 열쇠는 늘 커지니 가장 큰 열쇠가 바뀔 때만(빼기·글 치기·다른 카드에서 돌아옴은 아님). 오류 칩이 마지막이라 둘 다 못 들면 오류 칩이 보인다
  const newest = attached.reduce((m, a) => Math.max(m, a.key), 0)
  const shownNewest = useRef(newest)
  useEffect(() => {
    if (newest <= shownNewest.current) return
    shownNewest.current = newest
    const box = chipBox.current
    if (!box) return
    const chips = box.querySelectorAll<HTMLElement>(':scope > .att, :scope > .att-file')
    chips[chips.length - 1]?.scrollIntoView?.({ block: 'nearest' })
    box.querySelector<HTMLElement>(':scope > .att-file.bad')?.scrollIntoView?.({ block: 'nearest' })
  }, [newest])
  // 보내는 중(첨부는 몇 분 걸릴 수 있다)이거나 /model 을 바꾸는 중 — 글을 바꾸거나 또 보내지 않는다
  const locked = busy || sending !== undefined
  const canSend = !locked && preparing === 0 && !files.some(f => f.error || f.uploading) && (text.trim() !== '' || images.length > 0 || files.length > 0)

  const edit = (next: string) => {
    setText(next)
    setDismissed(false)
    setActive(0)
    setError(null)
  }

  /**
   * /clear → 새 대화 확인 · /model → 모델 목록 · /model <이름> → 그 모델로.
   * 목록이 아직 안 왔거나 Esc 로 닫았어도 같다 — Claude 로 가면 확인 없이 지워지고 모델 칩이 어긋난다.
   */
  const runOwn = async (name: 'clear' | 'model', arg: string) => {
    if (name === 'clear') {
      setText('')
      setAskClear(true)
      return
    }
    if (arg === '') {
      setText('')
      onOpenModel()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.dure.setModel(agentId, arg === 'default' ? null : arg)
      setText('')
      await getStore().refresh()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (!canSend) return
    const own = OWN_COMMAND.exec(text.trim())
    if (own) {
      await runOwn(own[1] as 'clear' | 'model', (own[2] ?? '').trim())
      return
    }
    // 그림 → 글 → 파일 차례(엔진은 파일을 모아 맨 끝 '첨부 파일:' 줄로 붙인다)
    const parts: UserPart[] = images.map(i => ({ type: 'image', mediaType: i.mediaType, base64: i.base64 }))
    if (text.trim() !== '') parts.push({ type: 'text', text: text.trim() })
    for (const f of files) parts.push({ type: 'file', path: f.path, name: f.name, bytes: f.bytes })
    const sent = new Set([...images, ...files].map(a => a.key))
    // 보내는 중은 drafts 에 — 다른 카드로 갔다 와도 그대로라 같은 입력을 또 보내지 않는다. 실패는 그 에이전트 입력의 오류 줄로(글·칩 그대로)
    updateDraft(agentId, d => ({ ...d, sending: files.length > 0 ? 'files' : 'text', sent: [...sent], error: undefined }))
    try {
      // 보낸 말은 기록(history 이벤트)으로 목록에 붙는다 — 일하는 중이면 엔진이 차례를 기다리게 둔다
      // 계획 먼저는 한 번짜리 — 이미 계획 모드인 에이전트에겐 따로 정하지 않는다
      if (plan && !planMode) await window.dure.sendUser(agentId, parts, { plan: true })
      else await window.dure.sendUser(agentId, parts)
      // 이 에이전트의 쓰던 입력을 비운다(보낸 이미지의 미리보기는 drafts 가 놓아 준다)
      updateDraft(agentId, d => ({ text: '', attached: d.attached.filter(a => !sent.has(a.key)), plan: false }))
      onSent?.(agentId)
    } catch (e) {
      updateDraft(agentId, d => ({ ...d, sending: undefined, sent: undefined, error: errorMessage(e) }))
    }
  }

  /** 대화 공간 링의 [지금 요약하기] — /compact 를 보낸다(실패는 입력창 아래 오류 줄) */
  const compact = async () => {
    setError(null)
    try {
      await window.dure.sendUser(agentId, [{ type: 'text', text: '/compact' }])
      onSent?.(agentId)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const pick = (c: SlashEntry) => {
    if (c.name === 'model' || c.name === 'clear') {
      void runOwn(c.name, '')
    } else {
      edit(`/${c.name} `)
      area.current?.focus()
    }
  }

  /** '계획 먼저' 단추 — 계획 모드 중이면 끄고(엔진), 아니면 다음 한 번의 표시를 뒤집는다 */
  const togglePlan = async () => {
    if (!planMode) {
      updateDraft(agentId, d => ({ ...d, plan: !d.plan }))
      return
    }
    setError(null)
    try {
      await window.dure.setPlanMode(agentId, false)
    } catch (e) {
      setError(errorMessage(e))
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
    // 목록이 없을 때의 Esc — 일하는 중·승인 대기·첨부를 보내는 중이면 멈춘다(서버 방은 올리기를 끊는다)
    if (e.key === 'Escape' && (working || sending === 'files')) {
      e.preventDefault()
      void window.dure.interrupt(agentId).catch(err => setError(errorMessage(err)))
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  /** 휴대폰 — 올리기를 시작한다. 다 올리면 받은 PC 경로로 칩을 채우고, 못 올리면 칩을 빼고 오류 줄(어느 파일인지). 그사이 뺀 칩은 그대로 둔다 */
  const startUpload = (key: number, file: File) => {
    const upload = phoneUpload()
    if (!upload) return
    const alive = () => getDraft(agentId).attached.some(x => x.key === key)
    upload(file).then(
      r => {
        if (!alive()) return
        setAttached(a => a.map(x => (x.key === key ? { key, state: 'file', name: r.name || file.name, bytes: r.bytes, path: r.path } : x)))
      },
      e => {
        if (!alive()) return
        setAttached(a => a.filter(x => x.key !== key))
        setError(`${file.name} — ${errorMessage(e)}`)
      },
    )
  }

  /** 파일 칩 하나 — PC 는 경로로, 휴대폰은 올려서. 둘 다 안 되면 null. at 이 있으면 그 칩(그림 준비 자리)을 갈음한다 */
  const putFileChip = (key: number, file: File, at?: number): boolean => {
    const chip = fileChip(key, file) ?? uploadChip(key, file)
    if (!chip) return false
    setAttached(a => (at === undefined ? [...a, chip] : a.map(x => (x.key === at ? chip : x))))
    if (chip.uploading) startUpload(key, file)
    return true
  }

  const addFiles = (list: File[]) => {
    if (list.length === 0) return
    setError(null)
    for (const file of list) {
      const key = nextAttachKey()
      if (!isImageType(file.type)) {
        if (!putFileChip(key, file)) setError(ATTACH_NO_PATH)
        continue
      }
      setAttached(a => [...a, { key, state: 'loading' }])
      void prepareImage(file).then(r => {
        // 그사이 다른 에이전트로 갔어도 이 에이전트의 입력에 넣는다(setAttached 는 agentId 로 drafts 를 고친다)
        if (!getDraft(agentId).attached.some(x => x.key === key)) return // 그사이 버려졌다(에이전트 지움)
        if ('error' in r) {
          // 그림 길로 못 가는 그림(줄여도 상한을 넘음·못 읽음) — 디스크 파일이면 거절하지 않고 파일 첨부로 내린다(경로 줄 · 휴대폰은 올려서)
          if (!putFileChip(key, file, key)) {
            setAttached(a => a.filter(x => x.key !== key))
            setError(r.error)
          }
          return
        }
        // 미리보기 주소는 붙일 때 한 번 — 글자를 칠 때마다 몇 MB 짜리 data: 주소를 다시 만들지 않는다
        const url = URL.createObjectURL(r.blob)
        setAttached(a => a.map(x => (x.key === key ? { key, state: 'ready', mediaType: r.mediaType, base64: r.base64, url } : x)))
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
    const { files, folders } = droppedFiles(e.dataTransfer)
    if (files.length === 0 && folders === 0) return
    e.preventDefault()
    addFiles(files)
    if (folders > 0) setError(ATTACH_FOLDER)
  }

  // 크게 보기는 준비가 끝난 그림만 — 썸네일과 같은 차례
  const ready = attached.flatMap(a => (a.state === 'ready' ? [a] : []))
  const readyKeys = ready.map(a => a.key)
  // 보내거나 다 지워 그림이 없어지면 보기도 닫는다 — 다음에 붙일 때 저절로 열리지 않게
  if (viewing !== null && ready.length === 0) setViewing(null)
  let shown = 0
  return (
    <div className="cmp">
      {/* 안내 투어는 입력 상자만 짚는다(패널 여백까지 짚으면 테가 창 밖으로 나간다 — 시안 tour-steps-v2 4) */}
      <div
        className={`box${dragging ? ' drop' : ''}${planOn ? ' plan' : ''}`}
        data-tour="composer"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <Presence show={menuOpen}>
          <SlashMenu
            id={listId}
            description={description}
            items={items}
            active={current}
            onPick={pick}
            onHover={setActive}
            onRetry={onRetryCommands}
          />
        </Presence>
        {attached.length > 0 && (
          <div className="atts" ref={chipBox}>
            {attached.map(a =>
              a.state === 'loading' ? (
                <span key={a.key} className="att wait" role="status" aria-label="이미지 준비 중" />
              ) : a.state === 'file' ? (
                // 파일 칩 — 이름(가운데 줄임) · 크기, 100MB 를 넘으면 크기 자리에 오류 · 휴대폰에서 올리는 동안은 '올리는 중…'
                <span key={a.key} className={`att-file${a.error ? ' bad' : ''}${a.uploading ? ' up' : ''}`} title={a.name}>
                  {a.error ? <FileX className="i af-i" aria-hidden="true" /> : <FileText className="i af-i" aria-hidden="true" />}
                  <span className="af-tx">
                    <FileName name={a.name} />
                    <span className="af-m" role={a.error ? 'alert' : a.uploading ? 'status' : undefined}>
                      {a.error ?? (a.uploading ? ATTACH_UPLOADING : formatBytes(a.bytes))}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="att-x"
                    aria-label={`${a.name} 빼기`}
                    title="빼기"
                    disabled={going(a.key)}
                    onClick={() => remove(a.key)}
                  >
                    <X className="i" size={12} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                </span>
              ) : (
                <span key={a.key} className="att">
                  <img src={a.url} alt={`붙인 이미지 ${++shown}`} />
                  <button
                    type="button"
                    className="att-view"
                    aria-label={`붙인 이미지 ${shown} 크게 보기`}
                    onClick={() => setViewing(readyKeys.indexOf(a.key))}
                  />
                  <button
                    type="button"
                    className="att-x"
                    aria-label="이미지 지우기"
                    title="지우기"
                    disabled={going(a.key)}
                    onClick={() => remove(a.key)}
                  >
                    <X className="i" size={12} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                </span>
              ),
            )}
            <ImageViewer
              open={viewing !== null}
              sources={ready.map(a => ({ url: a.url }))}
              index={viewing ?? 0}
              onIndex={setViewing}
              onClose={() => setViewing(null)}
            />
          </div>
        )}
        <textarea
          ref={area}
          rows={2}
          value={text}
          readOnly={locked}
          // 휴대폰 자판엔 / 명령을 찾아 쓸 일이 드물다 — 자리표시는 짧게(명령은 그대로 된다)
          placeholder={planOn ? `${name}에게 계획부터 세워 달라고 하기…` : phoneUpload() ? `${name}에게 일 시키기…` : `${name}에게 일 시키기… ( / 명령 )`}
          aria-label={`${name}에게 보낼 메시지`}
          aria-autocomplete="list"
          aria-controls={menuOpen ? listId : undefined}
          aria-activedescendant={menuOpen && items.length > 0 ? slashOptionId(listId, current) : undefined}
          onChange={e => edit(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="tb">
          <button type="button" className="ib" title={ATTACH_WORD} aria-label={ATTACH_WORD} onClick={() => filePick.current?.click()}>
            <Paperclip className="i" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`plan-btn${planOn ? ' on' : ''}`}
            aria-pressed={planOn}
            title="계획부터 세워 달라고 하기"
            onClick={() => void togglePlan()}
          >
            <ListChecks className="i" size={14} aria-hidden="true" />
            계획 먼저
          </button>
          {/* 종류 제한 없음 — 그림은 그림 길, 그 밖은 파일 칩 */}
          <input ref={filePick} type="file" multiple hidden onChange={onPick} />
          <span className="tb-sp" />
          {sending === 'files' && (
            <span className="cmp-sending" role="status">
              {ATTACH_SENDING}
            </span>
          )}
          {heldInput > 0 && <span className="held-in">보낼 차례를 기다리는 입력 {heldInput}개</span>}
          <ContextRing agentId={agentId} name={name} value={lastContext} working={working} onCompact={() => void compact()} />
          <button type="button" className="send" aria-label="보내기" title="보내기" disabled={!canSend} onClick={() => void send()}>
            <ArrowUp className="i" aria-hidden="true" />
          </button>
        </div>
      </div>
      {planOn && <p className="cmp-note">계획을 보고 승인하기 전에는 파일을 고치거나 명령을 실행하지 않아요</p>}
      {error && (
        <p className="cmp-err" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={askClear}
        title={RENEW_CONFIRM.title}
        body={RENEW_CONFIRM.body}
        confirmLabel={RENEW_CONFIRM.confirmLabel}
        onConfirm={renew}
        onCancel={() => setAskClear(false)}
      />
    </div>
  )
}
