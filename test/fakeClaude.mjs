// 테스트용 가짜 claude — 진짜와 같은 argv 를 받고 stream-json 으로 말한다. 동작 표는 plan Task 6.
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const logFile = process.env.FAKE_CLAUDE_LOG;
const log = (s) => {
  if (logFile) fs.appendFileSync(logFile, s + '\n');
};
log(JSON.stringify({ argv, pid: process.pid, mcpToolTimeout: process.env.MCP_TOOL_TIMEOUT ?? null }));

// FAKE_DIE_FLAG_FILE 로 이 프로세스(-n 이름)를 고장 낸다(파일을 지우면 다음 실행부터 정상):
//   "<이름>"       stdin 을 읽기 전에 바로 죽는다(exit 1)
//   "<이름>:hang"  아무것도 처리하지 않고 아무 말도 안 한다 — stdin 이 닫히면 끝
//   "<이름>:mute"  제어 요청에만 답하고 사용자 줄은 무시한다
const dieFile = process.env.FAKE_DIE_FLAG_FILE;
const knob = dieFile && fs.existsSync(dieFile) ? fs.readFileSync(dieFile, 'utf8') : '';
const myName = flag('-n');
if (knob === myName) process.exit(1);
const hang = knob === `${myName}:hang`;
const mute = knob === `${myName}:mute`;

const sessionId = flag('--resume') ?? flag('--session-id') ?? 'fake-session';
let model = flag('--model') ?? 'claude-opus-5-5'; // --model 이 없으면 기본 모델이 풀린 id 를 알린다
const permissionMode = process.env.FAKE_PERMISSION_MODE || 'default';
let mcp = null;
try {
  const cfg = JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8'));
  mcp = cfg?.mcpServers?.dure ?? null;
} catch {
  /* 설정 없음 */
}

const split = process.env.FAKE_SPLIT_WRITES === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function emit(obj) {
  const line = JSON.stringify(obj) + '\n';
  if (!split) {
    process.stdout.write(line);
    return;
  }
  const a = Math.floor(line.length / 3);
  const b = Math.floor((line.length * 2) / 3);
  for (const piece of [line.slice(0, a), line.slice(a, b), line.slice(b)]) {
    process.stdout.write(piece);
    await sleep(15);
  }
}

const init = () =>
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode, slash_commands: ['compact'], tools: ['Bash'] });
const result = (text, extra = {}) =>
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, permission_denials: [], ...extra });
const assistant = (content) => emit({ type: 'assistant', message: { role: 'assistant', content } });
const toolResult = (id, text, isError = false) =>
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } });

async function rpc(method, params, id, sid) {
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(mcp.headers ?? {}),
      ...(sid ? { 'mcp-session-id': sid } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }),
  });
  let body = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    // SSE: ': keepalive' 주석·'event:' 줄은 버리고 data 줄만 (두레는 답 하나를 data 한 줄로 보낸다)
    body = body
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice('data:'.length).trimStart())
      .join('\n');
  }
  return { sid: res.headers.get('mcp-session-id') ?? sid, json: body.trim() ? JSON.parse(body) : null };
}
async function callTool(name, args) {
  const a = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } }, 1);
  const r = await rpc('tools/call', { name, arguments: args }, 2, a.sid);
  return r.json?.result?.content?.[0]?.text ?? '';
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
let effortNow = process.env.FAKE_EFFORT ?? 'high';
let turnsDone = 0; // context = 12000 x 끝난 차례 수 (/compact 하면 0 으로)
let current = null; // 진행 중인 차례 { ended }
let sequence = 0;

async function turn(text) {
  const tok = { ended: false };
  current = tok;
  const finish = async (t, extra) => {
    if (tok.ended) return;
    tok.ended = true;
    current = null;
    turnsDone++;
    await result(t, extra);
  };
  if (text.trim() === '/compact') {
    turnsDone = 0;
    tok.ended = true;
    current = null;
    await emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } });
    await emit({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } });
    await result('');
    return;
  }
  await init();
  if (text.startsWith('SLOW')) return; // interrupt 가 올 때까지 대기
  if (text.startsWith('CRASH')) {
    process.stderr.write('fake crash\n');
    process.exit(3);
  }
  const send = /^SEND ([^:]+): ([\s\S]*)$/.exec(text);
  const ask = /^ASK (\S+)/.exec(text);
  if (send || ask) {
    const id = `toolu_${++sequence}`;
    const args = send ? { to: send[1], text: send[2] } : { x: 1 };
    await assistant([{ type: 'tool_use', id, name: send ? 'mcp__dure__send_message' : ask[1], input: args }]);
    const fail = async (msg) => {
      if (tok.ended) return;
      await toolResult(id, msg, true);
      await finish('error', { is_error: true, subtype: 'error_during_execution' });
    };
    if (!mcp) return fail('dure MCP 서버가 설정에 없습니다');
    let reply;
    try {
      reply = send
        ? await callTool('send_message', args)
        : await callTool('approve', { tool_name: ask[1], input: { x: 1 }, tool_use_id: id });
    } catch (e) {
      return fail(`MCP 호출 실패: ${e.message}`);
    }
    if (tok.ended) return; // 중단된 차례의 늦은 응답
    if (send) {
      await toolResult(id, reply);
      await finish(reply);
      return;
    }
    let verdict = {};
    try {
      verdict = JSON.parse(reply);
    } catch {
      /* deny 로 취급 */
    }
    if (verdict.behavior === 'allow') {
      await toolResult(id, 'ok');
      await finish('ok');
    } else {
      await toolResult(id, verdict.message ?? 'denied', true);
      await finish('denied', { permission_denials: [{ tool_name: ask[1], tool_use_id: id, tool_input: { x: 1 } }] });
    }
    return;
  }
  await emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '받음' } } });
  await assistant([{ type: 'text', text: `받음: ${text}` }]);
  await finish(`받음: ${text}`);
}


