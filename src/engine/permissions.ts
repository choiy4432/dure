import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ApproveResult } from './mcpServer';
import type { Store } from './store';
import type { AgentId, Decision, PendingRequest } from './types';

export const DENY_DEFAULT = '사용자가 거절했습니다.';
const QUESTION_TOOL = 'AskUserQuestion';

interface Entry {
  req: PendingRequest;
  resolve: (r: ApproveResult) => void;
}

// 권한·되묻기 대기열. 이벤트: 'request'(PendingRequest) · 'resolved'({ id, agentId })
export class Permissions extends EventEmitter {
  private entries = new Map<string, Entry>();
  private asked = new Set<string>();

  constructor(private store: Store) {
    super();
  }

  request(agentId: AgentId, args: { tool_name: string; input: unknown; tool_use_id?: string }): Promise<ApproveResult> {
    const agent = this.store.agent(agentId);
    if (!agent) return Promise.resolve({ behavior: 'deny', message: '에이전트를 찾을 수 없습니다.' });
    const isQuestion = args.tool_name === QUESTION_TOOL;
    if (!isQuestion && agent.alwaysAllow.includes(args.tool_name)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: args.input });
    }
    const req: PendingRequest = {
      id: crypto.randomUUID(),
      agentId,
      toolName: args.tool_name,
      input: args.input,
      toolUseId: args.tool_use_id,
      kind: isQuestion ? 'question' : 'permission',
      createdAt: Date.now(),
    };
    if (args.tool_use_id) this.asked.add(`${agentId}:${args.tool_use_id}`);
    let resolve!: (r: ApproveResult) => void;
    const result = new Promise<ApproveResult>((r) => {
      resolve = r;
    });
    this.entries.set(req.id, { req, resolve });
    // 알림은 대기를 만든 뒤 밖에서 — 듣는 쪽이 던져도 요청은 대기로 남아 답할 수 있다(엔진은 자기 듣는 쪽을 따로 감싼다)
    try {
      this.emit('request', { ...req });
    } catch {
      /* 듣는 쪽 오류로 요청을 잃지 않는다 */
    }
    return result;
  }

  answer(requestId: string, d: Decision): void {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error(`대기 중인 요청이 없습니다: ${requestId}`);
    const { req } = entry;
    if (d.type === 'answer' && req.kind !== 'question') throw new Error('권한 요청에는 answer 로 답할 수 없습니다.');
    if ((d.type === 'allow' || d.type === 'allow-always') && req.kind === 'question') {
      throw new Error('되묻기에는 allow 로 답할 수 없습니다.');
    }
    let result: ApproveResult;
    if (d.type === 'deny') {
      result = { behavior: 'deny', message: d.message ?? DENY_DEFAULT };
    } else if (d.type === 'answer') {
      const base = req.input && typeof req.input === 'object' ? (req.input as object) : {};
      result = { behavior: 'allow', updatedInput: { ...base, answers: d.answers } };
    } else {
      if (d.type === 'allow-always') {
        const cur = this.store.agent(req.agentId)?.alwaysAllow;
        if (cur && !cur.includes(req.toolName)) this.store.updateAgent(req.agentId, { alwaysAllow: [...cur, req.toolName] });
      }
      result = { behavior: 'allow', updatedInput: req.input };
    }
    this.finish(entry, result);
  }

  cancelForAgent(agentId: AgentId, message: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.req.agentId === agentId) this.finish(entry, { behavior: 'deny', message });
    }
  }

  pending(agentId?: AgentId): PendingRequest[] {
    return [...this.entries.values()]
      .map((e) => e.req)
      .filter((r) => !agentId || r.agentId === agentId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }));
  }

  wasAsked(agentId: AgentId, toolUseId: string): boolean {
    return this.asked.has(`${agentId}:${toolUseId}`);
  }

  private finish(entry: Entry, result: ApproveResult): void {
    this.entries.delete(entry.req.id);
    entry.resolve(result);
    this.emit('resolved', { id: entry.req.id, agentId: entry.req.agentId });
  }
}
