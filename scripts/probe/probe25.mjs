// probe25 — 서버(SSH) 방 실측 둘째. probe24 의 MCP 흉내·launch 를 가져와 서버 명령을 정식 모양(stdin 머리말 두 줄 → exec claude)으로.
// D1 비대화형 ssh 로 띄운 `bash -lc '…; exec claude'` 가 이미 세션 리더인가(pid == sid) · `exec setsid claude` 면 pid 가 그대로인가
// D2 ssh 를 끈 뒤 따로 보낸 정리 명령(`pkill -TERM -s <pid>` → 2초 → `-KILL`)이 도는 Bash 명령(손자)·백그라운드 명령까지 끄는가
//    — 안 되면 같은 자리에서 대안(나무 따라 끄기 + 그 나무의 세션들)을 잰다. 남는 게 하나라도 있으면 BLOCKED.
// D3 stdin 머리말(base64 mcp.json · base64 prompt.md 두 줄)을 bash 가 읽은 뒤 claude 가 나머지 stdin 을 stream-json 으로 그대로 받는가
//    (한 턴·터널로 MCP·파일 600·토큰이 서버 ps 에 없음)
// D4 그림(base64 PNG image 블록)이 ssh 위에서 가는가 · D5 서브에이전트(Agent 도구)의 task_started / task_notification 줄이 오는가
// Haiku(사용자 동의 2026-11-02). WSL 은 쉬면 꺼지니 먼저 `wsl.exe -d Ubuntu -- sleep 3600` 으로 붙잡는다.
// 환경: DURE_PROBE_SSH_HOST(기본 localhost) · DURE_PROBE_SSH_KEY(기본 ~/.ssh/dure_wsl_test) · DURE_PROBE_KNOWN_HOSTS
//       DURE_PROBE_RAW(있으면 받은 stream-json 줄을 그 파일에 덧붙임) · DURE_PROBE_ONLY=d2(D2 만 다시)
//       DURE_PROBE_TRIALS="busy:tree,idle:marker"(D2 시도 = 상황:정리 방법 — 상황 busy·idle, 방법은 아래 CLEANUP 의 키)
// 결과(2026-11-02): claude = 세션 리더(setsid 불필요·쓰면 깨짐) · Bash 명령은 각자 새 세션이라 `pkill -s` 는 claude 의 TERM 처리에 기댄다
//   → 정리는 표식(DURE_RUN)·나무·그 세션들(marker) · stdin 머리말·그림·서브에이전트 줄 모두 됨
import { spawn, execFileSync, execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import os from 'node:os'
import { join } from 'node:path'

const SSH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
const HOST = process.env.DURE_PROBE_SSH_HOST ?? 'localhost'
const KEY = process.env.DURE_PROBE_SSH_KEY ?? join(os.homedir(), '.ssh', 'dure_wsl_test')
const KNOWN = process.env.DURE_PROBE_KNOWN_HOSTS ?? join(os.homedir(), '.ssh', 'dure_wsl_known_hosts')
const RAW = process.env.DURE_PROBE_RAW
const ONLY = process.env.DURE_PROBE_ONLY
const BASE = ['-T', '-i', KEY, '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${KNOWN}`, '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10']
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const sh = (cmd) => execFileSync(SSH, [...BASE, HOST, cmd], { encoding: 'utf8' }).trim()
const shTry = (cmd) => { try { return sh(cmd) } catch (e) { return `(실패 ${e.status}) ${String(e.stderr ?? '').trim()}` } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** POSIX 작은따옴표 감싸기 */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
/** pgrep·pkill -f 가 자기를 돌리는 셸(인자에 같은 글이 있다)을 잡지 않게 — 첫 글자를 [x] 로 */
const pat = (s) => `[${s[0]}]${s.slice(1)}`

// ── 두레 MCP 흉내(HTTP JSON-RPC) — probe24 그대로. 받은 호출을 남긴다
const TOKEN = randomUUID()
const calls = []
const mcp = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let m; try { m = JSON.parse(body) } catch { res.writeHead(400).end(); return }
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })) }
    if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dure', version: '0.0.1' } })
    if (m.method === 'tools/list') return reply({ tools: [
      { name: 'approve', description: 'Permission prompt', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } },
      { name: 'list_agents', description: 'List the other agents in this room', inputSchema: { type: 'object', properties: {} } },
    ] })
    if (m.method === 'tools/call') {
      const { name, arguments: a } = m.params
      calls.push({ at: ts(), name, tool: a?.tool_name, agent: req.headers['x-dure-agent'] })
      console.log(ts(), `  [MCP] ${name}${a?.tool_name ? ` ${a.tool_name} ${JSON.stringify(a.input).slice(0, 80)}` : ''}`)
      const text = name === 'approve' ? JSON.stringify({ behavior: 'allow', updatedInput: a.input }) : '에이전트: 기획(쉬는 중), 화면(일하는 중)'
      return reply({ content: [{ type: 'text', text }] })
    }
    if (m.id === undefined) { res.writeHead(202).end(); return }
    reply({})
  })
})
await new Promise((r) => mcp.listen(0, '127.0.0.1', r))
const LOCAL = mcp.address().port

