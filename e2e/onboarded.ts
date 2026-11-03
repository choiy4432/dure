// e2e 도우미 — 빈 user-data 로 켜면 처음 쓰는 사람이라 안내 투어(환영)와 '승인 한 번'이 화면을 막는다.
// 투어를 시험하지 않는 spec 은 띄우기 전에 이걸 불러 '이미 본 사람'으로 시작한다(엔진 칸이 있으면 그대로 두고 합친다).
import fs from 'node:fs'
import path from 'node:path'

export function markOnboarded(userData: string): void {
  const file = path.join(userData, 'settings.json')
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // 아직 없다 — 새로 쓴다
  }
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...raw, tourDone: true, approvalTipSeen: true }, null, 2))
}
