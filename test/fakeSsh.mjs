// 테스트용 가짜 ssh — 윈도 ssh.exe 대신 띄운다(엔진 ssh 손잡이 { command: node, argsPrefix: [이 파일] }, 가짜 claude 와 같은 방식).
// 받는 인자는 진짜 ssh 그대로: SSH_OPTIONS(-T·-o …) · -R <원격>:127.0.0.1:<로컬> · -p <포트> · <호스트> · 'bash -lc <스크립트>'(src/engine/remote.ts).
// 셸을 흉내 내지 않는다 — remote.ts 가 만드는 스크립트 네 모양만 알아보고 그 결과를 낸다(모르는 모양은 code 2):
//   띄우기(remoteLaunchScript) · 확인(checkScript) · 기록 확인(transcriptCheckScript) · 정리(cleanupScript). 빈 스크립트는 code 0.
// 실제 모양은 실측: docs/findings/2026-11-02-ssh-remote-probe.md (probe24·probe25).
//
// 서버 = 이 PC 의 폴더 하나:
//   FAKE_SSH_ROOT(필수)  서버의 / — 서버 경로 /home/a/web → <root>/home/a/web (.. 는 / 위로 못 간다)
//   가짜 사용자는 늘 a  → $HOME = /home/a = <root>/home/a. ~·$HOME 은 여기로 펼친다(호스트가 me@h 여도 — 오류 글의 사용자 이름만 me)
//   공유 기록            <root>/.fake-ssh/procs.jsonl — 띄운 가짜 claude 의 표식·지킴이 포트·비밀(따로 뜬 가짜 ssh 끼리 맞추려고), portclash-once 표시
//
// 가짜 claude 는 지킴이(이 파일 --fake-keeper, detached) 아래에서 돈다. 지킴이가 claude 의 stdio 를 잇고, 127.0.0.1 의 제어 포트에서
// 띄울 때 정한 비밀(무작위 토큰)을 받아야만 자기 자식 claude 를 끈다. 정리·뒷정리는 기록의 pid 를 절대 process.kill 하지 않는다 —
// 기록이 낡아(지킴이가 taskkill 로 죽음) pid·포트가 남의 것이 됐어도, 비밀을 아는 우리 지킴이가 아니면 아무 일도 없다.
// 손잡이(환경 변수):
//   FAKE_SSH_CLAUDE      띄울 claude — JSON 배열 [명령, 앞 인자…](기본 [node, test/fakeClaude.mjs]). JSON 이 아니면 명령 하나
//   FAKE_SSH_LOG         JSON 한 줄씩: 시작 {event:'start', argv, host, user, port, forwards, command, script, kind}
//                        · {event:'launch', pid, marker, folder(서버 경로), cwd(이 PC 경로), args, runDir} · {event:'cleanup', pid, marker, killed, removed}
//                        · {event:'drop'} · {event:'exit', code}
//   FAKE_SSH_MODE        refused | denied | hostkey   → 접속 전에 code 255(진짜 ssh 의 stderr 글 그대로)
//                        noclaude                     → claude 없음: 띄우기는 DURE_PID 뒤 'bash: line 1: claude: command not found' 127, 확인은 127(글 없음)
//                        portclash-once               → 이 root 에서 -R 이 붙은 첫 호출만 255 'Error: remote port forwarding failed for listen port <N>'
//                        drop:<ms>                    → 띄운 claude 가 뜬 뒤 <ms> 에 255 'Connection to <host> closed by remote host.' —
//                                                        가짜 claude 는 죽이지 않고 남긴다: 지킴이가 claude 의 입력을 열어 둔 채(EOF 를 넘기지 않음)
//                                                        출력은 버리며 정리 명령·뒷정리가 끌 때까지 둔다(안전 상한 10 분). 띄우기에만 걸린다
//   FAKE_SSH_MODE_FILE   그 파일이 있으면 FAKE_SSH_MODE 대신 그 내용(빈 파일 = 보통) — 엔진 환경을 못 바꾸는 시험이 도중에 모드를 바꾸게
//   FAKE_SSH_CLEANUP_MS  정리 명령이 끝나기 전에 더 기다린다(진짜는 sleep 2 — 기본 0, 정리 상한 시험용)
// 서버 환경 = 이 프로세스의 환경 — CLAUDE_CONFIG_DIR·FAKE_TRANSCRIPTS·FAKE_CLAUDE_LOG 등이 가짜 claude 에 그대로 간다.
//   CLAUDE_CONFIG_DIR 은 이 PC 경로로 읽는다(가짜 claude 가 거기에 대화 파일을 만든다). 없으면 $HOME/.claude.
// 셸이 $HOME 을 펼친 claude 인자(큰따옴표 run 파일 경로)는 이 PC 경로로 바꿔 넘긴다 — 가짜 claude 가 그 mcp.json 을 직접 읽는다.
// 정리 명령에 꺼진 claude 가 붙은 ssh 는 255(진짜: exit-signal). 실제와 다른 점: 정리 명령은 sleep 2 없이 곧바로 끈다.
//
// 시험 뒷정리: `node test/fakeSsh.mjs --fake-reap`(FAKE_SSH_ROOT 같게) — 이 root 에서 띄운 지킴이에게 모두 끄라고 한다(끊김으로 남긴 것까지).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const USER = 'a';
const REMOTE_HOME = `/home/${USER}`;
const VERSION = '2.1.304 (Claude Code)';
const MODES = ['', 'refused', 'denied', 'hostkey', 'noclaude', 'portclash-once'];

