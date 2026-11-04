import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hostArgs, isSafeId } from './remote';
import { EFFORT_LEVELS, type Agent, type AgentId, type AgentPatch, type ContextUsage, type EffortLevel, type Room, type RoomId } from './types';

/** 지운 서버 방 에이전트의 정리하지 못한 서버 claude — 에이전트 기록과 따로(에이전트는 지워졌다). 정리가 되면 뺀다 */
export interface PendingCleanup {
  host: string;
  agentId: AgentId;
  launch: { pid: number; run: string };
}

/** 지운 서버 방 에이전트의 서버 첨부 폴더(`$HOME/.dure/attachments/<id>`) — 지우기가 되면 뺀다. 띄우기 정리(PendingCleanup)와 따로 */
export interface PendingAttachmentCleanup {
  host: string;
  agentId: AgentId;
}

export interface Store {
  rooms(): Room[];
  agents(roomId?: RoomId): Agent[];
  agent(id: AgentId): Agent | undefined;
  /** remote = 서버(SSH) 방 — host 는 앞뒤 빈칸을 자르고 hostArgs 로 검사(아니면 던진다). 없으면 이 PC 방 */
  addRoom(name: string, remote?: { host: string } | null): Room;
  renameRoom(id: RoomId, name: string): Room;
  removeRoom(id: RoomId): void;
  addAgent(input: { roomId: RoomId; name: string; role: string; folder: string }): Agent;
  /**
   * addAgent 가 더하기 전에 하는 검사 그대로(방·이름 빔·방 안 이름 겹침·폴더) — 더하지 않고 던지기만 한다.
   * 서버 방의 폴더는 이 PC 에서 찾지 않고 '/' 로 시작하는지만 본다(있는지는 ssh 확인이 맡는다)
   */
  checkAgent(input: { roomId: RoomId; name: string; folder: string }): void;
  updateAgent(id: AgentId, patch: AgentPatch): Agent;
  /**
   * 서버 방 에이전트면 저장된 띄우기(remoteLaunch)를 기다리는 정리 목록으로, 그 서버 첨부 폴더를 기다리는 첨부 정리 목록으로 옮긴 뒤 지운다
   * (엔진이 곧 지우고 되면 뺀다 — 서버가 내려가 있었으면 남아 다음에 켤 때 다시)
   */
  removeAgent(id: AgentId): void;
  /** 기다리는 정리 — 엔진이 켤 때 다시 해 본다 */
  pendingCleanups(): PendingCleanup[];
  /** 그 에이전트의 그 띄우기를 목록에서 뺀다(정리가 됐다) — 없으면 아무것도 안 한다 */
  dropPendingCleanup(agentId: AgentId, launch: { pid: number; run: string }): void;
  /** 기다리는 첨부 정리(지운 서버 방 에이전트의 서버 첨부 폴더) — 엔진이 켤 때 다시 해 본다 */
  pendingAttachmentCleanups(): PendingAttachmentCleanup[];
  /** 그 에이전트의 서버 첨부 폴더를 목록에서 뺀다(지웠다) — 없으면 아무것도 안 한다 */
  dropPendingAttachmentCleanup(agentId: AgentId): void;
  /**
   * 열 때 state.json 이 깨졌거나 읽지 못해 `state.json.broken-<시각>` 으로 옮기고 빈 상태로 시작했다(파일이 없던 처음은 false).
   * 이번 판의 가게가 비었을 뿐 주인이 없는 게 아니다 — 엔진은 이때 '주인 없는' 첨부 폴더를 지우지 않는다(되살리면 그 첨부가 있어야 한다)
   */
  readonly recovered: boolean;
}

interface State {
  version: 1;
  rooms: Room[];
  agents: Agent[];
  pendingCleanups: PendingCleanup[];
  pendingAttachmentCleanups: PendingAttachmentCleanup[];
}

const norm = (s: string) => s.trim().toLocaleLowerCase('ko');

// 윈도우에선 백신·검색 색인이 파일을 잠깐 잡고 있으면 이름 바꾸기가 EPERM·EACCES·EBUSY 로 실패한다
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRIES = 5;
const RENAME_BACKOFF_MS = 20;
const pause = new Int32Array(new SharedArrayBuffer(4));

