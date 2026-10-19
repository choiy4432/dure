import type { AssistantBlock, ControlRequest, StreamEvent, UserPart } from './types.js';

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

const LOCAL_OUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/;

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
  return { kind: 'assistant', blocks };
}

export function parseLine(line: string): StreamEvent | null {
  if (line.trim() === '') return null;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return ignored('invalid-json');
  }
  if (obj === null || typeof obj !== 'object') return ignored('invalid-json');
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
      return ignored(`system/${obj.subtype}`);
    case 'stream_event': {
      const d = obj.event?.delta;
      if (obj.event?.type === 'content_block_delta' && d?.type === 'text_delta' && typeof d.text === 'string') {
        return { kind: 'text-delta', text: d.text };
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
