import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openStore, type Store } from './store';
import { openMessageLog, type MessageLog } from './messageLog';
import { buildArgs, buildMcpConfig, SPAWN_ENV_EXTRA } from './claudeArgs';
import { buildRoomPrompt } from './roomPrompt';
import { ClaudeSession } from './claudeSession';
import { startMcpServer, type McpServerHandle } from './mcpServer';
import { Permissions } from './permissions';
import { Router } from './router';
import type {
  Agent, AgentId, AgentPatch, AgentStatus, Decision, PendingRequest, RelayMessage, Room, RoomId, StreamEvent, UserPart,
} from './types';

export interface EngineOptions {
  dataDir: string;
  claude: { command: string; argsPrefix?: string[] };
  autoChainLimit?: number;
  env?: NodeJS.ProcessEnv;
}

export interface AgentDescription {
  commands: { name: string; description: string; argumentHint: string }[];
  models: { value: string; displayName: string; description?: string }[];
  permissionMode: string;
}

// 이벤트:
//  'agent-event' { agentId; event: StreamEvent; viaApproval?: boolean }  (tool-result 일 때 viaApproval = permissions.wasAsked)
//  'status'      { agentId; status: AgentStatus; errorText: string | null }
//  'message'     RelayMessage     'held' { roomId }
//  'request'     PendingRequest   'request-resolved' { id; agentId }
//  'flags'       { agentId; bypass: boolean }   (init.permissionMode === 'bypassPermissions')
export interface Engine extends EventEmitter {
  rooms(): Room[];
  agents(roomId?: RoomId): Agent[];
  addRoom(name: string): Room;
  renameRoom(id: RoomId, name: string): Room;
  removeRoom(id: RoomId): Promise<void>;
  addAgent(i: { roomId: RoomId; name: string; role: string; folder: string }): Agent;
  updateAgent(id: AgentId, p: Pick<AgentPatch, 'name' | 'role' | 'auto' | 'pos' | 'color'>): Agent;
  removeAgent(id: AgentId): Promise<void>;
  status(id: AgentId): AgentStatus;
  errorText(id: AgentId): string | null;
  sendUser(id: AgentId, parts: UserPart[]): Promise<void>;
  interrupt(id: AgentId): Promise<void>;
  newConversation(id: AgentId): Promise<void>;
  setModel(id: AgentId, model: string | null): Promise<void>;
  describe(id: AgentId): Promise<AgentDescription>;
  messages(f?: Parameters<MessageLog['list']>[0]): RelayMessage[];
  approveMessage(id: string): void;
  dismissMessage(id: string): void;
  continueHeld(roomId: RoomId): void;
  pendingRequests(agentId?: AgentId): PendingRequest[];
  answerRequest(id: string, d: Decision): void;
  shutdown(): Promise<void>;
}

const STOP_LIMIT_MS = 5000; // ClaudeSession.stop() 의 kill 뒤 대기는 끝이 없다 — 엔진이 따로 끊는다
const EXITED = 'Claude 가 종료되었습니다.';
const STOPPED_BY_USER = '사용자가 멈췄습니다.';
const NO_AGENT = '에이전트를 찾을 수 없습니다.';
const CLOSED = '두레 엔진이 종료되었습니다.';

/** 프로세스에 써 넣었지만 아직 아무 이벤트도 안 온 줄 — 읽기 전에 죽으면 되살린다 */
type InFlight = { kind: 'relay'; messageId: string } | { kind: 'human'; parts: UserPart[] };

class EngineImpl extends EventEmitter implements Engine {
  private sessions = new Map<AgentId, ClaudeSession>();
  private held = new Map<AgentId, UserPart[][]>(); // 일하는 중에 사람이 넣은 입력 — 끝나면 순서대로
  private errors = new Map<AgentId, string>(); // 세션 없이 남은 오류(비정상 종료·폴더 없음) — 다음 실행까지
  private shown = new Map<AgentId, { status: AgentStatus; errorText: string | null }>();
  private described = new WeakMap<ClaudeSession, Promise<AgentDescription>>();
  private inFlight = new WeakMap<ClaudeSession, InFlight>();
  private removing = new Set<AgentId>();
  private closed = false;
  private closing: Promise<void> | null = null;
  private perms: Permissions;
  private router: Router;
  private mcp!: McpServerHandle;