/** renameSync — 잠금 오류면 RENAME_BACKOFF_MS 쉬고 RENAME_RETRIES 번까지 다시, 그래도 안 되면 던진다 */
export function renameRetrying(from: string, to: string): void {
  for (let retry = 0; ; retry++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (retry >= RENAME_RETRIES || !code || !LOCKED.has(code)) throw e;
      Atomics.wait(pause, 0, 0, RENAME_BACKOFF_MS);
    }
  }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 저장된 effort — 아는 단계가 아니면(손댄 파일·옛 값) null */
function savedEffort(v: unknown): EffortLevel | null {
  return (EFFORT_LEVELS as readonly unknown[]).includes(v) ? (v as EffortLevel) : null;
}

/** 저장된 마지막 대화 공간 — 수가 아닌 total·max·percent 가 있으면 null(링을 그리지 않는다) */
function savedContext(v: unknown): ContextUsage | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (!finite(c.total) || !finite(c.max) || c.max <= 0 || !finite(c.percent)) return null;
  return {
    total: c.total,
    max: c.max,
    percent: c.percent,
    autoCompactAt: finite(c.autoCompactAt) && c.autoCompactAt > 0 ? c.autoCompactAt : null,
    at: finite(c.at) ? c.at : 0,
  };
}

/** 저장된 서버 방 표시 — host 가 빈 글이 아닌 글일 때만, 아니면 null(이 PC 방) */
function savedRemote(v: unknown): { host: string } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const host = (v as Record<string, unknown>).host;
  return typeof host === 'string' && host ? { host } : null;
}

/** 저장된 서버 claude 띄우기 — 양의 정수 pid 와 안전한 띄우기 id(remote.ts 와 같은 검사)일 때만, 아니면 null */
function savedLaunch(v: unknown): { pid: number; run: string } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { pid, run } = v as Record<string, unknown>;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
  if (typeof run !== 'string' || !isSafeId(run)) return null;
  return { pid: pid as number, run };
}

/** 저장된 기다리는 정리 — 올바른 서버 이름·안전한 에이전트 id·띄우기만, 깨진 줄·배열이 아니면 버린다 */
function savedPending(v: unknown): PendingCleanup[] {
  if (!Array.isArray(v)) return [];
  const out: PendingCleanup[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const { host, agentId } = x as Record<string, unknown>;
    const launch = savedLaunch((x as Record<string, unknown>).launch);
    if (typeof host !== 'string' || typeof agentId !== 'string' || !isSafeId(agentId) || !launch) continue;
    try {
      hostArgs(host);
    } catch {
      continue;
    }
    out.push({ host, agentId, launch });
  }
  return out;
}

/** 저장된 기다리는 첨부 정리 — 올바른 서버 이름·안전한 에이전트 id 만(셸 명령에 들어간다), 깨진 줄·배열이 아니면 버린다 */
function savedPendingAttachments(v: unknown): PendingAttachmentCleanup[] {
  if (!Array.isArray(v)) return [];
  const out: PendingAttachmentCleanup[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const { host, agentId } = x as Record<string, unknown>;
    if (typeof host !== 'string' || typeof agentId !== 'string' || !isSafeId(agentId)) continue;
    try {
      hostArgs(host);
    } catch {
      continue;
    }
    out.push({ host, agentId });
  }
  return out;
}

export const REMOTE_FOLDER_ABSOLUTE = '서버 폴더는 / 로 시작하는 전체 경로로 적어 주세요';
/** 줄바꿈 같은 제어 문자 — 이름·역할·서버 폴더에 쓰지 않는다(서버 폴더는 셸 명령에 들어간다) */
export const CONTROL_CHAR = /[\p{Cc}\u2028\u2029]/u;

/** 상태 파일 이름(dataDir 안) · 깨진 것을 옮겨 둔 이름 — `state.json.broken-<Date.now()>`(load 가 만든다) */
const STATE_FILE = 'state.json';
const brokenName = (file: string) => `${file}.broken-${Date.now()}`;
const BROKEN_RE = /^state\.json\.broken-\d+$/;

