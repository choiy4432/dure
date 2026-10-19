import { describe, expect, test } from 'vitest';
import { encodeControl, encodeUser, parseLine } from '../src/engine/streamProtocol.js';

describe('parseLine', () => {
  test('init', () =>
    expect(
      parseLine('{"type":"system","subtype":"init","session_id":"S","model":"m","permissionMode":"default","slash_commands":["compact"],"tools":[]}'),
    ).toEqual({ kind: 'init', sessionId: 'S', model: 'm', permissionMode: 'default', slashCommands: ['compact'] }));

  test('assistant: thinking 버리고 text·tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Write', input: { a: 1 } }] },
    });
    expect(parseLine(line)).toEqual({
      kind: 'assistant',
      blocks: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Write', input: { a: 1 } }],
    });
  });

  test('assistant: thinking 만 있으면 빈 blocks', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } });
    expect(parseLine(line)).toEqual({ kind: 'assistant', blocks: [] });
  });

  test('stream_event text_delta', () =>
    expect(parseLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"안"}}}')).toEqual({
      kind: 'text-delta',
      text: '안',
    }));

  test('stream_event 그 외 → ignored', () =>
    expect(parseLine('{"type":"stream_event","event":{"type":"message_start"}}')).toEqual({ kind: 'ignored', type: 'stream_event' }));

  test('tool_result: 문자열 content 와 배열 content 둘 다 text 로', () => {
    const s = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } });
    expect(parseLine(s)).toEqual({ kind: 'tool-result', toolUseId: 'a', isError: false, text: 'ok' });
    const arr = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] }] },
    });
    expect(parseLine(arr)).toEqual({ kind: 'tool-result', toolUseId: 'b', isError: true, text: 'x\ny' });
  });

  test('local-command-stdout 에코 → local-output', () => {
    const s = JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to x</local-command-stdout>' } });
    expect(parseLine(s)).toEqual({ kind: 'local-output', text: 'Set model to x' });
  });

  test('그 외 user 줄 → ignored user', () => {
    const s = JSON.stringify({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } });
    expect(parseLine(s)).toEqual({ kind: 'ignored', type: 'user' });
  });

  test('result 성공·중단', () => {
    expect(parseLine('{"type":"result","subtype":"success","is_error":false,"result":"done"}')).toEqual({
      kind: 'result', ok: true, subtype: 'success', text: 'done', denials: [],
    });
    expect(parseLine('{"type":"result","subtype":"error_during_execution","is_error":true}')).toEqual({
      kind: 'result', ok: false, subtype: 'error_during_execution', text: '', denials: [],
    });
  });

  test('permission_denials → denials', () =>
    expect(
      parseLine('{"type":"result","subtype":"success","is_error":false,"result":"","permission_denials":[{"tool_name":"Write","tool_use_id":"u1","tool_input":{}}]}'),
    ).toEqual({ kind: 'result', ok: true, subtype: 'success', text: '', denials: [{ toolName: 'Write', toolUseId: 'u1' }] }));

  test('control_response', () => {
    expect(parseLine('{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"commands":[]}}}')).toEqual({
      kind: 'control-response', requestId: 'r1', ok: true, payload: { commands: [] },
    });
    expect(parseLine('{"type":"control_response","response":{"subtype":"error","request_id":"r2"}}')).toEqual({
      kind: 'control-response', requestId: 'r2', ok: false, payload: null,
    });
  });

  test('rate_limit_event', () =>
    expect(parseLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}')).toEqual({
      kind: 'rate-limit', info: { status: 'allowed' },
    }));

  test('hook·thinking_tokens·모르는 type → ignored', () => {
    expect(parseLine('{"type":"system","subtype":"hook_started"}')).toEqual({ kind: 'ignored', type: 'system/hook_started' });
    expect(parseLine('{"type":"system","subtype":"thinking_tokens"}')).toEqual({ kind: 'ignored', type: 'system/thinking_tokens' });
    expect(parseLine('{"type":"mystery"}')).toEqual({ kind: 'ignored', type: 'mystery' });
  });

  test('모양이 이상한 줄에도 던지지 않는다 — permission_denials 에 null → ignored parse-error', () => {
    const line = '{"type":"result","subtype":"success","is_error":false,"result":"x","permission_denials":[null]}';
    expect(() => parseLine(line)).not.toThrow();
    expect(parseLine(line)).toEqual({ kind: 'ignored', type: 'parse-error' });
  });

  test('message 가 객체가 아니어도 던지지 않는다', () => {
    for (const message of [7, 'x', null, true, [1]]) {
      for (const type of ['user', 'assistant']) {
        expect(() => parseLine(JSON.stringify({ type, message }))).not.toThrow();
      }
    }
    expect(parseLine('{"type":"user","message":7}')).toEqual({ kind: 'ignored', type: 'user' });
    expect(parseLine('{"type":"assistant","message":"x"}')).toEqual({ kind: 'assistant', blocks: [] });
  });

  test('깨진 JSON → ignored invalid-json, 빈 줄 → null', () => {
    expect(parseLine('{oops')).toEqual({ kind: 'ignored', type: 'invalid-json' });
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });
});

describe('encode', () => {
  test('encodeUser: 텍스트·이미지, 특수문자 왕복', () => {
    const text = '줄1\n"따옴표" \\ 백슬래시 🎉 한글';
    const s = encodeUser([{ type: 'image', mediaType: 'image/png', base64: 'AA==' }, { type: 'text', text }]);
    expect(s.endsWith('\n')).toBe(true);
    expect(s.slice(0, -1)).not.toContain('\n');
    const decoded = JSON.parse(s);
    expect(decoded.message.content[1].text.includes('\\')).toBe(true);
    expect(decoded).toEqual({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
        { type: 'text', text },
      ] },
    });
  });

  test('encodeControl', () => {
    const s = encodeControl('r9', { subtype: 'set_model', model: 'sonnet' });
    expect(s.endsWith('\n')).toBe(true);
    expect(JSON.parse(s)).toEqual({ type: 'control_request', request_id: 'r9', request: { subtype: 'set_model', model: 'sonnet' } });
  });
});