const ROOT = process.env.FAKE_SSH_ROOT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(obj) {
  const f = process.env.FAKE_SSH_LOG;
  if (f) fs.appendFileSync(f, JSON.stringify({ ...obj, sshPid: process.pid }) + '\n');
}

let exiting = false;
/** stdout·stderr 를 다 내보낸 뒤 끝낸다(파이프는 비동기) */
function finish(code) {
  if (exiting) return;
  exiting = true;
  closeRelay();
  log({ event: 'exit', code });
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}
const fail = (code, text) => {
  process.stderr.write(text.endsWith('\n') ? text : text + '\n');
  finish(code);
};

// ── 서버 경로 ↔ 이 PC 경로 ──
/** 서버 경로(상대면 $HOME 기준 — ssh 세션은 $HOME 에서 시작) → 정리된 서버 절대 경로 */
const remoteAbs = (p) => path.posix.resolve(REMOTE_HOME, p);
const toLocal = (p) => path.join(ROOT, ...remoteAbs(p).split('/').filter(Boolean));
function kindOf(local) {
  try {
    return fs.statSync(local).isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

// ── 공유 기록(따로 뜬 가짜 ssh 끼리) ──
const stateDir = () => path.join(ROOT, '.fake-ssh');
const stateFile = () => path.join(stateDir(), 'procs.jsonl');
function record(obj) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.appendFileSync(stateFile(), JSON.stringify(obj) + '\n');
}
/** 끝난 기록이 없는 띄우기 — { marker, pid, port, token }(pid 는 알림용 — 이걸로 끄지 않는다) */
function launched() {
  const live = new Map();
  let text = '';
  try {
    text = fs.readFileSync(stateFile(), 'utf8');
  } catch {
    return [];
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.launch?.token) live.set(r.launch.token, r.launch);
    else if (typeof r.gone === 'string') live.delete(r.gone);
  }
  return [...live.values()];
}
const CONTROL_TIMEOUT_MS = 3000;
/**
 * 지킴이에게 끄라고 한다 — 제어 포트에 비밀 한 줄. 우리 지킴이면 자식 claude 가 끝난 뒤 `killed <pid>` 로 답한다 → 그 pid.
 * 연결이 안 되거나(지킴이 없음) 다른 답·무응답(포트가 남의 것)이면 null — 아무것도 끄지 않는다
 */
