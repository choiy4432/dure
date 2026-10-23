import { describe, expect, test } from 'vitest';
import { encodeControl, encodeUser, parseLine } from '../src/engine/streamProtocol.js';

describe('parseLine', () => {
  test('init', () =>
    expect(
      parseLine('{"type":"system","subtype":"init","session_id":"S","model":"m","permissionMode":"default","slash_commands":["compact"],"tools":[]}'),
    ).toEqual({ kind: 'init', sessionId: 'S', model: 'm', permissionMode: 'default', slashCommands: ['compact'] }));

  test('system/compact_boundary → compacted', () =>
    expect(parseLine('{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual"}}')).toEqual({ kind: 'compacted' }));

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

  test('hook·모르는 type → ignored (thinking_tokens 는 생각 신호 — 아래)', () => {
    expect(parseLine('{"type":"system","subtype":"hook_started"}')).toEqual({ kind: 'ignored', type: 'system/hook_started' });
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

describe('parseLine — 서브에이전트', () => {
  const tu = { type: 'tool_use', id: 'toolu_R', name: 'Read', input: {} };
  test('assistant 의 parent_tool_use_id → parent, null 이면 칸 없음', () => {
    const mk = (p: unknown) => parseLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: p, message: { content: [tu] } }));
    expect(mk('toolu_A')).toEqual({ kind: 'assistant', blocks: [tu], parent: 'toolu_A' });
    expect(mk(null)).toEqual({ kind: 'assistant', blocks: [tu] });
  });

  test('tool_result 줄의 parent_tool_use_id → parent', () => {
    const line = JSON.stringify({
      type: 'user',
      parent_tool_use_id: 'toolu_A',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_R', content: 'ok' }] },
    });
    expect(parseLine(line)).toEqual({ kind: 'tool-result', toolUseId: 'toolu_R', isError: false, text: 'ok', parent: 'toolu_A' });
  });

  const started = { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_A', description: 'outer', subagent_type: 'general-purpose', task_type: 'local_agent', spawn_depth: 1 };
  test('task_started → task-started', () => {
    expect(parseLine(JSON.stringify(started))).toEqual({ kind: 'task-started', taskId: 't1', toolUseId: 'toolu_A', description: 'outer', subagentType: 'general-purpose', parentTaskId: null });
    expect(parseLine(JSON.stringify({ ...started, parent_task_id: 't0' }))).toMatchObject({ kind: 'task-started', parentTaskId: 't0' });
  });
  test('task_started: local_bash 는 무시, task_type 없으면 서브에이전트', () => {
    expect(parseLine(JSON.stringify({ ...started, task_type: 'local_bash' }))).toEqual({ kind: 'ignored', type: 'system/task_started' });
    const { task_type, ...noType } = started;
    expect(parseLine(JSON.stringify(noType))).toMatchObject({ kind: 'task-started', taskId: 't1' });
  });

  const note = { type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_A', status: 'stopped', summary: 'x', usage: { total_tokens: 9, tool_uses: 3, duration_ms: 8007 } };
  test('task_notification → task-ended', () => {
    expect(parseLine(JSON.stringify(note))).toEqual({ kind: 'task-ended', taskId: 't1', toolUseId: 'toolu_A', status: 'stopped', summary: 'x', toolUses: 3, durationMs: 8007 });
  });
  test('task_notification: 모르는 status → failed, usage·summary 없으면 null·빈 글', () => {
    const { usage, summary, ...bare } = note;
    expect(parseLine(JSON.stringify({ ...bare, status: 'weird' }))).toEqual({ kind: 'task-ended', taskId: 't1', toolUseId: 'toolu_A', status: 'failed', summary: '', toolUses: null, durationMs: null });
  });

  test('task_progress·task_updated·background_tasks_changed → ignored', () => {
    for (const subtype of ['task_progress', 'task_updated', 'background_tasks_changed']) {
      expect(parseLine(JSON.stringify({ type: 'system', subtype }))).toEqual({ kind: 'ignored', type: `system/${subtype}` });
    }
  });
});

describe('parseLine — 생각 신호(probe13·14 원본 모양)', () => {
  // 진짜 줄처럼 parent_tool_use_id: null · session_id · uuid 가 붙어 온다
  const ev = (event: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'stream_event', event, session_id: 'S', parent_tool_use_id: null, uuid: 'u1', ...extra });
  const tokens = (n: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: n, estimated_tokens_delta: 50, session_id: 'S', uuid: 'u2', ...extra });
  const blockStart = (content_block: unknown) => ev({ type: 'content_block_start', index: 0, content_block });

  test('thinking 블록 시작 → 생각 시작(토큰 수는 아직 모름)', () =>
    expect(parseLine(blockStart({ type: 'thinking', thinking: '', signature: '' }))).toEqual({ kind: 'thinking', active: true, tokens: null }));

  test('redacted_thinking 블록 시작(가려진 생각)도 생각 시작 — 끝이 아니다', () =>
    expect(parseLine(blockStart({ type: 'redacted_thinking', data: 'xyz' }))).toEqual({ kind: 'thinking', active: true, tokens: null }));

  test('다른 블록 시작(text·tool_use) → 생각 끝', () => {
    expect(parseLine(blockStart({ type: 'text', text: '' }))).toEqual({ kind: 'thinking', active: false, tokens: null });
    expect(parseLine(blockStart({ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }))).toEqual({ kind: 'thinking', active: false, tokens: null });
  });

  test('system/thinking_tokens → 누적 추정 토큰 수 · 수가 아니거나 없으면 ignored(블록 시작과 헷갈리지 않게 — 생각은 블록 시작만 연다)', () => {
    expect(parseLine(tokens(278))).toEqual({ kind: 'thinking', active: true, tokens: 278 });
    expect(parseLine(tokens(null))).toEqual({ kind: 'ignored', type: 'system/thinking_tokens' });
    expect(parseLine('{"type":"system","subtype":"thinking_tokens"}')).toEqual({ kind: 'ignored', type: 'system/thinking_tokens' });
  });

  test('thinking_delta(내용 빈칸 · 토큰 수 null 섞임)·signature_delta → ignored', () => {
    for (const delta of [
      { type: 'thinking_delta', thinking: '', estimated_tokens: 250 },
      { type: 'thinking_delta', thinking: '', estimated_tokens: null },
      { type: 'signature_delta', signature: 'sig' },
    ]) {
      expect(parseLine(ev({ type: 'content_block_delta', index: 0, delta }))).toEqual({ kind: 'ignored', type: 'stream_event' });
    }
    expect(parseLine(ev({ type: 'content_block_stop', index: 0 }))).toEqual({ kind: 'ignored', type: 'stream_event' });
  });

  test('서브에이전트 줄(parent_tool_use_id)의 생각 신호 → ignored', () => {
    const parent = { parent_tool_use_id: 'toolu_A' };
    expect(parseLine(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, parent))).toEqual({
      kind: 'ignored', type: 'stream_event',
    });
    expect(parseLine(ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, parent))).toEqual({
      kind: 'ignored', type: 'stream_event',
    });
    expect(parseLine(tokens(278, parent))).toEqual({ kind: 'ignored', type: 'system/thinking_tokens' });
  });
});

