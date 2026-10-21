import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openStore, renameRetrying, type Store } from './store';
import { openMessageLog, type MessageLog } from './messageLog';
import { openHistory, trimToolInput, type History } from './history';
import { buildArgs, buildMcpConfig, buildUsageArgs, SPAWN_ENV_EXTRA } from './claudeArgs';
import { buildRoomPrompt } from './roomPrompt';
import { ClaudeSession } from './claudeSession';
import { startMcpServer, type McpServerHandle } from './mcpServer';
import { Permissions } from './permissions';
import { DENY } from '../shared/denyTexts';
import { Router, AUTO_CHAIN_LIMIT } from './router';
import { EFFORT_LEVELS, type EffortLevel } from './types';
import { toContextUsage } from './usage';
import { UsageWatcher, USAGE_TIMING, type UsageTiming } from './usageWatcher';
import type {
  Agent, AgentDescription, AgentId, AgentPatch, AgentStatus, ContextUsage, Decision, EngineEventMap, HistoryItem, HistoryPart, PendingRequest, PlanUsage, RelayMessage, Room, RoomId, StreamEvent, UserPart,
} from './types';

export interface EngineOptions {
  dataDir: string;
  claude: { command: string; argsPrefix?: string[] };
  autoChainLimit?: number;
  env?: NodeJS.ProcessEnv;
  /** 기본 true — false 면 대기 메시지 전달(flushAll)을 미루고 engine.start() 가 한다(리스너를 붙인 뒤 부르기 위함) */
  autoStart?: boolean;
  /** 플랜 사용량 묻기 — 없으면 USAGE_TIMING, 일부만 주면 나머지는 USAGE_TIMING, false 면 끔 */
  usage?: false | Partial<UsageTiming>;
  /** 엔진이 보낸 /effort 에 답(result)이 없을 때 다시 띄우기까지 — 기본 EFFORT_TIMEOUT_MS(시험은 짧게) */
  effortTimeoutMs?: number;
  /** 세션 하나를 끌 때 기다리는 상한(ms) — 없으면 STOP_LIMIT_MS. 시험용 */
  stopLimitMs?: number;
}

// 이벤트:
//  'agent-event' { agentId; event: StreamEvent; viaApproval?: boolean }  (tool-result 일 때 viaApproval = permissions.wasAsked)
//  'status'      { agentId; status: AgentStatus; errorText: string | null }
//  'message'     RelayMessage     'held' { roomId }
//  'request'     PendingRequest   'request-resolved' { id; agentId }
//  'flags'       { agentId; bypass: boolean }   (init.permissionMode === 'bypassPermissions')
//  'history'     { agentId; item: HistoryItem }   (대화 기록에 한 항목이 더해질 때마다 — text-delta·init·rate-limit 은 기록하지 않는다)
//  'held-input'  { agentId; count }   (보낼 차례를 기다리는 사람 입력 수가 바뀔 때마다)
//  'effort'      { agentId; effort; effortNow }   (고른 값이 바뀌거나 Claude 에게 지금 값을 읽을 때마다)
//  'context'     { agentId; value: ContextUsage | null }   (차례 끝에 대화 공간을 받았을 때 · 요약·새 대화 직후엔 null)
//  'model-now'   { agentId; modelNow }   (차례의 init 이 알려 준 모델 id 가 바뀔 때 · setModel 은 null 로 비운다)
//  'usage'       PlanUsage | null   (플랜 사용량을 받을 때마다 — 모르는 모양·한도 없음이면 null)
//  'engine-error' { agentId: string | null; message: string }  (프로세스 이벤트 처리·듣는 쪽에서 난 오류 — 앱을 죽이지 않고 알린다)
export interface Engine extends EventEmitter {
  /** autoStart: false 로 만들었을 때 대기 메시지 전달을 시작한다(여러 번 불러도 한 번만) */
  start(): void;
  rooms(): Room[];
  agents(roomId?: RoomId): Agent[];
  addRoom(name: string): Room;
  renameRoom(id: RoomId, name: string): Room;
  removeRoom(id: RoomId): Promise<void>;
  addAgent(i: { roomId: RoomId; name: string; role: string; folder: string }): Agent;
  updateAgent(id: AgentId, p: Pick<AgentPatch, 'name' | 'role' | 'auto' | 'pos' | 'color'>): Agent;
  removeAgent(id: AgentId): Promise<void>;
  status(id: AgentId): AgentStatus;
  heldInput(id: AgentId): number;
  flags(id: AgentId): { bypass: boolean };
  setAutoChainLimit(n: number): void;
  autoChainLimit(): number;
  allowBypass(): boolean;
  /** 저장 + (끄면) 모든 에이전트 bypassOn=false 저장 */
  setAllowBypass(on: boolean): Promise<void>;
  errorText(id: AgentId): string | null;
  sendUser(id: AgentId, parts: UserPart[]): Promise<void>;
  interrupt(id: AgentId): Promise<void>;
  newConversation(id: AgentId): Promise<void>;
  setModel(id: AgentId, model: string | null): Promise<void>;
  /**
   * 저장하고, 세션이 살아 있으면 세션 명령 `/effort <단계>` 로 적용한다 — 차례 중이면 그 차례가 끝난 뒤(기다리던 입력보다 먼저),
   * 세션이 없으면 다음에 띄울 때 첫 줄로. Claude 를 켜지 않는다
   */
  setEffort(id: AgentId, level: EffortLevel): Promise<void>;
  /** 지금 세션이 쓰는 effort — /effort 의 답, 고른 값이 없으면 내 설정(get_settings) · 모르면 null */
  effortNow(id: AgentId): EffortLevel | null;
  /** 마지막 init 이 알려 준, 지금 실제로 쓰는 모델 id — 모르면 null */
  modelNow(id: AgentId): string | null;
  describe(id: AgentId): Promise<AgentDescription>;
  /** 마지막으로 받은 플랜 사용량 — 아직 없거나 모르는 모양·꺼짐이면 null */
  usage(): PlanUsage | null;
  /** 화면이 사용량을 볼 때 — 마지막 값이 1분보다 오래됐으면 다시 묻는다 */
  refreshUsage(): void;
  history(id: AgentId, o?: { all?: boolean; limit?: number }): HistoryItem[];
  messages(f?: Parameters<MessageLog['list']>[0]): RelayMessage[];
  approveMessage(id: string): void;
  dismissMessage(id: string): void;
  continueHeld(roomId: RoomId): void;
  pendingRequests(agentId?: AgentId): PendingRequest[];
  answerRequest(id: string, d: Decision): void;
  shutdown(): Promise<void>;
}

