// 테스트용 가짜 claude — 진짜와 같은 argv 를 받고 stream-json 으로 말한다. 동작 표는 plan Task 6.
//
// 사용자 줄(글) 하나에 차례 하나(init … result). 글에 따라:
//   SLOW                init 뒤 interrupt 가 올 때까지 기다린다
//   CRASH               init 뒤 stderr 에 'fake crash' 를 쓰고 죽는다(exit 3)
//   SEND <이름>: <글>   mcp__dure__send_message 를 부르고 받은 글로 끝낸다
//   ASK <도구>          MCP approve 로 묻고 답대로 tool_result
//   /effort · /compact  로컬 명령(아래)
//   SUB <설명>          서브에이전트를 뒤에서 띄운다(probe13) — Agent tool_use(id toolu_<n>) → task_started(task_<n>, is_backgrounded:true,
//                       task_type:'local_agent', spawn_depth:1) → 부모 tool_result "Async agent launched successfully. …" → 글 "LAUNCHED" → result.
//                       그 뒤 차례 밖에서 서브에이전트 줄(Read tool_use · tool_result · 글 "보고: <설명>" — 모두 parent_tool_use_id) →
//                       task_updated · task_notification(completed, summary "보고: <설명>", usage) → 스스로 시작한 차례
//                       (init → 글 "전달: 보고: <설명>" → result — 진행 중인 차례가 있으면 그 뒤에, probe14 B)
//   SUBFG <설명>        같은 서브에이전트를 차례 안에서(is_backgrounded:false, probe14 A) — 끝 알림 뒤 부모 tool_result
//                       "[Subagent hand-back] …" → 글 "정리: 보고: <설명>" → result. 스스로 시작한 차례는 없다
//   SUBASK <도구>       SUB 와 같되(설명 = <도구>) 서브에이전트가 Read 대신 <도구> tool_use(parent 붙음)를 내고 MCP approve(그 id)로 묻는다 →
//                       답대로 tool_result(허용 "ok" · 거절은 is_error) → 보고 · 끝 알림 · 스스로 시작한 차례
//   SUBSEND <이름>: <글> SUB 와 같되(설명 = "<이름>: <글>") 서브에이전트가 mcp__dure__send_message tool_use(parent 붙음) 뒤 MCP send_message 를
//                       부르고 받은 글을 tool_result 로(MCP 결과가 오류면 is_error) → 보고 · 끝 알림 · 스스로 시작한 차례
//   SUBNEST <도구>      SUB 와 같되(설명 = <도구>) 서브에이전트가 Agent tool_use(parent 붙음)로 안쪽 서브에이전트를 띄운다 — 안쪽 task_started
//                       (parent_task_id = 바깥 task, spawn_depth:2). 안쪽은 스트림에 줄을 내지 않고(probe14 A) 새 id 로 MCP approve 를 부른다 →
//                       안쪽 끝 알림 → 바깥 보고 · 끝 알림 · 스스로 시작한 차례
//   BGTASK <명령>       서브에이전트가 아닌 일(백그라운드 명령) — Bash tool_use(run_in_background) → task_started(task_<n>,
//                       task_type:'local_bash' — 파서가 버린다) → tool_result → task_notification(completed — 같은 모양, 엔진엔 모르는 끝으로 온다)
//                       → 글 "BG DONE" → result. 끝 알림까지 차례 안에서(시험이 result 로 기다릴 수 있게)
//   EDIT <파일> [<n>]   Edit tool_use(file_path·old_string·new_string) → tool_result "The file <파일> has been updated successfully."
//                       + 최상위 tool_use_result {filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll}
//                       (진짜 Claude Code 의 Edit 결과 모양) → 글 "EDITED" → result. 묶음은 앞뒤 줄 · '-' 한 줄 · '+' 두 줄,
//                       n 을 주면 '+' 줄 n 개 한 묶음. FAKE_EDIT_TOOL=<도구> 면 그 이름의 tool_use 로(기본 Edit)
//   EDITBARE [MULTI|FAIL] structuredPatch 없이(tool_use_result 가 없는 서브에이전트 줄처럼) — Edit tool_use(MULTI 면 MultiEdit, 두 군데)
//                       → tool_result 만 → 글 "EDITED" → result. FAIL 이면 결과가 is_error "String to replace not found in file."
//   그 밖               글 "받음: <글>"
// MCP tools/call 은 진짜(probe14 A)처럼 params._meta = { 'claudecode/toolUseId': <그 부르기의 tool_use id> } 를 싣는다.
// 서브에이전트 손잡이:
//   FAKE_SUB_GATE=<파일>   서브에이전트가 그 파일이 생길 때까지 일을 시작하지 않는다(20ms 간격)
//   FAKE_SUB_MS=<ms>       FAKE_SUB_GATE 가 없으면 그만큼 뒤에 시작한다(기본 150)
//   FAKE_MUTE_FILE=<파일>  그 파일이 있는 동안 사용자 줄을 읽지 않고(받은 줄을 기록만 한다) 스스로 시작한 차례도 미룬다
//   FAKE_SELF_TURN_MS=<ms> 끝 알림 뒤 스스로 시작한 차례를 그만큼 늦게 연다(그사이 온 사용자 줄의 차례가 먼저)
//   FAKE_PRE_INIT_SYSTEM=1 사용자 줄의 init 앞에 서브에이전트·백그라운드 system 줄(background_tasks_changed · task_progress — 부모 줄이 아니다)
//   interrupt(제어 요청)   도는 서브에이전트마다 task_updated {status:'killed'} · task_notification {status:'stopped'} 를 내고
//                          스스로 시작한 차례는 내지 않는다(probe14 C). 진행 중인 차례는 오류 result 로 끝낸다
//   FAKE_INTERRUPT_SPARES_TASKS=1  interrupt 가 진행 중인 차례만 끝내고 서브에이전트는 그대로 둔다 — 앞에서 돌던 서브에이전트의
//                          끝 알림이 그 차례의 result 뒤(쉬는 중)에 온다(부모 tool_result·스스로 시작한 차례 없이)
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
// 내 Claude 설정의 기본 모드(get_settings 의 effective.permissions.defaultMode) — 세션은 이 모드로 시작한다.
// 진짜(probe12)처럼 세션 모드를 바꿔도 get_settings 의 이 값은 그대로다
const defaultMode = process.env.FAKE_PERMISSION_MODE || 'default';
// FAKE_START_MODE=<모드> — 내 설정과 다른 모드로 시작한다(엔진 모르게 늦게 적용된 켜기 흉내)
let permissionMode = process.env.FAKE_START_MODE || defaultMode; // set_permission_mode 가 바꾸고, 다음 init 이 알린다
// 진짜(probe10)처럼 이 옵션으로 띄워야 실행 중에 bypassPermissions 로 바꿀 수 있다
const allowBypass = argv.includes('--allow-dangerously-skip-permissions');
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
const assistant = (content, extra = {}) => emit({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
const toolResult = (id, text, isError = false, extra = {}) =>
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] }, ...extra });
const system = (subtype, fields) => emit({ type: 'system', subtype, session_id: sessionId, ...fields });

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
/** 두레 MCP 도구를 부른다 — toolUseId = 그 부르기의 tool_use id(_meta 에 싣는다). 답은 결과 글과 오류 표시 */
async function callTool(name, args, toolUseId) {
  const a = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } }, 1);
  const r = await rpc('tools/call', { name, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } }, 2, a.sid);
  const res = r.json?.result;
  return { text: res?.content?.[0]?.text ?? '', isError: res?.isError === true };
}
/** approve 의 답 — 못 읽으면 거절로({}) */
function verdictOf(text) {
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {};
  }
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
let effortNow = process.env.FAKE_EFFORT ?? 'high';
let turnsDone = 0; // context = 12000 x 끝난 차례 수 (/compact 하면 0 으로)
let current = null; // 진행 중인 차례 { ended }
let sequence = 0;

