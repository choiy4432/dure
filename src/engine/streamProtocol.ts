import type { AssistantBlock, ControlRequest, DiffHunk, StreamEvent, SubagentEnd, UserPart } from './types.js';

const ignored = (type: string): StreamEvent => ({ kind: 'ignored', type });

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text as string)
      .join('\n');
  }
  return '';
}

/** 서브에이전트 줄이면 부모의 Agent tool_use id */
const parentOf = (obj: any): { parent?: string } =>
  typeof obj.parent_tool_use_id === 'string' && obj.parent_tool_use_id !== '' ? { parent: obj.parent_tool_use_id } : {};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const END_STATUS: readonly string[] = ['completed', 'failed', 'stopped'];

const LOCAL_OUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/;

/**
 * 고친 일의 바뀐 줄 — user 줄 최상위 tool_use_result.structuredPatch 의 묶음마다 oldStart·newStart·lines 만(lines 는 그대로).
 * originalFile 같은 다른 칸은 읽지 않는다. 묶음 하나라도 모양이 다르거나 비었으면 없음
 */
function patchOf(obj: any): { patch?: DiffHunk[] } {
  const sp = obj.tool_use_result?.structuredPatch;
  if (!Array.isArray(sp) || sp.length === 0) return {};
  const patch: DiffHunk[] = [];
  for (const h of sp) {
    const oldStart = num(h?.oldStart);
    const newStart = num(h?.newStart);
    if (oldStart === null || newStart === null || !Array.isArray(h.lines) || !h.lines.every((l: unknown) => typeof l === 'string')) return {};
    patch.push({ oldStart, newStart, lines: h.lines });
  }
  return { patch };
}

function parseUser(obj: any): StreamEvent {
  const content = obj.message?.content;
  if (typeof content === 'string') {
    const m = LOCAL_OUT.exec(content.trim());
    return m ? { kind: 'local-output', text: m[1] } : ignored('user');
  }
  if (Array.isArray(content)) {
    // 한 줄에 tool_result 가 여럿이면 첫 번째만 (줄당 이벤트 하나)
    const tr = content.find((c: any) => c && c.type === 'tool_result');
    if (tr) {
      return {
        kind: 'tool-result',
        toolUseId: String(tr.tool_use_id ?? ''),
        isError: tr.is_error === true,
        text: toolResultText(tr.content),
        ...parentOf(obj),
        ...patchOf(obj),
      };
    }
  }
  return ignored('user');
}

function parseAssistant(obj: any): StreamEvent {
  const content = obj.message?.content;
  const blocks: AssistantBlock[] = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') blocks.push({ type: 'text', text: c.text });
      else if (c?.type === 'tool_use') blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    }
  }
  return { kind: 'assistant', blocks, ...parentOf(obj) };
}

/** 한 줄을 이벤트로 — 던지지 않는다(모양이 이상하면 ignored parse-error) */
export function parseLine(line: string): StreamEvent | null {
  if (line.trim() === '') return null;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return ignored('invalid-json');
  }
  if (obj === null || typeof obj !== 'object') return ignored('invalid-json');
  try {
    return parseObject(obj);
  } catch {
    return ignored('parse-error');
  }
}

function parseObject(obj: any): StreamEvent {
  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') {
        return {
          kind: 'init',
          sessionId: obj.session_id,
          model: obj.model,
          permissionMode: obj.permissionMode,
          slashCommands: Array.isArray(obj.slash_commands) ? obj.slash_commands : [],
        };
      }
      if (obj.subtype === 'compact_boundary') return { kind: 'compacted' };
      // 생각하는 동안 오르는 누적 추정 토큰 수(probe13·14: 50→278→452). 서브에이전트의 것은 쓰지 않는다
      if (obj.subtype === 'thinking_tokens' && !parentOf(obj).parent) {
        return { kind: 'thinking', active: true, tokens: num(obj.estimated_tokens) };
      }
      if (obj.subtype === 'task_started') {
        // task_type 이 없으면 서브에이전트로 친다. 그 밖(local_bash 등)은 무시
        if (obj.task_type !== undefined && obj.task_type !== 'local_agent') return ignored('system/task_started');
        return {
          kind: 'task-started',
          taskId: String(obj.task_id ?? ''),
          toolUseId: String(obj.tool_use_id ?? ''),
          description: typeof obj.description === 'string' ? obj.description : '',
          subagentType: typeof obj.subagent_type === 'string' ? obj.subagent_type : null,
          parentTaskId: typeof obj.parent_task_id === 'string' ? obj.parent_task_id : null,
        };
      }
      if (obj.subtype === 'task_notification') {
        return {
          kind: 'task-ended',
          taskId: String(obj.task_id ?? ''),
          toolUseId: String(obj.tool_use_id ?? ''),
          status: (END_STATUS.includes(obj.status) ? obj.status : 'failed') as SubagentEnd,
          summary: typeof obj.summary === 'string' ? obj.summary : '',
          toolUses: num(obj.usage?.tool_uses),
          durationMs: num(obj.usage?.duration_ms),
        };
      }
      return ignored(`system/${obj.subtype}`);
    case 'stream_event': {
      const d = obj.event?.delta;
      if (obj.event?.type === 'content_block_delta' && d?.type === 'text_delta' && typeof d.text === 'string') {
        return { kind: 'text-delta', text: d.text };
      }
      // 블록 시작 — thinking 이면 생각 시작, 다른 블록(text·tool_use)이면 생각 끝. thinking_delta 는 내용이 비고 토큰 수에
      // null 이 섞여 쓰지 않는다(수는 system/thinking_tokens 에서). 서브에이전트 줄은 부모의 생각이 아니다
      const block = obj.event?.content_block;
      if (obj.event?.type === 'content_block_start' && block && typeof block.type === 'string' && !parentOf(obj).parent) {
        return { kind: 'thinking', active: block.type === 'thinking', tokens: null };
      }
      return ignored('stream_event');
    }
    case 'assistant':
      return parseAssistant(obj);
    case 'user':
      return parseUser(obj);
    case 'result':
      return {
        kind: 'result',
        ok: !obj.is_error && obj.subtype === 'success',
        subtype: obj.subtype,
        text: typeof obj.result === 'string' ? obj.result : '',
        denials: (Array.isArray(obj.permission_denials) ? obj.permission_denials : []).map((d: any) => ({
          toolName: d.tool_name,
          toolUseId: d.tool_use_id,
        })),
      };
    case 'control_response': {
      const r = obj.response ?? {};
      return { kind: 'control-response', requestId: r.request_id, ok: r.subtype === 'success', payload: r.response ?? null };
    }
    case 'rate_limit_event':
      return { kind: 'rate-limit', info: obj.rate_limit_info ?? null };
    default:
      return ignored(String(obj.type));
  }
}

export function encodeUser(parts: UserPart[]): string {
  const content = parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } },
  );
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

export function encodeControl(requestId: string, req: ControlRequest): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: req }) + '\n';
}