const STOP_LIMIT_MS = 5000; // ClaudeSession.stop() 의 kill 뒤 대기는 끝이 없다 — 엔진이 따로 끊는다
const FORCE_KILL_WAIT_MS = 1000; // shutdown 마지막에 직접 끈 claude 가 꺼지기를 기다리는 상한
const EXITED: string = DENY.claudeExited;
const STOPPED_BY_USER: string = DENY.userStopped;
const TURN_ENDED: string = DENY.turnEnded;
const TOOL_TEXT_KEEP = 2000;
const STOPPED_NOTICE = '멈췄어요';
const NO_AGENT = '에이전트를 찾을 수 없습니다.';
const LIMIT_INVALID = '상한은 1 이상이어야 해요.';
const DURE_TOOL_PREFIX = 'mcp__dure__';
const DURE_TOOL_DENIED = '두레 도구는 승인 대상이 아니에요.';
const EFFORT_UNKNOWN = '알 수 없는 effort 예요.';
const CLOSED = '두레 엔진이 종료되었습니다.';
/** /effort 의 답(로컬 명령 — 모델을 부르지 않는다): "Set effort level to max (this session only): …" (probe9) */
const EFFORT_SET = /Set effort level to (low|medium|high|xhigh|max)\b/;
const EFFORT_BUSY = '/effort 차례가 끝나면 보낸다';
/** /effort 답을 기다리는 한도 — 띄운 직후엔 CLI 시작·--resume 대화 읽기까지 기다리므로 넉넉히 */
const EFFORT_TIMEOUT_MS = 30_000;
const EFFORT_STUCK = 'effort 를 정하는 동안 Claude 가 답하지 않아 다시 띄웠어요 — 이번 실행엔 고른 effort 를 적용하지 못했어요.';
/** 위 일을 사람에게 — 그 에이전트 대화에 안내 한 줄 */
const EFFORT_STUCK_NOTICE = 'effort 를 적용하지 못해 기본값으로 이어 가요';

