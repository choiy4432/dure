import type { AgentDescription } from '../../engine/types'
import type { Described } from './ModelPicker'

export type SlashCommand = AgentDescription['commands'][number]

/** 한 번에 보이는 명령 수 */
const MAX_ITEMS = 8

/** 두레가 따로 처리하는 명령 — Claude 의 영어 설명 대신 */
const OWN_TEXT: Record<string, string> = {
  model: '모델 고르기',
  clear: '새 대화 시작',
}

/** 이름 앞부분이 맞는 명령 — 받은 순서대로, 최대 8개(대소문자 무시) */
export function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase()
  const out: SlashCommand[] = []
  for (const c of commands) {
    if (!c.name.toLowerCase().startsWith(q)) continue
    out.push(c)
    if (out.length === MAX_ITEMS) break
  }
  return out
}

export const slashOptionId = (listId: string, i: number) => `${listId}-${i}`

interface Props {
  id: string
  description: Described
  items: SlashCommand[]
  active: number
  onPick: (c: SlashCommand) => void
  onHover: (i: number) => void
  onRetry: () => void
}

/**
 * / 명령 목록 — 입력창 위에 뜬다. 포커스는 입력창에 둔 채 ↑↓ Enter Esc 로 고른다(입력창이 키를 받는다).
 * 누르는 동안 입력창이 포커스를 잃지 않게 mousedown 은 막는다.
 */
export function SlashMenu({ id, description, items, active, onPick, onHover, onRetry }: Props) {
  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault()
  return (
    <div id={id} className="slash" role="listbox" aria-label="명령" onMouseDown={keepFocus}>
      {description.state === 'error' ? (
        <div className="pop-note">
          명령을 불러오지 못했어요
          <button type="button" className="lk" onClick={onRetry}>
            다시 시도
          </button>
        </div>
      ) : description.state !== 'ready' ? (
        <p className="pop-note">명령을 불러오는 중…</p>
      ) : (
        items.map((c, i) => (
          <div
            key={c.name}
            id={slashOptionId(id, i)}
            role="option"
            aria-selected={i === active}
            className="sl"
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(c)}
          >
            <span className="f sl-n">/{c.name}</span>
            <span className="sl-d">{OWN_TEXT[c.name] ?? c.description}</span>
          </div>
        ))
      )}
    </div>
  )
}
