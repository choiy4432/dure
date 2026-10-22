import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EFFORT_LEVELS, type Agent, type AgentId, type AgentPatch, type ContextUsage, type EffortLevel, type Room, type RoomId } from './types';

export interface Store {
  rooms(): Room[];
  agents(roomId?: RoomId): Agent[];
  agent(id: AgentId): Agent | undefined;
  addRoom(name: string): Room;
  renameRoom(id: RoomId, name: string): Room;
  removeRoom(id: RoomId): void;
  addAgent(input: { roomId: RoomId; name: string; role: string; folder: string }): Agent;
  /** addAgent 가 더하기 전에 하는 검사 그대로(방·이름 빔·방 안 이름 겹침·폴더) — 더하지 않고 던지기만 한다 */
  checkAgent(input: { roomId: RoomId; name: string; folder: string }): void;
  updateAgent(id: AgentId, patch: AgentPatch): Agent;
  removeAgent(id: AgentId): void;
}

interface State {
  version: 1;
  rooms: Room[];
  agents: Agent[];
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

function load(file: string): State {
  const empty: State = { version: 1, rooms: [], agents: [] };
  if (!fs.existsSync(file)) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || !Array.isArray(raw.rooms) || !Array.isArray(raw.agents)) throw new Error('bad shape');
    return {
      version: 1,
      rooms: raw.rooms,
      agents: raw.agents.map((a: Agent) => ({ ...a, effort: savedEffort(a.effort), lastContext: savedContext(a.lastContext), bypassOn: a.bypassOn === true, bypassNoticeClosed: a.bypassNoticeClosed === true })),
    };
  } catch {
    renameRetrying(file, `${file}.broken-${Date.now()}`);
    return empty;
  }
}

export function openStore(dataDir: string): Store {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'state.json');
  const state = load(file);

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
  const checkAgent = ({ roomId, name, folder }: { roomId: RoomId; name: string; folder: string }) => {
    needRoom(roomId);
    checkName(roomId, name);
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
    addRoom(name) {
      if (!name.trim()) throw new Error('이름을 입력하세요');
      const room: Room = { id: crypto.randomUUID(), name: name.trim(), createdAt: Date.now() };
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
        alwaysAllow: [], pos: { x: 0, y: 0 }, color: null, effort: null, lastContext: null, bypassOn: false, bypassNoticeClosed: false,
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
      needAgent(id);
      state.agents = state.agents.filter((a) => a.id !== id);
      save();
    },
  };
}