describe('parseLine — API 상태(system/status)', () => {
  // 진짜 줄 모양(2.1.304 — 없는 모델로 잰 새 세션): {"type":"system","subtype":"status","status":"requesting","session_id":…,"uuid":…}
  const status = (st: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'system', subtype: 'status', status: st, session_id: 'S', uuid: 'u3', ...extra });

  test('requesting·compacting·null → api-status', () => {
    expect(parseLine(status('requesting'))).toEqual({ kind: 'api-status', status: 'requesting' });
    expect(parseLine(status('compacting'))).toEqual({ kind: 'api-status', status: 'compacting' });
    expect(parseLine(status(null))).toEqual({ kind: 'api-status', status: null });
  });

  test('status 줄의 permissionMode 를 싣는다 — 모르는 status 여도 모드는 남긴다', () => {
    expect(parseLine(status(null, { permissionMode: 'plan' }))).toEqual({ kind: 'api-status', status: null, permissionMode: 'plan' });
    expect(parseLine(status('weird', { permissionMode: 'default' }))).toEqual({ kind: 'api-status', status: null, permissionMode: 'default' });
    expect(parseLine(status('requesting'))).toEqual({ kind: 'api-status', status: 'requesting' });
  });

  test('모르는 값·없는 값 → ignored(다음 CLI 가 상태를 늘려도 엉뚱한 단계를 보이지 않게)', () => {
    expect(parseLine(status('uploading'))).toEqual({ kind: 'ignored', type: 'system/status' });
    expect(parseLine('{"type":"system","subtype":"status"}')).toEqual({ kind: 'ignored', type: 'system/status' });
  });

  test('서브에이전트 줄(parent_tool_use_id)의 상태 → ignored', () =>
    expect(parseLine(status('requesting', { parent_tool_use_id: 'toolu_A' }))).toEqual({ kind: 'ignored', type: 'system/status' }));
});

