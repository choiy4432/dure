import path from 'node:path';

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
function safeId(id: string): string {
  if (!SAFE_ID.test(id) || id === '.' || id.includes('..')) throw new Error('올바르지 않은 id');
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

export function remoteLaunchScript(a: { agentId: string; launchId: string; folder: string; claudeArgs: string[] }): string {
  const files = remoteRunFiles(a.agentId, a.launchId);
  const quoted = a.claudeArgs.map((x) => (x === files.mcp || x === files.prompt ? `"${x}"` : shq(x)));
  return [
    'umask 077',
    `d="${remoteRunDir(a.agentId, a.launchId)}"`,
    'mkdir -p "$d"',
    'IFS= read -r a',
    'IFS= read -r b',
    'printf %s "$a" | base64 -d > "$d/mcp.json"',
    'printf %s "$b" | base64 -d > "$d/prompt.md"',
    `cd ${shq(a.folder)} || exit 3`,
    'echo "DURE_PID=$$" >&2',
    // claude·그 Bash 명령·손자가 물려받는 표식 — 정리가 고아가 된 것도 찾는다. setsid 는 쓰지 않는다(이미 세션 리더, 쓰면 깨짐)
    `export DURE_RUN=${marker(a.agentId, a.launchId)}`,
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

/** 폴더가 있으면 첫 줄 = 펼친 폴더, 마지막 줄 = claude 버전. 종료 3 = 폴더 없음 · 127 = claude 없음 */
export function checkScript(folder?: string): string {
  const tail = 'command -v claude >/dev/null || exit 127; claude --version';
  if (!folder) return tail;
  // 작은따옴표 안에서는 ~ 가 펼쳐지지 않는다 — ~ 와 ~/하위 는 $HOME 으로
  const cd = folder === '~' ? 'cd "$HOME"' : folder.startsWith('~/') ? `cd "$HOME"/${shq(folder.slice(2))}` : `cd ${shq(folder)}`;
  return `${cd} && pwd -P || exit 3; ${tail}`;
}

// 서버의 claude 기록(projects 아래 <id>.jsonl)이 있는 id 만 한 줄씩
export function transcriptCheckScript(ids: string[]): string {
  if (ids.length === 0) return '';
  const list = ids.map((i) => shq(safeId(i))).join(' ');
  return `d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; for i in ${list}; do for f in "$d"/projects/*/"$i".jsonl; do [ -e "$f" ] && { echo "$i"; break; }; done; done`;
}

export type RemoteIssueKind = 'unreachable' | 'denied' | 'hostkey' | 'no-claude' | 'no-folder' | 'disconnected' | 'login' | 'port';

export function classifyExit(a: { code: number | null; stderr: string; started: boolean }): { kind: RemoteIssueKind; detail: string | null } | null {
  const { code, stderr } = a;
  // 시작한 뒤의 stderr 에는 로그인 프로필 잡음이 섞인다 — 끊김만 분류하고 나머지는 지금의 '예기치 않게 종료' 길로
  if (a.started) return code === 255 ? { kind: 'disconnected', detail: null } : null;
  if (code === 255) {
    if (/remote port forwarding failed/i.test(stderr)) return { kind: 'port', detail: null };
    if (/Permission denied/i.test(stderr)) return { kind: 'denied', detail: null };
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) return { kind: 'hostkey', detail: null };
    const first = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^Warning: Permanently added/i.test(l)) ?? null;
    return { kind: 'unreachable', detail: first };
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