// ── 서브에이전트(위 SUB·SUBFG·SUBASK·SUBSEND·SUBNEST) ──
const tasks = new Set(); // 도는 서브에이전트 { taskId, toolUseId, description, background, killed, startedAt, tools } — 안쪽 서브에이전트도
const subGate = process.env.FAKE_SUB_GATE;
const subMs = Number(process.env.FAKE_SUB_MS ?? 150);
const muteFile = process.env.FAKE_MUTE_FILE;
const muted = () => !!muteFile && fs.existsSync(muteFile);
const usageOf = (task) => ({ total_tokens: 1000 + 100 * task.tools, tool_uses: task.tools, duration_ms: Date.now() - task.startedAt });
const backgroundTasks = () => [...tasks].filter((t) => t.background).map((t) => ({ task_id: t.taskId, description: t.description }));
// 서브에이전트 줄 — parent_tool_use_id = 부모의 Agent tool_use id
const taskAssistant = (task, content) => assistant(content, { parent_tool_use_id: task.toolUseId });
const taskToolResult = (task, id, text, isError = false) => toolResult(id, text, isError, { parent_tool_use_id: task.toolUseId });
/** 서브에이전트가 도구를 하나 썼다 — task_progress(진짜는 도구마다, 엔진은 버린다) */
async function taskProgress(task, description, toolName) {
  task.tools++;
  await system('task_progress', {
    task_id: task.taskId, tool_use_id: task.toolUseId, description, usage: usageOf(task), last_tool_name: toolName,
  });
}
/** 서브에이전트의 두레 MCP 부르기 — MCP 서버가 없거나 부르기가 실패하면 오류 결과로 */
async function taskCall(name, args, toolUseId) {
  if (!mcp) return { text: 'dure MCP 서버가 설정에 없습니다', isError: true };
  try {
    return await callTool(name, args, toolUseId);
  } catch (e) {
    return { text: `MCP 호출 실패: ${e.message}`, isError: true };
  }
}