// ── 작은 PNG(빨강 바탕 + 잡음 — 압축이 안 되게 해 stdin 한 줄을 크게) — 외부 모듈 없이
function png(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) { const o = y * (w * 3 + 1); raw[o] = 0; for (let x = 0; x < w; x++) { raw[o + 1 + x * 3] = 200 + Math.floor(Math.random() * 56); raw[o + 2 + x * 3] = Math.floor(Math.random() * 30); raw[o + 3 + x * 3] = Math.floor(Math.random() * 30) } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ── 서버 명령(Task 2 remoteLaunchScript 모양) — 토큰·포트는 인자에 없다(run 폴더의 파일 경로만)
const DIR = sh('mkdir -p ~/dure-ssh-probe && cd ~/dure-ssh-probe && pwd')
const claudeArgs = (sid, resume) => [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
  resume ? '--resume' : '--session-id', sid,
  '--mcp-config', '"$d/mcp.json"', '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__dure__approve',
  '--allowedTools', 'mcp__dure__list_agents', '--disallowedTools', 'SendMessage', 'ListAgents',
  '--append-system-prompt-file', '"$d/prompt.md"', '--model', 'haiku', '-n', 'probe',
]
/** wrap = exec 앞에 붙일 것('' 그대로 · 'setsid ' 새 세션) · marker = claude 와 그 아래 전부가 물려받는 환경 변수 DURE_RUN=<id> */
function launchScript(agentId, sid, { wrap = '', marker = false } = {}) {
  return [
    'umask 077', `d=$HOME/.dure/run/${agentId}`, 'mkdir -p "$d"',
    'IFS= read -r a', 'IFS= read -r b',
    'printf %s "$a" | base64 -d > "$d/mcp.json"', 'printf %s "$b" | base64 -d > "$d/prompt.md"',
    `cd ${shq(DIR)} || exit 3`, 'echo "DURE_PID=$$" >&2',
    ...(marker ? [`export DURE_RUN=${agentId}`] : []),
    `exec ${wrap}claude ${claudeArgs(sid, false).join(' ')}`,
  ].join('; ')
}
const mcpJson = (port, agentId) => JSON.stringify({ mcpServers: { dure: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${TOKEN}`, 'X-Dure-Agent': agentId }, timeout: 86400000 } } })
// 방 안내문 — 실제 두레 안내문 크기쯤(수 KB)으로 부풀리고 확인용 암호를 넣는다
const PROMPT = '너는 두레 방의 에이전트야. 짧게 답해.\n누가 "암호"를 물으면 ZEBRA-42 라고만 답해.\n' + '참고: 이 줄은 길이를 채우는 줄이야. 따옴표 \' " 와 $HOME `백틱` 도 그대로 가야 해.\n'.repeat(80)

function launch(label, { agentId = `probe25-${label}-${randomUUID().slice(0, 8)}`, wrap = '', marker = false, firstText = null } = {}) {
  const sid = randomUUID()
  const port = 40000 + Math.floor(Math.random() * 9000)
  const script = launchScript(agentId, sid, { wrap, marker })
  const p = spawn(SSH, [...BASE, '-R', `${port}:127.0.0.1:${LOCAL}`, HOST, `bash -lc ${shq(script)}`], { stdio: ['pipe', 'pipe', 'pipe'] })
  const s = { p, label, agentId, sid, port, pid: null, stderr: '', results: [], init: null, code: undefined, tools: [], sys: {}, tasks: [], subLines: 0, lines: 0 }
  let buf = ''
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8')
  p.stderr.on('data', (d) => { s.stderr += d; const m = /DURE_PID=(\d+)/.exec(s.stderr); if (m && !s.pid) { s.pid = Number(m[1]); console.log(ts(), `  [${label}] DURE_PID=${s.pid}`) } })
  p.stdout.on('data', (d) => {
    buf += d; let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1)
      if (RAW) appendFileSync(RAW, `${label}\t${l.length > 4000 ? l.slice(0, 4000) + '…(잘림)' : l}\n`)
      let j; try { j = JSON.parse(l) } catch { continue }
      s.lines++
      if (typeof j.parent_tool_use_id === 'string' && j.parent_tool_use_id) s.subLines++
      if (j.type === 'system') {
        s.sys[j.subtype] = (s.sys[j.subtype] ?? 0) + 1
        if (j.subtype === 'init') { s.init = j; console.log(ts(), `  [${label}] init ${j.session_id} · ${j.claude_code_version ?? ''} · mcp ${JSON.stringify(j.mcp_servers)}`) }
        if (/^task_/.test(j.subtype)) { s.tasks.push(j); console.log(ts(), `  [${label}] system/${j.subtype} ${JSON.stringify(j).slice(0, 260)}`) }
      }
      if (j.type === 'assistant' && !j.parent_tool_use_id) for (const b of j.message?.content ?? []) if (b.type === 'tool_use') { s.tools.push(b.name); console.log(ts(), `  [${label}] 도구 ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`) }
      if (j.type === 'result') { s.results.push(j); console.log(ts(), `  [${label}] result ${j.subtype} | ${String(j.result ?? '').replace(/\n/g, ' / ').slice(0, 140)}`) }
    }
  })
  s.exited = new Promise((r) => p.on('close', (code) => { s.code = code; console.log(ts(), `  [${label}] ssh 끝남 code ${code}${s.stderr.trim() ? ` · stderr ${JSON.stringify(s.stderr.trim().slice(0, 200))}` : ''}`); r() }))
  // 머리말 두 줄 + 첫 메시지를 한 번에 쓴다(bash read 가 넘어 읽으면 첫 메시지가 깨진다)
  const first = firstText ? userLine([{ type: 'text', text: firstText }]) : ''
  p.stdin.write(b64(mcpJson(port, agentId)) + '\n' + b64(PROMPT) + '\n' + first)
  console.log(ts(), `[${label}] 띄움 ${wrap ? `(${wrap.trim()}) ` : ''}agent ${agentId} · 원격 포트 ${port}`)
  return s
}
const userLine = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
const say = (s, content) => s.p.stdin.write(userLine(typeof content === 'string' ? [{ type: 'text', text: content }] : content))
const waitFor = async (pred, limit) => { const end = Date.now() + limit; while (!pred() && Date.now() < end) await sleep(200); return pred() }
const waitResult = (s, n, limit = 150000) => waitFor(() => s.results.length >= n || s.code !== undefined, limit).then(() => s.results.length >= n)
const killLocal = (s) => { try { execSync(`taskkill /pid ${s.p.pid} /T /F`, { stdio: 'ignore' }) } catch {} }

// ── 서버 쪽 보기·정리 명령
const DESC = 'desc() { for c in $(pgrep -P "$1"); do echo "$c"; desc "$c"; done; }'
/** pid 와 그 아래 나무 전부 + 같은 세션 전부 — 정리 전후 비교용 */
const treeOf = (pid) => shTry(`${DESC}; l="${pid} $(desc ${pid})"; s=$(ps -o sid= -p ${pid} 2>/dev/null | tr -d ' '); ` +
  `ps -o pid,ppid,pgid,sid,stat,args -p "$(echo $l | tr ' ' ,)" 2>/dev/null; echo "-- session ${pid}:"; ps -o pid,ppid,pgid,sid,stat,args -s ${pid} 2>/dev/null | tail -n +2 || true`)
/** 환경 변수 DURE_RUN=<id> 를 가진 이 사용자의 프로세스(고아가 돼 부모 줄이 끊겨도 찾는다 — 리눅스 /proc) */
const MK = 'mk() { for e in /proc/[0-9]*/environ; do tr "\\0" "\\n" 2>/dev/null < "$e" | grep -qx "DURE_RUN=$1" && { p=${e#/proc/}; echo "${p%/environ}"; }; done; }'
const leftovers = (s) => shTry(`${MK}; echo "session: $(pgrep -s ${s.pid} | paste -sd,)"; echo "sleep: $(pgrep -f 'time[.]sleep' | paste -sd,)"; ` +
  `echo "claude: $(pgrep -f 'claude [-]p' | paste -sd,)"; echo "agent: $(pgrep -f ${pat(s.sid)} | paste -sd,)"; echo "marker: $(mk ${s.agentId} | paste -sd,)"; echo "rundir: $(ls -d $HOME/.dure/run/${s.agentId} 2>/dev/null)"`)
/** 나무를 먼저 다 모은다(claude 가 꺼지면 고아가 돼 부모 줄이 끊긴다) — 그 pid 들과 그들의 세션 */
const TREE = (pid) => `${DESC}; l="${pid} $(desc ${pid})"; ss=$(ps -o sid= -p "$(echo $l | tr ' ' ,)" 2>/dev/null | sort -u)`
const CLEANUP = {
  // spec 4.4 의 모양 그대로
  session: (pid, agentId) => `pkill -TERM -s ${pid}; sleep 2; pkill -KILL -s ${pid}; rm -rf "$HOME/.dure/run/${agentId}"; echo done`,
  // 증거용: claude 가 TERM 을 처리하지 못한 경우(멈춤·KILL)를 흉내 — 세션만 바로 KILL
  killonly: (pid, agentId) => `pkill -KILL -s ${pid}; rm -rf "$HOME/.dure/run/${agentId}"; echo done`,
  // 대안: 나무 + 그 나무의 세션들, TERM → 2초 → KILL
  tree: (pid, agentId) => `${TREE(pid)}; kill -TERM $l 2>/dev/null; for x in $ss; do pkill -TERM -s $x; done; sleep 2; ` +
    `kill -KILL $l 2>/dev/null; for x in $ss; do pkill -KILL -s $x; done; rm -rf "$HOME/.dure/run/${agentId}"; echo "done l=[$l] ss=[$(echo $ss)]"`,
  // 증거용: 나무 방식이 claude 의 TERM 처리에 기대지 않는가 — 바로 KILL
  treekill: (pid, agentId) => `${TREE(pid)}; kill -KILL $l 2>/dev/null; for x in $ss; do pkill -KILL -s $x; done; rm -rf "$HOME/.dure/run/${agentId}"; echo "done l=[$l] ss=[$(echo $ss)]"`,
  // 대안: 표식(DURE_RUN) + 나무 + 그 세션들 — claude 가 이미 꺼져 고아가 된 것도
  marker: (pid, agentId) => `${MK}; ${TREE(pid)}; l="$l $(mk ${agentId})"; ss=$(ps -o sid= -p "$(echo $l | tr ' ' ,)" 2>/dev/null | sort -u); ` +
    `kill -TERM $l 2>/dev/null; for x in $ss; do pkill -TERM -s $x; done; sleep 2; ` +
    `kill -KILL $l 2>/dev/null; for x in $ss; do pkill -KILL -s $x; done; rm -rf "$HOME/.dure/run/${agentId}"; echo "done l=[$(echo $l)] ss=[$(echo $ss)]"`,
  // 증거용: claude 가 먼저 죽어(충돌·OOM 흉내 — claude 만 KILL) 명령이 고아가 된 뒤 표식 정리로 치워지는가
  crashmarker: (pid, agentId) => `kill -KILL ${pid}; sleep 1; echo "orphans: $(ps -o pid=,ppid=,sid= -p "$(pgrep -f 'time[.]sleep' | paste -sd,)" 2>/dev/null | tr -s ' \\n' ' ')"; ${CLEANUP.marker(pid, agentId)}`,
}

/** D2 한 번. busy = Bash 명령(백그라운드 120초 + 앞 90초)이 도는 중에 ssh 를 끄고 정리 · idle = 백그라운드 120초만 띄우고 턴이 끝나 쉬는 중에 ssh 를 끄고 정리 */
async function d2Trial(s, method, scenario = 'busy') {
  const n0 = s.results.length
  if (scenario === 'busy') say(s, 'Bash 도구를 두 번 써. 먼저 run_in_background: true 로 `python3 -c "import time; time.sleep(120)"` 를 띄우고, 이어서 (백그라운드 아님) `python3 -c "import time; time.sleep(90)"` 를 실행해. 명령을 다른 것으로 바꾸지 마.')
  else say(s, 'Bash 도구를 run_in_background: true 로 써서 `python3 -c "import time; time.sleep(120)"` 를 띄워. 명령을 다른 것으로 바꾸지 마. 띄웠으면 기다리지 말고 "띄움" 한 마디만 답해.')
  let seen = false
  if (scenario === 'busy') {
    for (const end = Date.now() + 120000; !seen && Date.now() < end && s.code === undefined;) {
      seen = /^\d+/m.test(shTry(`pgrep -f 'time[.]sleep[(]90' || true`))
      if (!seen) await sleep(2000)
    }
  } else {
    await waitResult(s, n0 + 1)
    seen = /^\d+/m.test(shTry(`pgrep -f 'time[.]sleep[(]120' || true`))
  }
  await sleep(2000)
  const r = { method, scenario, sawCommand: seen }
  r.before = treeOf(s.pid)
  r.sleepsBefore = shTry(`pgrep -af 'time[.]sleep' || true`)
  console.log(ts(), `[${s.label}] 정리 전 나무\n${r.before}\n  sleep: ${r.sleepsBefore}`)
  console.log(ts(), `[${s.label}] ssh 강제 종료(taskkill /T /F) → 정리(${method}, ${scenario})`)
  killLocal(s); await s.exited
  await sleep(scenario === 'idle' ? 4000 : 1000)
  r.afterSshKill = leftovers(s)
  console.log(ts(), `[${s.label}] ssh 끈 뒤(정리 전)\n${r.afterSshKill}`)
  const t = Date.now()
  r.cleanup = shTry(CLEANUP[method](s.pid, s.agentId))
  r.cleanupMs = Date.now() - t
  await sleep(1000)
  r.after = leftovers(s)
  r.clean = !/session: \d|sleep: \d|claude: \d|agent: \d|marker: \d|rundir: \S/.test(r.after)
  console.log(ts(), `[${s.label}] 정리 결과(${method}) clean=${r.clean}\n${r.after}`)
  return r
}

const out = { versions: shTry('bash -lc "claude --version"; dpkg-query -W -f \'${Package} ${Version}\\n\' openssh-server 2>/dev/null; echo "shell=$SHELL"') }
const all = []
try {
  if (ONLY !== 'd2') {
    // ── D1 + D3: 정식 모양으로 띄우고 첫 메시지를 머리말과 같은 쓰기에 붙인다
    const a = launch('A', { firstText: '방 안내문에 적힌 암호가 뭐야? 암호만 답해. 도구는 쓰지 마.' }); all.push(a)
    out.d3turn = (await waitResult(a, 1)) ? a.results[0].result : `(결과 없음) stderr=${a.stderr}`
    out.d3init = { session: a.init?.session_id === a.sid, mcp: a.init?.mcp_servers?.find((m) => m.name === 'dure')?.status, version: a.init?.claude_code_version }
    out.d1 = shTry(`ps -o pid,ppid,pgid,sid,stat,args -p ${a.pid}; p=$(ps -o ppid= -p ${a.pid}); ps -o pid,ppid,pgid,sid,args -p $p`)
    out.d3files = shTry(`stat -c '%a %U %n' $HOME/.dure $HOME/.dure/run $HOME/.dure/run/${a.agentId} $HOME/.dure/run/${a.agentId}/*; ` +
      `sha256sum $HOME/.dure/run/${a.agentId}/mcp.json $HOME/.dure/run/${a.agentId}/prompt.md | cut -c1-64`)
    out.d3sameBytes = out.d3files.includes(sha(mcpJson(a.port, a.agentId))) && out.d3files.includes(sha(PROMPT))
    // 토큰이 서버의 어떤 프로세스 인자에도 없는가(자기 grep 을 안 세게 첫 글자를 [x] 로)
    out.d3tokenInPs = shTry(`echo "token-hits: $(ps -eww -o args | grep -c -- ${pat(TOKEN)})"; ps -eww -o args | grep -- '[-]-mcp-config' | head -2`)
    console.log(ts(), 'D1', out.d1, '\nD3 파일', out.d3files, '\nD3 ps 토큰', out.d3tokenInPs)
    // D3 터널 — 두레 도구
    say(a, 'list_agents 도구를 한 번 불러서 나온 에이전트 이름을 그대로 말해.')
    await waitResult(a, 2)
    out.d3mcp = { listAgents: calls.some((c) => c.name === 'list_agents' && c.agent === a.agentId), reply: a.results[1]?.result }
    // D4 그림
    const img = png(160, 160)
    say(a, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.toString('base64') } },
      { type: 'text', text: '이 그림을 가장 많이 채운 색을 한국어 한 단어로 답해. 도구는 쓰지 마.' }])
    await waitResult(a, 3)
    out.d4 = { pngBytes: img.length, b64Chars: img.toString('base64').length, subtype: a.results[2]?.subtype, reply: a.results[2]?.result }
    // D5 서브에이전트
    const sys0 = { ...a.sys }
    say(a, 'Agent 도구(subagent_type: general-purpose)로 서브에이전트를 하나 띄워서 "3 더하기 4 는? 숫자만" 을 물어봐. 서브에이전트의 답만 그대로 말해.')
    await waitResult(a, 4, 240000)
    out.d5 = { tools: a.tools, subLines: a.subLines, sysDelta: Object.fromEntries(Object.entries(a.sys).map(([k, v]) => [k, v - (sys0[k] ?? 0)]).filter(([, v]) => v)),
      tasks: a.tasks.map((t) => ({ subtype: t.subtype, task_type: t.task_type, status: t.status, description: t.description, tool_use_id: t.tool_use_id })), reply: a.results[3]?.result }
    // D2 — spec 의 모양(pkill -s)
    out.d2 = [await d2Trial(a, 'session')]

    // ── D1 둘째: `exec setsid claude` — 이미 세션 리더면 setsid 가 포크해 pid 가 바뀌는가(모델 턴 없음)
    const b = launch('B', { wrap: 'setsid ' }); all.push(b)
    await waitFor(() => b.pid, 15000); await sleep(3000)
    out.d1setsid = { durePid: b.pid, ps: shTry(`ps -o pid,ppid,pgid,sid,stat,args -p ${b.pid} 2>/dev/null || echo "(DURE_PID ${b.pid} 없음)"; for p in $(pgrep -f ${pat(b.sid)}); do ps -o pid,ppid,pgid,sid,stat,args -p $p | tail -1; done`), codeSoFar: b.code }
    console.log(ts(), 'D1 setsid', JSON.stringify(out.d1setsid, null, 1))
    b.p.stdin.end(); await Promise.race([b.exited, sleep(15000)])
    await sleep(1000)
    out.d1setsid.afterStdinEnd = { code: b.code, left: shTry(`pgrep -af ${pat(b.sid)} || true`) }
  }
  // ── D2 더 — 정리 방법 × 상황. DURE_PROBE_TRIALS="busy:killonly,busy:treekill,idle:session" 꼴(기본: spec 모양이 남겼으면 busy:tree)
  const trials = (process.env.DURE_PROBE_TRIALS ?? (ONLY === 'd2' || !out.d2?.[0]?.clean ? 'busy:tree' : '')).split(',').filter(Boolean)
  for (const [i, t] of trials.entries()) {
    const [scenario, method] = t.split(':')
    const c = launch(`C${i + 1}`, { marker: true }); all.push(c)
    await waitFor(() => c.pid, 15000)
    const r = await d2Trial(c, method, scenario)
    ;(out.d2 ??= []).push(r)
    // 남겼으면 다음 시도가 섞이지 않게 여기서 치운다(무엇을 치웠는지 남긴다)
    if (!r.clean) r.sweptAfter = shTry(`${MK}; for p in $(mk ${c.agentId}) $(pgrep -f 'time[.]sleep[(](90|120)'); do echo "kill $p $(ps -o sid=,args= -p $p | cut -c1-80)"; kill -KILL $p 2>/dev/null; done; rm -rf "$HOME/.dure/run/${c.agentId}"`)
  }
} finally {
  // 정리 — 이 PC 의 ssh 를 끄고, 서버에 남은 이 실측의 claude·명령·run 폴더를 지운다
  for (const s of all) if (s.code === undefined) { s.p.stdin.end(); killLocal(s) }
  await sleep(1000)
  const pids = all.map((s) => s.pid).filter(Boolean)
  // 이 실측이 띄운 것만: 세션 id 가 인자에 든 claude 와 그 나무, 그 pid 들의 세션, 이 실측의 python sleep
  out.finalSweep = shTry(`${DESC}; for p in $(pgrep -f '${all.map((s) => pat(s.sid)).join('|') || 'x^'}') ${pids.join(' ')}; do kill -KILL $(desc $p) $p 2>/dev/null; pkill -KILL -s $p; done; ` +
    `pkill -KILL -f 'time[.]sleep[(](90|120)'; ` +
    `rm -rf ${all.map((s) => `"$HOME/.dure/run/${s.agentId}"`).join(' ') || '/nonexistent-x'}; rmdir "$HOME/.dure/run" "$HOME/.dure" 2>/dev/null; ` +
    `echo "남은 claude: $(pgrep -af 'claude [-]p')"; echo "남은 sleep: $(pgrep -af 'time[.]sleep')"; ls -la $HOME/.dure 2>&1 | head -3`)
  mcp.close()
  console.log('\n== 판정')
  console.log(JSON.stringify(out, null, 1))
  console.log('MCP 호출', JSON.stringify(calls))
}
