import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hostArgs, SSH_OPTIONS, shq, remoteRunDir, remoteRunFiles, remoteLaunchScript, launchArgs, launchPreamble,
  cleanupScript, checkScript, transcriptCheckScript, classifyExit, parsePid, isLoginFailure, posixJoin,
} from '../src/engine/remote';

const hasBash = (() => {
  try { return spawnSync('bash', ['--version']).status === 0; } catch { return false; }
})();
/** 윈도 경로 → bash 가 아는 경로(Git Bash 면 cygpath, 아니면 그대로) */
const posix = (p: string) => {
  try { return execFileSync('cygpath', ['-u', p], { encoding: 'utf8' }).trim(); } catch { return p; }
};

describe('hostArgs', () => {
  it('별칭은 그대로', () => expect(hostArgs('dev')).toEqual(['dev']));
  it('사용자@주소 그대로', () => expect(hostArgs('me@10.0.0.1')).toEqual(['me@10.0.0.1']));
  it('사용자@주소:포트 → -p', () => expect(hostArgs('me@10.0.0.1:2222')).toEqual(['-p', '2222', 'me@10.0.0.1']));
  it.each(['', '  ', '-oProxyCommand=x', 'a b', ' dev'])('올바르지 않은 이름 %j 은 던진다', (h) => {
    expect(() => hostArgs(h)).toThrow('서버 이름이 올바르지 않아요');
  });
});

describe('SSH_OPTIONS', () => {
  it('필수 옵션', () => {
    const s = SSH_OPTIONS.join(' ');
    for (const o of ['-T', 'BatchMode=yes', 'ExitOnForwardFailure=yes', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ConnectTimeout=10', 'StrictHostKeyChecking=accept-new']) {
      expect(s).toContain(o);
    }
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
    expect(s).toMatch(/export DURE_RUN=ag1\.ab12cd34; exec claude /);
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
      writeFileSync(join(fake, 'claude'), '#!/bin/bash\nprintf "[%s]\\n" "$@"\npwd\necho "RUN=$DURE_RUN"\ncat\n');
      execFileSync('bash', ['-c', `chmod +x ${shq(posix(fake))}/claude`]);
      const script = remoteLaunchScript({
        agentId: 'ag1', launchId: 'ab12cd34', folder,
        claudeArgs: ['-p', '--mcp-config', files.mcp, '--append-system-prompt-file', files.prompt, '-n', `it's $x`],
      });
      const mcp = '{"t":"a\'b"}', prompt = 'hello $HOME `x` "q"\n';
      const r = spawnSync('bash', ['-c', script], {
        input: launchPreamble(mcp, prompt) + 'REST\n',
        encoding: 'utf8',
        env: { ...process.env, HOME: posix(home), PATH: `${posix(fake)}:${process.env.PATH}` },
      });
      expect(r.stderr).toMatch(/DURE_PID=\d+/);
      const out = r.stdout.split('\n');
      expect(out).toContain(`[${posix(home)}/.dure/run/ag1/ab12cd34/mcp.json]`);
      expect(out).toContain(`[${posix(home)}/.dure/run/ag1/ab12cd34/prompt.md]`);
      expect(out).toContain(`[it's $x]`);
      expect(out).toContain(folder);
      expect(out).toContain('RUN=ag1.ab12cd34');
      expect(out).toContain('REST');
      const dir = join(home, '.dure', 'run', 'ag1', 'ab12cd34');
      expect(readFileSync(join(dir, 'mcp.json'), 'utf8')).toBe(mcp);
      expect(readFileSync(join(dir, 'prompt.md'), 'utf8')).toBe(prompt);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('launchArgs', () => {
  it('옵션·역터널·호스트·명령', () => {
    const a = launchArgs({ host: 'me@h:2222', remotePort: 41000, localPort: 5123, script: `echo 'x'` });
    expect(a).toContain('-T');
    expect(a).toContain('BatchMode=yes');
    const i = a.indexOf('-R');
    expect(a[i + 1]).toBe('41000:127.0.0.1:5123');
    expect(a.slice(-4)).toEqual(['-p', '2222', 'me@h', `bash -lc 'echo '\\''x'\\'''`]);
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
  it('표식·나무·SID·TERM→KILL→run 폴더', () => {
    expect(s).toContain('DURE_RUN=$1');
    expect(s).toContain('m=ag1.ab12cd34');
    expect(s).toContain('grep -qxF "DURE_RUN=$m"');
    expect(s).toContain('[ -r /proc/self/environ ]');
    expect(s).toContain('desc 4242');
    expect(s).toContain(`tr '\\0' '\\n' 2>/dev/null < "$e"`);
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

describe('checkScript', () => {
  it('폴더 없이', () => expect(checkScript()).toBe('command -v claude >/dev/null || exit 127; claude --version'));
  it('폴더 있으면 cd && pwd -P', () => {
    expect(checkScript(`/a b/it's`)).toBe(`cd '/a b/it'\\''s' && pwd -P || exit 3; command -v claude >/dev/null || exit 127; claude --version`);
  });
});

describe('checkScript — ~', () => {
  it('~ 는 $HOME 으로', () => {
    expect(checkScript('~')).toContain('cd "$HOME" && pwd -P || exit 3');
    expect(checkScript('~/my dir')).toContain(`cd "$HOME"/'my dir' && pwd -P`);
  });
  it.skipIf(!hasBash)('bash 에서 ~/my dir 이 $HOME 아래로 풀린다', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dure-tilde-'));
    try {
      execFileSync('bash', ['-c', `mkdir -p ${shq(posix(tmp))}/"my dir"`]);
      const run = (f: string) => spawnSync('bash', ['-c', checkScript(f).split('; command')[0]], { encoding: 'utf8', env: { ...process.env, HOME: posix(tmp) } });
      const r = run('~/my dir');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toMatch(/my dir$/);
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
  it('포트', () => expect(c(255, 'Error: remote port forwarding failed for listen port 41000')?.kind).toBe('port'));
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