// 서브에이전트의 일(runTask 의 work) — 끝까지 했으면 true, 그새 멈췄으면 false
/** SUB·SUBFG — Read 한 번 */
async function readNote(task) {
  const id = `toolu_${++sequence}`;
  await taskAssistant(task, [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'note.txt' } }]);
  await taskProgress(task, 'Reading note.txt', 'Read');
  if (task.killed) return false;
  await taskToolResult(task, id, 'note.txt 내용');
  return true;
}
/** SUBASK — <도구> 를 MCP approve 로 묻고 답대로 */
const askTool = (tool) => async (task) => {
  const id = `toolu_${++sequence}`;
  const input = { x: 1 };
  await taskAssistant(task, [{ type: 'tool_use', id, name: tool, input }]);
  await taskProgress(task, `Using ${tool}`, tool);
  const reply = await taskCall('approve', { tool_name: tool, input, tool_use_id: id }, id);
  if (task.killed) return false;
  const verdict = reply.isError ? {} : verdictOf(reply.text);
  if (verdict.behavior === 'allow') await taskToolResult(task, id, 'ok');
  else await taskToolResult(task, id, verdict.message ?? (reply.text || 'denied'), true);
  return true;
};
/** SUBSEND — 두레 도구 send_message 를 부르고 받은 글을 그대로(MCP 결과가 오류면 is_error) */
const sendTool = (arg) => async (task) => {
  const [, to, text] = /^([^:]+): ([\s\S]*)$/.exec(arg) ?? [arg, arg, ''];
  const id = `toolu_${++sequence}`;
  await taskAssistant(task, [{ type: 'tool_use', id, name: 'mcp__dure__send_message', input: { to, text } }]);
  await taskProgress(task, `Sending to ${to}`, 'mcp__dure__send_message');
  const reply = await taskCall('send_message', { to, text }, id);
  if (task.killed) return false;
  await taskToolResult(task, id, reply.text, reply.isError);
  return true;
};
/** SUBNEST — Agent 로 안쪽 서브에이전트를 띄운다(probe14 A): 안쪽은 시작·끝 알림만 내고, 스트림에 없는 새 id 로 approve 를 부른다 */
const nestTask = (tool) => async (task) => {
  const n = ++sequence;
  const description = `${tool} 맡김`;
  const prompt = `${description} 해 줘`;
  const inner = { taskId: `task_${n}`, toolUseId: `toolu_${n}`, description, background: false, killed: false, startedAt: Date.now(), tools: 0 };
  await taskAssistant(task, [{ type: 'tool_use', id: inner.toolUseId, name: 'Agent', input: { description, subagent_type: 'general-purpose', prompt } }]);
  await taskProgress(task, `Delegating ${tool}`, 'Agent');
  tasks.add(inner);
  await system('task_started', {
    task_id: inner.taskId, tool_use_id: inner.toolUseId, description, subagent_type: 'general-purpose',
    is_backgrounded: false, spawn_depth: 2, parent_task_id: task.taskId, task_type: 'local_agent', prompt,
  });
  const askId = `toolu_${++sequence}`; // 안쪽의 하는 일 — 스트림에 내지 않는다
  inner.tools++;
  await taskCall('approve', { tool_name: tool, input: { x: 1 }, tool_use_id: askId }, askId);
  if (inner.killed || task.killed) return false;
  tasks.delete(inner);
  await system('task_updated', { task_id: inner.taskId, patch: { status: 'completed', end_time: Date.now() } });
  await system('task_notification', {
    task_id: inner.taskId, tool_use_id: inner.toolUseId, status: 'completed', summary: `보고: ${description}`,
    output_file: `${inner.taskId}.output`, usage: usageOf(inner),
  });
  return true;
};

