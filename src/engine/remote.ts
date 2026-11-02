import path from 'node:path';
import { SPAWN_ENV_EXTRA } from './claudeArgs';
import type { RemoteIssue } from './types';

// 서버(SSH) 방 — 서버에서 claude 를 띄우고·확인하고·정리하는 명령과 종료 분류. 순수 함수만(프로세스·파일 없음).
// 서버 모양은 실측으로 정했다: docs/findings/2026-11-02-ssh-remote-probe.md (probe25)

/** ssh 대상 그대로 — 별칭 또는 `사용자@주소`(`:포트` 허용) */
export type RemoteHost = string;

export const SSH_OPTIONS: readonly string[] = [
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
];

export function hostArgs(host: RemoteHost): string[] {
  // 공백·빈 글·`-` 시작(ssh 옵션 끼워넣기)은 받지 않는다
  if (!host || /\s/.test(host) || host.startsWith('-')) throw new Error('서버 이름이 올바르지 않아요');
  const m = /^(.+):(\d{1,5})$/.exec(host);
  return m ? ['-p', m[2], m[1]] : [host];
}

/** POSIX 작은따옴표 감싸기 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// id 는 셸 명령·경로에 그대로 들어가니 안전한 글자만
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
/** 셸 명령·서버 경로에 그대로 넣어도 되는 id 인가 — 에이전트 id·띄우기 id(저장값을 읽을 때도 이것으로) */
export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id) && id !== '.' && !id.includes('..');
}
function safeId(id: string): string {
  if (!isSafeId(id)) throw new Error('올바르지 않은 id');
  return id;
}

/** 이 launch 의 서버 쪽 폴더(셸이 $HOME 을 펼친다) — launch 마다 달라 옛 launch 의 정리가 새 것을 건드리지 않는다 */
export function remoteRunDir(agentId: string, launchId: string): string {
  return `$HOME/.dure/run/${safeId(agentId)}/${safeId(launchId)}`;
}

/** claude 인자에 넣을 파일 경로 — remoteLaunchScript 가 이 둘만 큰따옴표(셸이 $HOME 을 펼침)로 내보낸다 */
export function remoteRunFiles(agentId: string, launchId: string): { mcp: string; prompt: string } {
  const d = remoteRunDir(agentId, launchId);
  return { mcp: `${d}/mcp.json`, prompt: `${d}/prompt.md` };
}

const marker = (agentId: string, launchId: string) => `${safeId(agentId)}.${safeId(launchId)}`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 서버에서 claude 띄우기 — 폴더로 먼저 간다(없으면 3: run 폴더도 토큰이 든 머리말 파일도 만들지 않는다 — 읽지 않은 머리말은 셸과 함께 버려진다).
 * 그다음 run 폴더에 머리말 두 줄을 풀고, pid 를 알리고, 표식과 이 PC 의 claude 와 같은 환경(SPAWN_ENV_EXTRA — ssh 는 환경을 넘기지 않는다)을 둔 뒤 exec
 */
export function remoteLaunchScript(a: { agentId: string; launchId: string; folder: string; claudeArgs: string[] }): string {
  const files = remoteRunFiles(a.agentId, a.launchId);
  const quoted = a.claudeArgs.map((x) => (x === files.mcp || x === files.prompt ? `"${x}"` : shq(x)));
  const env = Object.entries(SPAWN_ENV_EXTRA).map(([k, v]) => {
    if (!ENV_NAME.test(k)) throw new Error('올바르지 않은 환경 이름');
    return `export ${k}=${shq(v)}`;
  });
  return [
    'umask 077',
    `cd ${shq(a.folder)} || exit 3`,
    `d="${remoteRunDir(a.agentId, a.launchId)}"`,
    'mkdir -p "$d"',
    'IFS= read -r a',
    'IFS= read -r b',
    'printf %s "$a" | base64 -d > "$d/mcp.json"',
    'printf %s "$b" | base64 -d > "$d/prompt.md"',
    'echo "DURE_PID=$$" >&2',
    // claude·그 Bash 명령·손자가 물려받는 표식 — 정리가 고아가 된 것도 찾는다. setsid 는 쓰지 않는다(이미 세션 리더, 쓰면 깨짐)
    `export DURE_RUN=${marker(a.agentId, a.launchId)}`,
    ...env,
    `exec claude ${quoted.join(' ')}`,
  ].join('; ');
}

