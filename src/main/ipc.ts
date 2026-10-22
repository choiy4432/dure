import type { Engine } from '../engine'
import {
  CHANNEL, CLAUDE_MISSING_ERROR, EVENT_NAMES, METHODS,
  type AgentView, type InvokeRequest, type InvokeResult, type Snapshot,
} from '../shared/ipcContract'

export interface IpcLike {
  handle(channel: string, fn: (event: unknown, req: unknown) => unknown): void
}
export interface IpcDeps {
  pickFolder(): Promise<string | null>
  openFolder(path: string): Promise<void>
  /** 작업표시줄 배지 — count 가 0 이면 지운다. 엔진을 거치지 않는 창 쪽 일이라 deps 로 받는다 */
  setTaskbar(count: number, png: string | null): Promise<void>
  /** 초점이 없는 창의 작업표시줄 단추를 깜박인다 */
  flashWindow(): Promise<void>
  /** 창을 앞으로(최소화면 되살리고 초점) */
  focusWindow(): Promise<void>
  /** 요청을 보낸 프레임 주소가 두레 화면인가 — 아니면 거절(window.ts 의 appPageMatcher) */
  isAppPage(url: string | undefined): boolean
}

const NOT_ALLOWED = '허용되지 않은 요청이에요'
const FOLDER_NOT_ALLOWED = '등록된 에이전트의 폴더만 열 수 있어요'

function agentViews(engine: Engine): AgentView[] {
  return engine.agents().map((a) => {
    const flags = engine.flags(a.id)
    return {
      ...a,
      status: engine.status(a.id),
      errorText: engine.errorText(a.id),
      bypass: flags.bypass,
      bypassBySettings: flags.bySettings,
      bypassPending: flags.pending,
      heldInput: engine.heldInput(a.id),
      effortNow: engine.effortNow(a.id),
      modelNow: engine.modelNow(a.id),
      subagentsRunning: engine.subagentsRunning(a.id),
    }
  })
}

function snapshot(engine: Engine | null): Snapshot {
  if (!engine) {
    return { claudeMissing: true, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0, allowBypass: false, notify: { asks: true, finished: false }, usage: null }
  }
  return {
    claudeMissing: false,
    rooms: engine.rooms(),
    agents: agentViews(engine),
    messages: engine.messages(),
    requests: engine.pendingRequests(),
    autoChainLimit: engine.autoChainLimit(),
    allowBypass: engine.allowBypass(),
    notify: engine.notify(),
    usage: engine.usage(),
  }
}

type Handler = (e: Engine, deps: IpcDeps, ...a: any[]) => unknown
const HANDLERS: Record<(typeof METHODS)[number], Handler> = {
  snapshot: (e) => snapshot(e),
  addRoom: (e, _d, name) => e.addRoom(name),
  renameRoom: (e, _d, id, name) => e.renameRoom(id, name),
  removeRoom: (e, _d, id) => e.removeRoom(id),
  addAgent: (e, _d, i) => e.addAgent(i),
  updateAgent: (e, _d, id, p) => e.updateAgent(id, p),
  removeAgent: (e, _d, id) => e.removeAgent(id),
  setSelected: (e, _d, id) => e.setSelected(id),
  sendUser: (e, _d, id, parts) => e.sendUser(id, parts),
  interrupt: (e, _d, id) => e.interrupt(id),
  newConversation: (e, _d, id) => e.newConversation(id),
  setModel: (e, _d, id, model) => e.setModel(id, model),
  setEffort: (e, _d, id, level) => e.setEffort(id, level),
  refreshUsage: (e) => e.refreshUsage(),
  describe: (e, _d, id) => e.describe(id),
  history: (e, _d, id, o) => e.history(id, o),
  approveMessage: (e, _d, id) => e.approveMessage(id),
  dismissMessage: (e, _d, id) => e.dismissMessage(id),
  continueHeld: (e, _d, roomId) => e.continueHeld(roomId),
  answerRequest: (e, _d, id, d) => e.answerRequest(id, d),
  setAutoChainLimit: (e, _d, n) => e.setAutoChainLimit(n),
  setAllowBypass: (e, _d, on) => e.setAllowBypass(on),
  setNotify: (e, _d, p) => e.setNotify(p),
  setBypass: (e, _d, id, on) => e.setBypass(id, on),
  pickFolder: (_e, d) => d.pickFolder(),
  setTaskbar: (_e, d, count, png) => d.setTaskbar(count as number, (png ?? null) as string | null),
  flashWindow: (_e, d) => d.flashWindow(),
  focusWindow: (_e, d) => d.focusWindow(),
  openFolder: (e, d, path) => {
    // renderer 가 임의 경로를 열지 못하게 — 등록된 에이전트의 폴더만
    if (!e.agents().some((a) => a.folder === path)) throw new Error(FOLDER_NOT_ALLOWED)
    return d.openFolder(path)
  },
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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

/** `dure:invoke` 하나로 화이트리스트 메서드를 엔진에 잇고, 엔진 이벤트를 `dure:event` 로 내보낸다. */
export function registerIpc(
  ipc: IpcLike,
  engine: Engine | null,
  send: (channel: string, payload: unknown) => void,
  deps: IpcDeps,
): void {
  ipc.handle(CHANNEL.invoke, async (event, req): Promise<InvokeResult> => {
    try {
      // 두레 화면이 아닌 곳(창 안으로 들어온 다른 페이지·프레임)의 요청은 받지 않는다
      if (!deps.isAppPage(senderUrl(event))) throw new Error(NOT_ALLOWED)
      const { method, args } = (req ?? {}) as Partial<InvokeRequest>
      if (typeof method !== 'string' || !Object.hasOwn(HANDLERS, method)) throw new Error(NOT_ALLOWED)
      if (method === 'snapshot') return { ok: true, value: snapshot(engine) }
      if (!engine) throw new Error(CLAUDE_MISSING_ERROR)
      const handler = HANDLERS[method as keyof typeof HANDLERS]
      const value = await handler(engine, deps, ...(Array.isArray(args) ? args : []))
      return { ok: true, value: value ?? null }
    } catch (err) {
      return { ok: false, error: messageOf(err) } // 스택은 넘기지 않는다
    }
  })

  if (!engine) return
  // 창이 생기기 전에 난 이벤트는 그냥 버려진다 — renderer 가 처음 뜰 때 snapshot() 으로 현재 상태를 받는다.
  for (const name of EVENT_NAMES) {
    engine.on(name, (payload: unknown) => {
      try {
        send(CHANNEL.event, { name, payload })
      } catch {
        // 창이 닫히는 중이면 보낼 곳이 없다 — 엔진을 멈추지 않는다
      }
    })
  }
}
