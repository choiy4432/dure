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
  // 보낸 말의 되돌림 — Claude 가 그 말을 읽은 순간(probe17). 글 조각만 이어 붙여 보낸 말과 맞춘다
  if (obj.isReplay === true) return { kind: 'replay', text: replayText(content) };
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

function replayText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c: any) => c && c.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n');
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
      // 생각하는 동안 오르는 누적 추정 토큰 수(probe13·14: 50→278→452). 서브에이전트의 것은 쓰지 않는다.
      // 수가 없으면 버린다 — 수 없는(tokens null) 신호는 생각 블록 시작이고, 생각은 블록 시작만 연다(늦게 온 수가 다시 열지 않게)
      if (obj.subtype === 'thinking_tokens' && !parentOf(obj).parent) {
        const tokens = num(obj.estimated_tokens);
        return tokens === null ? ignored('system/thinking_tokens') : { kind: 'thinking', active: true, tokens };
      }
      // 요청 보냄·요약 중·끝(null) — 모르는 값은 버린다(다음 CLI 가 상태를 늘려도 엉뚱한 단계를 보이지 않게)
      if (obj.subtype === 'status' && !parentOf(obj).parent) {
        const st = obj.status;
        // 모드가 바뀌면 status null 줄에 permissionMode 가 실려 온다(probe16) — 모르는 status 여도 모드는 버리지 않는다
        const mode = typeof obj.permissionMode === 'string' ? { permissionMode: obj.permissionMode } : {};
        if (st === 'requesting' || st === 'compacting' || st === null) return { kind: 'api-status', status: st, ...mode };
        return 'permissionMode' in mode ? { kind: 'api-status', status: null, ...mode } : ignored('system/status');
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
      if (obj.subtype === 'background_tasks_changed') {
        // tasks 가 없거나 배열이 아니면 빈 목록. task_id 가 글이 아닌 항목은 뺀다
        const tasks: unknown[] = Array.isArray(obj.tasks) ? obj.tasks : [];
        const taskIds = tasks.flatMap((t: any) => (typeof t?.task_id === 'string' ? [t.task_id] : []));
        return { kind: 'background-tasks', taskIds };
      }
      return ignored(`system/${obj.subtype}`);
    case 'stream_event': {
      const d = obj.event?.delta;
      if (obj.event?.type === 'content_block_delta' && d?.type === 'text_delta' && typeof d.text === 'string') {
        return { kind: 'text-delta', text: d.text };
      }
      // 블록 시작 — thinking·redacted_thinking(가려진 생각)이면 생각 시작, 다른 블록(text·tool_use)이면 생각 끝. thinking_delta 는
      // 내용이 비고 토큰 수에 null 이 섞여 쓰지 않는다(수는 system/thinking_tokens 에서). 서브에이전트 줄은 부모의 생각이 아니다
      const block = obj.event?.content_block;
      if (obj.event?.type === 'content_block_start' && block && typeof block.type === 'string' && !parentOf(obj).parent) {
        return { kind: 'thinking', active: block.type === 'thinking' || block.type === 'redacted_thinking', tokens: null };
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

/** 줄·문단 구분자(U+2028·U+2029) — JSON.stringify 는 그대로 두지만, 받는 쪽이 줄 끝으로 읽으면(Node readline 등) 한 줄이 쪼개진다 */
const LINE_SEPARATORS = /[\p{Zl}\p{Zp}]/gu;

/** 보내는 한 줄 JSON 의 구분자를 JSON 이스케이프(백슬래시 u2028·u2029)로 — JSON 으로는 같은 글이다 */
function escapeSeparators(json: string): string {
  return json.replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

export function encodeUser(parts: UserPart[]): string {
  const content = parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } },
  );
  return escapeSeparators(JSON.stringify({ type: 'user', message: { role: 'user', content } })) + '\n';
}

export function encodeControl(requestId: string, req: ControlRequest): string {
  return escapeSeparators(JSON.stringify({ type: 'control_request', request_id: requestId, request: req })) + '\n';
}