export function launchArgs(a: { host: RemoteHost; remotePort: number; localPort: number; script: string }): string[] {
  return [
    ...SSH_OPTIONS,
    '-R', `${a.remotePort}:127.0.0.1:${a.localPort}`,
    ...hostArgs(a.host),
    'bash -lc ' + shq(a.script),
  ];
}

/** ssh stdin 맨 앞 두 줄 — 토큰이 든 MCP 설정과 방 안내문(명령 인자에 안 싣는다) */
export function launchPreamble(mcpJson: string, prompt: string): string {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  return `${b64(mcpJson)}\n${b64(prompt)}\n`;
}

/**
 * 끄기 — 표식(DURE_RUN)을 가진 프로세스 ∪ claude 나무 → 그 pid 와 세션(SID) 전부 TERM → 2초 → KILL → run 폴더 지움.
 * Bash 명령은 각자 새 세션이라 `pkill -s` 만으로는 안 꺼진다(probe25). /proc 이 없으면 나무 + SID 까지만.
 * pgrep -f 는 쓰지 않는다(자기 셸을 잡는다).
 */
export function cleanupScript(a: { pid: number; agentId: string; launchId: string }): string {
  if (!Number.isInteger(a.pid) || a.pid <= 0) throw new Error('올바르지 않은 pid');
  const dir = remoteRunDir(a.agentId, a.launchId);
  return [
    `mk() { for e in /proc/[0-9]*/environ; do tr '\\0' '\\n' 2>/dev/null < "$e" | grep -qxF "DURE_RUN=$1" && { p=\${e#/proc/}; echo "\${p%/environ}"; }; done; }`,
    'desc() { for c in $(pgrep -P "$1"); do echo "$c"; desc "$c"; done; }',
    // 저장해 둔 pid 는 다른 프로세스가 물려받았을 수 있다 — /proc 이 있으면 표식이 맞을 때만 그 pid 와 나무를 넣는다
    `m=${marker(a.agentId, a.launchId)}`,
    `if [ -r /proc/self/environ ]; then l="$(mk $m)"; tr '\\0' '\\n' 2>/dev/null < /proc/${a.pid}/environ | grep -qxF "DURE_RUN=$m" && l="${a.pid} $(desc ${a.pid}) $l"; else l="${a.pid} $(desc ${a.pid})"; fi`,
    `ss=$(ps -o sid= -p "$(echo $l | tr ' ' ,)" 2>/dev/null | sort -u)`,
    'kill -TERM $l 2>/dev/null; for x in $ss; do pkill -TERM -s $x; done',
    'sleep 2',
    'kill -KILL $l 2>/dev/null; for x in $ss; do pkill -KILL -s $x; done',
    `rm -rf "${dir}"; rmdir "$HOME/.dure/run/${safeId(a.agentId)}" 2>/dev/null; true`,
  ].join('; ');
}

/**
 * 폴더가 있으면 새 줄에 DURE_DIR=<펼친 폴더>, 마지막 줄 = claude 버전(parseCheckOutput 이 읽는다). 종료 3 = 폴더 없음 · 127 = claude 없음.
 * 표식 앞에서 줄을 바꾼다 — 로그인 셸 프로필이 줄바꿈 없이 찍은 글이 경로에 붙지 않게
 */
export function checkScript(folder?: string): string {
  const tail = 'command -v claude >/dev/null || exit 127; claude --version';
  if (!folder) return tail;
  // 작은따옴표 안에서는 ~ 가 펼쳐지지 않는다 — ~ 와 ~/하위 는 $HOME 으로
  const cd = folder === '~' ? 'cd "$HOME"' : folder.startsWith('~/') ? `cd "$HOME"/${shq(folder.slice(2))}` : `cd ${shq(folder)}`;
  return `${cd} || exit 3; printf '\\nDURE_DIR='; pwd -P; ${tail}`;
}

