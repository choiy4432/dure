import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, AgentId, AgentPatch, Room, RoomId } from './types';

export interface Store {
  rooms(): Room[];
  agents(roomId?: RoomId): Agent[];
  agent(id: AgentId): Agent | undefined;
  addRoom(name: string): Room;
  renameRoom(id: RoomId, name: string): Room;
  removeRoom(id: RoomId): void;
  addAgent(input: { roomId: RoomId; name: string; role: string; folder: string }): Agent;
  updateAgent(id: AgentId, patch: AgentPatch): Agent;
  removeAgent(id: AgentId): void;
}

interface State {
  version: 1;
  rooms: Room[];
  agents: Agent[];
}

const norm = (s: string) => s.trim().toLocaleLowerCase('ko');

function load(file: string): State {
  const empty: State = { version: 1, rooms: [], agents: [] };
  if (!fs.existsSync(file)) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || !Array.isArray(raw.rooms) || !Array.isArray(raw.agents)) throw new Error('bad shape');
    return { version: 1, rooms: raw.rooms, agents: raw.agents };
  } catch {
    fs.renameSync(file, `${file}.broken-${Date.now()}`);
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
    fs.renameSync(tmp, file);
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
    addAgent({ roomId, name, role, folder }) {
      needRoom(roomId);
      checkName(roomId, name);
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        throw new Error(`폴더를 찾을 수 없습니다: ${folder}`);
      }
      const agent: Agent = {
        id: crypto.randomUUID(), roomId, name: name.trim(), role, folder,
        sessionId: crypto.randomUUID(), started: false, auto: false, model: null,
        alwaysAllow: [], pos: { x: 0, y: 0 }, color: null,
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
      Object.assign(a, clone(patch));
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