/** 부모가 Agent 로 서브에이전트를 띄운다 — Agent tool_use · task_started(probe13) */
async function launchTask(description, background) {
  const n = ++sequence;
  const task = { taskId: `task_${n}`, toolUseId: `toolu_${n}`, description, background, killed: false, startedAt: Date.now(), tools: 0 };
  const prompt = `${description} 해 줘`;
  await assistant([{ type: 'tool_use', id: task.toolUseId, name: 'Agent', input: { description, subagent_type: 'general-purpose', prompt } }]);
  tasks.add(task);
  await system('task_started', {
    task_id: task.taskId, tool_use_id: task.toolUseId, description, subagent_type: 'general-purpose',
    is_backgrounded: background, spawn_depth: 1, task_type: 'local_agent', prompt,
  });
  if (background) await system('background_tasks_changed', { tasks: backgroundTasks() });
  return task;
}

/** 일을 시작해도 되면 true — 그새 멈췄으면 false */
async function taskWait(task) {
  if (subGate) {
    while (!fs.existsSync(subGate)) {
      if (task.killed) return false;
      await sleep(20);
    }
  } else await sleep(subMs);
  return !task.killed;
}

/** 서브에이전트의 일 — work(기본 Read 한 번) · 보고 · 끝 알림. 끝까지 가면 보고, 멈췄으면 null */
async function runTask(task, work = readNote) {
  if (!(await taskWait(task))) return null;
  if (!(await work(task))) return null;
  const report = `보고: ${task.description}`;
  await taskAssistant(task, [{ type: 'text', text: report }]);
  if (task.killed) return null;
  tasks.delete(task);
  await system('task_updated', { task_id: task.taskId, patch: { status: 'completed', end_time: Date.now() } });
  await system('task_notification', {
    task_id: task.taskId, tool_use_id: task.toolUseId, status: 'completed', summary: report,
    output_file: `${task.taskId}.output`, usage: usageOf(task),
  });
  if (task.background) await system('background_tasks_changed', { tasks: backgroundTasks() });
  return report;
}

/** interrupt — 도는 서브에이전트를 모두 멈춘다(probe14 C). 스스로 시작한 차례는 오지 않는다 */
async function killTasks() {
  if (tasks.size === 0) return;
  for (const task of [...tasks]) {
    task.killed = true;
    tasks.delete(task);
    await system('task_updated', { task_id: task.taskId, patch: { status: 'killed', end_time: Date.now() } });
    await system('task_notification', {
      task_id: task.taskId, tool_use_id: task.toolUseId, status: 'stopped', output_file: `${task.taskId}.output`, usage: usageOf(task),
    });
  }
  await system('background_tasks_changed', { tasks: [] });
}