const usageNow = () => {
  const inFuture = (ms) => new Date(Date.now() + ms).toISOString();
  return {
    rate_limits_available: true,
    rate_limits: {
      limits: [
        { kind: 'session', percent: 12, resets_at: inFuture(2 * 3600e3) },
        { kind: 'weekly_all', percent: 34, resets_at: inFuture(6 * 86400e3) },
        { kind: 'weekly_scoped', percent: 81, resets_at: inFuture(6 * 86400e3), scope: { model: { display_name: 'Fable' } } },
      ],
    },
  };
};

async function control(msg) {
  const rid = msg.request_id;
  const sub = msg.request?.subtype;
  log(JSON.stringify({ control: sub, request: msg.request }));
  if (process.env.FAKE_NO_CONTROL_REPLY === '1') return;
  const ok = (response = {}) => emit({ type: 'control_response', response: { subtype: 'success', request_id: rid, response } });
  const slow = Number(process.env.FAKE_SLOW_CONTROL_MS ?? 0);
  if (sub === 'initialize') {
    const levels = process.env.FAKE_EXTRA_LEVEL ? [...EFFORTS, process.env.FAKE_EXTRA_LEVEL] : EFFORTS;
    await ok({
      commands: [{ name: 'compact', description: '대화 요약', argumentHint: '' }],
      models: [
        { value: 'default', displayName: 'Default', resolvedModel: 'claude-sonnet-5-5', supportsEffort: true, supportedEffortLevels: levels },
        { value: 'sonnet', displayName: 'Sonnet 5.5', description: '빠름', resolvedModel: 'claude-sonnet-5-5', supportsEffort: true, supportedEffortLevels: levels },
        { value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5' },
        { value: 'claude-opus-4-8', displayName: 'Opus 4.8', resolvedModel: 'claude-opus-4-8' },
      ],
      current_permission_mode: permissionMode,
      account: { email: 'fake-user@example.com', subscriptionType: 'max' }, // 진짜처럼 — 엔진은 버려야 한다
    });
  } else if (sub === 'set_model') {
    model = msg.request.model;
    await ok();
  } else if (sub === 'get_settings') {
    if (slow) await sleep(slow);
    await ok({ effective: { effortLevel: effortNow }, sources: {}, applied: {} });
  } else if (sub === 'apply_flag_settings') {
    const lv = msg.request.settings?.effortLevel;
    if (model !== 'haiku' && typeof lv === 'string') effortNow = lv;
    await ok();
  } else if (sub === 'get_usage') {
    if (process.env.FAKE_USAGE_HANG === '1') return;
    await ok(process.env.FAKE_USAGE ? JSON.parse(process.env.FAKE_USAGE) : usageNow());
  } else if (sub === 'get_context_usage') {
    if (slow) await sleep(slow);
    const total = 12000 * turnsDone;
    await ok({ totalTokens: total, maxTokens: 200000, percentage: (total / 200000) * 100, autoCompactThreshold: 167000, isAutoCompactEnabled: true });
  } else if (sub === 'interrupt') {
    await ok();
    if (current && !current.ended) {
      current.ended = true;
      current = null;
      await result('interrupted', { is_error: true, subtype: 'error_during_execution' });
    }
  } else {
    await emit({ type: 'control_response', response: { subtype: 'error', request_id: rid, error: `unknown ${sub}` } });
  }
}

if (hang) {
  process.stdin.resume(); // 받기만 하고 버린다
  process.stdin.on('end', () => process.exit(0));
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    log(line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'control_request') void control(msg);
    else if (msg.type === 'user' && !mute) {
      const content = msg.message?.content ?? [];
      const text = (Array.isArray(content) ? content : [{ type: 'text', text: String(content) }])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      void turn(text);
    }
  });
  rl.on('close', () => process.exit(0));
}