function stopKeeper(rec) {
  return new Promise((resolve) => {
    let reply = '';
    let done = false;
    const sock = net.connect(Number(rec.port), '127.0.0.1');
    const end = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => end(null), CONTROL_TIMEOUT_MS);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${rec.token}\n`));
    sock.on('data', (d) => {
      reply += d;
      const m = /^killed (\d+)\n/.exec(reply);
      if (m) end(Number(m[1]));
      else if (reply.includes('\n') || reply.length > 64) end(null);
    });
    sock.on('error', () => end(null));
    sock.on('close', () => end(null));
  });
}

// ── 셸 단어 풀기(remote.ts 가 만드는 모양만큼) ──
// 명령은 따옴표 밖 ; 로 나눈다. 단어 = { value, home }(home = 따옴표 밖·큰따옴표 안의 $HOME 을 펼쳤다).
// 작은따옴표는 그대로, 큰따옴표는 \$ \` \" \\ 만 풀고 $HOME·${HOME} 을 펼친다. 다른 $변수는 글자 그대로 둔다.
const HOME_RE = /^\$(?:HOME(?![A-Za-z0-9_])|\{HOME\})/;
function tokenize(src) {
  const cmds = [];
  let cmd = [];
  let word = null;
  const add = (s, home = false) => {
    word ??= { value: '', home: false };
    word.value += s;
    if (home) word.home = true;
  };
  const push = () => {
    if (word) cmd.push(word);
    word = null;
  };
  const end = () => {
    push();
    if (cmd.length) cmds.push(cmd);
    cmd = [];
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error('닫히지 않은 작은따옴표');
      add(src.slice(i + 1, j));
      i = j + 1;
    } else if (ch === '"') {
      add('');
      i++;
      for (;;) {
        if (i >= src.length) throw new Error('닫히지 않은 큰따옴표');
        const c = src[i];
        if (c === '"') {
          i++;
          break;
        }
        if (c === '\\' && '$`"\\\n'.includes(src[i + 1] ?? '')) {
          if (src[i + 1] !== '\n') add(src[i + 1]);
          i += 2;
        } else if (c === '$' && HOME_RE.test(src.slice(i))) {
          add(REMOTE_HOME, true);
          i += HOME_RE.exec(src.slice(i))[0].length;
        } else {
          add(c);
          i++;
        }
      }
    } else if (ch === '\\') {
      if (src[i + 1] !== '\n') add(src[i + 1] ?? '');
      i += 2;
    } else if (ch === '$' && HOME_RE.test(src.slice(i))) {
      add(REMOTE_HOME, true);
      i += HOME_RE.exec(src.slice(i))[0].length;
    } else if (ch === ';' || ch === '\n') {
      end();
      i++;
    } else if (ch === ' ' || ch === '\t') {
      push();
      i++;
    } else {
      add(ch);
      i++;
    }
  }
  end();
  return cmds;
}
const values = (cmd) => cmd.map((w) => w.value);
const same = (cmd, list) => cmd.length === list.length && list.every((v, k) => v === null || cmd[k].value === v);

