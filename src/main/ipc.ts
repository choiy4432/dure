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
}

const NOT_ALLOWED = '허용되지 않은 요청이에요'
const FOLDER_NOT_ALLOWED = '등록된 에이전트의 폴더만 열 수 있어요'

function agentViews(engine: Engine): AgentView[] {
  return engine.agents().map((a) => ({
    ...a,
    status: engine.status(a.id),
    errorText: engine.errorText(a.id),
    bypass: engine.flags(a.id).bypass,
    heldInput: engine.heldInput(a.id),
  }))
}

function snapshot(engine: Engine | null): Snapshot {
  if (!engine) {
    return { claudeMissing: true, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0 }
  }
  return {
    claudeMissing: false,
    rooms: engine.rooms(),
    agents: agentViews(engine),
    messages: engine.messages(),
    requests: engine.pendingRequests(),
    autoChainLimit: engine.autoChainLimit(),
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
  sendUser: (e, _d, id, parts) => e.sendUser(id, parts),
  interrupt: (e, _d, id) => e.interrupt(id),
  newConversation: (e, _d, id) => e.newConversation(id),
  setModel: (e, _d, id, model) => e.setModel(id, model),
  describe: (e, _d, id) => e.describe(id),
  history: (e, _d, id, o) => e.history(id, o),
  approveMessage: (e, _d, id) => e.approveMessage(id),
  dismissMessage: (e, _d, id) => e.dismissMessage(id),
  continueHeld: (e, _d, roomId) => e.continueHeld(roomId),
  answerRequest: (e, _d, id, d) => e.answerRequest(id, d),
  setAutoChainLimit: (e, _d, n) => e.setAutoChainLimit(n),
  pickFolder: (_e, d) => d.pickFolder(),
  openFolder: (e, d, path) => {
    // renderer 가 임의 경로를 열지 못하게 — 등록된 에이전트의 폴더만
    if (!e.agents().some((a) => a.folder === path)) throw new Error(FOLDER_NOT_ALLOWED)
    return d.openFolder(path)
  },
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `dure:invoke` 하나로 화이트리스트 메서드를 엔진에 잇고, 엔진 이벤트를 `dure:event` 로 내보낸다. */
export function registerIpc(
  ipc: IpcLike,
  engine: Engine | null,
  send: (channel: string, payload: unknown) => void,
  deps: IpcDeps,
): void {
  ipc.handle(CHANNEL.invoke, async (_event, req): Promise<InvokeResult> => {
    try {
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
