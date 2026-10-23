import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ApproveResult } from './mcpServer';
import type { Store } from './store';
import type { AgentId, Decision, PendingRequest } from './types';

import { DENY } from '../shared/denyTexts';

export const DENY_DEFAULT: string = DENY.userDenied;
const CANCELLED: string = DENY.requestCancelled; // 부른 쪽이 끊겨 Claude 에겐 닿지 않는다
const QUESTION_TOOL = 'AskUserQuestion';
const PLAN_TOOL = 'ExitPlanMode';
const PLAN_ONLY_ALLOW_DENY = '계획에는 진행이나 고쳐 달라고 하기로만 답할 수 있습니다.';
const CREATE_ONLY_ALLOW_DENY = '새 에이전트 만들기에는 allow 나 deny 로만 답할 수 있습니다.';

interface Entry {
  req: PendingRequest;
  resolve: (r: ApproveResult) => void;
  detach?: () => void; // signal 에 단 abort 듣는 쪽을 뗀다
}

// 권한·되묻기 대기열. 이벤트: 'request'(PendingRequest) · 'resolved'({ id, agentId }) ·
// 'always-allow'({ agentId, alwaysAllow }) — allow-always 로 늘 허용 목록에 더했을 때(바뀐 뒤의 목록)
export class Permissions extends EventEmitter {
  private entries = new Map<string, Entry>();
  private asked = new Set<string>();

  constructor(private store: Store) {
    super();
  }

  /**
   * signal 이 abort 되면(부른 쪽이 끊김) 대기에서 빼고 deny 로 끝낸다 — 죽은 호출의 카드가 남지 않게.
   * o.fromSubagent: 서브에이전트가 물은 것 — 요청에 표시해 둔다(차례 끝 정리에서 남길지 가른다).
   * o.kind 'create-agent': 새 에이전트 만들기 카드 — 늘 허용 목록과 상관없이 늘 묻고, allow·deny 로만 답한다
   */
  request(
    agentId: AgentId,
    args: { tool_name: string; input: unknown; tool_use_id?: string },
    signal?: AbortSignal,
    o: { fromSubagent?: boolean; kind?: 'create-agent' } = {},
  ): Promise<ApproveResult> {
    const agent = this.store.agent(agentId);
    if (!agent) return Promise.resolve({ behavior: 'deny', message: '에이전트를 찾을 수 없습니다.' });
    const create = o.kind === 'create-agent';
    const isQuestion = !create && args.tool_name === QUESTION_TOOL;
    if (!create && this.allowsAlways(agentId, args.tool_name)) return Promise.resolve({ behavior: 'allow', updatedInput: args.input });
    if (signal?.aborted) return Promise.resolve({ behavior: 'deny', message: CANCELLED });
    const req: PendingRequest = {
      id: crypto.randomUUID(),
      agentId,
      toolName: args.tool_name,
      input: args.input,
      toolUseId: args.tool_use_id,
      kind: create ? 'create-agent' : isQuestion ? 'question' : args.tool_name === PLAN_TOOL ? 'plan' : 'permission',
      createdAt: Date.now(),
      ...(o.fromSubagent ? { fromSubagent: true as const } : {}),
    };
    if (args.tool_use_id) this.asked.add(`${agentId}:${args.tool_use_id}`);
    let resolve!: (r: ApproveResult) => void;
    const result = new Promise<ApproveResult>((r) => {
      resolve = r;
    });
    const entry: Entry = { req, resolve };
    if (signal) {
      const onAbort = () => {
        if (this.entries.get(req.id) === entry) this.finish(entry, { behavior: 'deny', message: CANCELLED });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.detach = () => signal.removeEventListener('abort', onAbort);
    }
    this.entries.set(req.id, entry);
    // 알림은 대기를 만든 뒤 밖에서 — 듣는 쪽이 던져도 요청은 대기로 남아 답할 수 있다(엔진은 자기 듣는 쪽을 따로 감싼다)
    try {
      this.emit('request', { ...req });
    } catch {
      /* 듣는 쪽 오류로 요청을 잃지 않는다 */
    }
    return result;
  }

  /** 묻지 않고 허용할 도구인가 — 그 에이전트가 늘 허용한 도구(질문은 늘 묻는다). 엔진은 부른 쪽을 가르기 전에 본다 */
  allowsAlways(agentId: AgentId, toolName: string): boolean {
    return toolName !== QUESTION_TOOL && toolName !== PLAN_TOOL && !!this.store.agent(agentId)?.alwaysAllow.includes(toolName);
  }

  answer(requestId: string, d: Decision): void {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error(`대기 중인 요청이 없습니다: ${requestId}`);
    const { req } = entry;
    // 새 에이전트 만들기는 매번 사람이 정한다 — 늘 허용(allow-always)이 없다
    if (req.kind === 'create-agent' && d.type !== 'allow' && d.type !== 'deny') throw new Error(CREATE_ONLY_ALLOW_DENY);
    // 계획도 allow·deny 로만 — 늘 허용 없이 매번 사람이 본다
    if (req.kind === 'plan' && d.type !== 'allow' && d.type !== 'deny') throw new Error(PLAN_ONLY_ALLOW_DENY);
    if (d.type === 'answer' && req.kind !== 'question') throw new Error('권한 요청에는 answer 로 답할 수 없습니다.');
    if ((d.type === 'allow' || d.type === 'allow-always') && req.kind === 'question') {
      throw new Error('되묻기에는 allow 로 답할 수 없습니다.');
    }
    let result: ApproveResult;
    let always: string[] | null = null; // 늘 허용에 더했으면 바뀐 뒤의 목록
    if (d.type === 'deny') {
      result = { behavior: 'deny', message: d.message ?? (req.kind === 'create-agent' ? DENY.createAgentDenied : DENY_DEFAULT) };
    } else if (d.type === 'answer') {
      const base = req.input && typeof req.input === 'object' ? (req.input as object) : {};
      result = { behavior: 'allow', updatedInput: { ...base, answers: d.answers } };
    } else {
      if (d.type === 'allow-always') {
        const cur = this.store.agent(req.agentId)?.alwaysAllow;
        if (cur && !cur.includes(req.toolName)) always = this.store.updateAgent(req.agentId, { alwaysAllow: [...cur, req.toolName] }).alwaysAllow;
      }
      result = { behavior: 'allow', updatedInput: req.input };
    }
    this.finish(entry, result);
    // 화면의 '항상 허용한 일'(메뉴의 수·대화상자)이 다음 스냅샷을 기다리지 않게 — 답을 보낸 뒤 알린다(듣는 쪽이 던져도 답은 이미 갔다)
    if (always) {
      try {
        this.emit('always-allow', { agentId: req.agentId, alwaysAllow: [...always] });
      } catch {
        /* 듣는 쪽 오류로 답을 잃지 않는다 */
      }
    }
  }

  /** 그 에이전트의 대기를 message 로 거절한다 — keep 이 true 인 요청은 남긴다(차례가 끝나도 도는 서브에이전트가 물은 것) */
  cancelForAgent(agentId: AgentId, message: string, keep?: (r: PendingRequest) => boolean): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.req.agentId !== agentId || keep?.({ ...entry.req })) continue;
      this.finish(entry, { behavior: 'deny', message });
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
    entry.detach?.();
    entry.resolve(result);
    this.emit('resolved', { id: entry.req.id, agentId: entry.req.agentId });
  }
}
