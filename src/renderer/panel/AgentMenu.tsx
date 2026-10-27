import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { Ellipsis, FolderOpen, MessageSquarePlus, Moon, ShieldCheck, Pencil, Trash2 } from 'lucide-react'
import type { SleepBlock } from '../../engine/types'
import type { AgentView } from '../../shared/ipcContract'
import { getStore } from '../state/store'
import { errorMessage, josa, RENEW_CONFIRM, SLEEP_BLOCK_WORD, SLEEP_NOW } from '../lib/words'
import { moveMenuFocus, useDismiss } from '../lib/popover'
import { MotionDiv, Presence } from '../lib/presence'
import { MOTION } from '../lib/motion'
import { ConfirmDialog } from '../shell/ConfirmDialog'
import { AlwaysAllowDialog } from './AlwaysAllowDialog'

interface Props {
  agent: AgentView
  /** '이름·역할 바꾸기' — 머리가 같은 자리에 입력칸을 연다 */
  onEdit: () => void
  /** 폴더 열기 등이 실패했을 때 엔진 문구 */
  onError: (message: string) => void
  /** 메뉴 버튼 — 바꾸기를 마친 뒤 포커스를 돌려받는 자리 */
  buttonRef?: Ref<HTMLButtonElement>
}

type Ask = 'renew' | 'remove' | 'always' | null

/** 재울 수 있나 — undefined 는 아직 묻는 중, 'no-session' 은 재울 게 없음, null 은 지금 재울 수 있음 */
type SleepCheck = SleepBlock | 'no-session' | null | undefined

/** 패널 머리의 … 메뉴 — 이름·역할 바꾸기 · 새 대화 · 지금 재우기 · 폴더 열기 · 항상 허용한 일 · 지우기 */
export function AgentMenu({ agent, onEdit, onError, buttonRef }: Props) {
  const [open, setOpen] = useState(false)
  const [ask, setAsk] = useState<Ask>(null)
  const [sleepCheck, setSleepCheck] = useState<SleepCheck>(undefined)
  const wrap = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, wrap, close)

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [open])

  // 메뉴를 열 때마다 지금 재울 수 있는지 묻는다 — 답이 오기 전엔 항목을 꺼 두어 깜박여 눌리지 않게
  const agentId = agent.id
  useEffect(() => {
    if (!open) return
    let stale = false
    setSleepCheck(undefined)
    Promise.resolve()
      .then(() => window.dure.sleepBlock(agentId))
      .then(r => { if (!stale) setSleepCheck(r) })
      .catch(() => { if (!stale) setSleepCheck('no-session') }) // 못 물으면 항목을 감춘다 — 재우기는 편의라 막혀도 해롭지 않다
    return () => { stale = true }
  }, [open, agentId])

  const setButton = (el: HTMLButtonElement | null) => {
    btn.current = el
    if (typeof buttonRef === 'function') buttonRef(el)
    else if (buttonRef) buttonRef.current = el
  }

  // 항목을 고르면 메뉴를 닫고 포커스를 메뉴 버튼에 — 대화상자가 닫힐 때 그리로 돌아온다
  const choose = (fn: () => void) => () => {
    setOpen(false)
    btn.current?.focus()
    fn()
  }

  const openFolder = () => {
    window.dure.openFolder(agent.folder).catch(e => onError(errorMessage(e)))
  }

  const sleepNow = () => {
    window.dure
      .sleep(agent.id)
      .then(() => getStore().refresh())
      .catch(e => onError(errorMessage(e)))
  }

  const renew = async () => {
    await window.dure.newConversation(agent.id) // 실패하면 대화상자에 문구
    setAsk(null)
    await getStore().refresh().catch(e => onError(errorMessage(e)))
  }

  const remove = async () => {
    await window.dure.removeAgent(agent.id)
    setAsk(null)
    // 지운 에이전트는 스냅샷에서 빠지고 선택도 풀린다 — 패널은 '내가 할 일' 로
    await getStore().refresh().catch(e => onError(errorMessage(e)))
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      btn.current?.focus()
      return
    }
    if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    moveMenuFocus(e)
  }

  return (
    <span className="mp" ref={wrap}>
      <button
        ref={setButton}
        type="button"
        className="ib"
        aria-label="메뉴"
        title="메뉴"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <Ellipsis className="i" aria-hidden="true" />
      </button>
      <Presence show={open}>
        <MotionDiv motion={MOTION.pop} origin="top right" ref={menu} className="pop end" role="menu" aria-label="메뉴" onKeyDown={onKey}>
          <button type="button" role="menuitem" className="mi" onClick={choose(onEdit)}>
            <Pencil className="i" aria-hidden="true" />
            이름·역할 바꾸기
          </button>
          <button type="button" role="menuitem" className="mi" onClick={choose(() => setAsk('renew'))}>
            <MessageSquarePlus className="i" aria-hidden="true" />새 대화
          </button>
          {sleepCheck !== 'no-session' && (
            <button
              type="button"
              role="menuitem"
              className="mi"
              disabled={sleepCheck !== null}
              title={sleepCheck ? SLEEP_BLOCK_WORD[sleepCheck] : undefined}
              onClick={choose(sleepNow)}
            >
              <Moon className="i" aria-hidden="true" />
              {SLEEP_NOW}
            </button>
          )}
          <button type="button" role="menuitem" className="mi" onClick={choose(openFolder)}>
            <FolderOpen className="i" aria-hidden="true" />
            폴더 열기
          </button>
          <button type="button" role="menuitem" className="mi" onClick={choose(() => setAsk('always'))}>
            <ShieldCheck className="i" aria-hidden="true" />
            <span className="mi-tx">항상 허용한 일</span>
            {agent.alwaysAllow.length > 0 && <span className="mi-n">{agent.alwaysAllow.length}</span>}
          </button>
          <div className="pop-sep" role="separator" />
          <button type="button" role="menuitem" className="mi dng-t" onClick={choose(() => setAsk('remove'))}>
            <Trash2 className="i" aria-hidden="true" />
            지우기
          </button>
        </MotionDiv>
      </Presence>
      <ConfirmDialog
        open={ask === 'renew'}
        title={RENEW_CONFIRM.title}
        confirmLabel={RENEW_CONFIRM.confirmLabel}
        onConfirm={renew}
        onCancel={() => setAsk(null)}
      />
      <ConfirmDialog
        open={ask === 'remove'}
        title={`에이전트 ${agent.name}${josa(agent.name, '을/를')} 지울까요?`}
        body="대화 기록도 지워져요."
        confirmLabel="지우기"
        danger
        onConfirm={remove}
        onCancel={() => setAsk(null)}
      />
      <AlwaysAllowDialog open={ask === 'always'} agent={agent} onClose={() => setAsk(null)} />
    </span>
  )
}
