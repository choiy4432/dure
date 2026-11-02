// probe24 — 원격(SSH) 에이전트 실측. 두레(윈도우)가 `ssh … -R <원격포트>:127.0.0.1:<두레MCP> 서버 bash -lc 'claude …'` 로
// 서버(여기선 WSL Ubuntu + openssh-server)에서 claude 를 띄우는 방식이 되는지. Haiku(사용자 동의 2026-11-02).
// ① SSH stdio 위 stream-json 왕복(init·result) ② 역방향 터널로 두레 MCP 닿기(승인 요청 approve · 두레 도구 list_agents)
// ③ interrupt(control_request) ④ 일하는 중 ssh 프로세스를 강제로 끄면 서버의 claude 가 남는가 ⑤ 쉬는 중 끄면 남는가
// ⑥ --resume 으로 이어지는가 ⑦ 같은 원격 포트를 두 번 열면(ExitOnForwardFailure) 어떻게 실패하는가
// 환경: DURE_PROBE_SSH_HOST(기본 localhost) · DURE_PROBE_SSH_KEY(기본 ~/.ssh/dure_wsl_test) · DURE_PROBE_KNOWN_HOSTS
import { spawn, execFileSync, execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { join } from 'node:path'

const SSH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
const HOST = process.env.DURE_PROBE_SSH_HOST ?? 'localhost'
const KEY = process.env.DURE_PROBE_SSH_KEY ?? join(os.homedir(), '.ssh', 'dure_wsl_test')
const KNOWN = process.env.DURE_PROBE_KNOWN_HOSTS ?? join(os.homedir(), '.ssh', 'dure_wsl_known_hosts')
const BASE = ['-i', KEY, '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${KNOWN}`, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15']
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const sh = (cmd) => execFileSync(SSH, [...BASE, HOST, cmd], { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 두레 MCP 흉내(HTTP JSON-RPC) — 받은 호출을 남긴다
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
      console.log(ts(), `  [MCP] ${name}${a?.tool_name ? ` ${a.tool_name} ${JSON.stringify(a.input).slice(0, 60)}` : ''}`)
      const text = name === 'approve' ? JSON.stringify({ behavior: 'allow', updatedInput: a.input }) : '에이전트: 기획(쉬는 중), 화면(일하는 중)'
      return reply({ content: [{ type: 'text', text }] })
    }
    if (m.id === undefined) { res.writeHead(202).end(); return }
    reply({})
  })
})
await new Promise((r) => mcp.listen(0, '127.0.0.1', r))
const LOCAL = mcp.address().port

// ── 서버 쪽 작업 폴더·mcp.json·방 안내문
const REMOTE_PORT = 40000 + Math.floor(Math.random() * 9000)
const DIR = sh('mkdir -p ~/dure-ssh-probe && cd ~/dure-ssh-probe && pwd')
const cfg = { mcpServers: { dure: { type: 'http', url: `http://127.0.0.1:${REMOTE_PORT}/mcp`, headers: { Authorization: `Bearer ${TOKEN}`, 'X-Dure-Agent': 'probe-agent' }, timeout: 86400000 } } }
execFileSync(SSH, [...BASE, HOST, `cat > ${DIR}/mcp.json`], { input: JSON.stringify(cfg) })
execFileSync(SSH, [...BASE, HOST, `cat > ${DIR}/prompt.md`], { input: '너는 두레 방의 에이전트야. 짧게 답해.\n' })
console.log(ts(), `준비: 로컬 MCP ${LOCAL} · 원격 포트 ${REMOTE_PORT} · 폴더 ${DIR}`)

const claudeArgs = (sid, resume) => [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
  resume ? '--resume' : '--session-id', sid,
  '--mcp-config', 'mcp.json', '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__dure__approve',
  '--allowedTools', 'mcp__dure__list_agents', '--disallowedTools', 'SendMessage', 'ListAgents',
  '--append-system-prompt-file', 'prompt.md', '--model', 'haiku', '-n', 'probe',
]
/** 원격 claude — exec 로 bash 를 claude 로 바꾼다(신호가 claude 에 바로 가게) */
function launch(label, sid, resume, port = REMOTE_PORT) {
  const remote = `bash -lc 'cd ${DIR} && exec claude ${claudeArgs(sid, resume).join(' ')}'`
  const p = spawn(SSH, [...BASE, '-R', `${port}:127.0.0.1:${LOCAL}`, HOST, remote], { stdio: ['pipe', 'pipe', 'pipe'] })
  const s = { p, label, lines: [], stderr: '', results: [], init: null, code: undefined, tools: [] }
  let buf = ''
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8')
  p.stderr.on('data', (d) => { s.stderr += d })
  p.stdout.on('data', (d) => {
    buf += d; let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1)
      let j; try { j = JSON.parse(l) } catch { continue }
      if (j.type === 'system' && j.subtype === 'init') { s.init = j; console.log(ts(), `  [${label}] init ${j.session_id} · mcp ${JSON.stringify(j.mcp_servers)}`) }
      if (j.type === 'assistant') for (const b of j.message?.content ?? []) if (b.type === 'tool_use') { s.tools.push(b.name); console.log(ts(), `  [${label}] 도구 ${b.name}`) }
      if (j.type === 'result') { s.results.push(j); console.log(ts(), `  [${label}] result ${j.subtype} | ${String(j.result ?? '').replace(/\n/g, ' / ').slice(0, 100)}`) }
      if (j.type === 'control_response') console.log(ts(), `  [${label}] control_response ${j.response?.subtype} ${j.response?.request_id}`)
    }
  })
  s.exited = new Promise((r) => p.on('close', (code) => { s.code = code; console.log(ts(), `  [${label}] ssh 끝남 code ${code}`); r() }))
  console.log(ts(), `[${label}] 띄움 ${resume ? '--resume' : '--session-id'} ${sid}`)
  return s
}
const say = (s, text) => s.p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
const waitResult = async (s, n, limit = 120000) => { const end = Date.now() + limit; while (s.results.length < n && s.code === undefined && Date.now() < end) await sleep(200); return s.results.length >= n }
const remoteClaudes = () => { try { return sh(`pgrep -af 'claude -p' | grep -v pgrep || true`) } catch { return '(못 셈)' } }
const killLocal = (s) => { try { execSync(`taskkill /pid ${s.p.pid} /T /F`, { stdio: 'ignore' }) } catch {} }

