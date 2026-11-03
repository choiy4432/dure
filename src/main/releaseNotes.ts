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
  const text = typeof notes === 'string' ? notes : notes.map((n) => n.note ?? '').join('\n')
  const out: string[] = []
  for (const line of text.split(/\r\n|\n|\r/)) {
    // 한 줄에 <li> 가 여럿일 수도 있다
    const lis = [...line.matchAll(/<li[^>]*>([\s\S]*?)(?:<\/li>|$)/gi)]
    const items = lis.length > 0 ? lis.map((m) => m[1]) : /^\s*[-*]\s+(.*)$/.test(line) ? [line.replace(/^\s*[-*]\s+/, '')] : []
    for (const it of items) {
      const c = clean(it)
      if (c) out.push(c)
    }
  }
  return out.slice(0, max)
}