/** ssh 명령(인자를 띄어 이은 글) → bash -lc 의 스크립트. 그 모양이 아니면 null */
function scriptOf(command) {
  let cmds;
  try {
    cmds = tokenize(command);
  } catch {
    return null;
  }
  if (cmds.length !== 1) return null;
  const w = values(cmds[0]);
  const c = w.findIndex((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
  return w[0] === 'bash' && c > 0 && c === w.length - 2 ? w[c + 1] : null;
}

const SAFE = '[A-Za-z0-9._-]+';
/** 스크립트가 무엇인가 — remote.ts 의 네 모양 */
function classify(script) {
  if (script === null) return { kind: 'unknown' };
  if (!script.trim()) return { kind: 'empty' };
  // 정리(cleanupScript) — 셸 함수·/proc 를 쓰는 글이라 풀지 않고 글자에서 뽑는다:
  //   표식 `m=<에이전트>.<띄우기>;` · pid 는 `desc <pid>)`(/proc 있을 때·없을 때 두 번)와 `/proc/<pid>/environ` — 모두 같아야 한다
  //   · run 폴더 `rm -rf "$HOME/.dure/run/<에이전트>/<띄우기>"` — 표식과 같아야 한다
  if (script.includes('DURE_RUN=$1') && script.includes('rm -rf "$HOME/.dure/run/')) {
    const marker = new RegExp(`(?:^|; )m=(${SAFE});`).exec(script)?.[1];
    const pids = [...script.matchAll(/\bdesc (\d+)\)/g), ...script.matchAll(/\/proc\/(\d+)\/environ/g)].map((m) => Number(m[1]));
    const dir = new RegExp(`rm -rf "\\$HOME/\\.dure/run/(${SAFE})/(${SAFE})"`).exec(script);
    if (!marker || pids.length === 0 || new Set(pids).size !== 1 || !dir || `${dir[1]}.${dir[2]}` !== marker) return { kind: 'unknown' };
    return { kind: 'cleanup', pid: pids[0], marker, agentId: dir[1], launchId: dir[2] };
  }
  let cmds;
  try {
    cmds = tokenize(script);
  } catch {
    return { kind: 'unknown' };
  }
  // 띄우기(remoteLaunchScript) — d="…" · cd <폴더> || exit 3 · export DURE_RUN=<표식> · exec claude <인자…>
  const exec = cmds.find((c) => c[0]?.value === 'exec' && c[1]?.value === 'claude');
  if (exec) {
    const d = cmds.find((c) => c.length === 1 && c[0].value.startsWith('d='));
    const cd = cmds.find((c) => same(c, ['cd', null, '||', 'exit', '3']));
    const run = cmds.find((c) => c.length === 2 && c[0].value === 'export' && c[1].value.startsWith('DURE_RUN='));
    if (!d || !cd || !run) return { kind: 'unknown' };
    return {
      kind: 'launch',
      runDir: d[0].value.slice(2),
      folder: cd[1].value,
      marker: run[1].value.slice('DURE_RUN='.length),
      // 셸이 $HOME 을 펼친 인자(run 폴더의 mcp.json·prompt.md)는 가짜 claude 가 읽게 이 PC 경로로
      args: exec.slice(2).map((w) => (w.home ? toLocal(w.value) : w.value)),
    };
  }
  // 확인(checkScript) — [cd <폴더> && pwd -P || exit 3;] command -v claude >/dev/null || exit 127; claude --version
  const last = cmds.at(-1);
  if (last && same(last, ['claude', '--version'])) {
    const probe = cmds.at(-2);
    if (!probe || !same(probe, ['command', '-v', 'claude', '>/dev/null', '||', 'exit', '127'])) return { kind: 'unknown' };
    if (cmds.length === 2) return { kind: 'check', folder: null };
    if (cmds.length === 3 && same(cmds[0], ['cd', null, '&&', 'pwd', '-P', '||', 'exit', '3'])) return { kind: 'check', folder: cmds[0][1].value };
    return { kind: 'unknown' };
  }
  // 기록 확인(transcriptCheckScript) — d="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; for i in '<id>' …; do … done
  const loop = cmds.find((c) => same(c.slice(0, 3), ['for', 'i', 'in']));
  if (loop && script.includes('${CLAUDE_CONFIG_DIR:-$HOME/.claude}')) return { kind: 'transcripts', ids: values(loop.slice(3)) };
  return { kind: 'unknown' };
}

// ── ssh 인자 ──
const WITH_VALUE = new Set('BbcDEeFIiJLlmOopQRSWw');
function parseArgs(argv) {
  const o = { options: {}, forwards: [], port: null, login: null, host: null, command: '' };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    for (let j = 1; j < a.length; j++) {
      if (!WITH_VALUE.has(a[j])) continue;
      const v = j + 1 < a.length ? a.slice(j + 1) : argv[++i];
      if (a[j] === 'o') {
        const m = /^([^=\s]+)[=\s]+(.*)$/.exec(v ?? '');
        if (m) o.options[m[1].toLowerCase()] = m[2];
      } else if (a[j] === 'R') {
        const p = (v ?? '').split(':');
        const [rport, host, lport] = p.length === 4 ? p.slice(1) : p;
        o.forwards.push({ spec: v, remotePort: Number(rport), host, localPort: Number(lport) });
      } else if (a[j] === 'p') o.port = Number(v);
      else if (a[j] === 'l') o.login = v;
      break;
    }
  }
  o.host = argv[i] ?? null;
  o.command = argv.slice(i + 1).join(' ');
  return o;
}

