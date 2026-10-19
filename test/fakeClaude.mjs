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

// FAKE_DIE_FLAG_FILE 의 내용이 이 프로세스의 -n 이름이면 stdin 을 읽기 전에 바로 죽는다(파일을 지우면 다시 산다)
const dieFile = process.env.FAKE_DIE_FLAG_FILE;
if (dieFile && fs.existsSync(dieFile) && fs.readFileSync(dieFile, 'utf8') === flag('-n')) process.exit(1);

const sessionId = flag('--resume') ?? flag('--session-id') ?? 'fake-session';
let model = flag('--model') ?? 'default';
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
  const m = /^data: (.*)$/m.exec(body);
  if (m) body = m[1];
  return { sid: res.headers.get('mcp-session-id') ?? sid, json: body.trim() ? JSON.parse(body) : null };
}
async function callTool(name, args) {
  const a = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } }, 1);
  const r = await rpc('tools/call', { name, arguments: args }, 2, a.sid);
  return r.json?.result?.content?.[0]?.text ?? '';
}

let current = null; // 진행 중인 차례 { ended }
let sequence = 0;

async function turn(text) {
  const tok = { ended: false };
  current = tok;
  const finish = async (t, extra) => {
    if (tok.ended) return;
    tok.ended = true;
    current = null;
    await result(t, extra);
  };
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


async function control(msg) {
  if (process.env.FAKE_NO_CONTROL_REPLY === '1') return;
  const rid = msg.request_id;
  const sub = msg.request?.subtype;
  const ok = (response = {}) => emit({ type: 'control_response', response: { subtype: 'success', request_id: rid, response } });
  if (sub === 'initialize') {
    await ok({
      commands: [{ name: 'compact', description: '대화 요약', argumentHint: '' }],
      models: [
        { value: 'default', displayName: 'Default' },
        { value: 'sonnet', displayName: 'Sonnet', description: '빠름', resolvedModel: 'fake-sonnet' },
      ],
      current_permission_mode: permissionMode,
      account: { email: 'fake-user@example.com', subscriptionType: 'max' }, // 진짜처럼 — 엔진은 버려야 한다
    });
  } else if (sub === 'set_model') {
    model = msg.request.model;
    await ok();
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
  else if (msg.type === 'user') {
    const content = msg.message?.content ?? [];
    const text = (Array.isArray(content) ? content : [{ type: 'text', text: String(content) }])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    void turn(text);
  }
});
rl.on('close', () => process.exit(0));
