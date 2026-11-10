// 에이전트 작업 폴더를 글로 — 패널 머리의 폴더 줄(전체 · 가운데 말줄임)과 관계도 카드의 짧은 폴더(시안 ② A)

/** 보이는 폴더 — 서버 방이면 `호스트:경로`(이 PC 에서 열 수 없는 서버 쪽 경로) */
export function folderText(folder: string, host: string | null): string {
  return host ? `${host}:${folder}` : folder
}

/** 끝의 나눔표(\ /)를 뗀다 — 뿌리(C:\ · /)는 그대로 */
function trimEnd(path: string): string {
  const t = path.replace(/[\\/]+$/, '')
  return t === '' || /^[A-Za-z]:$/.test(t) ? path : t
}

/**
 * 짧은 폴더(카드) — 뿌리(드라이브 · ~ · /) 뒤로 마지막 두 마디. 마디가 더 있으면 앞을 '…' 로 줄인다.
 * C:\work\shop\web → …\shop\web · ~/shop/api → 그대로 · /home/me/shop/api → …/shop/api
 */
export function shortFolder(folder: string): string {
  const path = trimEnd(folder)
  const sep = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]+/)
  // 첫 조각은 뿌리(드라이브 'C:' · '~' · 절대 경로의 '') — 마디로 세지 않는다
  if (parts.length - 1 <= 2) return path
  return `…${sep}${parts.slice(-2).join(sep)}`
}

/** 가운데 말줄임 — 앞(줄어드는 쪽)과 마지막 마디(나눔표부터, 늘 보이는 쪽). 나눔표가 없으면 통째로 끝 */
export function splitTail(path: string): { head: string; tail: string } {
  const p = trimEnd(path)
  const at = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return at <= 0 ? { head: '', tail: p } : { head: p.slice(0, at), tail: p.slice(at) }
}
