/** electron-updater 의 releaseNotes — 글(HTML 또는 마크다운) 또는 [{ note }] 목록 */
export type ReleaseNotes = string | { note: string | null }[] | null | undefined

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function clean(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** 릴리스 노트에서 목록 항목(HTML `<li>` · 마크다운 `- `·`* `)을 앞에서 max 개 — 태그·엔터티를 벗기고 빈 항목은 버린다 */
export function releaseHighlights(notes: ReleaseNotes, max = 3): string[] {
  if (!notes) return []
  // 배열은 칸마다 따로 읽는다(칸마다 HTML 일 수도 마크다운일 수도)
  const parts = typeof notes === 'string' ? [notes] : notes.map((n) => n.note ?? '')
  return parts.flatMap((t) => itemsOf(t)).slice(0, max)
}

function itemsOf(text: string): string[] {
  const out: string[] = []
  const push = (raw: string): void => {
    const c = clean(raw)
    if (c) out.push(c)
  }
  if (/<li[\s>]/i.test(text)) {
    // 렌더된 HTML — 줄에 걸친 <li> 도 본다. 안쪽(중첩) 목록은 건너뛰고 맨 위 항목만 센다
    let depth = 0
    let cur: number | null = null
    for (const m of text.matchAll(/<(\/?)(li|ul|ol)(?:\s[^>]*)?>/gi)) {
      const close = m[1] === '/'
      const tag = m[2].toLowerCase()
      const at = m.index ?? 0
      if (tag === 'li') {
        if (cur !== null) {
          push(text.slice(cur, at))
          cur = null
        }
        if (!close && depth <= 1) cur = at + m[0].length
      } else if (!close) {
        if (cur !== null) {
          push(text.slice(cur, at))
          cur = null
        }
        depth++
      } else {
        depth = Math.max(0, depth - 1)
      }
    }
    if (cur !== null) push(text.slice(cur))
  } else {
    for (const line of text.split(/\r\n|\n|\r/)) {
      if (/^\s*[-*]\s+/.test(line)) push(line.replace(/^\s*[-*]\s+/, ''))
    }
  }
  return out
}
