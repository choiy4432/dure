import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, MessageState, RelayMessage, RoomId } from './types';

export interface MessageLog {
  create(m: { roomId: RoomId; from: AgentId; to: AgentId; text: string; state: MessageState }): RelayMessage;
  setState(id: string, state: MessageState): RelayMessage;
  get(id: string): RelayMessage | undefined;
  list(f?: { roomId?: RoomId; to?: AgentId; from?: AgentId; states?: MessageState[] }): RelayMessage[]; // createdAt 오름차순
}

function replay(file: string): RelayMessage[] {
  const msgs: RelayMessage[] = [];
  if (!fs.existsSync(file)) return msgs;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.op === 'create' && rec.msg && typeof rec.msg.id === 'string') {
        msgs.push(rec.msg as RelayMessage);
      } else if (rec?.op === 'state') {
        const m = msgs.find((x) => x.id === rec.id);
        if (m) {
          m.state = rec.state;
          m.updatedAt = rec.at;
        }
      }
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return msgs;
}

export function openMessageLog(dataDir: string): MessageLog {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'messages.jsonl');
  const msgs = replay(file);
  // 마지막 줄이 끊겨 있으면 다음 기록이 그 줄에 붙지 않게 줄바꿈으로 닫는다
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 0 && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
  }
  const append = (rec: unknown) => fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  const clone = <T>(v: T): T => structuredClone(v);

  return {
    create({ roomId, from, to, text, state }) {
      const now = Date.now();
      const msg: RelayMessage = {
        id: crypto.randomUUID(), roomId, from, to, text, createdAt: now, state, updatedAt: now,
      };
      append({ op: 'create', msg });
      msgs.push(msg);
      return clone(msg);
    },
    setState(id, state) {
      const m = msgs.find((x) => x.id === id);
      if (!m) throw new Error(`메시지를 찾을 수 없습니다: ${id}`);
      const at = Date.now();
      append({ op: 'state', id, state, at });
      m.state = state;
      m.updatedAt = at;
      return clone(m);
    },
    get(id) {
      const m = msgs.find((x) => x.id === id);
      return m ? clone(m) : undefined;
    },
    list(f = {}) {
      return clone(
        msgs
          .filter(
            (m) =>
              (!f.roomId || m.roomId === f.roomId) &&
              (!f.to || m.to === f.to) &&
              (!f.from || m.from === f.from) &&
              (!f.states || f.states.includes(m.state)),
          )
          .sort((a, b) => a.createdAt - b.createdAt),
      );
    },
  };
}