/** checkScript 의 출력 — folder = 마지막 DURE_DIR= 줄(/ 로 시작할 때만), claudeVersion = 그 밖의 마지막 줄의 번호(앞의 프로필 잡음은 버린다) */
export function parseCheckOutput(stdout: string): { folder: string | null; claudeVersion: string | null } {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  const dir = lines.filter((l) => l.startsWith('DURE_DIR=')).at(-1)?.slice('DURE_DIR='.length) ?? null;
  const last = lines.filter((l) => !l.startsWith('DURE_DIR=')).at(-1)?.trim();
  // `claude --version` 은 번호 뒤에 이름이 붙는다 — 번호만
  const claudeVersion = last ? (/\d+(?:\.\d+)+\S*/.exec(last)?.[0] ?? last) : null;
  return { folder: dir?.startsWith('/') ? dir : null, claudeVersion };
}

// 서버의 claude 기록(projects 아래 <id>.jsonl)이 있는 id 만 한 줄씩
export function transcriptCheckScript(ids: string[]): string {
  if (ids.length === 0) return '';
  const list = ids.map((i) => shq(safeId(i))).join(' ');
  return `d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; for i in ${list}; do for f in "$d"/projects/*/"$i".jsonl; do [ -e "$f" ] && { echo "$i"; break; }; done; done`;
}

export type { RemoteIssueKind } from './types';

/**
 * ssh·서버 stderr 의 뜻 있는 줄 — 앞뒤 빈칸을 자르고 빈 줄·처음 보는 서버 키를 받아 둔 경고(accept-new)·띄우기의 DURE_PID 줄은 뺀다.
 * 접속 실패 첫 줄(classifyExit)과 엔진의 오류 글이 같이 쓴다
 */
export function sshErrorLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Warning: Permanently added/i.test(l) && !/^DURE_PID=\d+$/.test(l));
}

/**
 * ssh 가 끝난 까닭 — started = stdout 을 한 줄이라도 받았다 · pidSeen = 띄운 셸이 DURE_PID 를 알렸다(서버에서 명령이 돌기 시작했다 —
 * claude 가 없어도 셸은 먼저 알리니 started 와 따로). 어느 쪽이든 그 뒤의 255 는 끊김이다(stderr 의 프로필 잡음으로 가르지 않는다)
 */
export function classifyExit(a: { code: number | null; stderr: string; started: boolean; pidSeen?: boolean }): RemoteIssue | null {
  const { code, stderr } = a;
  // 시작한 뒤의 stderr 에는 로그인 프로필 잡음이 섞인다 — 끊김만 분류하고 나머지는 지금의 '예기치 않게 종료' 길로
  if (a.started) return code === 255 ? { kind: 'disconnected', detail: null } : null;
  if (code === 255) {
    if (/remote port forwarding failed/i.test(stderr)) return { kind: 'port', detail: null };
    if (a.pidSeen) return { kind: 'disconnected', detail: null };
    if (/Permission denied/i.test(stderr)) return { kind: 'denied', detail: null };
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) return { kind: 'hostkey', detail: null };
    return { kind: 'unreachable', detail: sshErrorLines(stderr)[0] ?? null };
  }
  if (code === 127 || /claude: (command )?not found/i.test(stderr)) return { kind: 'no-claude', detail: null };
  if (code === 3) return { kind: 'no-folder', detail: null };
  return null;
}

/** 띄운 셸이 stderr 로 알리는 `DURE_PID=<숫자>` — 정리 때 쓴다 */
export function parsePid(stderrChunk: string): number | null {
  const m = /^DURE_PID=(\d+)\r?\n/m.exec(stderrChunk);
  return m ? Number(m[1]) : null;
}

/** 서버 claude 로그인이 풀렸을 때의 결과 글 */
export function isLoginFailure(resultText: string): boolean {
  return /^\s*(Failed to authenticate|Invalid API key|Please run \/login)/i.test(resultText);
}

export function posixJoin(base: string, rel: string): string {
  return path.posix.resolve(base, rel);
}
