import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hostArgs, SSH_OPTIONS, shq, remoteRunDir, remoteRunFiles, remoteLaunchScript, launchArgs, launchPreamble,
  cleanupScript, checkScript, updateScript, transcriptCheckScript, classifyExit, parsePid, isLoginFailure, posixJoin, parseCheckOutput, sshErrorLines, isSafeId,
  runArgs, forwardFailed,
} from '../src/engine/remote';
import { SPAWN_ENV_EXTRA } from '../src/engine/claudeArgs';

/** 윈도 경로 → Git Bash 경로(cygpath). 윈도우가 아니면 그대로, cygpath 가 없으면 null */
function toPosix(p: string): string | null {
  if (process.platform !== 'win32') return p;
  try { return execFileSync('cygpath', ['-u', p], { encoding: 'utf8', windowsHide: true }).trim() || null; } catch { return null; }
}
/**
 * bash 로 돌리는 시험은 bash 와 cygpath 가 둘 다 있고, cygpath 로 바꾼 임시 폴더를 그 bash 가 볼 때만 돈다.
 * PowerShell 에서 돌리면 cygpath 가 없고 bash 는 WSL 의 것이라, 윈도 경로가 그대로 넘어가 작업 폴더에
 * 'CUsers…Temp…dure-*' 쓰레기 폴더가 생겼다 — 그럴 땐 건너뛴다(Git Bash 에서 돌리면 돈다).
 */
const hasBash = (() => {
  try {
    if (spawnSync('bash', ['--version']).status !== 0) return false;
    const tmp = toPosix(tmpdir());
    return tmp !== null && spawnSync('bash', ['-c', 'test -d "$1"', 'bash', tmp]).status === 0;
  } catch { return false; }
})();
/** 윈도 경로 → bash 가 아는 경로 — hasBash 일 때만 쓴다. 못 바꾸면 던진다(윈도 경로를 그대로 넘겨 쓰레기 폴더를 만들지 않게) */
const posix = (p: string) => {
  const r = toPosix(p);
  if (r === null) throw new Error(`cygpath 없이는 bash 경로로 바꿀 수 없어요: ${p}`);
  return r;
};
/** 진짜 claude 가 없는 PATH — 이 PC 에 깔린 claude(Git Bash 는 윈도우 PATH 를 물려받는다)를 찾지 않게 */
const BARE_PATH = '/usr/bin:/bin';
/** 실행 파일 하나를 만든다(Git Bash 는 #! 로 실행 여부를 본다) */
function exe(file: string, body: string) {
  execFileSync('bash', ['-c', `mkdir -p "$(dirname ${shq(posix(file))})"`]);
  writeFileSync(file, `#!/bin/bash\n${body}`);
  execFileSync('bash', ['-c', `chmod +x ${shq(posix(file))}`]);
}

describe('hostArgs', () => {
  it('별칭은 그대로', () => expect(hostArgs('dev')).toEqual(['dev']));
  it('사용자@주소 그대로', () => expect(hostArgs('me@10.0.0.1')).toEqual(['me@10.0.0.1']));
  it('사용자@주소:포트 → -p', () => expect(hostArgs('me@10.0.0.1:2222')).toEqual(['-p', '2222', 'me@10.0.0.1']));
  it.each(['', '  ', '-oProxyCommand=x', 'a b', ' dev'])('올바르지 않은 이름 %j 은 던진다', (h) => {
    expect(() => hostArgs(h)).toThrow('서버 이름이 올바르지 않아요');
  });
});

