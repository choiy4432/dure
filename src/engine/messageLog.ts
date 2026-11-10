import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, MessageState, RelayMessage, RoomId } from './types';

export interface MessageLog {
  create(m: { roomId: RoomId; from: AgentId; to: AgentId; text: string; state: MessageState }): RelayMessage;
  /** failed 면 o.failReason 을 함께 남긴다 — 다른 상태로 바뀌면 까닭은 지운다 */
  setState(id: string, state: MessageState, o?: { failReason?: string }): RelayMessage;
  get(id: string): RelayMessage | undefined;
  list(f?: { roomId?: RoomId; to?: AgentId; from?: AgentId; states?: MessageState[] }): RelayMessage[]; // createdAt 오름차순
  /**
   * 전달하고(delivered) 아직 읽음(read)을 못 받은 메시지 — createdAt 오름차순. 이 판이 남긴 전달만(그 줄에 awaitRead 표시):
   * 읽음을 남기지 않던 옛 판의 delivered 는 이미 읽혔는지 알 수 없어 넣지 않는다(다시 전달하지 않는다)
   */
  awaitingRead(): RelayMessage[];
}

/** 기록 줄 — create · state(전달이면 awaitRead: 읽음을 기다린다, failed 면 failReason) */
function replay(file: string): { msgs: RelayMessage[]; awaiting: Set<string> } {
  const msgs: RelayMessage[] = [];
  const awaiting = new Set<string>();
  if (!fs.existsSync(file)) return { msgs, awaiting };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.op === 'create' && rec.msg && typeof rec.msg.id === 'string') {
        msgs.push(rec.msg as RelayMessage);
      } else if (rec?.op === 'state') {
        const m = msgs.find((x) => x.id === rec.id);
        if (m) {
          apply(m, rec.state, rec.at, typeof rec.failReason === 'string' ? rec.failReason : undefined);
          if (rec.state === 'delivered' && rec.awaitRead === true) awaiting.add(m.id);
          else awaiting.delete(m.id);
        }
      }
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return { msgs, awaiting };
}

function apply(m: RelayMessage, state: MessageState, at: number, failReason: string | undefined): void {
  m.state = state;
  m.updatedAt = at;
  if (state === 'failed') m.failReason = failReason ?? '';
  else delete m.failReason;
}

export function openMessageLog(dataDir: string): MessageLog {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'messages.jsonl');
  const { msgs, awaiting } = replay(file);
  // 마지막 줄이 끊겨 있으면 다음 기록이 그 줄에 붙지 않게 줄바꿈으로 닫는다
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 0 && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
  }
  const append = (rec: unknown) => fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  const clone = <T>(v: T): T => structuredClone(v);
  const byCreated = (a: RelayMessage, b: RelayMessage) => a.createdAt - b.createdAt;

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
    setState(id, state, o = {}) {
      const m = msgs.find((x) => x.id === id);
      if (!m) throw new Error(`메시지를 찾을 수 없습니다: ${id}`);
      const at = Date.now();
      const failReason = state === 'failed' ? o.failReason ?? '' : undefined;
      append({
        op: 'state', id, state, at,
        ...(state === 'delivered' ? { awaitRead: true } : {}),
        ...(failReason !== undefined ? { failReason } : {}),
      });
      apply(m, state, at, failReason);
      if (state === 'delivered') awaiting.add(id);
      else awaiting.delete(id);
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
          .sort(byCreated),
      );
    },
    awaitingRead() {
      return clone(msgs.filter((m) => awaiting.has(m.id)).sort(byCreated));
    },
  };
}