  constructor(private o: EngineOptions, private store: Store, private log: MessageLog) {
    super();
    this.perms = new Permissions(store);
    this.router = new Router({
      store,
      log,
      limit: o.autoChainLimit,
      deliver: (id, text, messageId) => this.sendTo(this.ensure(id), [{ type: 'text', text }], { kind: 'relay', messageId }),
      isBusy: (id) => this.waiting(id) || (this.held.get(id)?.length ?? 0) > 0,
    });
    this.perms.on('request', (r: PendingRequest) => {
      this.emit('request', r);
      this.emitStatus(r.agentId);
    });
    this.perms.on('resolved', (r: { id: string; agentId: AgentId }) => {
      this.emit('request-resolved', r);
      this.emitStatus(r.agentId);
      this.pump(r.agentId);
    });
    this.router.on('message', (m: RelayMessage) => this.emit('message', m));
    this.router.on('held', (h: { roomId: RoomId }) => this.emit('held', h));
  }

  async start(): Promise<void> {
    this.mcp = await startMcpServer({
      listAgents: (agentId) => {
        const me = this.caller(agentId);
        const peers = this.store.agents(me.roomId).filter((a) => a.id !== me.id);
        return JSON.stringify(peers.map((a) => ({ name: a.name, role: a.role, status: this.status(a.id) })));
      },
      sendMessage: (agentId, to, text) => this.router.send(this.caller(agentId).id, to, text),
      approve: (agentId, args) => {
        if (this.closed || this.removing.has(agentId)) return Promise.resolve({ behavior: 'deny', message: EXITED });
        return this.perms.request(agentId, args);
      },
    });
    this.router.flushAll();
  }

  // ── 방·에이전트 ──
  rooms() { return this.store.rooms(); }
  agents(roomId?: RoomId) { return this.store.agents(roomId); }
  addRoom(name: string) { return this.store.addRoom(name); }
  renameRoom(id: RoomId, name: string) { return this.store.renameRoom(id, name); }
  addAgent(i: { roomId: RoomId; name: string; role: string; folder: string }) { return this.store.addAgent(i); }

  updateAgent(id: AgentId, p: Pick<AgentPatch, 'name' | 'role' | 'auto' | 'pos' | 'color'>) {
    this.need(id);
    const { name, role, auto, pos, color } = p; // model·alwaysAllow·sessionId 는 엔진이 따로 다룬다
    return this.store.updateAgent(id, { name, role, auto, pos, color });
  }

  async removeRoom(id: RoomId) {
    for (const a of this.store.agents(id)) await this.removeAgent(a.id);
    this.store.removeRoom(id); // 없는 방이면 여기서 던진다(그 전엔 할 일이 없다)
  }

  async removeAgent(id: AgentId) {
    this.need(id);
    this.removing.add(id);
    try {
      await this.endSession(id);
      for (const m of this.log.list({ states: ['pending', 'held', 'queued'] })) {
        if (m.to === id || m.from === id) this.router.dismiss(m.id);
      }
      this.store.removeAgent(id);
    } finally {
      this.removing.delete(id);
      this.shown.delete(id);
      this.held.delete(id); // 기다리던 사람 입력은 에이전트와 함께 버린다
    }
  }

  // ── 상태 ──
  status(id: AgentId): AgentStatus {
    this.need(id);
    if (this.perms.pending(id).length > 0) return 'awaiting';
    const s = this.sessions.get(id);
    if (s) return s.status;
    return this.errors.has(id) ? 'error' : 'idle';
  }

  errorText(id: AgentId): string | null {
    this.need(id);
    const s = this.sessions.get(id);
    if (s?.status === 'error') return s.errorText;
    return this.errors.get(id) ?? null;
  }

  // ── 대화 ──
  async sendUser(id: AgentId, parts: UserPart[]) {
    const agent = this.need(id);
    this.router.humanInput(agent.roomId);
    const q = this.heldOf(id);
    q.push(parts);
    try {
      this.ensure(id);
    } catch (e) {
      q.pop();
      throw e;
    }
    this.pump(id); // 차례 중·승인 대기면 그대로 두고, 그 차례의 result 에서 보낸다 — 두 줄을 동시에 보내지 않는다
  }

  async interrupt(id: AgentId) {
    this.need(id);
    this.perms.cancelForAgent(id, STOPPED_BY_USER);
    const s = this.sessions.get(id);
    if (s) await s.interrupt();
  }