const out = {}
const sid = randomUUID()
try {
  // ①② 왕복 + 터널로 MCP
  const a = launch('A', sid, false)
  say(a, '다음 단어를 기억해: 사과. "알았어" 한 마디만 답해. 도구는 쓰지 마.')
  out.roundtrip = (await waitResult(a, 1)) && a.init?.session_id === sid
  say(a, 'list_agents 도구를 한 번 불러서 나온 에이전트 이름을 그대로 말해.')
  await waitResult(a, 2)
  say(a, 'Bash 로 `echo 원격-$(hostname)` 을 실행하고 출력만 그대로 말해.')
  await waitResult(a, 3)
  out.mcpListAgents = calls.some((c) => c.name === 'list_agents')
  out.mcpApprove = calls.some((c) => c.name === 'approve' && c.tool === 'Bash')
  out.bashReply = a.results[2]?.result
  // ③ interrupt — 오래 걸리는 명령 도중
  say(a, 'Bash 로 `python3 -c "import time; time.sleep(40)"` 을 실행해. 다른 방법으로 바꾸지 말고 그대로.')
  const end = Date.now() + 60000
  while (!calls.some((c) => c.name === 'approve' && c.at && a.tools.filter((t) => t === 'Bash').length >= 2) && Date.now() < end) await sleep(200)
  await sleep(2500)
  a.p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } }) + '\n')
  out.interrupt = await waitResult(a, 4, 20000)
  out.interruptSubtype = a.results[3]?.subtype
  // ⑤ 쉬는 중 ssh 강제 종료 → 서버에 claude 가 남는가
  console.log(ts(), '[A] 쉬는 중 ssh 강제 종료(taskkill /T /F)')
  killLocal(a); await a.exited
  await sleep(3000)
  out.idleKillLeft = remoteClaudes()
  // ⑥ resume
  const b = launch('B', sid, true)
  say(b, '지금까지 기억하라고 한 단어를 전부 말해. 다른 말 없이, 도구는 쓰지 마.')
  await waitResult(b, 1)
  out.resume = { init: b.init?.session_id === sid, reply: b.results[0]?.result }
  // ④ 일하는 중 ssh 강제 종료
  say(b, 'Bash 로 `python3 -c "import time; time.sleep(61)"` 을 실행해. 다른 방법으로 바꾸지 말고 그대로.')
  const end2 = Date.now() + 60000
  while (!b.tools.includes('Bash') && Date.now() < end2) await sleep(200)
  await sleep(3000)
  out.busyBefore = remoteClaudes(); out.busyPyBefore = (() => { try { return sh(`pgrep -af 'time.sleep' | grep -v pgrep || true`) } catch { return '?' } })()
  console.log(ts(), '[B] 일하는 중 ssh 강제 종료')
  killLocal(b); await b.exited
  await sleep(3000)
  out.busyKillLeft3s = remoteClaudes()
  await sleep(10000)
  out.busyKillLeft13s = remoteClaudes()
  out.sleepLeft = (() => { try { return sh(`pgrep -af 'time.sleep' | grep -v pgrep || true`) } catch { return '?' } })()
  // ⑦ 같은 원격 포트 두 번
  const c1 = launch('C1', randomUUID(), false)
  await sleep(4000)
  const c2 = launch('C2', randomUUID(), false)
  await Promise.race([c2.exited, sleep(15000)])
  out.portClash = { c2code: c2.code, c2stderr: c2.stderr.trim().slice(0, 300) }
  c1.p.stdin.end(); await Promise.race([c1.exited, sleep(15000)])
  out.stdinEndExit = c1.code
  out.afterAll = remoteClaudes()
} finally {
  mcp.close()
  console.log('\n== 판정')
  console.log(JSON.stringify(out, null, 1))
  console.log('MCP 호출', JSON.stringify(calls))
}