/**
 * dataDir 에 옮겨 둔 깨진 상태 파일(load 가 만든 이름 꼴 그대로)이 하나라도 남아 있나 — 있으면 엔진은 '주인 없는' 첨부 폴더를 지우지 않는다
 * (깨진 채 켠 뒤 에이전트를 새로 만들면 새 state.json 이 생겨 그다음 판은 recovered 가 아니다 — 사용자가 그 .broken 을 되살릴 수 있다).
 * 폴더를 못 읽으면 남아 있다고 본다(지우지 않는 쪽)
 */
export function brokenStateLeft(dataDir: string): boolean {
  try {
    return fs.readdirSync(dataDir).some((f) => BROKEN_RE.test(f));
  } catch {
    return true;
  }
}

/** recovered: 깨졌거나 못 읽어 옮기고 빈 상태로 시작했다(Store.recovered) */
function load(file: string): { state: State; recovered: boolean } {
  const empty: State = { version: 1, rooms: [], agents: [], pendingCleanups: [], pendingAttachmentCleanups: [] };
  if (!fs.existsSync(file)) return { state: empty, recovered: false };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || !Array.isArray(raw.rooms) || !Array.isArray(raw.agents)) throw new Error('bad shape');
    const state: State = {
      version: 1,
      rooms: raw.rooms.map((r: Room) => ({ ...r, remote: savedRemote(r.remote) })),
      agents: raw.agents.map((a: Agent) => ({
        ...a, effort: savedEffort(a.effort), lastContext: savedContext(a.lastContext), bypassOn: a.bypassOn === true, bypassNoticeClosed: a.bypassNoticeClosed === true,
        forkOf: typeof a.forkOf === 'string' && a.forkOf ? a.forkOf : null, remoteLaunch: savedLaunch(a.remoteLaunch),
      })),
      pendingCleanups: savedPending(raw.pendingCleanups), // 옛 파일엔 없다 → []
      pendingAttachmentCleanups: savedPendingAttachments(raw.pendingAttachmentCleanups), // 옛 파일엔 없다 → []
    };
    return { state, recovered: false };
  } catch {
    renameRetrying(file, brokenName(file));
    return { state: empty, recovered: true };
  }
}