/** 엔진이 써 넣은 /effort 한 줄 — 그 result 까지 */
interface EffortTurn {
  heard: EffortLevel | null; // 답 글에서 읽은 단계
  timer: NodeJS.Timeout | null; // 답이 없으면 다시 띄운다
}

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
  private bypass = new Map<AgentId, boolean>(); // 마지막 init 의 권한 모드
  private modelNows = new Map<AgentId, string>(); // 마지막 init 의 풀린 모델 id
  private effortNows = new Map<AgentId, EffortLevel>(); // Claude 에게 마지막으로 읽은 지금 effort
  // effort 는 세션 명령 `/effort <단계>` 로 정한다 — 설정 층(apply_flag_settings)엔 max 가 없어 조용히 무시되고,
  // get_settings 는 세션 값을 모른다(probe9). 사람 입력처럼 한 줄씩 쓰지만 기록·사건·작업 중 표시는 남기지 않는다.
  private effortWant = new WeakMap<ClaudeSession, EffortLevel>(); // 보낼 /effort — 차례가 끝나면 기다리던 사람 입력보다 먼저(마지막 값 하나만)
  private effortTurn = new WeakMap<ClaudeSession, EffortTurn>(); // 써 넣은 /effort — 그 result 까지 이벤트를 삼킨다
  private effortBroken = new Set<AgentId>(); // /effort 가 막혀 다시 띄움 — 고르기·모델 바꾸기 전까지 /effort 없이 띄운다(메모리만)
  private compactedTurn = new WeakSet<ClaudeSession>(); // 이번 차례에 요약됨 — 그 차례의 result 뒤엔 값을 받지 않는다
  private started = false;
  private limit: number;
  private allow: boolean;
  private closed = false;
  private closing: Promise<void> | null = null;
  private stopping = new Set<Promise<void>>(); // 끄는 중인 세션(상한 STOP_LIMIT_MS) — 맵에서 빠졌어도 shutdown 이 기다린다
  private unstopped = new Set<ClaudeSession>(); // stop() 이 아직 안 끝난 세션 — 상한이 먼저 지나도 shutdown 이 마지막에 직접 끈다
  private perms: Permissions;
  private router: Router;
  private mcp!: McpServerHandle;
  private watcher: UsageWatcher | null;

  constructor(private o: EngineOptions, private store: Store, private log: MessageLog, private hist: History) {
    super();
    this.limit = this.loadLimit(o.autoChainLimit ?? AUTO_CHAIN_LIMIT);
    this.allow = this.readSettings().allowBypass === true;
    this.watcher =
      o.usage === false
        ? null
        : new UsageWatcher({
            liveSession: () => [...this.sessions.values()].find((s) => s.status === 'idle' || s.status === 'working') ?? null,
            spawnProbe: () => this.spawnUsageProbe(),
            anyWorking: () => [...this.sessions.values()].some((s) => s.status === 'working'),
            now: () => Date.now(),
            emit: (u) => this.guard(null, () => this.emit('usage', u)),
            timing: { ...USAGE_TIMING, ...o.usage },
          });
    this.perms = new Permissions(store);
    this.router = new Router({
      store,
      log,
      limit: this.limit,
      deliver: (id, text, messageId) => {
        const s = this.ensure(id);
        // 막 띄운 세션이 /effort 차례 중 — 던지면 queued 로 남고, 그 차례가 끝나면 pump → onIdle 이 꺼낸다(두 줄을 동시에 쓰지 않는다)
        if (this.effortTurn.has(s)) throw new Error(EFFORT_BUSY);
        this.sendTo(id, s, [{ type: 'text', text }], { kind: 'relay', messageId });
      },
      isBusy: (id) => this.waiting(id) || (this.held.get(id)?.length ?? 0) > 0,
    });
    // 아래 알림은 프로세스 이벤트·MCP 요청 처리 중에도 불린다 — 듣는 쪽이 던져도 남은 일(상태·다음 입력)은 한다
    this.perms.on('request', (r: PendingRequest) => {
      this.guard(r.agentId, () => this.emit('request', r));
      this.guard(r.agentId, () => this.emitStatus(r.agentId));
    });
    this.perms.on('resolved', (r: { id: string; agentId: AgentId }) => {
      this.guard(r.agentId, () => this.emit('request-resolved', r));
      this.guard(r.agentId, () => {
        this.emitStatus(r.agentId);
        this.pump(r.agentId);
      });
    });
    this.router.on('message', (m: RelayMessage) => this.guard(null, () => this.emit('message', m)));
    this.router.on('held', (h: { roomId: RoomId }) => this.guard(null, () => this.emit('held', h)));
  }

  async init(): Promise<void> {
    this.mcp = await startMcpServer({
      listAgents: (agentId) => {
        const me = this.caller(agentId);
        const peers = this.store.agents(me.roomId).filter((a) => a.id !== me.id);
        return JSON.stringify(peers.map((a) => ({ name: a.name, role: a.role, status: this.status(a.id) })));
      },
      sendMessage: (agentId, to, text) => this.router.send(this.caller(agentId).id, to, text),
      approve: (agentId, args, signal) => {
        if (String(args.tool_name).startsWith(DURE_TOOL_PREFIX)) return Promise.resolve({ behavior: 'deny', message: DURE_TOOL_DENIED });
        if (this.closed || this.removing.has(agentId)) return Promise.resolve({ behavior: 'deny', message: EXITED });
        return this.perms.request(agentId, args, signal); // 부른 프로세스가 끊기면 카드도 사라진다
      },
    });
    if (this.o.autoStart !== false) this.start();
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.router.flushAll();
    this.watcher?.start();
  }

  // ── 설정 ──
  private settingsFile() { return path.join(this.o.dataDir, 'settings.json'); }

  /** 설정 파일 — 없거나 깨졌으면 빈 객체 */
  private readSettings(): { autoChainLimit?: unknown; allowBypass?: unknown } {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsFile(), 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  /** 있던 값은 그대로 두고 patch 만 덮어 쓴다 */
  private writeSettings(patch: { autoChainLimit?: number; allowBypass?: boolean }): void {
    const file = this.settingsFile();
    fs.mkdirSync(this.o.dataDir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...this.readSettings(), ...patch }, null, 2));
    renameRetrying(`${file}.tmp`, file);
  }

  /** 저장된 값이 없거나 깨졌으면 fallback */
  private loadLimit(fallback: number): number {
    const n = this.readSettings().autoChainLimit;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : fallback;
  }

  allowBypass(): boolean { return this.allow; }

  async setAllowBypass(on: boolean): Promise<void> {
    this.writeSettings({ allowBypass: on });
    this.allow = on;
    if (!on) for (const a of this.store.agents()) if (a.bypassOn) this.store.updateAgent(a.id, { bypassOn: false });
  }

  autoChainLimit(): number { return this.limit; }

  setAutoChainLimit(n: number): void {
    if (!Number.isInteger(n) || n < 1) throw new Error(LIMIT_INVALID);
    this.writeSettings({ autoChainLimit: n });
    this.limit = n;
    this.router.setLimit(n);
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
      this.hist.remove(id);
    } finally {
      this.removing.delete(id);
      this.shown.delete(id);
      const had = this.held.get(id)?.length ?? 0;
      this.held.delete(id); // 기다리던 사람 입력은 에이전트와 함께 버린다
      this.bypass.delete(id);
      this.effortNows.delete(id);
      this.effortBroken.delete(id);
      this.modelNows.delete(id);
      if (had > 0) this.guard(id, () => this.emit('held-input', { agentId: id, count: 0 }));
    }
  }

  // ── 상태 ──
  status(id: AgentId): AgentStatus {
    this.need(id);
    if (this.perms.pending(id).length > 0) return 'awaiting';
    const s = this.sessions.get(id);
    // 엔진이 보낸 /effort 차례 중에 사람 입력이 기다리면 작업 중 — 첫 입력이 멈춘 듯 보이지 않게(멈추기도 켜진다)
    if (s) return s.status === 'idle' && this.effortTurn.has(s) && (this.held.get(id)?.length ?? 0) > 0 ? 'working' : s.status;
    return this.errors.has(id) ? 'error' : 'idle';
  }

  heldInput(id: AgentId): number {
    this.need(id);
    return this.held.get(id)?.length ?? 0;
  }

  flags(id: AgentId): { bypass: boolean } {
    this.need(id);
    return { bypass: this.bypass.get(id) ?? false };
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
    this.emitHeld(id);
    this.pump(id); // 차례 중·승인 대기면 그대로 두고, 그 차례의 result 에서 보낸다 — 두 줄을 동시에 보내지 않는다
    this.emitStatus(id); // /effort 차례 중이면 기다리는 입력 때문에 작업 중
  }

  async interrupt(id: AgentId) {
    this.need(id);
    this.perms.cancelForAgent(id, STOPPED_BY_USER);
    const s = this.sessions.get(id);
    if (!s) return;
    // 엔진이 보낸 /effort 차례 중 — 기다리는 사람 입력이 있으면(화면엔 작업 중) 같은 프로세스에 이어 쓰지 않고 다시 띄운다(답 없음과 같은 길).
    // 없으면(남은 승인 카드만 멈춤) 카드만 치우고 그 /effort 는 그대로 끝나게 둔다
    if (this.effortTurn.has(s)) {
      if ((this.held.get(id)?.length ?? 0) > 0) return this.restartAfterEffort(id, s, 'interrupt');
      return;
    }
    const wasWorking = s.status === 'working';
    await s.interrupt();
    if (wasWorking) this.guard(id, () => this.record(id, { kind: 'notice', text: STOPPED_NOTICE }));
  }

  async newConversation(id: AgentId) {
    this.need(id);
    const ending = this.endSession(id);
    this.guard(id, () => this.record(id, { kind: 'boundary' }));
    this.store.updateAgent(id, { sessionId: crypto.randomUUID(), started: false });
    this.guard(id, () => this.setContext(id, null));
    this.emitStatus(id);
    await ending;
    // 끝낸 세션이 못 읽었거나 기다리던 사람 입력은 새 대화로 보낸다 — 두면 사람이 다시 칠 때까지 멈춰 있고 메시지도 쌓인다
    if ((this.held.get(id)?.length ?? 0) === 0) return;
    try {
      this.ensure(id);
    } catch {
      return; // 폴더 없음 등 — ensure 가 status error·errorText 를 남겼다
    }
    this.pump(id);
  }

  async setModel(id: AgentId, model: string | null) {
    this.need(id);
    this.store.updateAgent(id, { model });
    this.effortBroken.delete(id); // 모델이 바뀌었다 — /effort 를 다시 해 본다
    this.guard(id, () => this.setModelNow(id, null)); // 다음 차례가 풀 모델은 다르다
    this.guard(id, () => this.forgetEffortNow(id)); // 모델이 바뀌면 지금 effort 도 다시 읽을 때까지 모른다
    const s = this.sessions.get(id);
    if (!s) return;
    await s.request({ subtype: 'set_model', model: model ?? 'default' });
    // 세션 effort 가 새 모델로 이어지는지 모른다 — 고른 값이 있으면 다시 보낸다(해롭지 않다), 없으면 내 설정을 다시 읽는다
    if (this.live(id, s)) this.applyEffort(id, s);
  }

  private setModelNow(id: AgentId, value: string | null) {
    if (this.removing.has(id) || !this.store.agent(id)) return;
    if ((this.modelNows.get(id) ?? null) === value) return;
    if (value === null) this.modelNows.delete(id);
    else this.modelNows.set(id, value);
    this.emit('model-now', { agentId: id, modelNow: value });
  }

  async setEffort(id: AgentId, level: EffortLevel) {
    this.need(id);
    if (!(EFFORT_LEVELS as readonly unknown[]).includes(level)) throw new Error(EFFORT_UNKNOWN);
    this.store.updateAgent(id, { effort: level });
    this.effortBroken.delete(id); // 새로 골랐다 — /effort 를 다시 해 본다
    // 전에 읽은 지금 값은 버린다 — 남겨 두면 화면이 새로 고른 값 대신 옛 값으로 돌아간다(/effort 의 답이 채운다)
    this.effortNows.delete(id);
    this.emitEffort(id);
    const s = this.sessions.get(id);
    if (s) this.applyEffort(id, s);
  }

  modelNow(id: AgentId): string | null {
    return this.modelNows.get(id) ?? null;
  }

  effortNow(id: AgentId): EffortLevel | null {
    return this.effortNows.get(id) ?? null;
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
  history(id: AgentId, o: { all?: boolean; limit?: number } = {}): HistoryItem[] {
    this.need(id);
    return this.hist.read(id, { sinceBoundary: !o.all, limit: o.limit ?? (o.all ? Infinity : 500) });
  }
  messages(f?: Parameters<MessageLog['list']>[0]) { return this.log.list(f); }
  approveMessage(id: string) { this.router.approve(id); }
  dismissMessage(id: string) { this.router.dismiss(id); }
  continueHeld(roomId: RoomId) { this.router.continueHeld(roomId); }
  pendingRequests(agentId?: AgentId) { return this.perms.pending(agentId); }
  answerRequest(id: string, d: Decision) { this.perms.answer(id, d); }

  // ── 사용량 ──
  usage(): PlanUsage | null { return this.watcher?.current() ?? null; }
  refreshUsage(): void { this.watcher?.requested(); }

  shutdown(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      const ids = [...this.sessions.keys()];
      for (const r of this.perms.pending()) this.perms.cancelForAgent(r.agentId, EXITED);
      // 맵에서 이미 빠진 채 끄는 중인 세션(다시 띄우기·새 대화)도 기다린다 — 각각 STOP_LIMIT_MS 상한
      await Promise.all([this.stopWatcher(), ...ids.map((id) => this.endSession(id)), ...this.stopping]);
      // 상한이 먼저 지나 아직 살아 있는 claude(바쁜 PC 에서 taskkill 이 늦음) — 앱이 닫힌 뒤 떠돌지 않게 직접 끈다
      await Promise.all([...this.unstopped].map((s) => s.forceKill(FORCE_KILL_WAIT_MS)));
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

  /** 지금 차례 중(엔진이 보낸 /effort 차례 포함)이거나 사람 답을 기다리는 중 */
  private waiting(id: AgentId): boolean {
    const s = this.sessions.get(id);
    return s?.status === 'working' || (!!s && this.effortTurn.has(s)) || this.perms.pending(id).length > 0;
  }

  /** 한가하면 줄에 선 /effort 부터, 다음은 사람 입력, 없으면 다른 에이전트가 보낸 대기 메시지 — 한 번에 한 줄 */
  private pump(id: AgentId): void {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'idle' || this.effortTurn.has(s) || this.perms.pending(id).length > 0) return;
    const level = this.effortWant.get(s);
    if (level) {
      this.sendEffort(id, s, level);
      return; // 그 차례의 result 에서 다시 pump
    }
    const next = this.held.get(id)?.shift();
    if (next) {
      this.emitHeld(id);
      this.sendTo(id, s, next, { kind: 'human', parts: next });
    }
    else this.router.onIdle(id);
  }

  private sendTo(id: AgentId, s: ClaudeSession, parts: UserPart[], item: InFlight): void {
    s.send(parts);
    this.inFlight.set(s, item);
    // 실제로 쓴 줄만 기록한다 — 대기 중인 입력은 보낼 때 나타난다
    this.guard(id, () =>
      this.record(id, {
        kind: 'user',
        source: item.kind === 'relay' ? 'relay' : 'human',
        parts: parts.map(toHistoryPart),
        ...(item.kind === 'relay' ? { messageId: item.messageId } : {}),
      }),
    );
  }

  private record(id: AgentId, item: HistoryItem | (Omit<HistoryItem, 't'> & { t?: number })): void {
    const full = { t: Date.now(), ...item } as HistoryItem;
    this.hist.append(id, full);
    this.guard(id, () => this.emit('history', { agentId: id, item: full }));
  }

  private emitHeld(id: AgentId): void {
    this.guard(id, () => this.emit('held-input', { agentId: id, count: this.held.get(id)?.length ?? 0 }));
  }

  private heldOf(id: AgentId): UserPart[][] {
    const q = this.held.get(id) ?? [];
    this.held.set(id, q);
    return q;
  }

  /** 사용량 전용 claude — 데이터 폴더 안 빈 폴더에서, 에이전트와 같은 환경으로(start 는 UsageWatcher 가) */
  private spawnUsageProbe(): ClaudeSession {
    const cwd = path.join(this.o.dataDir, 'usage-probe');
    fs.mkdirSync(cwd, { recursive: true });
    return new ClaudeSession({
      command: this.o.claude.command,
      args: [...(this.o.claude.argsPrefix ?? []), ...buildUsageArgs()],
      cwd,
      env: this.spawnEnv(),
    });
  }

  private spawnEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.o.env, ...SPAWN_ENV_EXTRA };
  }

  /** 타이머를 끄고 떠 있는 사용량 전용 claude 를 끈다 — 상한 STOP_LIMIT_MS(세션 끝내기와 같은 까닭) */
  private async stopWatcher(): Promise<void> {
    if (!this.watcher) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((r) => {
      timer = setTimeout(r, STOP_LIMIT_MS);
    });
    await Promise.race([this.watcher.stop(), limit]);
    clearTimeout(timer);
  }

  /**
   * 필요할 때 띄운다 — 띄울 때마다 MCP 설정·방 안내문을 새로 쓴다(포트·토큰·동료 목록 최신).
   * quiet: 띄운 뒤 상태를 알리지 않는다(부른 쪽이 보내고 나서 알린다)
   */
  private ensure(id: AgentId, o: { quiet?: boolean } = {}): ClaudeSession {
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
      env: this.spawnEnv(),
    });
    // 세션 콜백 안에서 던지면 stdout 처리 중 잡히지 않은 예외가 되어 앱이 죽는다 — 모두 guard 로 감싼다
    s.on('event', (ev: StreamEvent) =>
      this.guard(id, () => {
        // 제어 응답이 아닌 이벤트가 오면 보낸 줄을 읽은 것 — 끝내는 중인 세션이어도 센다(endSession 이 본다)
        if (ev.kind !== 'control-response') this.inFlight.delete(s);
        if (this.sessions.get(id) !== s) return;
        if (ev.kind !== 'control-response' && this.effortTurn.has(s)) this.onEffortEvent(id, s, ev);
        else this.onEvent(id, ev);
      }),
    );
    s.on('status', () =>
      this.guard(id, () => {
        if (this.sessions.get(id) === s) this.emitStatus(id);
      }),
    );
    s.on('exit', ({ expected }: { expected: boolean }) =>
      this.guard(id, () => {
        if (this.sessions.get(id) !== s) return; // 엔진이 끝낸 세션은 endSession 이 정리
        this.sessions.delete(id);
        this.endEffortTurn(s); // /effort 차례 중이었으면 그 타이머도(다음에 띄울 때 다시 보낸다)
        this.guard(id, () => this.forgetEffortNow(id));
        if (!expected) {
          this.guard(id, () => this.restoreInFlight(id, s)); // 기록 실패여도 아래 정리는 한다
          const why = s.errorText ?? EXITED;
          this.guard(id, () => this.record(id, { kind: 'notice', text: why }));
          this.errors.set(id, why);
          this.perms.cancelForAgent(id, EXITED);
        }
        this.emitStatus(id);
      }),
    );
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
    if (!o.quiet) this.emitStatus(id);
    // 막 띄운 세션은 한가하다 — 고른 effort 가 있으면 어떤 입력보다 먼저 /effort 를 쓴다(pump 는 부르지 않는다: router 가 deliver 중일 수 있다).
    // 전에 /effort 가 막혀 다시 띄운 에이전트면 /effort 없이(고르기·모델 바꾸기 전까지)
    if (agent.effort && !this.effortBroken.has(id)) this.sendEffort(id, s, agent.effort);
    else void this.readEffort(id, s); // 기다리지 않는다
    return s;
  }

  /** 고른 effort 를 살아 있는 세션에 — 있으면 /effort 를 줄 맨 앞에 세우고(한가하면 바로), 없으면 내 설정을 읽는다 */
  private applyEffort(id: AgentId, s: ClaudeSession): void {
    const want = this.store.agent(id)?.effort;
    if (!want) {
      void this.readEffort(id, s);
      return;
    }
    this.effortWant.set(s, want); // 줄에 선 옛 값은 바뀐다
    this.pump(id);
  }

  /**
   * /effort 를 쓴다 — 상태는 working 으로 바꾸지 않고, 기록하지 않는다(그 차례의 이벤트는 onEffortEvent 가 삼킨다).
   * result 가 effortTimeoutMs 안에 안 오면 다시 띄운다(restartAfterEffort).
   */
  private sendEffort(id: AgentId, s: ClaudeSession, level: EffortLevel): void {
    this.effortWant.delete(s);
    const turn: EffortTurn = { heard: null, timer: null };
    this.effortTurn.set(s, turn);
    try {
      s.send([{ type: 'text', text: `/effort ${level}` }], { quiet: true });
    } catch {
      this.effortTurn.delete(s); // 이미 끝난 세션 — 다음에 띄울 때 다시 보낸다
      return;
    }
    turn.timer = setTimeout(() => {
      if (this.effortTurn.get(s) === turn) void this.restartAfterEffort(id, s, 'timeout');
    }, this.o.effortTimeoutMs ?? EFFORT_TIMEOUT_MS);
    turn.timer.unref?.();
    this.emitStatus(id); // 기다리는 사람 입력이 있으면 작업 중
  }

  /** /effort 차례를 끝낸다(타이머 끔) — result · 세션 끝 · 다시 띄우기 */
  private endEffortTurn(s: ClaudeSession): EffortTurn | undefined {
    const turn = this.effortTurn.get(s);
    if (!turn) return undefined;
    if (turn.timer) clearTimeout(turn.timer);
    this.effortTurn.delete(s);
    return turn;
  }

  /** 엔진이 보낸 /effort 차례의 이벤트 — 기록·사건 없이 삼키고, 답에서 지금 effort 를 읽는다 */
  private onEffortEvent(id: AgentId, s: ClaudeSession, ev: StreamEvent): void {
    const turn = this.effortTurn.get(s)!;
    if (ev.kind === 'init') {
      this.noteInit(id, ev); // /effort 만 받은 세션도 저장된다 — started 를 남겨야 다음 실행이 --resume 한다(같은 --session-id 는 거절됨)
    } else if (ev.kind === 'rate-limit') {
      this.onEvent(id, ev); // 사용량 신호는 평소처럼 알린다(기록은 원래 안 한다)
    } else if (ev.kind === 'assistant') {
      turn.heard ??= effortSaid(ev.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
    } else if (ev.kind === 'local-output') {
      turn.heard ??= effortSaid(ev.text); // 답을 <local-command-stdout> 로 내는 CLI 도 있을 수 있다
    } else if (ev.kind === 'result') {
      this.endEffortTurn(s);
      const heard = turn.heard ?? effortSaid(ev.text);
      // 그새 다시 고른 값이 줄에 서 있으면 이 답은 옛 값 — 받지 않는다(화면이 옛 값으로 돌아갔다 오지 않게).
      // 모르는 답(effort 없는 모델·바뀐 문구)이면 지금 값은 비운 채 — 화면은 고른 값을 보인다
      if (heard && !this.effortWant.has(s)) {
        this.effortNows.set(id, heard);
        this.emitEffort(id);
      }
      this.perms.cancelForAgent(id, TURN_ENDED); // 끝난 차례에 남은 승인 질문(떠난 프로세스의 호출 등) — 평소 result 와 같게
      this.pump(id);
      this.emitStatus(id);
    }
  }

  /**
   * /effort 에 답이 없거나(timeout) 그 사이 사람이 멈췄다(interrupt). 같은 프로세스에 다음 줄을 이어 쓰면 늦게 온 /effort 답이
   * 그 줄의 답처럼 보이고 그 차례를 일찍 끝낸다 — 대신 세션을 끝내고, 다시 띄워 기다리던 입력·메시지를 보낸다.
   * 답이 없었으면 /effort 없이 띄우고 고르기·모델 바꾸기 전까지 다시 보내지 않는다(effortBroken · 대화에 안내 한 줄).
   * 멈추기면 /effort 부터 다시 보낸다(멀쩡한데 느린 시작일 수 있다 — 정말 막혔으면 다시 시간 초과가 잡는다).
   */
  private async restartAfterEffort(id: AgentId, s: ClaudeSession, why: 'timeout' | 'interrupt'): Promise<void> {
    try {
      if (this.closed || !this.effortTurn.has(s) || !this.live(id, s)) return;
      if (why === 'timeout') {
        // 막힌 CLI — 이번 실행 동안 /effort 없이(고르기·모델 바꾸기 전까지). 멈추기는 멀쩡한 /effort 일 수 있어 다시 띄울 때 /effort 부터 다시 보낸다
        this.effortBroken.add(id);
        this.guard(id, () => this.emit('engine-error', { agentId: id, message: EFFORT_STUCK }));
        this.guard(id, () => this.record(id, { kind: 'notice', text: EFFORT_STUCK_NOTICE }));
      }
      await this.endSession(id); // 기다리던 입력·queued 메시지는 그대로 — /effort 는 보낸 줄로 치지 않아 되살릴 것이 없다
      if (this.closed || this.removing.has(id) || !this.store.agent(id)) return;
      const waiting = (this.held.get(id)?.length ?? 0) > 0 || this.log.list({ to: id, states: ['queued'] }).length > 0;
      // 그새 누가 띄웠으면 그 세션을 쓴다. 상태는 보내고 나서 한 번만 알린다(다시 띄우는 사이 대기로 깜박이지 않게)
      if (!this.sessions.has(id) && waiting) this.ensure(id, { quiet: true });
      this.pump(id);
      this.emitStatus(id);
    } catch (e) {
      this.guard(id, () => this.emitStatus(id));
      this.guard(id, () => this.emit('engine-error', { agentId: id, message: e instanceof Error ? e.message : String(e) }));
    }
  }

  /**
   * 세션이 쓰는 값 = 내 Claude 설정(get_settings 의 effective) — 고른 effort 가 없을 때, 또는 /effort 가 막혀 적용하지 못했을 때.
   * 실패·시간 초과는 조용히 넘어간다. 그 밖에 고른 effort 가 있으면 답을 버린다 — 세션 값(/effort)을 모르는 설정 층이라
   * 화면이 그 값으로 돌아간다.
   */
  private async readEffort(id: AgentId, s: ClaudeSession): Promise<void> {
    try {
      const res: any = await s.request({ subtype: 'get_settings' });
      if (!this.live(id, s) || (this.store.agent(id)?.effort && !this.effortBroken.has(id))) return;
      const now = res?.effective?.effortLevel;
      if (!(EFFORT_LEVELS as readonly unknown[]).includes(now)) return;
      this.effortNows.set(id, now);
      this.emitEffort(id);
    } catch {
      /* 요청 실패·세션 종료 — 표시만 비운 채 둔다 */
    }
  }

  /** 차례 끝에 대화 공간을 받는다 — 실패·모르는 모양·그새 바뀐 세션이면 조용히 넘어간다 */
  private async fetchContext(id: AgentId, s: ClaudeSession): Promise<void> {
    try {
      const raw = await s.request({ subtype: 'get_context_usage', detail: 'summary' });
      if (!this.live(id, s)) return;
      const value = toContextUsage(raw, Date.now());
      if (value) this.guard(id, () => this.setContext(id, value));
    } catch {
      /* 요청 실패·세션 종료 — 링은 마지막 값 그대로 */
    }
  }

  private setContext(id: AgentId, value: ContextUsage | null): void {
    if (this.removing.has(id) || !this.store.agent(id)) return;
    this.store.updateAgent(id, { lastContext: value });
    this.emit('context', { agentId: id, value });
  }

  /** 늦게 온 답을 받아도 되는가 — 그 세션이 아직 그 에이전트의 세션이고 에이전트도 있다 */
  private live(id: AgentId, s: ClaudeSession): boolean {
    return this.sessions.get(id) === s && !this.removing.has(id) && !!this.store.agent(id);
  }

  /** Claude 에게 읽은 지금 effort 를 잊는다(세션이 끝남·모델 바뀜) — 알고 있었으면 사건으로 알린다(화면은 내가 정한 값으로) */
  private forgetEffortNow(id: AgentId): void {
    if (!this.effortNows.delete(id)) return;
    if (!this.closed) this.emitEffort(id);
  }

  private emitEffort(id: AgentId): void {
    if (this.removing.has(id)) return;
    const a = this.store.agent(id);
    if (!a) return;
    this.guard(id, () => this.emit('effort', { agentId: id, effort: a.effort, effortNow: this.effortNow(id) }));
  }

  private onEvent(id: AgentId, ev: StreamEvent): void {
    if (ev.kind === 'control-response') return; // 내부 응답 — initialize 의 account 같은 것이 밖으로 새지 않게
    if (ev.kind === 'compacted') {
      const cur = this.sessions.get(id);
      if (cur) this.compactedTurn.add(cur);
      this.guard(id, () => this.setContext(id, null));
    }
    if (ev.kind === 'init') this.noteInit(id, ev);
    if (ev.kind === 'tool-result') {
      this.guard(id, () =>
        this.emit('agent-event', { agentId: id, event: ev, viaApproval: this.perms.wasAsked(id, ev.toolUseId) }),
      );
    } else {
      this.guard(id, () => this.emit('agent-event', { agentId: id, event: ev }));
    }
    this.guard(id, () => this.recordEvent(id, ev));
    // 세션은 result 를 내보내기 직전에 idle 이 된다 — 이 차례의 result 를 먼저 알린 뒤 다음 입력을 보낸다
    if (ev.kind === 'result') {
      // 끝난 차례엔 살아 있는 권한 질문이 있을 수 없다 — 남은 것(떠난 프로세스의 호출 등)은 정리해야 다음 입력이 나간다
      this.perms.cancelForAgent(id, TURN_ENDED);
      this.guard(null, () => this.watcher?.turnEnded());
      const cur = this.sessions.get(id);
      if (cur) {
        if (this.compactedTurn.delete(cur)) {
          /* 요약한 차례 — 값을 받지 않는다(옛 값이 되살아나지 않게) */
        } else {
          void this.fetchContext(id, cur);
        }
      }
      this.pump(id);
    }
  }

  /** 차례의 init — 시작됨 · 권한 모드 · 풀린 모델 id(엔진이 보낸 /effort 차례에서도) */
  private noteInit(id: AgentId, ev: Extract<StreamEvent, { kind: 'init' }>): void {
    // 저장이 실패해도 init 은 알린다 — started 는 다음 차례의 init 때 다시 쓴다
    this.guard(id, () => {
      if (this.store.agent(id)?.started === false) this.store.updateAgent(id, { started: true });
    });
    this.guard(id, () => {
      const bypass = ev.permissionMode === 'bypassPermissions';
      this.bypass.set(id, bypass);
      this.emit('flags', { agentId: id, bypass });
    });
    this.guard(id, () => this.setModelNow(id, ev.model || null));
  }

  private recordEvent(id: AgentId, ev: StreamEvent): void {
    if (ev.kind === 'assistant')
      this.record(id, {
        kind: 'assistant',
        // 하는 일 입력은 화면이 읽는 칸만 — 파일 본문·넘김 본문으로 기록 파일이 커지지 않게(이벤트로 나가는 것도 같은 모양)
        blocks: ev.blocks.map((b) => (b.type === 'tool_use' ? { ...b, input: trimToolInput(b.input) } : b)),
      });
    else if (ev.kind === 'tool-result')
      this.record(id, {
        kind: 'tool-result',
        toolUseId: ev.toolUseId,
        isError: ev.isError,
        text: ev.text.slice(0, TOOL_TEXT_KEEP),
        viaApproval: this.perms.wasAsked(id, ev.toolUseId),
      });
    else if (ev.kind === 'local-output') this.record(id, { kind: 'local-output', text: ev.text });
    else if (ev.kind === 'result') this.record(id, { kind: 'result', ok: ev.ok, subtype: ev.subtype });
  }

  /** 콜백 안의 오류를 삼키고 'engine-error' 로 알린다('error' 는 듣는 쪽이 없으면 Node 가 던진다) */
  private guard(agentId: AgentId | null, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      try {
        this.emit('engine-error', { agentId, message: e instanceof Error ? e.message : String(e) });
      } catch {
        /* engine-error 듣는 쪽의 오류까지는 어쩔 수 없다 — 삼킨다 */
      }
    }
  }

  /** 세션을 맵에서 빼고(이후 이벤트 무시) 승인 대기를 정리한 뒤 멈춘다 — 상한 STOP_LIMIT_MS */
  private async endSession(id: AgentId): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s) this.endEffortTurn(s); // /effort 차례 중이었으면 그 타이머도
    this.errors.delete(id);
    this.guard(id, () => this.forgetEffortNow(id)); // 끝난 세션의 지금 값은 다음 세션의 값이 아니다
    this.perms.cancelForAgent(id, EXITED);
    if (!s) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((r) => {
      timer = setTimeout(r, this.o.stopLimitMs ?? STOP_LIMIT_MS);
    });
    this.unstopped.add(s);
    const stop = s.stop().catch(() => undefined).finally(() => this.unstopped.delete(s));
    const stopped = Promise.race([stop, limit]).then(() => clearTimeout(timer));
    this.stopping.add(stopped);
    try {
      await stopped;
    } finally {
      this.stopping.delete(stopped);
    }
    this.restoreInFlight(id, s); // 멈출 때까지도 못 읽은 줄
  }

  /** 보낸 줄을 읽기 전에 끝났다 — 메시지는 queued 로, 사람 입력은 기다리는 줄 맨 앞으로(다음 실행·flushAll 때 다시) */
  private restoreInFlight(id: AgentId, s: ClaudeSession): void {
    const lost = this.inFlight.get(s);
    this.inFlight.delete(s);
    if (lost?.kind === 'relay') this.router.requeue(lost.messageId);
    else if (lost) {
      this.heldOf(id).unshift(lost.parts);
      this.emitHeld(id);
    }
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

/** /effort 답에서 정해진 단계 — 모르는 말이면 null */
function effortSaid(text: string): EffortLevel | null {
  const m = EFFORT_SET.exec(text);
  return m ? (m[1] as EffortLevel) : null;
}

function toHistoryPart(p: UserPart): HistoryPart {
  // 이미지는 크기만 남긴다 — 내용은 저장하지 않는다
  return p.type === 'text'
    ? { type: 'text', text: p.text }
    : { type: 'image', mediaType: p.mediaType, bytes: Buffer.from(p.base64, 'base64').length };
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
      ...(typeof m?.resolvedModel === 'string' ? { resolvedModel: m.resolvedModel } : {}),
      ...(m?.supportsEffort === true
        ? {
            supportsEffort: true,
            effortLevels: list(m?.supportedEffortLevels).filter((l): l is EffortLevel => (EFFORT_LEVELS as readonly unknown[]).includes(l)),
          }
        : {}),
    })),
    permissionMode: String(p?.current_permission_mode ?? ''),
  };
}

export async function createEngine(o: EngineOptions): Promise<Engine> {
  const engine = new EngineImpl(o, openStore(o.dataDir), openMessageLog(o.dataDir), openHistory(o.dataDir));
  await engine.init();
  return engine;
}