  async newConversation(id: AgentId) {
    this.need(id);
    const ending = this.endSession(id);
    this.store.updateAgent(id, { sessionId: crypto.randomUUID(), started: false });
    this.emitStatus(id);
    await ending;
  }

  async setModel(id: AgentId, model: string | null) {
    this.need(id);
    this.store.updateAgent(id, { model });
    const s = this.sessions.get(id);
    if (s) await s.request({ subtype: 'set_model', model: model ?? 'default' });
  }

  describe(id: AgentId): Promise<AgentDescription> {
    try {
      this.need(id);
      const s = this.ensure(id);
      let p = this.described.get(s);
      if (!p) {
        p = s.request({ subtype: 'initialize' }).then(toDescription);
        this.described.set(s, p);
        p.catch(() => this.described.delete(s));
      }
      return p;
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // ── 메시지·승인 ──
  messages(f?: Parameters<MessageLog['list']>[0]) { return this.log.list(f); }
  approveMessage(id: string) { this.router.approve(id); }
  dismissMessage(id: string) { this.router.dismiss(id); }
  continueHeld(roomId: RoomId) { this.router.continueHeld(roomId); }
  pendingRequests(agentId?: AgentId) { return this.perms.pending(agentId); }
  answerRequest(id: string, d: Decision) { this.perms.answer(id, d); }

  shutdown(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      const ids = [...this.sessions.keys()];
      for (const r of this.perms.pending()) this.perms.cancelForAgent(r.agentId, EXITED);
      await Promise.all(ids.map((id) => this.endSession(id)));
      await this.mcp.close();
    })();
    return this.closing;
  }

  // ── 내부 ──
  private need(id: AgentId): Agent {
    const a = this.removing.has(id) ? undefined : this.store.agent(id);
    if (!a) throw new Error(`에이전트를 찾을 수 없습니다: ${id}`);
    return a;
  }

  /** MCP 로 부른 에이전트 — 모르면 도구 오류로 돌아간다 */
  private caller(id: AgentId): Agent {
    const a = this.closed || this.removing.has(id) ? undefined : this.store.agent(id);
    if (!a) throw new Error(NO_AGENT);
    return a;
  }

  /** 지금 차례 중이거나 사람 답을 기다리는 중 */
  private waiting(id: AgentId): boolean {
    return this.sessions.get(id)?.status === 'working' || this.perms.pending(id).length > 0;
  }

