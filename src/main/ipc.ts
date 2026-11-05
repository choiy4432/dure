import type { Engine } from '../engine'
import { CHANNEL, EVENT_NAMES, type InvokeRequest, type InvokeResult } from '../shared/ipcContract'
import type { AppEventMap } from '../shared/appTypes'
import { createDispatcher, NOT_ALLOWED, type DispatchDeps } from './dispatch'

export { saveName, type AppHost } from './dispatch'

export interface IpcLike {
  handle(channel: string, fn: (event: unknown, req: unknown) => unknown): void
}

/** registerIpc 가 받는 것 — 디스패처의 일(DispatchDeps)에 창 쪽 칸을 더한다 */
export interface IpcDeps extends DispatchDeps {
  /** 앱 사건을 받을 곳을 건넨다 — registerIpc 가 한 번 불러 창(CHANNEL.event)으로 잇는다. 엔진이 없어도 */
  onAppEvent(fn: (name: keyof AppEventMap, payload: unknown) => void): void
  /** 요청을 보낸 프레임 주소가 두레 화면인가 — 아니면 거절(window.ts 의 appPageMatcher) */
  isAppPage(url: string | undefined): boolean
}

/** 요청을 보낸 프레임의 주소 — 프레임이 없으면(닫힘 등) undefined */
function senderUrl(event: unknown): string | undefined {
  const url = (event as { senderFrame?: { url?: unknown } | null } | null)?.senderFrame?.url
  return typeof url === 'string' ? url : undefined
}

/** 엔진 오류를 main 기록에 남긴다 — 종류와 문구만(사람이 쓴 글·파일 내용은 넣지 않는다) */
export function logEngineErrors(
  engine: Engine,
  log: (...args: unknown[]) => void = console.error,
): void {
  engine.on('engine-error', (p: { message: string }) => log('[두레] engine-error:', p.message))
}

/**
 * `dure:invoke` 하나로 화이트리스트 메서드를 잇고, 엔진·앱 사건을 `dure:event` 로 내보낸다.
 * 순서: 두레 화면에서 온 요청인가(isAppPage) → 디스패처(createDispatcher — 앱 메서드 → deps.app(엔진 없어도) · snapshot → 바로 ·
 * 엔진 없음 → CLAUDE_MISSING_ERROR · BEFORE_START 밖 → engineReady 뒤). 휴대폰 서버도 같은 디스패처를 탄다(phoneDispatcher)
 */
export function registerIpc(
  ipc: IpcLike,
  engine: Engine | null,
  send: (channel: string, payload: unknown) => void,
  deps: IpcDeps,
): void {
  const dispatch = createDispatcher(engine, deps)
  ipc.handle(CHANNEL.invoke, async (event, req): Promise<InvokeResult> => {
    try {
      // 두레 화면이 아닌 곳(창 안으로 들어온 다른 페이지·프레임)의 요청은 받지 않는다
      if (!deps.isAppPage(senderUrl(event))) throw new Error(NOT_ALLOWED)
      const { method, args } = (req ?? {}) as Partial<InvokeRequest>
      // 이름·인자의 꼴은 디스패처가 다시 본다(글이 아닌 이름 → 거절 · 목록이 아닌 인자 → 빈 목록)
      return await dispatch(method as string, args as unknown[])
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) } // 스택은 넘기지 않는다
    }
  })

  // 창이 생기기 전에 난 사건은 그냥 버려진다 — renderer 가 처음 뜰 때 snapshot()·앱 상태 메서드로 현재 상태를 받는다.
  const forward = (name: string, payload: unknown) => {
    try {
      send(CHANNEL.event, { name, payload })
    } catch {
      // 창이 닫히는 중이면 보낼 곳이 없다 — 엔진·앱 흐름을 멈추지 않는다
    }
  }
  // 앱 사건은 엔진이 없어도(준비 화면) 간다 — 그래서 아래 early return 보다 먼저
  deps.onAppEvent(forward)

  if (!engine) return
  for (const name of EVENT_NAMES) engine.on(name, (payload: unknown) => forward(name, payload))
}
