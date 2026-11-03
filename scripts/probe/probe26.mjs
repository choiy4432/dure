// probe26 — 설치·로그인·claude update 실측. 인자 하나: login | update | install
// login   D1 빈 임시 CLAUDE_CONFIG_DIR 로 `auth status --json`(loggedIn false) → `auth login --claudeai` 를 windowsHide·stdio pipe 로 띄우고
//         출력을 그대로 찍는다. 사용자가 브라우저에서 로그인하는 동안 2초마다 `auth status --json` 의 loggedIn 만 본다(끝나면 임시 폴더 통째로 지움 — 안의 파일은 열지 않는다)
// update  D3 이 PC 의 `claude update` 두 번 + 놀고 있는 `claude -p`(메시지 안 보냄) 가 있는 채 한 번 · D4 서버(WSL)에서 같은 것
// install D2 공식 설치 스크립트를 창 없는 powershell 로 — Windows Sandbox 안에서만 돌린다(DURE_PROBE_SANDBOX=1 이 있어야 시작)
// 약관: 자격 증명 파일·account 를 읽지 않는다 · `auth logout` 안 함 · --bare·API 키 안 씀. 모델 호출 없음(claude -p 는 메시지 없이 띄웠다 끈다)
// 환경: DURE_PROBE_SSH_HOST(기본 localhost) · DURE_PROBE_SSH_KEY(기본 ~/.ssh/dure_wsl_test) · DURE_PROBE_KNOWN_HOSTS(기본 ~/.ssh/dure_wsl_known_hosts)
//       DURE_PROBE_WSL_DISTRO(기본 Ubuntu) · DURE_PROBE_SKIP_SERVER=1(서버 건너뜀)
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const MODE = process.argv[2]
const SSH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
const HOST = process.env.DURE_PROBE_SSH_HOST ?? 'localhost'
const KEY = process.env.DURE_PROBE_SSH_KEY ?? join(os.homedir(), '.ssh', 'dure_wsl_test')
const KNOWN = process.env.DURE_PROBE_KNOWN_HOSTS ?? join(os.homedir(), '.ssh', 'dure_wsl_known_hosts')
const DISTRO = process.env.DURE_PROBE_WSL_DISTRO ?? 'Ubuntu'
const BASE = ['-T', '-i', KEY, '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${KNOWN}`, '-o', 'ConnectTimeout=10']
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(ts(), ...a)
const firstLines = (s, n = 3) => String(s).split(/\r?\n/).filter((l) => l.trim()).slice(0, n).map((l) => l.slice(0, 200))

/** 명령 하나를 돌려 시간·종료 코드·출력 첫 줄을 낸다 */
function run(label, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const start = Date.now()
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let out = '', err = ''
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8')
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => resolve({ label, code: 'spawn-error', ms: Date.now() - start, out, err: String(e) }))
    p.on('close', (code) => {
      const r = { label, code, ms: Date.now() - start, lines: (out + err).split(/\r?\n/).filter((l) => l.trim()).length, first: firstLines(out), firstErr: firstLines(err) }
      log(`[${label}] code ${code} · ${r.ms}ms · ${r.lines}줄`, JSON.stringify(r.first), r.firstErr.length ? `stderr ${JSON.stringify(r.firstErr)}` : '')
      resolve(r)
    })
  })
}
const killTree = (pid) => { try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
const CLAUDE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--disallowedTools', 'SendMessage', 'ListAgents']

// ───────────────────────── login
async function login() {
  const dir = mkdtempSync(join(os.tmpdir(), 'dure-probe26-'))
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir }
  const out = {}
  try {
    const status = () => {
      try { return JSON.parse(execFileSync('claude', ['auth', 'status', '--json'], { env, encoding: 'utf8', windowsHide: true }))?.loggedIn === true } catch (e) {
        try { return JSON.parse(String(e.stdout))?.loggedIn === true } catch { return null }
      }
    }
    out.before = status()
    log('시작 전 loggedIn =', out.before, '(false 여야 한다)')
    if (out.before !== false) throw new Error('빈 임시 설정인데 loggedIn 이 false 가 아님 — 중단')
    const start = Date.now()
    const p = spawn('claude', ['auth', 'login', '--claudeai'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    out.stdout = ''; out.stderr = ''
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8')
    p.stdout.on('data', (d) => { out.stdout += d; process.stdout.write(`[stdout] ${d}`) })
    p.stderr.on('data', (d) => { out.stderr += d; process.stdout.write(`[stderr] ${d}`) })
    const exited = new Promise((r) => p.on('close', (code) => { out.code = code; out.ms = Date.now() - start; r() }))
    log('auth login 띄움 — 사용자에게: 브라우저가 열리면 로그인해 달라고 한다(최대 5분)')
    for (let i = 0; i < 150 && out.code === undefined; i++) {
      await Promise.race([exited, sleep(2000)])
      if (out.code === undefined && status() === true && !out.loggedInAt) { out.loggedInAt = Date.now() - start; log('loggedIn = true') }
    }
    if (out.code === undefined) { killTree(p.pid); out.timedOut = true }
    await Promise.race([exited, sleep(3000)])
    out.after = status()
    out.promptedForInput = /paste|code|enter/i.test(out.stdout + out.stderr)
    log('끝', JSON.stringify({ code: out.code, ms: out.ms, loggedInAtMs: out.loggedInAt, after: out.after, promptedForInput: out.promptedForInput, timedOut: out.timedOut }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    log('임시 폴더 지움', !existsSync(dir))
  }
}

// ───────────────────────── update
const FIND_CLAUDE = 'c=$(command -v claude); [ -x "$c" ] || c=; [ -n "$c" ] || for x in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do [ -x "$x" ] && { c=$x; break; }; done; ' +
  'if [ -z "$c" ]; then n="${NVM_DIR:-$HOME/.nvm}/nvm.sh"; [ -s "$n" ] && . "$n" >/dev/null 2>&1; c=$(command -v claude); [ -x "$c" ] || c=; fi; [ -n "$c" ] || exit 127'
const sshRun = (label, script, opts) => run(label, SSH, [...BASE, HOST, `bash -lc '${script.replace(/'/g, `'\\''`)}'`], opts)

async function update() {
  const res = {}
  const ver = await run('local --version', 'claude', ['--version']); res.version = ver.first
  res.local1 = await run('local update #1', 'claude', ['update'])
  res.local2 = await run('local update #2', 'claude', ['update'])
  // 놀고 있는 claude -p(메시지 안 보냄) 가 있는 채
  const idle = spawn('claude', CLAUDE_ARGS, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  await sleep(6000)
  log('놀고 있는 claude -p pid', idle.pid, '살아 있음', idle.exitCode === null)
  res.localIdle = await run('local update (idle claude -p 있음)', 'claude', ['update'])
  res.localIdle.idleAliveAfter = idle.exitCode === null
  killTree(idle.pid); idle.stdin.end()
  res.localAfter = await run('local --version (after)', 'claude', ['--version'])

  if (process.env.DURE_PROBE_SKIP_SERVER === '1') return console.log(JSON.stringify(res, null, 1))
  // 서버 — WSL 은 쉬면 꺼지니 먼저 붙잡는다
  const hold = spawn('wsl.exe', ['-d', DISTRO, '--', 'sleep', '3600'], { windowsHide: true, stdio: 'ignore' })
  await sleep(4000)
  try {
    res.srvVersion = await sshRun('server --version', `${FIND_CLAUDE}; "$c" --version`)
    res.srv1 = await sshRun('server update #1', `${FIND_CLAUDE}; echo "path=$c"; "$c" update`)
    res.srv2 = await sshRun('server update #2', `${FIND_CLAUDE}; "$c" update`)
    // 서버의 놀고 있는 claude -p — stdin 을 열어 둔 채(메시지 없음)
    const sidle = spawn(SSH, [...BASE, HOST, `bash -lc '${FIND_CLAUDE}; exec "$c" ${CLAUDE_ARGS.join(' ')}'`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    await sleep(8000)
    res.srvIdleUp = sidle.exitCode === null
    log('서버 놀고 있는 claude -p ssh 살아 있음', res.srvIdleUp)
    res.srvIdleSeen = (await sshRun('server pgrep', `pgrep -af "claude.* -p" | cut -c1-120 || true`)).first
    res.srvIdle = await sshRun('server update (idle claude -p 있음)', `${FIND_CLAUDE}; "$c" update`)
    res.srvIdle.idleAliveAfter = sidle.exitCode === null
    sidle.stdin.end(); killTree(sidle.pid)
    await sleep(1500)
    res.srvCleanup = await sshRun('server 남은 claude -p', `pkill -KILL -f "claude.* -p" ; sleep 0.5; pgrep -af "claude.* -p" | cut -c1-100 || echo none`)
    res.srvAfter = await sshRun('server --version (after)', `${FIND_CLAUDE}; "$c" --version`)
  } finally {
    hold.kill(); killTree(hold.pid)
  }
  console.log(JSON.stringify(res, null, 1))
}

// ───────────────────────── install
async function install() {
  if (process.env.DURE_PROBE_SANDBOX !== '1') throw new Error('install 은 Windows Sandbox 안에서만 — DURE_PROBE_SANDBOX=1 을 주고 돌린다')
  const bin = join(os.homedir(), '.local', 'bin', 'claude.exe')
  log('설치 전 claude.exe 있음', existsSync(bin))
  const cmd = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; irm https://claude.ai/install.ps1 | iex'
  const r = await run('install.ps1', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd])
  r.binExists = existsSync(bin)
  log('설치 뒤 claude.exe 있음', r.binExists)
  if (r.binExists) r.version = (await run('claude --version', bin, ['--version'])).first
  console.log(JSON.stringify(r, null, 1))
}

const MODES = { login, update, install }
if (!MODES[MODE]) { console.error('usage: node probe26.mjs login|update|install'); process.exit(2) }
await MODES[MODE]()
