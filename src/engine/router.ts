import { EventEmitter } from 'node:events';
import type { MessageLog } from './messageLog';
import type { Store } from './store';
import type { Agent, AgentId, RelayMessage, RoomId } from './types';

export const AUTO_CHAIN_LIMIT = 3;

export function formatDelivery(from: Agent, text: string): string {
  return `[두레 메시지 — 보낸 쪽: ${from.name}(${from.role})]\n${text}`;
}

export interface RouterDeps {
  store: Store;
  log: MessageLog;
  deliver(agentId: AgentId, text: string, messageId: string): void;
  isBusy(agentId: AgentId): boolean;
  limit?: number;
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
    this.drain(agentId, true);
  }

  flushAll(): void {
    const targets = new Set(this.d.log.list({ states: ['queued'] }).map((m) => m.to));
    for (const to of targets) if (!this.d.isBusy(to)) this.drain(to, false);
  }

  /** 받는 쪽의 queued 중 가장 오래된 것을 전달. 보낸 쪽이 지워진 메시지는 취소하고 다음 것으로 넘어간다. */
  private drain(to: AgentId, ignoreBusy: boolean): void {
    for (const m of this.d.log.list({ to, states: ['queued'] })) {
      if (this.tryDeliver(m.id, ignoreBusy) !== 'dismissed') return;
    }
  }

  /** 전달 허락된 새 메시지 — queued 로 만들고 전달을 시도해 결과 글을 돌려준다 */
  private queue(from: Agent, target: Agent, text: string): string {
    const m = this.d.log.create({ roomId: from.roomId, from: from.id, to: target.id, text, state: 'queued' });
    this.record(m);
    return this.tryDeliver(m.id) === 'delivered'
      ? `${target.name} 에게 전달했습니다.`
      : `${target.name} 에게 보냈습니다. 지금 하던 일이 끝나면 전달됩니다.`;
  }

  /** 사람이 풀어 준 메시지: queued 로 바꾸고, 한가하면 바로 전달 */
  private release(m: RelayMessage): void {
    this.record(this.d.log.setState(m.id, 'queued'));
    if (!this.d.isBusy(m.to)) this.tryDeliver(m.id);
  }

  /** queued 메시지를 전달 시도(ignoreBusy: 호출한 쪽이 한가하다고 알려 준 경우). 바쁘거나 deliver 가 던지면 queued 로 남는다. */
  private tryDeliver(id: string, ignoreBusy = false): 'delivered' | 'wait' | 'dismissed' {
    const m = this.d.log.get(id);
    if (!m || m.state !== 'queued') return 'wait';
    if (!ignoreBusy && this.d.isBusy(m.to)) return 'wait';
    const from = this.d.store.agent(m.from);
    if (!from) {
      this.record(this.d.log.setState(id, 'dismissed'));
      return 'dismissed';
    }
    try {
      this.d.deliver(m.to, formatDelivery(from, m.text), m.id);
    } catch {
      return 'wait';
    }
    this.record(this.d.log.setState(id, 'delivered'));
    return 'delivered';
  }

  private record(m: RelayMessage): void {
    this.emit('message', m);
  }
}
