import { openPhoneStore } from './phone/phoneStore'
import { offRecordedRoute, type Tailscale } from './phone/tailscale'

// 제거 정리 — 두레를 지울 때 제거 프로그램(build/installer.nsh 의 customUnInstall)이 `Dure.exe --uninstall-cleanup` 으로 부른다.
// 창·트레이·엔진 없이: 두레가 연 tailscale serve 길(phone.json 에 적어 둔 짝만) → 이 빌드의 로그인 항목 → 끝(index.ts 가 늘 0 으로 나간다).
// 🔴 앱 데이터(%APPDATA%\Dure — 방·대화·phone.json 의 설정·기기)는 지우지 않는다. 길 기록만 지운다(꺼졌으니)
//    로그에는 고정된 글만(경로·출력 없이). 업데이트(새 판이 옛 판을 지움)엔 NSIS 가 부르지 않는다(${isUpdated})

/** 제거 프로그램이 붙이는 인자 — build/installer.nsh 와 같아야 한다(builderConfig 시험) */
export const UNINSTALL_CLEANUP_ARG = '--uninstall-cleanup'
/** 길 끄기를 기다리는 상한 — 제거를 오래 붙잡지 않는다(못 끄면 그대로 둔다) */
export const UNINSTALL_ROUTE_WAIT_MS = 5_000

export interface UninstallCleanupOptions {
  /** <userData> — phone.json 이 여기 */
  dataDir: string
  tailscale: Pick<Tailscale, 'status' | 'serveOff'>
  /** 이 빌드의 로그인 항목 지우기 — 진짜는 설치본에서만 app.setLoginItemSettings(loginItemSettings(false, <빌드 이름>, exe)) */
  removeLoginItem: () => void
  /** 시험 — 길 끄기 상한(기본 UNINSTALL_ROUTE_WAIT_MS) */
  timeoutMs?: number
  /** 기본 console.error — 고정된 글만 */
  log?: (...args: unknown[]) => void
}

/** 정리 — 던지지 않는다(정리가 실패해도 제거는 계속) */
export async function uninstallCleanup(o: UninstallCleanupOptions): Promise<void> {
  const log = o.log ?? console.error
  try {
    const store = openPhoneStore(o.dataDir)
    const rec = store.read().serve
    if (rec) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), o.timeoutMs ?? UNINSTALL_ROUTE_WAIT_MS)))
      const r = await Promise.race([offRecordedRoute(o.tailscale, rec).then(() => 'done' as const), late]).finally(() => clearTimeout(timer))
      if (r === 'done') store.write({ serve: null })
      else log('[두레] 제거 — Tailscale 이 답하지 않아 휴대폰 길을 그대로 뒀어요')
    }
  } catch {
    log('[두레] 제거 — 휴대폰 길을 정리하지 못했어요')
  }
  try {
    o.removeLoginItem()
  } catch {
    log('[두레] 제거 — Windows 를 켜면 두레도 켜기를 지우지 못했어요')
  }
}