describe('SSH_OPTIONS', () => {
  it('필수 옵션 — 모든 호출에 RemoteCommand=none · 전달 실패로 끝내기는 공통에 없다', () => {
    const s = SSH_OPTIONS.join(' ');
    for (const o of ['-T', 'BatchMode=yes', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ConnectTimeout=10', 'StrictHostKeyChecking=accept-new', 'RemoteCommand=none']) {
      expect(s).toContain(o);
    }
    expect(s).not.toContain('ExitOnForwardFailure');
  });
});

describe('runArgs — 확인·정리·기록 확인 ssh', () => {
  it('전달을 모두 지운다(ClearAllForwardings) · RemoteCommand=none · -R 없음 · 확인은 bash -lc', () => {
    const a = runArgs({ host: 'me@h:2222', script: `echo 'x'` });
    expect(a).toEqual(expect.arrayContaining(['-o', 'ClearAllForwardings=yes', 'RemoteCommand=none', 'BatchMode=yes', 'ConnectTimeout=10']));
    expect(a).not.toContain('-R');
    expect(a.join(' ')).not.toContain('ExitOnForwardFailure');
    expect(a.slice(-4)).toEqual(['-p', '2222', 'me@h', `bash -lc 'echo '\\''x'\\'''`]);
  });
  it('정리는 bash -c(로그인 프로필을 읽지 않는다) · 접속 한도', () => {
    const a = runArgs({ host: 'dev', script: 'true', login: false, connectTimeout: 5 });
    expect(a.at(-1)).toBe(`bash -c 'true'`);
    expect(a).toContain('ConnectTimeout=5');
    expect(a).not.toContain('ConnectTimeout=10');
  });
});


describe('shq — 공백·따옴표·$ 경로', () => {
  it('작은따옴표를 이스케이프', () => expect(shq(`/srv/my app/it's $HOME`)).toBe(`'/srv/my app/it'\\''s $HOME'`));
  it.skipIf(!hasBash)('bash 가 그대로 되돌린다', () => {
    const raw = `/srv/my app/it's $HOME \`x\` "q" ;rm -rf`;
    const r = spawnSync('bash', ['-c', `printf %s ${shq(raw)}`], { encoding: 'utf8' });
    expect(r.stdout).toBe(raw);
  });
});

describe('실행 폴더', () => {
  it('launch 마다 다른 폴더', () => {
    expect(remoteRunDir('ag1', 'ab12cd34')).toBe('$HOME/.dure/run/ag1/ab12cd34');
    expect(remoteRunFiles('ag1', 'ab12cd34')).toEqual({
      mcp: '$HOME/.dure/run/ag1/ab12cd34/mcp.json',
      prompt: '$HOME/.dure/run/ag1/ab12cd34/prompt.md',
    });
  });
  it('id 에 셸 글자가 있으면 던진다', () => {
    expect(() => remoteRunDir('a;b', 'x')).toThrow();
    expect(() => remoteRunDir('a', '$(x)')).toThrow();
    expect(() => remoteRunDir('', 'x')).toThrow();
    for (const bad of ['.', '..', 'a..b']) {
      expect(() => remoteRunDir(bad, 'x')).toThrow();
      expect(() => remoteRunDir('a', bad)).toThrow();
    }
  });
});

describe('remoteLaunchScript', () => {
  const files = remoteRunFiles('ag1', 'ab12cd34');
  const make = (folder = '/home/a/web') => remoteLaunchScript({
    agentId: 'ag1', launchId: 'ab12cd34', folder,
    claudeArgs: ['-p', '--mcp-config', files.mcp, '--append-system-prompt-file', files.prompt, '--model', 'haiku'],
  });
  it('폴더는 shq, 경로는 큰따옴표, setsid 없음', () => {
    const s = make(`/srv/my app/it's $HOME`);
    expect(s).toContain(`cd '/srv/my app/it'\\''s $HOME' || exit 3`);
    expect(s).toContain(`'--mcp-config' "$HOME/.dure/run/ag1/ab12cd34/mcp.json"`);
    expect(s).toContain(`'--append-system-prompt-file' "$HOME/.dure/run/ag1/ab12cd34/prompt.md"`);
    expect(s).toContain('echo "DURE_PID=$$" >&2');
    expect(s).not.toContain('setsid');
    // 이 PC 의 claude 와 같은 환경(SPAWN_ENV_EXTRA) — 표식 바로 뒤, exec 바로 앞. ssh 는 환경을 넘기지 않는다
    const extra = Object.entries(SPAWN_ENV_EXTRA).map(([k, v]) => `export ${k}=${shq(v)}; `).join('');
    expect(extra).toContain("export MCP_TOOL_TIMEOUT='86400000'; ");
    expect(s).toContain(`export DURE_RUN=ag1.ab12cd34; ${extra}exec "$c" `);
  });
  it('cd·claude 찾기가 먼저 — 폴더나 claude 가 없으면 run 폴더·머리말 파일을 만들기 전에 끝난다 · umask 077 은 파일 쓰기에만 · pid·표식·exec 는 그 뒤', () => {
    const s = make('/home/a/web');
    const at = (x: string) => {
      const i = s.indexOf(x);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      "cd '/home/a/web' || exit 3", 'c=$(command -v claude)', '|| exit 127', 'o=$(umask)', 'umask 077', 'mkdir -p "$d"', 'IFS= read -r a', 'IFS= read -r b',
      'base64 -d > "$d/mcp.json"', 'base64 -d > "$d/prompt.md"', 'umask "$o"', 'echo "DURE_PID=$$" >&2', 'export DURE_RUN=', 'export MCP_TOOL_TIMEOUT=', 'exec "$c" ',
    ].map(at);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });
  it('토큰·포트가 스크립트에 없다', () => {
    expect(make()).not.toMatch(/Bearer|127\.0\.0\.1|token/i);
  });
  it('일반 인자는 shq', () => {
    const s = remoteLaunchScript({ agentId: 'a', launchId: 'b', folder: '/x', claudeArgs: ['-n', `it's me`] });
    expect(s).toContain(`'-n' 'it'\\''s me'`);
  });
  it.skipIf(!hasBash)('bash 로 돌려 보면: 머리말 풀기·$HOME 펼침·폴더·인자 보존', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dure-remote-'));
    try {
      const fake = join(tmp, 'bin');
      const home = join(tmp, 'home');
      const folder = `${posix(join(tmp, 'my app'))}/it's $HOME`;
      execFileSync('bash', ['-c', `mkdir -p ${shq(posix(fake))} ${shq(posix(home))} ${shq(folder)}`]);
      writeFileSync(join(fake, 'claude'), '#!/bin/bash\nprintf "[%s]\\n" "$@"\npwd\necho "RUN=$DURE_RUN"\necho "TIMEOUT=$MCP_TOOL_TIMEOUT"\necho "UMASK=$(umask)"\ncat\n');
      execFileSync('bash', ['-c', `chmod +x ${shq(posix(fake))}/claude`]);
      const script = remoteLaunchScript({
        agentId: 'ag1', launchId: 'ab12cd34', folder,
        claudeArgs: ['-p', '--mcp-config', files.mcp, '--append-system-prompt-file', files.prompt, '-n', `it's $x`],
      });
      const mcp = '{"t":"a\'b"}', prompt = 'hello $HOME `x` "q"\n';
      const { MCP_TOOL_TIMEOUT: _drop, ...outer } = process.env; // 서버 쪽 환경엔 없다 — 스크립트가 넣어야 한다
      const r = spawnSync('bash', ['-c', script], {
        input: launchPreamble(mcp, prompt) + 'REST\n',
        encoding: 'utf8',
        env: { ...outer, HOME: posix(home), PATH: `${posix(fake)}:${process.env.PATH}` },
      });
      expect(r.stderr).toMatch(/DURE_PID=\d+/);
      const out = r.stdout.split('\n');
      expect(out).toContain(`[${posix(home)}/.dure/run/ag1/ab12cd34/mcp.json]`);
      expect(out).toContain(`[${posix(home)}/.dure/run/ag1/ab12cd34/prompt.md]`);
      expect(out).toContain(`[it's $x]`);
      expect(out).toContain(folder);
      expect(out).toContain('RUN=ag1.ab12cd34');
      expect(out).toContain(`TIMEOUT=${SPAWN_ENV_EXTRA.MCP_TOOL_TIMEOUT}`);
      // umask 077 은 머리말 파일에만 — claude 와 그 명령은 셸의 원래 umask 로(서버에 만든 파일을 같은 그룹이 못 읽게 되지 않게)
      const shellMask = spawnSync('bash', ['-c', 'umask'], { encoding: 'utf8' }).stdout.trim();
      expect(shellMask).not.toBe('0077');
      expect(out).toContain(`UMASK=${shellMask}`);
      expect(out).toContain('REST');
      const dir = join(home, '.dure', 'run', 'ag1', 'ab12cd34');
      expect(readFileSync(join(dir, 'mcp.json'), 'utf8')).toBe(mcp);
      expect(readFileSync(join(dir, 'prompt.md'), 'utf8')).toBe(prompt);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('remoteLaunchScript·checkScript — claude 찾기(PATH → ~/.local/bin → ~/.claude/local → nvm)', () => {
  const files = remoteRunFiles('ag1', 'ab12cd34');
  /** 임시 $HOME 과 서버 폴더 — 진짜 claude 가 없는 PATH 로 */
  function server() {
    const tmp = mkdtempSync(join(tmpdir(), 'dure-find-'));
    const home = join(tmp, 'home');
    const work = join(tmp, 'work');
    execFileSync('bash', ['-c', `mkdir -p ${shq(posix(home))} ${shq(posix(work))}`]);
    // PATH 는 셸 안에서 바꾼다 — 바깥 env 의 PATH 는 윈도우가 bash 를 찾는 데 쓴다
    const { NVM_DIR: _n, ...rest } = process.env;
    const env = { ...rest, HOME: posix(home) };
    const launch = (path = BARE_PATH) =>
      spawnSync('bash', ['-c', `PATH=${shq(path)}; ` + remoteLaunchScript({ agentId: 'ag1', launchId: 'ab12cd34', folder: posix(work), claudeArgs: ['--mcp-config', files.mcp, '-p'] })], {
        input: launchPreamble('{"t":"secret"}', 'p'), encoding: 'utf8', env,
      });
    const check = () => spawnSync('bash', ['-c', `PATH=${shq(BARE_PATH)}; ` + checkScript(posix(work))], { encoding: 'utf8', env });
    return { tmp, home, work, launch, check, done: () => rmSync(tmp, { recursive: true, force: true }) };
  }
  const CLAUDE = (who: string) => `if [ "$1" = --version ]; then echo "2.1.304 (Claude Code)"; exit 0; fi\necho "FOUND=${who}"; printf "[%s]\\n" "$@"\n`;

  it.skipIf(!hasBash)('PATH 에 없고 ~/.local/bin 에만 있으면 그것으로 띄우고 확인한다', () => {
    const t = server();
    try {
      exe(join(t.home, '.local', 'bin', 'claude'), CLAUDE('local-bin'));
      const r = t.launch();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('FOUND=local-bin');
      expect(r.stdout).toContain(`[${posix(t.home)}/.dure/run/ag1/ab12cd34/mcp.json]`);
      expect(parseCheckOutput(t.check().stdout)).toEqual({ folder: expect.any(String), claudeVersion: '2.1.304' });
    } finally { t.done(); }
  });
  it.skipIf(!hasBash)('~/.claude/local 에만 있어도', () => {
    const t = server();
    try {
      exe(join(t.home, '.claude', 'local', 'claude'), CLAUDE('claude-local'));
      expect(t.launch().stdout).toContain('FOUND=claude-local');
      expect(parseCheckOutput(t.check().stdout).claudeVersion).toBe('2.1.304');
    } finally { t.done(); }
  });
  it.skipIf(!hasBash)('nvm — nvm.sh 를 읽은 뒤 PATH 에서(NVM_DIR 이 없으면 ~/.nvm)', () => {
    const t = server();
    try {
      exe(join(t.home, '.nvm', 'versions', 'node', 'v22', 'bin', 'claude'), CLAUDE('nvm'));
      writeFileSync(join(t.home, '.nvm', 'nvm.sh'), 'export PATH="$HOME/.nvm/versions/node/v22/bin:$PATH"\necho nvm-noise\n');
      const r = t.launch();
      expect(r.stdout).toContain('FOUND=nvm');
      expect(r.stdout).not.toContain('nvm-noise');
      expect(parseCheckOutput(t.check().stdout).claudeVersion).toBe('2.1.304');
    } finally { t.done(); }
  });
  it.skipIf(!hasBash)('PATH 에 있으면 그것이 먼저', () => {
    const t = server();
    try {
      exe(join(t.tmp, 'bin', 'claude'), CLAUDE('path'));
      exe(join(t.home, '.local', 'bin', 'claude'), CLAUDE('local-bin'));
      expect(t.launch(`${posix(join(t.tmp, 'bin'))}:${BARE_PATH}`).stdout).toContain('FOUND=path');
    } finally { t.done(); }
  });
  it.skipIf(!hasBash)('어디에도 없으면 127 — 띄우기는 DURE_PID 도 run 폴더(토큰 파일)도 남기지 않는다', () => {
    const t = server();
    try {
      const r = t.launch();
      expect(r.status).toBe(127);
      expect(r.stderr).not.toMatch(/DURE_PID=/);
      expect(existsSync(join(t.home, '.dure'))).toBe(false);
      expect(t.check().status).toBe(127);
    } finally { t.done(); }
  });
});

describe('remoteLaunchScript — 없는 폴더', () => {
  it.skipIf(!hasBash)('bash 로 돌리면 3 으로 끝나고 서버에 run 폴더(토큰 파일)를 남기지 않는다', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dure-nofolder-'));
    try {
      const home = join(tmp, 'home');
      execFileSync('bash', ['-c', `mkdir -p ${shq(posix(home))}`]);
      const files = remoteRunFiles('ag1', 'ab12cd34');
      const script = remoteLaunchScript({ agentId: 'ag1', launchId: 'ab12cd34', folder: `${posix(tmp)}/nope`, claudeArgs: ['--mcp-config', files.mcp] });
      const r = spawnSync('bash', ['-c', script], { input: launchPreamble('{"t":"secret"}', 'p'), encoding: 'utf8', env: { ...process.env, HOME: posix(home) } });
      expect(r.status).toBe(3);
      expect(r.stderr).not.toMatch(/DURE_PID=/);
      expect(existsSync(join(home, '.dure'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('launchArgs', () => {
  it('옵션·역터널(서버 쪽도 127.0.0.1)·호스트·명령 · 전달을 못 열면 명령 전에 끝낸다(남이 쥔 포트로 토큰이 가지 않게) · RemoteCommand=none', () => {
    const a = launchArgs({ host: 'me@h:2222', remotePort: 41000, localPort: 5123, script: `echo 'x'` });
    expect(a).toContain('-T');
    expect(a).toContain('BatchMode=yes');
    expect(a).toEqual(expect.arrayContaining(['-o', 'ExitOnForwardFailure=yes', 'RemoteCommand=none']));
    expect(a).toEqual(expect.arrayContaining(['-o', 'ControlPath=none'])); // 설정 파일의 연결 공유(ControlMaster)를 거치지 않는다 — 전달 실패를 이 ssh 가 직접 받게
    expect(a).not.toContain('ClearAllForwardings=yes'); // 명령줄 -R 까지 지운다
    const i = a.indexOf('-R');
    expect(a[i + 1]).toBe('127.0.0.1:41000:127.0.0.1:5123');
    expect(a.slice(-4)).toEqual(['-p', '2222', 'me@h', `bash -lc 'echo '\\''x'\\'''`]);
  });
});

describe('forwardFailed — 우리 원격 포트의 전달 실패 줄만', () => {
  it('그 포트면 true · 다른 포트·앞자리만 같은 포트는 false', () => {
    expect(forwardFailed('Warning: remote port forwarding failed for listen port 41000\n', 41000)).toBe(true);
    expect(forwardFailed('Error: remote port forwarding failed for listen port 41000', 41000)).toBe(true);
    expect(forwardFailed('Warning: remote port forwarding failed for listen port 5555\n', 41000)).toBe(false);
    expect(forwardFailed('Warning: remote port forwarding failed for listen port 410001\n', 41000)).toBe(false);
  });
});

describe('launchPreamble', () => {
  it('base64 두 줄', () => {
    const p = launchPreamble('{"a":"한글"}', 'x\ny');
    const lines = p.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(Buffer.from(lines[0], 'base64').toString('utf8')).toBe('{"a":"한글"}');
    expect(Buffer.from(lines[1], 'base64').toString('utf8')).toBe('x\ny');
  });
});

describe('cleanupScript', () => {
  const s = cleanupScript({ pid: 4242, agentId: 'ag1', launchId: 'ab12cd34' });
  it('표식(grep 한 번)·나무·SID·TERM→KILL→run 폴더', () => {
    expect(s).toContain('m=ag1.ab12cd34');
    expect(s).toContain('grep -lzxF "DURE_RUN=$m" /proc/[0-9]*/environ 2>/dev/null');
    expect(s).toContain('grep -qzxF "DURE_RUN=$m" /proc/4242/environ');
    expect(s).toContain('[ -r /proc/self/environ ]');
    expect(s).toContain('desc 4242');
    expect(s).not.toContain(`tr '\\0'`);
    expect(s).not.toContain('for e in /proc');
    expect(s.indexOf('-TERM')).toBeLessThan(s.indexOf('sleep 2'));
    expect(s.indexOf('sleep 2')).toBeLessThan(s.indexOf('-KILL'));
    expect(s).toContain('rm -rf "$HOME/.dure/run/ag1/ab12cd34"');
    expect(s).not.toMatch(/pgrep -f|pkill -f/);
  });
  it('이상한 pid·id 는 던진다', () => {
    expect(() => cleanupScript({ pid: -1, agentId: 'a', launchId: 'b' })).toThrow();
    expect(() => cleanupScript({ pid: 1.5, agentId: 'a', launchId: 'b' })).toThrow();
    expect(() => cleanupScript({ pid: 1, agentId: 'a b', launchId: 'b' })).toThrow();
  });
  it.skipIf(!hasBash)('bash 문법이 맞다', () => {
    expect(spawnSync('bash', ['-n', '-c', s]).status).toBe(0);
    expect(spawnSync('bash', ['-n', '-c', remoteLaunchScript({ agentId: 'a', launchId: 'b', folder: '/x', claudeArgs: [] })]).status).toBe(0);
  });
  it.skipIf(!hasBash)('표식을 가진 프로세스는 다른 세션·고아여도 끄고, 표식 없는 것은 남긴다', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dure-mark-'));
    const pids: string[] = [];
    try {
      // 표식 둘(하나는 setsid 없이 새 프로세스 그룹·하나는 부모가 끝난 고아) + 표식 없는 하나 — 모두 sleep
      const r = spawnSync('bash', ['-c', [
        'DURE_RUN=ag1.ab12cd34 sleep 61 >/dev/null 2>&1 & echo $!',
        "bash -c 'DURE_RUN=ag1.ab12cd34 sleep 62 >/dev/null 2>&1 & echo $!' ",
        'sleep 63 >/dev/null 2>&1 & echo $!',
      ].join('; ')], { encoding: 'utf8' });
      pids.push(...r.stdout.trim().split(/\s+/));
      const marked = () => spawnSync('bash', ['-c', 'grep -lzxF "DURE_RUN=ag1.ab12cd34" /proc/[0-9]*/environ 2>/dev/null | wc -l'], { encoding: 'utf8' }).stdout.trim();
      const plainAlive = () => spawnSync('bash', ['-c', `kill -0 ${pids[2]}`]).status === 0;
      // 뒤로 띄운 프로세스가 /proc 에 보일 때까지(Git Bash 는 조금 늦다)
      const wait = (ok: () => boolean) => { for (let i = 0; i < 30 && !ok(); i++) spawnSync('bash', ['-c', 'sleep 0.1']); };
      wait(() => Number(marked()) >= 2);
      expect(Number(marked())).toBeGreaterThanOrEqual(2);
      expect(plainAlive()).toBe(true);
      const c = spawnSync('bash', ['-c', cleanupScript({ pid: 2147483646, agentId: 'ag1', launchId: 'ab12cd34' })], { encoding: 'utf8', env: { ...process.env, HOME: posix(tmp) } });
      expect(c.status).toBe(0);
      wait(() => marked() === '0');
      expect(marked()).toBe('0');
      expect(plainAlive()).toBe(true);
    } finally {
      spawnSync('bash', ['-c', `kill -9 ${pids.join(' ')} 2>/dev/null; true`]);
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30000);
  it.skipIf(!hasBash)('실행하면 run 폴더를 지우고 없는 pid 에도 끝까지 간다', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dure-clean-'));
    try {
      const dir = join(tmp, '.dure', 'run', 'ag1', 'ab12cd34');
      execFileSync('bash', ['-c', `mkdir -p ${shq(posix(dir))}`]);
      writeFileSync(join(dir, 'mcp.json'), '{}');
      const r = spawnSync('bash', ['-c', cleanupScript({ pid: 2147483646, agentId: 'ag1', launchId: 'ab12cd34' })], {
        encoding: 'utf8', env: { ...process.env, HOME: posix(tmp) },
      });
      expect(r.status).toBe(0);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30000);
});

describe('cleanupScript — 표식이 안 맞는 pid 는 건드리지 않는다', () => {
  it.skipIf(!hasBash)('남의 살아 있는 프로세스는 그대로', () => {
    const holder = spawnSync('bash', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!; disown'], { encoding: 'utf8' });
    const pid = Number(holder.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    try {
      const alive = () => spawnSync('bash', ['-c', `kill -0 ${pid}`]).status === 0;
      expect(alive()).toBe(true);
      const tmp = mkdtempSync(join(tmpdir(), 'dure-guard-'));
      try {
        const r = spawnSync('bash', ['-c', cleanupScript({ pid, agentId: 'ag1', launchId: 'ab12cd34' })], { encoding: 'utf8', env: { ...process.env, HOME: posix(tmp) } });
        expect(r.status).toBe(0);
      } finally { rmSync(tmp, { recursive: true, force: true }); }
      expect(alive()).toBe(true);
    } finally {
      spawnSync('bash', ['-c', `kill -9 ${pid} 2>/dev/null; true`]);
    }
  }, 30000);
});

describe('updateScript', () => {
  it('updateScript — claude 찾기 뒤 update', () => {
    const s = updateScript();
    expect(s.startsWith('c=$(command -v claude); ')).toBe(true);
    expect(s).toContain('[ -n "$c" ] || exit 127');
    expect(s.endsWith('; "$c" update')).toBe(true);
    expect(s).not.toContain('--version');
  });
});

describe('checkScript', () => {
  it('폴더 없이 — 띄우기와 같은 claude 찾기 뒤 버전', () => {
    const s = checkScript();
    expect(s.startsWith('c=$(command -v claude); ')).toBe(true);
    expect(s).toContain('[ -n "$c" ] || exit 127');
    expect(s.endsWith('; "$c" --version')).toBe(true);
  });
  it('폴더 있으면 cd 뒤 새 줄에 표식 DURE_DIR= + pwd -P — 로그인 셸 프로필이 줄바꿈 없이 찍어도 붙지 않게', () => {
    expect(checkScript(`/a b/it's`).startsWith(`cd '/a b/it'\\''s' || exit 3; printf '\\nDURE_DIR='; pwd -P; c=$(command -v claude); `)).toBe(true);
  });
});

describe('checkScript — ~', () => {
  it('~ 는 $HOME 으로', () => {
    expect(checkScript('~')).toContain(`cd "$HOME" || exit 3; printf '\\nDURE_DIR='; pwd -P;`);
    expect(checkScript('~/my dir')).toContain(`cd "$HOME"/'my dir' || exit 3;`);
  });
  it.skipIf(!hasBash)('bash 에서 ~/my dir 이 $HOME 아래로 풀린다', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dure-tilde-'));
    try {
      execFileSync('bash', ['-c', `mkdir -p ${shq(posix(tmp))}/"my dir"`]);
      const run = (f: string) => spawnSync('bash', ['-c', checkScript(f).split('; c=$(command')[0]], { encoding: 'utf8', env: { ...process.env, HOME: posix(tmp) } });
      const r = run('~/my dir');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^\nDURE_DIR=.*my dir\n$/);
      expect(run('~').status).toBe(0);
      expect(run('~/nope').status).toBe(3);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('transcriptCheckScript', () => {
  it('빈 목록은 빈 글', () => expect(transcriptCheckScript([])).toBe(''));
  it('id 를 shq 로, 이상한 id 는 던진다', () => {
    const s = transcriptCheckScript(['abc-123', 'def']);
    expect(s).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
    expect(s).toContain(`'abc-123' 'def'`);
    expect(() => transcriptCheckScript(['a;b'])).toThrow();
  });
  it.skipIf(!hasBash)('있는 id 만 출력한다', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dure-tr-'));
    try {
      execFileSync('bash', ['-c', `mkdir -p ${shq(posix(tmp))}/cfg/projects/-p1`]);
      writeFileSync(join(tmp, 'cfg', 'projects', '-p1', 'aaa-111.jsonl'), '');
      const r = spawnSync('bash', ['-c', transcriptCheckScript(['aaa-111', 'bbb-222'])], {
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: `${posix(tmp)}/cfg` },
      });
      expect(r.stdout.trim().split('\n')).toEqual(['aaa-111']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('classifyExit', () => {
  const c = (code: number | null, stderr = '', started = false) => classifyExit({ code, stderr, started });
  it('포트 — 이 띄우기의 원격 포트 줄일 때만(설정 파일의 다른 전달 실패는 접속 실패 쪽으로)', () => {
    const p = (stderr: string) => classifyExit({ code: 255, stderr, started: false, port: 41000 });
    expect(p('Error: remote port forwarding failed for listen port 41000')?.kind).toBe('port');
    expect(p('Warning: remote port forwarding failed for listen port 5555\nssh: connect to host h port 22: Connection refused')?.kind).toBe('unreachable');
    expect(c(255, 'Error: remote port forwarding failed for listen port 41000')?.kind).toBe('unreachable'); // 확인 ssh — 전달이 없다
  });
  it('윈도우 OpenSSH 의 -1(4294967295) 은 255 와 같다 — 연결 도중 끊김(실측)', () => {
    for (const code of [4294967295, -1]) {
      expect(c(code, 'Connection to h closed by remote host.', true)).toEqual({ kind: 'disconnected', detail: null });
      expect(classifyExit({ code, stderr: 'DURE_PID=12\nConnection to h closed by remote host.', started: false, pidSeen: true })).toEqual({ kind: 'disconnected', detail: null });
      expect(c(code, 'me@h: Permission denied (publickey).')?.kind).toBe('denied');
      expect(c(code, 'ssh: connect to host h port 22: Connection timed out')).toEqual({ kind: 'unreachable', detail: 'ssh: connect to host h port 22: Connection timed out' });
    }
  });
  it('키 거절', () => expect(c(255, 'me@h: Permission denied (publickey).')?.kind).toBe('denied'));
  it('키 바뀜', () => {
    expect(c(255, '@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @')?.kind).toBe('hostkey');
    expect(c(255, 'Host key verification failed.')?.kind).toBe('hostkey');
  });
  it('255 시작 전 = unreachable + 첫 줄', () => {
    expect(c(255, '\nssh: connect to host h port 22: Connection timed out\nmore')).toEqual({ kind: 'unreachable', detail: 'ssh: connect to host h port 22: Connection timed out' });
  });
  it('255 시작 뒤 = disconnected', () => expect(c(255, 'Connection reset', true)?.kind).toBe('disconnected'));
  it('127 · command not found', () => {
    expect(c(127)?.kind).toBe('no-claude');
    expect(c(1, 'bash: claude: command not found')?.kind).toBe('no-claude');
  });
  it('시작 뒤: 잡음은 분류하지 않고 255 만 끊김', () => {
    expect(c(1, 'bash: nvm: command not found', true)).toBeNull();
    expect(c(0, 'bash: claude: command not found', true)).toBeNull();
    expect(c(127, '', true)).toBeNull();
    expect(c(255, 'Permission denied noise', true)).toEqual({ kind: 'disconnected', detail: null });
  });
  it('시작 전: 프로필 잡음(nvm)은 no-claude 가 아니다', () => expect(c(1, 'bash: nvm: command not found')).toBeNull());
  it('DURE_PID 뒤(pidSeen)의 255 는 stderr 에 무엇이 섞여도 끊김 · 127 은 그대로 claude 없음', () => {
    const p = (code: number, stderr: string) => classifyExit({ code, stderr, started: false, pidSeen: true });
    expect(p(255, 'DURE_PID=12\nme@h: Permission denied (publickey).\nConnection to h closed by remote host.')).toEqual({ kind: 'disconnected', detail: null });
    expect(p(255, 'DURE_PID=12\nHost key verification failed.')).toEqual({ kind: 'disconnected', detail: null });
    expect(p(255, 'DURE_PID=12\nConnection to h closed by remote host.')).toEqual({ kind: 'disconnected', detail: null });
    expect(p(127, 'DURE_PID=12\nbash: line 1: claude: command not found')?.kind).toBe('no-claude');
  });
  it('unreachable detail 은 known_hosts 경고를 건너뛴다', () => {
    expect(c(255, "Warning: Permanently added 'h' (ED25519) to the list of known hosts.\nssh: connect to host h port 22: Connection refused")?.detail)
      .toBe('ssh: connect to host h port 22: Connection refused');
  });
  it('3 = no-folder', () => expect(c(3)?.kind).toBe('no-folder'));
  it('0·1·null = null', () => {
    expect(c(0)).toBeNull();
    expect(c(1)).toBeNull();
    expect(c(null)).toBeNull();
  });
});

describe('작은 것들', () => {
  it('parsePid', () => {
    expect(parsePid('x\nDURE_PID=4242\n')).toBe(4242);
    expect(parsePid('nothing')).toBeNull();
    expect(parsePid('DURE_PID=4242\r\n')).toBe(4242);
    // 줄이 둘로 쪼개져 온 첫 조각은 숫자가 잘렸을 수 있다
    expect(parsePid('DURE_PID=12')).toBeNull();
    expect(parsePid('x\nDURE_PID=12')).toBeNull();
    expect(parsePid('DURE_PID=12' + '194\n')).toBe(12194);
  });
  it('isLoginFailure', () => {
    expect(isLoginFailure('Failed to authenticate: OAuth session expired…')).toBe(true);
    expect(isLoginFailure('  invalid api key · Please run /login')).toBe(true);
    expect(isLoginFailure('please run /login')).toBe(true);
    expect(isLoginFailure('알았어')).toBe(false);
  });
  it('posixJoin', () => expect(posixJoin('/home/a/web', '../api')).toBe('/home/a/api'));
});

describe('parseCheckOutput — 확인 출력 읽기', () => {
  it('폴더·버전', () => {
    expect(parseCheckOutput('\nDURE_DIR=/home/a/web\n2.1.304 (Claude Code)\n')).toEqual({ folder: '/home/a/web', claudeVersion: '2.1.304' });
  });
  it('프로필이 줄바꿈 없이 찍은 잡음은 표식 줄에 붙지 않는다 · CRLF', () => {
    expect(parseCheckOutput('Welcome!\r\nnvm ready\nDURE_DIR=/srv/x y\r\n2.1.316 (Claude Code)\r\n')).toEqual({ folder: '/srv/x y', claudeVersion: '2.1.316' });
    expect(parseCheckOutput('motd without newline\nDURE_DIR=/home/a\n2.1.304 (Claude Code)\n')).toEqual({ folder: '/home/a', claudeVersion: '2.1.304' });
  });
  it('폴더 없이 — 버전만(프로필 잡음 뒤 마지막 줄)', () => {
    expect(parseCheckOutput('hello\n2.1.304 (Claude Code)\n')).toEqual({ folder: null, claudeVersion: '2.1.304' });
  });
  it('표식이 / 로 시작하지 않으면 폴더 없음 · 빈 출력은 버전 없음', () => {
    expect(parseCheckOutput('DURE_DIR=\n2.1.304\n').folder).toBeNull();
    expect(parseCheckOutput('')).toEqual({ folder: null, claudeVersion: null });
  });
  it('마지막 줄이 버전 번호(x.y.z)가 아니면 버전 없음 — 프로필·motd 줄을 버전으로 읽지 않는다', () => {
    expect(parseCheckOutput('Welcome to Ubuntu 24.04 LTS\n')).toEqual({ folder: null, claudeVersion: null });
    expect(parseCheckOutput('\nDURE_DIR=/home/a\nLast login: Mon Nov  2 10:00:00 2026\n')).toEqual({ folder: '/home/a', claudeVersion: null });
    expect(parseCheckOutput('motd 1.2.3\n').claudeVersion).toBeNull();
    expect(parseCheckOutput('2.1\n').claudeVersion).toBeNull();
  });
});

describe('sshErrorLines — ssh·서버 stderr 의 뜻 있는 줄', () => {
  it('known_hosts 경고·DURE_PID·빈 줄은 뺀다', () => {
    expect(sshErrorLines("Warning: Permanently added 'h' (ED25519) to the list of known hosts.\r\nDURE_PID=4242\n\n  fake crash  \nx\n")).toEqual(['fake crash', 'x']);
  });
  it('classifyExit 의 접속 실패 첫 줄도 같은 거르기 — DURE_PID 줄은 첫 줄이 아니다', () => {
    expect(classifyExit({ code: 255, stderr: 'DURE_PID=12\nConnection to dev closed by remote host.\n', started: false })).toEqual({
      kind: 'unreachable', detail: 'Connection to dev closed by remote host.',
    });
  });
});

describe('isSafeId', () => {
  it('셸·경로에 그대로 넣어도 되는 id 만', () => {
    expect(['abcd1234', 'a-b_c.d', 'x'].every(isSafeId)).toBe(true);
    expect(['', '.', '..', 'a..b', '../x', 'a/b', 'a b', "a'b", 'a;b'].some(isSafeId)).toBe(false);
  });
});