// ── -R 중계: 서버의 127.0.0.1:<원격> → 이 PC 의 <host>:<로컬> ──
const relays = [];
const sockets = new Set();
function closeRelay() {
  for (const s of relays) s.close();
  for (const s of sockets) s.destroy();
}
function forward(f) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      const up = net.connect(f.localPort, f.host);
      for (const s of [sock, up]) {
        sockets.add(s);
        s.on('close', () => {
          sockets.delete(s);
          sock.destroy();
          up.destroy();
        });
      }
      sock.on('error', () => {});
      up.on('error', () => process.stderr.write(`connect_to ${f.host} port ${f.localPort}: failed.\n`));
      sock.pipe(up);
      up.pipe(sock);
    });
    server.once('error', () => resolve(false));
    server.listen(f.remotePort, '127.0.0.1', () => {
      relays.push(server);
      resolve(true);
    });
  });
}
/** portclash-once — 이 root 에서 처음 부른 쪽만 true(파일을 먼저 만든 쪽) */
function firstClash() {
  fs.mkdirSync(stateDir(), { recursive: true });
  try {
    fs.closeSync(fs.openSync(path.join(stateDir(), 'portclash-once'), 'wx'));
    return true;
  } catch {
    return false;
  }
}

function claudeCommand() {
  const v = process.env.FAKE_SSH_CLAUDE;
  if (!v) return [process.execPath, path.join(HERE, 'fakeClaude.mjs')];
  try {
    const a = JSON.parse(v);
    if (Array.isArray(a) && a.length > 0) return a.map(String);
  } catch {
    /* 명령 하나 */
  }
  return [v];
}

// ── 스크립트 실행 ──
function runCheck(spec, mode) {
  if (spec.folder !== null) {
    const remotePath = remoteAbs(spec.folder);
    const k = kindOf(toLocal(remotePath));
    if (k !== 'dir') return fail(3, `bash: line 1: cd: ${spec.folder}: ${k ? 'Not a directory' : 'No such file or directory'}`);
    process.stdout.write(remotePath + '\n'); // pwd -P — 링크는 풀지 않는다
  }
  if (mode === 'noclaude') return finish(127); // command -v 는 말없이 실패
  process.stdout.write(VERSION + '\n');
  finish(0);
}

