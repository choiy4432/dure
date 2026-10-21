import type { CSSProperties } from 'react'
import type { DiffHunk } from '../../engine/types'
import { Clamp } from '../lib/Clamp'

type RowKind = 'ctx' | 'del' | 'add' | 'meta'
interface Row {
  kind: RowKind
  text: string
  /** 옛·새 줄 번호 — 그 쪽에 없는 줄이거나 시작을 모르면 null */
  old: number | null
  new: number | null
}

/** 줄 머리로 가른 종류 — '\'(줄바꿈 없음 같은 안내)는 번호 없는 안내 줄, 모르는 머리는 앞뒤 줄로 */
const kindOf = (line: string): RowKind => (line[0] === '-' ? 'del' : line[0] === '+' ? 'add' : line[0] === '\\' ? 'meta' : 'ctx')

/** 한 묶음의 줄 — 앞뒤 줄은 옛·새 번호가 함께, '-' 는 옛 번호만, '+' 는 새 번호만 늘어난다. 시작을 모르면 번호 없음 */
function rowsOf(h: DiffHunk): Row[] {
  let o = h.oldStart
  let n = h.newStart
  const numbered = o !== null && n !== null
  return h.lines.map(text => {
    const kind = kindOf(text)
    if (!numbered || kind === 'meta') return { kind, text, old: null, new: null }
    const row: Row = { kind, text, old: kind === 'add' ? null : o, new: kind === 'del' ? null : n }
    if (kind !== 'add') o = (o as number) + 1
    if (kind !== 'del') n = (n as number) + 1
    return row
  })
}

/** 읽는 말 — 바뀐 종류를 색만으로 알리지 않는다(보이는 '-'·'+' 앞 기호와 함께) */
const SPOKEN: Partial<Record<RowKind, string>> = { del: '지운 줄 ', add: '더한 줄 ' }

/**
 * 수정의 바뀐 줄 — 통합 diff 한 덩어리. 줄마다 옛/새 줄 번호(알면) · 앞 기호 그대로의 고정폭 글,
 * '-' 줄은 danger-bg · '+' 줄은 ok-bg · 앞뒤 줄은 muted, 묶음 사이는 얇은 나눔 줄.
 * 하는 일 출력처럼 길면 3줄로 접히고(Clamp), 엔진이 앞 400줄만 남겼으면(cut) "전체는 길어서 생략"
 */
export function DiffView({ hunks, cut }: { hunks: DiffHunk[]; cut?: boolean }) {
  const rows = hunks.map(rowsOf)
  // 번호 칸 너비 — 가장 큰 번호의 자릿수만큼(묶음마다 달라지지 않게 한 덩어리 공통)
  let top = 0
  for (const rs of rows) for (const r of rs) top = Math.max(top, r.old ?? 0, r.new ?? 0)
  const style = { '--df-w': `${String(top).length}ch` } as CSSProperties
  return (
    <>
      <Clamp className="clamp-mono">
        <div className="df" style={style}>
          {rows.map((rs, i) => (
            <div key={i} className="df-h">
              {rs.map((r, j) => (
                <div key={j} className={`df-l ${r.kind}`}>
                  {hunks[i].oldStart !== null && hunks[i].newStart !== null && (
                    <>
                      <span className="df-n">{r.old ?? ''}</span>
                      <span className="df-n">{r.new ?? ''}</span>
                    </>
                  )}
                  {SPOKEN[r.kind] && <span className="df-hid">{SPOKEN[r.kind]}</span>}
                  <span className="df-t">{r.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Clamp>
      {cut && <p className="act-cut">전체는 길어서 생략</p>}
    </>
  )
}
