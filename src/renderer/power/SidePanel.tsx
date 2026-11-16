// 파워 모드 옆 칸 — 머리의 [대화 | 기록] 전환. 대화 = 스토어가 고른 에이전트의 대화 패널(AgentPanel 그대로 — 대화·도구 카드·승인·질문·입력창·첨부·탭),
// 기록 = 넘겨받은 실시간 기록. 아무도 안 골랐으면 기록. 관제실과 터미널 벽이 같이 쓴다. 새 상태는 없다(고르기는 스토어 것).
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useDure } from '../state/store'
import { AgentPanel } from '../panel/AgentPanel'

type View = 'chat' | 'log'
const ORDER: View[] = ['chat', 'log']
const LABEL: Record<View, string> = { chat: '대화', log: '기록' }

/**
 * 고르면(카드·노드·찾기) 대화로 — 고른 에이전트가 바뀌거나, 같은 에이전트라도 입력창 커서 요청(카드 클릭)이 새로 오면.
 * 대화 칸은 대화 탭일 때만 그린다(기록을 보는 동안 숨은 입력창이 커서를 받지 않게 — 숨겨 두고 마운트하면 효과가 두 벌 돈다).
 * 그래서 대화 탭의 aria-controls 는 대화 칸이 있을 때만. 기록은 늘 그려 두고 숨기기만 해 줄이 계속 쌓인다.
 * 대화 패널 요소는 하나로 굳힌다 — 화면이 시계·사건마다 다시 그려져도 대화 패널은 제 스토어 구독으로만 다시 그린다.
 */
export function SidePanel({ log }: { log: ReactNode }) {
  const sel = useDure(s => (s.agents.some(a => a.id === s.selectedAgentId) ? s.selectedAgentId : null))
  const ask = useDure(s => s.inputFocus?.n ?? 0)
  const [view, setView] = useState<View>(sel ? 'chat' : 'log')
  // 고르기·커서 요청이 바뀐 그 그리기에서 바로 대화로(효과를 기다리면 기록이 한 번 비친다)
  const [seen, setSeen] = useState({ sel, ask })
  if (seen.sel !== sel || seen.ask !== ask) {
    setSeen({ sel, ask })
    if (sel && (seen.sel !== sel || ask !== 0)) setView('chat')
  }
  const shown: View = sel ? view : 'log'
  const base = useId()
  const tabs = useRef<Partial<Record<View, HTMLButtonElement | null>>>({})
  const chat = useMemo(() => <AgentPanel />, [])

  const go = (v: View) => {
    if (v === 'chat' && !sel) return
    setView(v)
    tabs.current[v]?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const i = ORDER.indexOf(shown)
    const to = e.key === 'Home' ? ORDER[0] : e.key === 'End' ? ORDER[ORDER.length - 1] : ORDER[(i + (e.key === 'ArrowRight' ? 1 : ORDER.length - 1)) % ORDER.length]
    go(to)
  }

  return (
    <section className="pw-side" aria-label="옆 칸">
      <div className="pw-side-hd">
        <div className="pw-seg" role="tablist" aria-label="옆 칸 보기">
          {ORDER.map(v => (
            <button
              key={v}
              ref={el => {
                tabs.current[v] = el
              }}
              type="button"
              role="tab"
              id={`${base}-${v}`}
              aria-selected={shown === v}
              aria-controls={v === 'chat' && shown !== 'chat' ? undefined : `${base}-${v}-panel`}
              tabIndex={shown === v ? 0 : -1}
              disabled={v === 'chat' && !sel}
              onClick={() => go(v)}
              onKeyDown={onKey}
            >
              {LABEL[v]}
            </button>
          ))}
        </div>
      </div>
      {shown === 'chat' && (
        <div className="pw-side-chat" role="tabpanel" id={`${base}-chat-panel`} aria-labelledby={`${base}-chat`}>
          {chat}
        </div>
      )}
      <div className="pw-side-log" role="tabpanel" id={`${base}-log-panel`} aria-labelledby={`${base}-log`} hidden={shown !== 'log'}>
        {log}
      </div>
    </section>
  )
}