function runTranscripts(spec) {
  const cfg = process.env.CLAUDE_CONFIG_DIR || toLocal(`${REMOTE_HOME}/.claude`);
  let dirs = [];
  try {
    dirs = fs.readdirSync(path.join(cfg, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  } catch {
    /* projects 없음 */
  }
  for (const id of spec.ids) {
    if (dirs.some((d) => fs.existsSync(path.join(cfg, 'projects', d.name, `${id}.jsonl`)))) process.stdout.write(id + '\n');
  }
  finish(0);
}

async function runCleanup(spec) {
  // 진짜: 표식을 가진 프로세스 ∪ (저장 pid 가 표식을 가졌으면 그 pid 와 나무). 가짜는 표식이 같은 띄우기의 지킴이에게 비밀로 끄라고 한다 —
  // 정리 명령의 pid 로는 아무것도 끄지 않는다(표식이 다른 pid 는 건드리지 않는 진짜와 같은 결과)
  const killed = (await Promise.all(launched().filter((r) => r.marker === spec.marker).map(stopKeeper))).filter((p) => p !== null);
  const extra = Number(process.env.FAKE_SSH_CLEANUP_MS ?? 0);
  if (extra) await sleep(extra);
  const runParent = toLocal(`${REMOTE_HOME}/.dure/run/${spec.agentId}`);
  const runDir = path.join(runParent, spec.launchId);
  const removed = kindOf(runDir) !== null;
  fs.rmSync(runDir, { recursive: true, force: true });
  try {
    fs.rmdirSync(runParent); // 비었을 때만
  } catch {
    /* 다른 띄우기가 남았거나 없음 */
  }
  log({ event: 'cleanup', pid: spec.pid, marker: spec.marker, killed, removed });
  finish(0);
}

/** stdin — 머리말 두 줄을 줄 단위로 읽고, 나머지는 claude 가 뜨면 그대로 넘긴다 */
function stdinReader() {
  let buf = Buffer.alloc(0);
  let ended = false;
  let wake = () => {};
  let sink = null;
  process.stdin.on('data', (d) => {
    if (sink) sink.write(d);
    else {
      buf = Buffer.concat([buf, d]);
      wake();
    }
  });
  const onEnd = () => {
    if (ended) return;
    ended = true;
    if (sink) sink.end();
    else wake();
  };
  process.stdin.on('end', onEnd);
  process.stdin.on('error', onEnd);
  return {
    /** IFS= read -r — 줄 하나(끝 \n 뺌). 입력이 끝났으면 남은 것 */
    async line() {
      for (;;) {
        const i = buf.indexOf(10);
        if (i >= 0) {
          const s = buf.subarray(0, i).toString('latin1');
          buf = buf.subarray(i + 1);
          return s;
        }
        if (ended) {
          const s = buf.toString('latin1');
          buf = Buffer.alloc(0);
          return s;
        }
        await new Promise((r) => (wake = r));
      }
    },
    /** 이제부터 받는 것은 s 로 — 이미 받아 둔 나머지를 먼저 */
    attach(s) {
      if (buf.length) s.write(buf);
      buf = Buffer.alloc(0);
      sink = s;
      if (ended) s.end();
    },
  };
}

async function runLaunch(spec, mode, host) {
  // 진짜 순서: mkdir -p run 폴더 → 머리말 두 줄 읽기 → 파일 쓰기 → cd(없으면 3) → DURE_PID → exec claude
  const runDir = toLocal(spec.runDir);
  fs.mkdirSync(runDir, { recursive: true });
  const input = stdinReader();
  const a = await input.line();
  const b = await input.line();
  fs.writeFileSync(path.join(runDir, 'mcp.json'), Buffer.from(a, 'base64'));
  fs.writeFileSync(path.join(runDir, 'prompt.md'), Buffer.from(b, 'base64'));
  const remotePath = remoteAbs(spec.folder);
  const cwd = toLocal(remotePath);
  const k = kindOf(cwd);
  if (k !== 'dir') return fail(3, `bash: line 1: cd: ${spec.folder}: ${k ? 'Not a directory' : 'No such file or directory'}`);
  const notFound = () => fail(127, 'bash: line 1: claude: command not found');
  if (mode === 'noclaude') {
    process.stderr.write(`DURE_PID=${process.pid}\n`); // 진짜도 셸 pid 를 먼저 알린 뒤 exec 에서 실패한다
    return notFound();
  }
  const drop = /^drop:(\d+)$/.exec(mode);
  const [cmd, ...pre] = claudeCommand();
  const env = { ...process.env, HOME: toLocal(REMOTE_HOME), DURE_RUN: spec.marker };
  // 지킴이 — detached: ssh 와 같은 수명이 아니다(서버의 claude 처럼 — 윈도에서 detached 가 아니면 ssh 가 끝날 때 함께 죽는다).
  // claude 는 지킴이의 보통 자식이라 지킴이가 죽으면 함께 죽는다(주인 없는 claude 는 남지 않는다)
  const keeper = spawn(process.execPath, [SELF, '--fake-keeper'], {
    cwd,
    env: { ...env, FAKE_SSH_KEEPER: JSON.stringify({ cmd, args: [...pre, ...spec.args], cwd, marker: spec.marker }) },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: true,
    windowsHide: true,
  });
  keeper.stdin.on('error', () => {});
  const ready = await new Promise((resolve) => {
    keeper.once('message', resolve);
    keeper.once('error', () => resolve(null));
    keeper.once('exit', () => resolve(null));
  });
  if (!ready?.ready) {
    process.stderr.write(`DURE_PID=${process.pid}\n`);
    return notFound();
  }
  const pid = ready.ready.pid;
  log({ event: 'launch', pid, marker: spec.marker, folder: remotePath, cwd, args: spec.args, runDir });
  process.stderr.write(`DURE_PID=${pid}\n`); // claude 의 stderr 보다 먼저 — 그새 온 것은 스트림에 쌓여 있다
  keeper.stdout.pipe(process.stdout, { end: false });
  keeper.stderr.pipe(process.stderr, { end: false });
  let dropped = false;
  keeper.on('close', (code) => {
    if (!dropped) finish(code ?? 255);
  });
  input.attach({
    write: (d) => keeper.stdin.write(d),
    end: () => {
      if (!dropped) keeper.stdin.end(); // 입력이 닫히면 진짜 claude 는 끝난다 — 지킴이가 EOF 를 넘긴다
    },
  });
  if (drop) {
    setTimeout(() => {
      if (exiting) return;
      dropped = true;
      keeper.stdout.unpipe(process.stdout);
      keeper.stderr.unpipe(process.stderr);
      log({ event: 'drop', pid });
      // 지킴이가 '끊김'을 받은 뒤에 끝낸다 — 그래야 이 프로세스가 끝나며 생기는 EOF 를 claude 에게 넘기지 않는다
      const go = () => fail(255, `Connection to ${host} closed by remote host.`);
      const late = setTimeout(go, 1000);
      keeper.on('message', (m) => {
        if (m?.dropped) {
          clearTimeout(late);
          go();
        }
      });
      try {
        keeper.send({ drop: true });
      } catch {
        go();
      }
    }, Number(drop[1]));
  }
}

const ORPHAN_MAX_MS = 10 * 60_000;
/**
 * 지킴이(--fake-keeper) — 가짜 claude 하나를 자식으로 띄워 stdio 를 잇고, 127.0.0.1 제어 포트에서 비밀 한 줄을 받으면 그 자식만 끈다.
 * 기록 { marker, pid, port, token } 을 남기고 ssh 에게 { ready: { pid } } 를 알린다. 끊김({ drop }) 뒤에는 입력 EOF 를 넘기지 않고
 * 출력을 버린다 — 진짜 서버의 남은 claude 처럼 정리될 때까지(안전 상한 ORPHAN_MAX_MS). 끝날 때 { gone: token }.
 */
async function keeperMain() {
  const cfg = JSON.parse(process.env.FAKE_SSH_KEEPER);
  delete process.env.FAKE_SSH_KEEPER;
  const token = randomBytes(16).toString('hex');
  const send = (m) => {
    try {
      if (process.connected) process.send(m);
    } catch {
      /* ssh 가 이미 없음 */
    }
  };
  const exitKeeper = (code) => {
    setTimeout(() => process.exit(code), 500); // 끊긴 뒤라 stdout 이 깨져 콜백이 안 와도
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  };
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  let child = null;
  let stoppedBy = null; // 비밀을 대고 끄라고 한 연결 — claude 가 끝난 뒤 답한다
  const control = net.createServer((sock) => {
    let line = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      line += d;
      const i = line.indexOf('\n');
      if (i < 0) {
        if (line.length > 64) sock.destroy();
        return;
      }
      if (line.slice(0, i) !== token || !child || stoppedBy) return void sock.destroy(); // 비밀이 다르면 아무것도 하지 않는다
      stoppedBy = sock;
      child.kill('SIGTERM'); // 자식 핸들로 — pid 를 다시 찾지 않는다
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    });
  });
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(0, '127.0.0.1', resolve);
  });
  const port = control.address().port;
  try {
    child = spawn(cfg.cmd, cfg.args, { cwd: cfg.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.on('error', () => {});
  } catch {
    child = null;
  }
  if (!child?.pid) {
    send({ notFound: true });
    control.close();
    return exitKeeper(127);
  }
  const pid = child.pid;
  let dropped = false;
  record({ launch: { marker: cfg.marker, pid, port, token } });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => dropped || process.stdout.write(d));
  child.stderr.on('data', (d) => dropped || process.stderr.write(d));
  process.stdin.on('data', (d) => dropped || child.stdin.write(d));
  process.stdin.on('end', () => dropped || child.stdin.end());
  process.stdin.on('error', () => {});
  process.on('message', (m) => {
    if (!m?.drop || dropped) return;
    dropped = true;
    setTimeout(() => child.kill('SIGKILL'), ORPHAN_MAX_MS).unref();
    send({ dropped: true });
  });
  process.on('disconnect', () => {});
  child.on('close', (code, signal) => {
    record({ gone: token });
    control.close();
    const status = stoppedBy || signal ? 255 : (code ?? 255); // 정리로 꺼진 claude — ssh 는 exit-signal 로 255
    if (stoppedBy) stoppedBy.end(`killed ${pid}\n`, () => exitKeeper(status));
    else exitKeeper(status);
  });
  send({ ready: { pid } });
}