  /** 한가하면 사람 입력부터, 없으면 다른 에이전트가 보낸 대기 메시지 */
  private pump(id: AgentId): void {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'idle' || this.perms.pending(id).length > 0) return;
    const next = this.held.get(id)?.shift();
    if (next) this.sendTo(s, next, { kind: 'human', parts: next });
    else this.router.onIdle(id);
  }

  private sendTo(s: ClaudeSession, parts: UserPart[], item: InFlight): void {
    s.send(parts);
    this.inFlight.set(s, item);
  }

  private heldOf(id: AgentId): UserPart[][] {
    const q = this.held.get(id) ?? [];
    this.held.set(id, q);
    return q;
  }

  /** 필요할 때 띄운다 — 띄울 때마다 MCP 설정·방 안내문을 새로 쓴다(포트·토큰·동료 목록 최신) */
  private ensure(id: AgentId): ClaudeSession {
    if (this.closed) throw new Error(CLOSED);
    const agent = this.need(id);
    const live = this.sessions.get(id);
    if (live) return live;

    const runDir = path.join(this.o.dataDir, 'run', id);
    fs.mkdirSync(runDir, { recursive: true });
    const mcpConfigPath = path.join(runDir, 'mcp.json');
    const promptPath = path.join(runDir, 'prompt.md');
    fs.writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig({ port: this.mcp.port, token: this.mcp.token, agentId: id })));
    const peers = this.store.agents(agent.roomId).filter((a) => a.id !== id);
    fs.writeFileSync(promptPath, buildRoomPrompt(agent, peers));
    const args = buildArgs({
      sessionId: agent.sessionId, resume: agent.started, mcpConfigPath, promptPath, model: agent.model, name: agent.name,
    });
    const s = new ClaudeSession({
      command: this.o.claude.command,
      args: [...(this.o.claude.argsPrefix ?? []), ...args],
      cwd: agent.folder,
      env: { ...process.env, ...this.o.env, ...SPAWN_ENV_EXTRA },
    });
    s.on('event', (ev: StreamEvent) => {
      // 제어 응답이 아닌 이벤트가 오면 보낸 줄을 읽은 것 — 끝내는 중인 세션이어도 센다(endSession 이 본다)
      if (ev.kind !== 'control-response') this.inFlight.delete(s);
      if (this.sessions.get(id) === s) this.onEvent(id, ev);
    });
    s.on('status', () => this.sessions.get(id) === s && this.emitStatus(id));
    s.on('exit', ({ expected }: { expected: boolean }) => {
      if (this.sessions.get(id) !== s) return; // 엔진이 끝낸 세션은 endSession 이 정리
      this.sessions.delete(id);
      if (!expected) {
        this.restoreInFlight(id, s);
        this.errors.set(id, s.errorText ?? EXITED);
        this.perms.cancelForAgent(id, EXITED);
      }
      this.emitStatus(id);
    });
    s.start();
    if (s.status === 'error') {
      // 폴더 없음 — 띄우지 않았다
      const why = s.errorText ?? EXITED;
      this.errors.set(id, why);
      this.emitStatus(id);
      throw new Error(why);
    }
    this.errors.delete(id);
    this.sessions.set(id, s);
    this.emitStatus(id);
    return s;
  }

  private onEvent(id: AgentId, ev: StreamEvent): void {
    if (ev.kind === 'control-response') return; // 내부 응답 — initialize 의 account 같은 것이 밖으로 새지 않게
    if (ev.kind === 'init') {
      if (this.store.agent(id)?.started === false) this.store.updateAgent(id, { started: true });
      this.emit('flags', { agentId: id, bypass: ev.permissionMode === 'bypassPermissions' });
    }
    if (ev.kind === 'tool-result') {
      this.emit('agent-event', { agentId: id, event: ev, viaApproval: this.perms.wasAsked(id, ev.toolUseId) });
    } else {
      this.emit('agent-event', { agentId: id, event: ev });
    }
    // 세션은 result 를 내보내기 직전에 idle 이 된다 — 이 차례의 result 를 먼저 알린 뒤 다음 입력을 보낸다
    if (ev.kind === 'result') this.pump(id);
  }

  /** 세션을 맵에서 빼고(이후 이벤트 무시) 승인 대기를 정리한 뒤 멈춘다 — 상한 STOP_LIMIT_MS */
  private async endSession(id: AgentId): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    this.errors.delete(id);
    this.perms.cancelForAgent(id, EXITED);
    if (!s) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((r) => {
      timer = setTimeout(r, STOP_LIMIT_MS);
    });
    await Promise.race([s.stop().catch(() => undefined), limit]);
    clearTimeout(timer);
    this.restoreInFlight(id, s); // 멈출 때까지도 못 읽은 줄
  }

  /** 보낸 줄을 읽기 전에 끝났다 — 메시지는 queued 로, 사람 입력은 기다리는 줄 맨 앞으로(다음 실행·flushAll 때 다시) */
  private restoreInFlight(id: AgentId, s: ClaudeSession): void {
    const lost = this.inFlight.get(s);
    this.inFlight.delete(s);
    if (lost?.kind === 'relay') this.router.requeue(lost.messageId);
    else if (lost) this.heldOf(id).unshift(lost.parts);
  }

  private emitStatus(id: AgentId): void {
    if (this.removing.has(id) || !this.store.agent(id)) return;
    const status = this.status(id);
    const errorText = this.errorText(id);
    const prev = this.shown.get(id) ?? { status: 'idle', errorText: null };
    if (prev.status === status && prev.errorText === errorText) return;
    this.shown.set(id, { status, errorText });
    this.emit('status', { agentId: id, status, errorText });
  }
}

function toDescription(p: any): AgentDescription {
  // 필요한 필드만 골라 담는다 — account(이메일)는 읽지도 남기지도 않는다
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  return {
    commands: list(p?.commands).map((c) => ({
      name: String(c?.name ?? ''),
      description: String(c?.description ?? ''),
      argumentHint: String(c?.argumentHint ?? ''),
    })),
    models: list(p?.models).map((m) => ({
      value: String(m?.value ?? ''),
      displayName: String(m?.displayName ?? ''),
      ...(typeof m?.description === 'string' ? { description: m.description } : {}),
    })),
    permissionMode: String(p?.current_permission_mode ?? ''),
  };
}

export async function createEngine(o: EngineOptions): Promise<Engine> {
  const engine = new EngineImpl(o, openStore(o.dataDir), openMessageLog(o.dataDir));
  await engine.start();
  return engine;
}