export function openStore(dataDir: string): Store {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, STATE_FILE);
  const { state, recovered } = load(file);

  const save = () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameRetrying(tmp, file);
  };
  const clone = <T>(v: T): T => structuredClone(v);
  const needRoom = (id: RoomId) => {
    const r = state.rooms.find((x) => x.id === id);
    if (!r) throw new Error(`방을 찾을 수 없습니다: ${id}`);
    return r;
  };
  const needAgent = (id: AgentId) => {
    const a = state.agents.find((x) => x.id === id);
    if (!a) throw new Error(`에이전트를 찾을 수 없습니다: ${id}`);
    return a;
  };
  const checkName = (roomId: RoomId, name: string, exceptId?: AgentId) => {
    if (!name.trim()) throw new Error('이름을 입력하세요');
    const n = norm(name);
    if (state.agents.some((a) => a.roomId === roomId && a.id !== exceptId && norm(a.name) === n)) {
      throw new Error(`이미 있는 이름입니다: ${name.trim()}`);
    }
  };
  /** 지우는 에이전트의 서버 claude 띄우기를 기다리는 정리 목록으로 — 서버 방이고 저장된 띄우기가 있을 때만(같은 것은 한 번) */
  const keepLaunch = (a: Agent) => {
    const host = state.rooms.find((r) => r.id === a.roomId)?.remote?.host;
    const launch = a.remoteLaunch;
    if (!host || !launch) return;
    if (state.pendingCleanups.some((p) => p.agentId === a.id && p.launch.pid === launch.pid && p.launch.run === launch.run)) return;
    state.pendingCleanups.push({ host, agentId: a.id, launch: { pid: launch.pid, run: launch.run } });
  };
  /** 지우는 서버 방 에이전트의 서버 첨부 폴더를 기다리는 첨부 정리 목록으로 — 띄운 적이 없어도(올리기만 했을 수 있다), 같은 것은 한 번 */
  const keepAttachments = (a: Agent) => {
    const host = state.rooms.find((r) => r.id === a.roomId)?.remote?.host;
    if (!host || state.pendingAttachmentCleanups.some((p) => p.agentId === a.id)) return;
    state.pendingAttachmentCleanups.push({ host, agentId: a.id });
  };
  const checkAgent = ({ roomId, name, folder }: { roomId: RoomId; name: string; folder: string }) => {
    const room = needRoom(roomId);
    checkName(roomId, name);
    if (room.remote) {
      if (!folder.startsWith('/') || CONTROL_CHAR.test(folder)) throw new Error(REMOTE_FOLDER_ABSOLUTE);
      return;
    }
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      throw new Error(`폴더를 찾을 수 없습니다: ${folder}`);
    }
  };

  return {
    rooms: () => clone(state.rooms),
    agents: (roomId) => clone(roomId ? state.agents.filter((a) => a.roomId === roomId) : state.agents),
    agent: (id) => {
      const a = state.agents.find((x) => x.id === id);
      return a ? clone(a) : undefined;
    },
    addRoom(name, remote) {
      if (!name.trim()) throw new Error('이름을 입력하세요');
      const host = remote ? (typeof remote.host === 'string' ? remote.host.trim() : '') : null;
      if (host !== null) hostArgs(host); // 빔·공백·- 시작이면 던진다
      const room: Room = { id: crypto.randomUUID(), name: name.trim(), createdAt: Date.now(), remote: host !== null ? { host } : null };
      state.rooms.push(room);
      save();
      return clone(room);
    },
    renameRoom(id, name) {
      const r = needRoom(id);
      if (!name.trim()) throw new Error('이름을 입력하세요');
      r.name = name.trim();
      save();
      return clone(r);
    },
    removeRoom(id) {
      needRoom(id);
      // 방이 지워지기 전에(서버 이름은 방에 있다)
      for (const a of state.agents) {
        if (a.roomId !== id) continue;
        keepLaunch(a);
        keepAttachments(a);
      }
      state.rooms = state.rooms.filter((r) => r.id !== id);
      state.agents = state.agents.filter((a) => a.roomId !== id);
      save();
    },
    checkAgent,
    addAgent({ roomId, name, role, folder }) {
      checkAgent({ roomId, name, folder });
      const agent: Agent = {
        id: crypto.randomUUID(), roomId, name: name.trim(), role, folder,
        sessionId: crypto.randomUUID(), started: false, auto: false, model: null,
        alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null, bypassOn: false, bypassNoticeClosed: false, forkOf: null,
        remoteLaunch: null,
      };
      state.agents.push(agent);
      save();
      return clone(agent);
    },
    updateAgent(id, patch) {
      const a = needAgent(id);
      if (patch.name !== undefined) {
        checkName(a.roomId, patch.name, id);
        patch = { ...patch, name: patch.name.trim() };
      }
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      Object.assign(a, clone(defined));
      save();
      return clone(a);
    },
    removeAgent(id) {
      const a = needAgent(id);
      keepLaunch(a);
      keepAttachments(a);
      state.agents = state.agents.filter((x) => x.id !== id);
      save();
    },
    pendingCleanups: () => clone(state.pendingCleanups),
    dropPendingCleanup(agentId, launch) {
      const rest = state.pendingCleanups.filter((p) => !(p.agentId === agentId && p.launch.pid === launch.pid && p.launch.run === launch.run));
      if (rest.length === state.pendingCleanups.length) return;
      state.pendingCleanups = rest;
      save();
    },
    pendingAttachmentCleanups: () => clone(state.pendingAttachmentCleanups),
    dropPendingAttachmentCleanup(agentId) {
      const rest = state.pendingAttachmentCleanups.filter((p) => p.agentId !== agentId);
      if (rest.length === state.pendingAttachmentCleanups.length) return;
      state.pendingAttachmentCleanups = rest;
      save();
    },
    recovered,
  };
}
