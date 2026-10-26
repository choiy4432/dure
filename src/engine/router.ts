import { EventEmitter } from 'node:events';
import type { MessageLog } from './messageLog';
import type { Store } from './store';
import type { Agent, AgentId, RelayMessage, RoomId } from './types';

export const AUTO_CHAIN_LIMIT = 3;

/** 이만큼 늦게 전달되면 머리에 보낸 때를 적는다 — 받는 쪽이 이미 지난 일인지 가늠하게 */
export const LATE_MS = 2 * 60_000;

/** '34분' · '1시간 5분' — 보낸 지 얼마나 됐나(분 아래는 버린다) */
function agoText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}시간 ${min % 60}분` : `${h}시간`;
}

/** 전달 글 — 머리 '[두레 메시지 — 보낸 쪽: 이름(역할)]'(늦게 가면 끝에 ' · 34분 전에 보냄') + 본문 */
export function formatDelivery(from: Agent, text: string, lateMs = 0): string {
  const late = lateMs >= LATE_MS ? ` · ${agoText(lateMs)} 전에 보냄` : '';
  return `[두레 메시지 — 보낸 쪽: ${from.name}(${from.role})${late}]\n${text}`;
}

/** 한 번에 넘기는 전달 글 — 여럿이면 앞에 '다 읽고 한 번에' 안내를 붙여 보낸 차례대로 잇는다(Claude 에게는 한 줄) */
export function joinDeliveries(texts: string[]): string {
  if (texts.length === 1) return texts[0];
  const head = `[두레 메시지 ${texts.length}개 — 기다리는 동안 쌓인 것을 보낸 차례대로 묶었다. 뒤 메시지가 앞 메시지를 고치거나 취소할 수 있으니 다 읽은 뒤 한 번에 처리한다]`;
  return [head, ...texts].join('\n\n');
}

/** 한 메시지의 전달 — 기록은 메시지마다 따로 남는다 */
export interface Delivery {
  messageId: string;
  text: string;
}

export interface RouterDeps {
  store: Store;
  log: MessageLog;
  /** 받는 쪽에 넘긴다 — 여럿이면 한 줄로 묶어서(joinDeliveries). mid = 받는 쪽 차례 도중에 끼워 넣기(다음 걸음에서 읽는다) */
  deliver(agentId: AgentId, batch: Delivery[], mid: boolean): void;
  isBusy(agentId: AgentId): boolean;
  /** 바쁜 받는 쪽의 지금 차례에 끼워 넣을 수 있나 — 없으면 쉴 때까지 기다린다 */
  canInterject?(agentId: AgentId): boolean;
  limit?: number;
  now?: () => number;
}

const norm = (s: string) => s.trim().toLocaleLowerCase('ko');
const DONE = '이미 처리된 메시지입니다.';

export class Router extends EventEmitter {
  private chains = new Map<RoomId, number>();
  private limit: number;

  constructor(private d: RouterDeps) {
    super();
    this.limit = d.limit ?? AUTO_CHAIN_LIMIT;
  }

  /** 자동 전달 상한을 바꾼다 — 이미 센 연속 횟수는 그대로 */
  setLimit(n: number): void {
    this.limit = n;
  }

  chain(roomId: RoomId): number {
    return this.chains.get(roomId) ?? 0;
  }

  humanInput(roomId: RoomId): void {
    this.chains.set(roomId, 0);
  }

  send(fromId: AgentId, toName: string, text: string): string {
    const { store, log } = this.d;
    const from = store.agent(fromId);
    if (!from) throw new Error('보낸 에이전트를 찾을 수 없습니다.');
    const inRoom = store.agents(from.roomId);
    const key = norm(toName);
    const target = inRoom.find((a) => norm(a.name) === key);
    if (!target) {
      const names = inRoom.filter((a) => a.id !== from.id).map((a) => a.name).join(', ') || '(없음)';
      throw new Error(`이 방에 '${toName}' 에이전트가 없습니다. 있는 에이전트: ${names}`);
    }
    if (target.id === from.id) throw new Error('자기 자신에게는 보낼 수 없습니다.');
    if (!text.trim()) throw new Error('보낼 내용이 비어 있습니다.');

    const roomId = from.roomId;
    if (!target.auto) {
      this.record(log.create({ roomId, from: from.id, to: target.id, text, state: 'pending' }));
      return `${target.name} 에게 보냈습니다. 사람이 확인하면 전달됩니다.`;
    }
    if (this.chain(roomId) >= this.limit) {
      this.record(log.create({ roomId, from: from.id, to: target.id, text, state: 'held' }));
      this.emit('held', { roomId });
      return `${target.name} 에게 보냈습니다. 자동 전달이 ${this.limit}번 이어져, 사람이 확인한 뒤 전달됩니다.`;
    }
    this.chains.set(roomId, this.chain(roomId) + 1);
    return this.queue(from, target, text);
  }

  /**
   * 사람이 이미 허락한 메시지 — 새 에이전트를 만들 때 넘긴 첫 할 일([만들기] 승인이 이 메시지의 승인이다).
   * 받는 쪽 확인(pending)·자동 상한(held)을 건너뛰고 queued 로, 그 방 연속 횟수는 사람이 승인한 메시지(approve)처럼 0.
   * 전달을 시도하고 send 와 같은 결과 글을 돌려준다
   */
  sendApproved(fromId: AgentId, toId: AgentId, text: string): string {
    const { store } = this.d;
    const from = store.agent(fromId);
    if (!from) throw new Error('보낸 에이전트를 찾을 수 없습니다.');
    const target = store.agent(toId);
    if (!target || target.roomId !== from.roomId) throw new Error('받는 에이전트를 찾을 수 없습니다.');
    if (target.id === from.id) throw new Error('자기 자신에게는 보낼 수 없습니다.');
    if (!text.trim()) throw new Error('보낼 내용이 비어 있습니다.');
    this.chains.set(from.roomId, 0);
    return this.queue(from, target, text);
  }

  approve(messageId: string): void {
    const m = this.d.log.get(messageId);
    if (!m) throw new Error(`메시지를 찾을 수 없습니다: ${messageId}`);
    if (m.state !== 'pending' && m.state !== 'held') throw new Error(DONE);
    this.chains.set(m.roomId, 0);
    this.release(m);
  }

  continueHeld(roomId: RoomId): void {
    this.chains.set(roomId, 0);
    for (const m of this.d.log.list({ roomId, states: ['held'] })) this.release(m);
  }

  dismiss(messageId: string): void {
    const m = this.d.log.get(messageId);
    if (!m) throw new Error(`메시지를 찾을 수 없습니다: ${messageId}`);
    if (m.state !== 'pending' && m.state !== 'held' && m.state !== 'queued') throw new Error(DONE);
    this.record(this.d.log.setState(messageId, 'dismissed'));
  }

  /** 전달했는데 받는 쪽이 읽기 전에 죽은 메시지 — delivered 만 queued 로 되돌린다(다음 실행·flushAll 때 다시 전달) */
  requeue(messageId: string): void {
    const m = this.d.log.get(messageId);
    if (!m || m.state !== 'delivered') return;
    this.record(this.d.log.setState(messageId, 'queued'));
  }

  onIdle(agentId: AgentId): void {
    this.flush(agentId, true);
  }

  flushAll(): void {
    const targets = new Set(this.d.log.list({ states: ['queued'] }).map((m) => m.to));
    for (const to of targets) if (!this.d.isBusy(to)) this.flush(to);
  }

  /** 전달 허락된 새 메시지 — queued 로 만들고 전달을 시도해 결과 글을 돌려준다 */
  private queue(from: Agent, target: Agent, text: string): string {
    const m = this.d.log.create({ roomId: from.roomId, from: from.id, to: target.id, text, state: 'queued' });
    this.record(m);
    const r = this.flush(target.id);
    if (r === 'delivered') return `${target.name} 에게 전달했습니다.`;
    if (r === 'mid') return `${target.name} 에게 전달했습니다. 지금 하는 일 사이에 읽습니다.`;
    return `${target.name} 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.`;
  }

  /** 사람이 풀어 준 메시지: queued 로 바꾸고 전달을 시도한다(한가하면 새 차례로, 일하는 중이면 끼워 넣기) */
  private release(m: RelayMessage): void {
    this.record(this.d.log.setState(m.id, 'queued'));
    this.flush(m.to);
  }

  /**
   * 받는 쪽의 queued 를 다 넘긴다 — 보낸 차례대로 한 번에(쌓였다 하나씩 차례를 열면 앞 메시지에 답하고서야 뒤의 정정·취소를 읽는다).
   * 한가하면(idle: 호출한 쪽이 한가하다고 알려 준 경우 포함) 새 차례로, 바쁘면 지금 차례에 끼워 넣을 수 있을 때만. 보낸 쪽이 지워진 메시지는 취소.
   * 못 넘기면(끼워 넣을 수 없거나 deliver 가 던지면) queued 그대로
   */
  private flush(to: AgentId, idle = false): 'delivered' | 'mid' | 'wait' {
    let mid = false;
    if (!idle && this.d.isBusy(to)) {
      if (!this.d.canInterject?.(to)) return 'wait';
      mid = true;
    }
    const now = (this.d.now ?? Date.now)();
    const batch: { m: RelayMessage; text: string }[] = [];
    for (const m of this.d.log.list({ to, states: ['queued'] })) {
      const from = this.d.store.agent(m.from);
      if (!from) {
        this.record(this.d.log.setState(m.id, 'dismissed'));
        continue;
      }
      batch.push({ m, text: formatDelivery(from, m.text, now - m.createdAt) });
    }
    if (!batch.length) return 'wait';
    try {
      this.d.deliver(to, batch.map(({ m, text }) => ({ messageId: m.id, text })), mid);
    } catch {
      return 'wait';
    }
    for (const { m } of batch) this.record(this.d.log.setState(m.id, 'delivered'));
    return mid ? 'mid' : 'delivered';
  }

  private record(m: RelayMessage): void {
    this.emit('message', m);
  }
}