function hostKeyChanged(host) {
  return [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Someone could be eavesdropping on you right now (man-in-the-middle attack)!',
    'It is also possible that a host key has just been changed.',
    'The fingerprint for the ED25519 key sent by the remote host is',
    'SHA256:fakefakefakefakefakefakefakefakefakefakefak.',
    'Please contact your system administrator.',
    'Add correct host key in ~/.ssh/known_hosts to get rid of this message.',
    'Offending ED25519 key in ~/.ssh/known_hosts:1',
    `Host key for ${host} has changed and you have requested strict checking.`,
    'Host key verification failed.',
  ].join('\n');
}

function readMode() {
  let mode = process.env.FAKE_SSH_MODE ?? '';
  const f = process.env.FAKE_SSH_MODE_FILE;
  if (f) {
    try {
      mode = fs.readFileSync(f, 'utf8').trim();
    } catch {
      /* 파일이 없으면 FAKE_SSH_MODE */
    }
  }
  return MODES.includes(mode) || /^drop:\d+$/.test(mode) ? mode : null;
}

/** 뒷정리 — 이 root 의 모든 지킴이에게 비밀로 끄라고 한다. 끈 claude pid 를 한 줄씩 */
async function reap() {
  const killed = (await Promise.all(launched().map(stopKeeper))).filter((p) => p !== null);
  process.stdout.write(killed.map((p) => `${p}\n`).join(''));
  finish(0);
}

