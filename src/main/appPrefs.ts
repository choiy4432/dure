import fs from 'node:fs'
import path from 'node:path'
import { renameRetrying } from '../engine/store'
import { DEFAULT_APP_PREFS, type AppPrefs } from '../shared/appTypes'

const KEYS = Object.keys(DEFAULT_APP_PREFS) as (keyof AppPrefs)[]

/** 엔진 설정과 같은 파일 — 서로 남의 칸을 지우지 않게 둘 다 '읽고 합쳐 쓰기'(엔진 writeSettings 와 같은 꼴) */
const settingsFile = (dir: string) => path.join(dir, 'settings.json')

/** 설정 파일 전체 — 없거나 깨졌거나 객체가 아니면 빈 객체 */
function readRaw(dir: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 아는 칸 중 제 칸에 든 불리언만 — 그 밖(모르는 칸·불리언 아님·물려받은 칸·객체 아님)은 버린다 */
export function pickPrefs(v: unknown): Partial<AppPrefs> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Partial<AppPrefs> = {}
  for (const k of KEYS) {
    if (!Object.hasOwn(v, k)) continue
    const x = (v as Record<string, unknown>)[k]
    if (typeof x === 'boolean') out[k] = x
  }
  return out
}

/** 앱 설정 — 칸이 없거나 불리언이 아니면 기본값 */
export function readAppPrefs(dir: string): AppPrefs {
  return { ...DEFAULT_APP_PREFS, ...pickPrefs(readRaw(dir)) }
}

/** 바꾼 칸만 합쳐 쓰고(엔진 칸은 그대로) 바뀐 뒤의 앱 설정을 돌려준다 — 불리언이 아닌 칸은 무시, 남는 게 없으면 쓰지 않는다 */
export function writeAppPrefs(dir: string, patch: Partial<AppPrefs>): AppPrefs {
  const clean = pickPrefs(patch)
  if (Object.keys(clean).length === 0) return readAppPrefs(dir)
  const file = settingsFile(dir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...readRaw(dir), ...clean }, null, 2))
  renameRetrying(`${file}.tmp`, file)
  return readAppPrefs(dir)
}

/**
 * 켤 때 한 번 — 파일에 tourDone 칸이 아예 없는데 방이 있으면 업데이트로 받은 사람이다:
 * 투어·승인 안내를 이미 본 것으로 써 둔다. 칸이 있으면(false 라도) 그대로
 */
export function initAppPrefs(dir: string, hasRooms: boolean): AppPrefs {
  if (hasRooms && !Object.hasOwn(readRaw(dir), 'tourDone')) return writeAppPrefs(dir, { tourDone: true, approvalTipSeen: true })
  return readAppPrefs(dir)
}

/** 켤 때 쓰는 initAppPrefs — 쓰기가 실패해도(잠김·권한) 던지지 않고 지금 파일을 읽은 값. 투어 칸 하나로 두레가 못 켜지면 안 된다 */
export function initAppPrefsSafe(
  dir: string,
  hasRooms: boolean,
  log: (...args: unknown[]) => void = console.error,
): AppPrefs {
  try {
    return initAppPrefs(dir, hasRooms)
  } catch (e) {
    log('[두레] 앱 설정을 쓰지 못했어요:', e instanceof Error ? e.message : String(e))
    return readAppPrefs(dir)
  }
}