/** 뒤에서 돈 서브에이전트가 끝난 뒤 Claude 가 입력 없이 여는 차례(probe13) — 진행 중인 차례가 있거나 막혀 있으면(FAKE_MUTE_FILE) 그 뒤에 */
async function selfTurn(report) {
  const late = Number(process.env.FAKE_SELF_TURN_MS ?? 0);
  if (late) await sleep(late);
  while (current || muted()) await sleep(20);
  const tok = { ended: false };
  current = tok;
  await init();
  const said = `전달: ${report}`;
  await assistant([{ type: 'text', text: said }]);
  if (tok.ended) return;
  tok.ended = true;
  current = null;
  turnsDone++;
  await result(said);
}

// 로컬 명령 /effort — 진짜(2.1.304, probe9)처럼 init · 안내 글 · result(비용 0). 모델을 부르지 않으니 끝난 차례로 세지 않고(context 그대로),
// get_settings 의 값도 바꾸지 않는다(세션 effort 는 설정 층에 안 보인다). 손잡이:
//   FAKE_EFFORT_REPLY=<글>       그 글로 답한다          FAKE_SLOW_EFFORT_MS=<ms>   그만큼 늦게 답한다
//   FAKE_EFFORT_SILENT=1         읽기만 하고 끝내 답하지 않는다(막힌 /effort)
//   FAKE_EFFORT_LOCAL_OUTPUT=1   글을 어시스턴트 대신 <local-command-stdout> 사용자 줄로(result 글은 빈칸)
//   FAKE_EFFORT_RATE_LIMIT=1     답 앞에 rate_limit_event 한 줄
async function effortCommand(arg) {
  log(JSON.stringify({ local: 'effort', arg, pid: process.pid }));
  if (process.env.FAKE_EFFORT_SILENT === '1') return;
  await init();
  const slowEffort = Number(process.env.FAKE_SLOW_EFFORT_MS ?? 0);
  if (slowEffort) await sleep(slowEffort);
  if (process.env.FAKE_EFFORT_RATE_LIMIT === '1') await emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  const said =
    process.env.FAKE_EFFORT_REPLY ??
    (EFFORTS.includes(arg)
      ? `Set effort level to ${arg} (this session only): 가짜 설명`
      : arg
        ? `Invalid argument: ${arg}. Valid options are: low, medium, high, xhigh, max, auto, ultracode [on|off]`
        : 'Usage: /effort <low|medium|high|xhigh|max|auto|ultracode [on|off]>');
  if (process.env.FAKE_EFFORT_LOCAL_OUTPUT === '1') {
    await emit({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${said}</local-command-stdout>` } });
    await result('', { total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    return;
  }
  await assistant([{ type: 'text', text: said }]);
  await result(said, { total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
}

async function turn(text) {
  const effort = /^\/effort(?:\s+(\S+))?$/.exec(text.trim());
  if (effort) return effortCommand(effort[1] ?? '');
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
  if (process.env.FAKE_PRE_INIT_SYSTEM === '1') {
    await system('background_tasks_changed', { tasks: backgroundTasks() });
    await system('task_progress', {
      task_id: 'task_bg', tool_use_id: 'toolu_bg', description: 'Working', usage: { total_tokens: 1, tool_uses: 0, duration_ms: 0 }, last_tool_name: 'Read',
    });
  }
  await init();
  if (text.startsWith('SLOW')) return; // interrupt 가 올 때까지 대기
  if (text.startsWith('CRASH')) {
    process.stderr.write('fake crash\n');
    process.exit(3);
  }
  const subCmd = /^SUB(FG|ASK|SEND|NEST)? ([\s\S]+)$/.exec(text);
  if (subCmd) {
    const [, kind, arg] = subCmd;
    const background = kind !== 'FG';
    const work = kind === 'ASK' ? askTool(arg) : kind === 'SEND' ? sendTool(arg) : kind === 'NEST' ? nestTask(arg) : readNote;
    const task = await launchTask(arg, background);
    if (background) {
      // 진짜(probe13)의 내부 안내 — 화면에 보이면 안 되는 글
      await toolResult(
        task.toolUseId,
        `Async agent launched successfully. (This tool result is internal metadata — never quote, paraphrase, or reference it to the user.) agentId: ${task.taskId} The agent is working in the background. You will be notified automatically when it completes.`,
        false,
        { tool_use_result: { isAsync: true, status: 'async_launched', agentId: task.taskId } },
      );
      await assistant([{ type: 'text', text: 'LAUNCHED' }]);
      await finish('LAUNCHED');
      void runTask(task, work).then((report) => report && selfTurn(report));
      return;
    }
    const report = await runTask(task, work);
    if (!report || tok.ended) return; // 멈춤 — interrupt 가 이 차례를 끝냈다
    await toolResult(task.toolUseId, `[Subagent hand-back] The text below is the final report of a subagent you launched.\n\n${report}`);
    const said = `정리: ${report}`;
    await assistant([{ type: 'text', text: said }]);
    await finish(said);
    return;
  }
  const bg = /^BGTASK ([\s\S]+)$/.exec(text);
  if (bg) {
    const n = ++sequence;
    const toolUseId = `toolu_${n}`;
    const taskId = `task_${n}`;
    const command = bg[1];
    await assistant([{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command, run_in_background: true } }]);
    await system('task_started', { task_id: taskId, tool_use_id: toolUseId, description: command, task_type: 'local_bash' });
    await toolResult(toolUseId, `Command running in background with ID: ${taskId}`);
    await system('task_notification', {
      task_id: taskId, tool_use_id: toolUseId, status: 'completed', summary: `Background command "${command}" completed (exit code 0)`,
      output_file: `${taskId}.output`,
    });
    await assistant([{ type: 'text', text: 'BG DONE' }]);
    await finish('BG DONE');
    return;
  }
  const edit = /^EDIT (\S+)(?: (\d+))?$/.exec(text);
  if (edit) {
    const [, file, count] = edit;
    const id = `toolu_${++sequence}`;
    const oldString = 'const b = 2';
    const newString = 'const b = 3\nconst c = 4';
    await assistant([{ type: 'tool_use', id, name: process.env.FAKE_EDIT_TOOL || 'Edit', input: { file_path: file, old_string: oldString, new_string: newString } }]);
    const n = count === undefined ? null : Number(count);
    const hunk =
      n === null
        ? { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [' const a = 1', '-const b = 2', '+const b = 3', '+const c = 4', ' const d = 5'] }
        : { oldStart: 1, oldLines: 0, newStart: 1, newLines: n, lines: Array.from({ length: n }, (_, i) => `+줄 ${i + 1}`) };
    await toolResult(id, `The file ${file} has been updated successfully.`, false, {
      tool_use_result: {
        filePath: file, oldString, newString, originalFile: 'ORIGINAL FILE BODY\n'.repeat(50), structuredPatch: [hunk], userModified: false, replaceAll: false,
      },
    });
    await assistant([{ type: 'text', text: 'EDITED' }]);
    await finish('EDITED');
    return;
  }
  const bare = /^EDITBARE(?: (MULTI|FAIL))?$/.exec(text);
  if (bare) {
    const id = `toolu_${++sequence}`;
    const multi = bare[1] === 'MULTI';
    const input = multi
      ? { file_path: 'bare.txt', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b\nc', new_string: 'B' }] }
      : { file_path: 'bare.txt', old_string: 'old 1\nold 2', new_string: 'new 1\nnew 2\nnew 3' };
    await assistant([{ type: 'tool_use', id, name: multi ? 'MultiEdit' : 'Edit', input }]);
    if (bare[1] === 'FAIL') await toolResult(id, 'String to replace not found in file.', true);
    else await toolResult(id, 'The file bare.txt has been updated successfully.');
    await assistant([{ type: 'text', text: 'EDITED' }]);
    await finish('EDITED');
    return;
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
        ? (await callTool('send_message', args, id)).text
        : (await callTool('approve', { tool_name: ask[1], input: { x: 1 }, tool_use_id: id }, id)).text;
    } catch (e) {
      return fail(`MCP 호출 실패: ${e.message}`);
    }
    if (tok.ended) return; // 중단된 차례의 늦은 응답
    if (send) {
      await toolResult(id, reply);
      await finish(reply);
      return;
    }
    const verdict = verdictOf(reply);
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

// set_permission_mode 손잡이 — '1' 이면 모든 요청, 모드 이름이면 그 모드만, '<모드>:once' 면 그 모드의 첫 요청만
const onceUsed = new Set();
function knobHits(name, mode) {
  const v = process.env[name];
  if (!v) return false;
  if (v === '1') return true;
  const [m, once] = v.split(':');
  if (m !== mode) return false;
  if (once !== 'once') return true;
  if (onceUsed.has(name)) return false;
  onceUsed.add(name);
  return true;
}
let lateUsed = false;
let modeBusy = null; // 아직 끝나지 않은 늦은 set_permission_mode — 뒤의 요청은 그 뒤에
function queueMode(p) {
  modeBusy = p;
  void p.then(() => {
    if (modeBusy === p) modeBusy = null;
  });
}

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
  } else if (sub === 'set_permission_mode') {
    // 진짜(probe10)처럼: 옵션 없이 띄웠으면 bypass 는 거절 · manual 은 default 로 · 응답은 실제 모드 {mode} · 다음 init 에 싣는다.
    // 손잡이(값 = '1' 이면 모든 요청, 모드 이름이면 그 모드만, '<모드>:once' 면 그 모드의 첫 요청만):
    //   FAKE_SET_MODE_FAIL      오류 응답(모드는 그대로)
    //   FAKE_SET_MODE_SILENT    끝내 답하지 않음(모드는 그대로)
    //   FAKE_SET_MODE_LATE_MS=<ms>  첫 bypassPermissions 요청을 그만큼 늦게 적용하고 답한다(엔진의 한도를 넘겨 늦게 적용되는 켜기).
    //                               그 뒤의 set_permission_mode 는 진짜처럼 차례대로 — 늦은 요청이 끝난 뒤에 처리된다
    // 늦은 요청이 없으면 모드는 기다리지 않고(await 전에) 바꾼다 — 바로 뒤에 온 사용자 줄의 init 이 새 모드를 알리게
    const mode = msg.request.mode;
    if (knobHits('FAKE_SET_MODE_SILENT', mode)) return;
    const fail = (error, extra = {}) =>
      emit({ type: 'control_response', response: { subtype: 'error', request_id: rid, error, ...extra } });
    if (knobHits('FAKE_SET_MODE_FAIL', mode)) return fail('set_permission_mode failed');
    const apply = () => {
      if (mode === 'bypassPermissions' && !allowBypass) {
        return fail(
          'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
          { error_code: 'bypass_not_launched' },
        );
      }
      permissionMode = mode === 'manual' ? 'default' : mode;
      return ok({ mode: permissionMode });
    };
    const late = Number(process.env.FAKE_SET_MODE_LATE_MS ?? 0);
    if (late && mode === 'bypassPermissions' && !lateUsed) {
      lateUsed = true;
      queueMode(sleep(late).then(apply));
      return;
    }
    if (modeBusy) queueMode(modeBusy.then(apply));
    else await apply();
  } else if (sub === 'get_settings') {
    if (slow) await sleep(slow);
    await ok({ effective: { effortLevel: effortNow, permissions: { defaultMode } }, sources: {}, applied: {} });
  } else if (sub === 'apply_flag_settings') {
    if (process.env.FAKE_APPLY_FAIL === '1') {
      await emit({ type: 'control_response', response: { subtype: 'error', request_id: rid, error: 'apply failed' } });
      return;
    }
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
    if (process.env.FAKE_INTERRUPT_SPARES_TASKS !== '1') await killTasks(); // 진짜(probe14 C)처럼 제어 응답보다 먼저
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
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log(line);
      return;
    }
    log(JSON.stringify({ ...msg, pid: process.pid })); // 어느 프로세스가 받은 줄인지(argv 줄의 pid 와 맞춘다)
    if (msg.type === 'control_request') void control(msg);
    else if (msg.type === 'user' && !mute && !muted()) {
      const content = msg.message?.content ?? [];
      const text = (Array.isArray(content) ? content : [{ type: 'text', text: String(content) }])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      void turn(text);
    }
  });
  // FAKE_IGNORE_STDIN_END=1 — stdin 이 닫혀도 안 꺼진다(엔진이 끝까지 기다리다 죽이는지 보려고)
  rl.on('close', () => {
    if (process.env.FAKE_IGNORE_STDIN_END === '1') setInterval(() => {}, 1 << 30);
    else process.exit(0);
  });
}