async function main() {
  if (!ROOT) return fail(2, 'fakeSsh: FAKE_SSH_ROOT 가 필요해요');
  const argv = process.argv.slice(2);
  if (argv[0] === '--fake-keeper') return keeperMain();
  if (argv[0] === '--fake-reap') return reap();
  const o = parseArgs(argv);
  if (!o.host) return fail(255, 'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-o option] [-p port] [-R address] destination [command]');
  const at = o.host.lastIndexOf('@');
  const hostname = at >= 0 ? o.host.slice(at + 1) : o.host;
  const user = at >= 0 ? o.host.slice(0, at) : (o.login ?? USER);
  const port = o.port ?? (Number(o.options.port) || 22);
  const script = scriptOf(o.command);
  const spec = classify(script);
  log({ event: 'start', argv, host: o.host, user, port, forwards: o.forwards.map((f) => f.spec), command: o.command, script, kind: spec.kind });
  const mode = readMode();
  if (mode === null) return fail(2, `fakeSsh: 모르는 FAKE_SSH_MODE — ${MODES.filter(Boolean).join(' | ')} | drop:<ms>`);
  // 접속 단계
  if (mode === 'refused') return fail(255, `ssh: connect to host ${hostname} port ${port}: Connection refused`);
  if (mode === 'denied') return fail(255, `${user}@${hostname}: Permission denied (publickey).`);
  if (mode === 'hostkey') return fail(255, hostKeyChanged(hostname));
  // 역방향 터널 — ExitOnForwardFailure=yes 면 못 열 때 명령 전에 255
  const strict = (o.options.exitonforwardfailure ?? '').toLowerCase() === 'yes';
  for (const f of o.forwards) {
    const ok = !(mode === 'portclash-once' && firstClash()) && (await forward(f));
    if (ok) continue;
    if (strict) return fail(255, `Error: remote port forwarding failed for listen port ${f.remotePort}`);
    process.stderr.write(`Warning: remote port forwarding failed for listen port ${f.remotePort}\n`);
  }
  // 명령
  if (spec.kind === 'empty') return finish(0);
  if (spec.kind === 'check') return runCheck(spec, mode);
  if (spec.kind === 'transcripts') return runTranscripts(spec);
  if (spec.kind === 'cleanup') return runCleanup(spec);
  if (spec.kind === 'launch') return runLaunch(spec, mode, hostname);
  fail(2, 'fakeSsh: 모르는 서버 명령 — src/engine/remote.ts 가 만드는 스크립트만 흉내 낸다');
}

main().catch((e) => fail(2, `fakeSsh: ${e?.stack ?? e}`));