describe('parseLine — 수정의 바뀐 줄(tool_use_result.structuredPatch)', () => {
  // Claude Code 가 Edit 결과에 싣는 모양 — originalFile 같은 큰 칸은 읽지 않는다
  const editResult = (toolUseResult: unknown) =>
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_E', content: 'The file a.ts has been updated successfully.' }] },
      tool_use_result: toolUseResult,
    });
  const hunk = { oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [' a', '-b', '+B', '+C', ' d'] };

  test('structuredPatch → patch: 묶음마다 oldStart·newStart·lines(그대로)만', () => {
    const second = { oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: ['-x', '+y', '\\ No newline at end of file'] };
    expect(
      parseLine(editResult({ filePath: 'a.ts', oldString: 'b', newString: 'B\nC', originalFile: 'a\nb\nd\n'.repeat(100), structuredPatch: [hunk, second], userModified: false, replaceAll: false })),
    ).toEqual({
      kind: 'tool-result',
      toolUseId: 'toolu_E',
      isError: false,
      text: 'The file a.ts has been updated successfully.',
      patch: [
        { oldStart: 3, newStart: 3, lines: [' a', '-b', '+B', '+C', ' d'] },
        { oldStart: 20, newStart: 21, lines: ['-x', '+y', '\\ No newline at end of file'] },
      ],
    });
  });

  test('서브에이전트 줄이어도 — parent 와 patch 둘 다', () => {
    const line = JSON.parse(editResult({ structuredPatch: [hunk] }));
    expect(parseLine(JSON.stringify({ ...line, parent_tool_use_id: 'toolu_A' }))).toMatchObject({
      kind: 'tool-result', parent: 'toolu_A', patch: [{ oldStart: 3, newStart: 3, lines: hunk.lines }],
    });
  });

  test('모양이 이상하면 patch 칸이 없다 — 결과 글은 그대로', () => {
    const odd: unknown[] = [
      undefined,
      'Error: String to replace not found in file.',
      { filePath: 'a.ts' },
      { structuredPatch: 'x' },
      { structuredPatch: [] },
      { structuredPatch: [null] },
      { structuredPatch: [{ ...hunk, lines: 'x' }] },
      { structuredPatch: [{ ...hunk, lines: [' a', 5] }] },
      { structuredPatch: [{ ...hunk, oldStart: '3' }] },
      { structuredPatch: [hunk, { newStart: 9, lines: ['+z'] }] },
    ];
    for (const r of odd) {
      const ev = parseLine(editResult(r));
      expect(ev).toEqual({ kind: 'tool-result', toolUseId: 'toolu_E', isError: false, text: 'The file a.ts has been updated successfully.' });
    }
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

  test('encodeUser: U+2028·U+2029 는 이스케이프해 한 줄로 — 받는 쪽이 줄 끝으로 읽어 쪼개지 않게', () => {
    const text = '앞\u2028가운데\u2029뒤';
    const s = encodeUser([{ type: 'text', text }]);
    expect(s.slice(0, -1)).not.toMatch(/[\u2028\u2029]/);
    expect(s).toContain('\\u2028');
    expect(s).toContain('\\u2029');
    expect(JSON.parse(s).message.content[0].text).toBe(text);
  });

  test('encodeControl: U+2028·U+2029 도 이스케이프', () => {
    const s = encodeControl('r1', { subtype: 'set_model', model: 'a\u2028b' });
    expect(s.slice(0, -1)).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(s).request.model).toBe('a\u2028b');
  });

  test('encodeControl', () => {
    const s = encodeControl('r9', { subtype: 'set_model', model: 'sonnet' });
    expect(s.endsWith('\n')).toBe(true);
    expect(JSON.parse(s)).toEqual({ type: 'control_request', request_id: 'r9', request: { subtype: 'set_model', model: 'sonnet' } });
  });
});
