import type { AgentDescription } from '../../engine/types'
import type { Described } from './ModelPicker'
import { MotionDiv } from '../lib/presence'
import { MOTION } from '../lib/motion'

export type SlashCommand = AgentDescription['commands'][number]

/** 한 번에 보이는 명령 수 */
const MAX_ITEMS = 8

/** 목록 한 줄 — 이름 · 보여 줄 설명 · 작은 출처 표시(내 명령 · 이 프로젝트 · 플러그인 이름, 기본 명령엔 없음) */
export type SlashEntry = { name: string; text: string; source?: string }

/**
 * Claude 의 기본 명령 중 두레에서 쓸 수 있는 것만 — 한국어 설명과 함께.
 * clear·model 은 두레가 직접 처리한다(새 대화 확인 · 모델 목록). 나머지 기본 명령(config·cost 등)은 터미널 전용이라 숨긴다.
 */
const BUILTIN: Record<string, string> = {
  compact: '대화를 요약해 용량을 줄여요',
  init: '이 폴더 설명서(CLAUDE.md)를 만들어요',
  review: '바뀐 내용을 검토해요',
  clear: '새 대화 시작',
  model: '모델 고르기',
}

/**
 * 설명의 마지막 꼬리표가 사용자 것인가 — '… (user)' · '… (project)' · '… (gstack) (user)'.
 * 기본 명령도 '(dynamic workflow)' · '(claude.ai sync)' 같은 괄호 메모로 끝나므로 이 둘만 본다.
 */
const USER_TAG = /\((user|project)\)\s*$/

/** 설명 끝의 영어 출처 꼬리표 묶음 — ' (gstack) (user)' 처럼. 한국어가 든 괄호(설명의 일부)는 꼬리표가 아니다 */
const TRAILING_TAGS = /(?:\s*\([A-Za-z0-9 _.:/@+-]*\))+\s*$/

/** 출처 꼬리표 → 화면의 작은 한국어 출처 */
const SOURCE: Record<string, string> = { user: '내 명령', project: '이 프로젝트' }

/**
 * 목록에 보일지·무엇으로 보일지(claude 2.1.270 의 initialize 목록 기준):
 * 1. 이름에 ':' — 설치한 플러그인 스킬(superpowers:brainstorming 등) → 출처는 ':' 앞 플러그인 이름(사용자가 설치한 이름)
 * 2. 마지막 꼬리표가 (user)·(project) — 사용자 명령·스킬 → 출처 '내 명령' · '이 프로젝트'
 * 3. 그 밖은 Claude Code 기본·번들 명령 → BUILTIN 에 있는 것만 한국어로(출처 없음), 나머지는 null(숨김)
 * 1·2 의 설명은 끝의 영어 꼬리표 묶음('(gstack) (user)')을 떼고 보인다 — 출처는 따로 작게.
 * 보일지 정하는 규칙(1·2·3)은 꼬리표를 떼기 전 원래 설명으로 정한다.
 */
export function slashEntry(c: SlashCommand): SlashEntry | null {
  const tag = USER_TAG.exec(c.description)?.[1]
  const colon = c.name.indexOf(':')
  if (colon !== -1 || tag) {
    const text = c.description.replace(TRAILING_TAGS, '').trim()
    return { name: c.name, text, source: colon !== -1 ? c.name.slice(0, colon) : SOURCE[tag!] }
  }
  const text = BUILTIN[c.name]
  return text === undefined ? null : { name: c.name, text }
}

/** 보일 명령 중 이름 앞부분이 맞는 것 — 받은 순서대로, 최대 8개(대소문자 무시) */
export function matchCommands(commands: SlashCommand[], query: string): SlashEntry[] {
  const q = query.toLowerCase()
  const out: SlashEntry[] = []
  for (const c of commands) {
    if (!c.name.toLowerCase().startsWith(q)) continue
    const entry = slashEntry(c)
    if (!entry) continue
    out.push(entry)
    if (out.length === MAX_ITEMS) break
  }
  return out
}

export const slashOptionId = (listId: string, i: number) => `${listId}-${i}`

interface Props {
  id: string
  description: Described
  items: SlashEntry[]
  active: number
  onPick: (c: SlashEntry) => void
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
    <MotionDiv motion={MOTION.popUp} origin="bottom left" id={id} className="slash" role="listbox" aria-label="명령" onMouseDown={keepFocus}>
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
            <span className="sl-d">{c.text}</span>
            {c.source && <span className="sl-src">{c.source}</span>}
          </div>
        ))
      )}
    </MotionDiv>
  )
}
