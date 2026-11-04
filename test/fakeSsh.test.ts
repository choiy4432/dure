import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildArgs } from '../src/engine/claudeArgs';
import {
  checkScript, updateScript, classifyExit, cleanupScript, forwardFailed, launchArgs, launchPreamble, parseCheckOutput, parsePid, remoteLaunchScript,
  remoteRunFiles, runArgs, shq, transcriptCheckScript, uploadScript, parseUploadHome, classifyUploadExit, attachmentsCleanupScript, attachmentRemoveScript,
  remoteAttachDir,
} from '../src/engine/remote';

// 가짜 ssh(test/fakeSsh.mjs) — 서버 방 시험이 진짜 ssh·서버 없이 돌게 한다. 명령 모양은 src/engine/remote.ts 그대로 만든다
const FAKE_SSH = path.resolve('test/fakeSsh.mjs');
const AGENT = 'ag1';
const LAUNCH = 'ab12cd34';

let tmp: string;
let root: string; // FAKE_SSH_ROOT — 서버의 / (가짜 사용자 a 의 $HOME = <root>/home/a)
let home: string;
let sshLog: string;
let claudeLog: string;
let children: ChildProcess[] = [];
let servers: net.Server[] = [];
let conns: net.Socket[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-fakessh-'));
  root = path.join(tmp, 'server');
  home = path.join(root, 'home', 'a');
  fs.mkdirSync(path.join(home, 'web'), { recursive: true });
  sshLog = path.join(tmp, 'ssh.log');
  claudeLog = path.join(tmp, 'claude.log');
});

afterEach(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
  children = [];
  // 끊김으로 남긴 가짜 claude 까지 — 가짜 ssh 의 정리 손잡이. 비동기로(spawnSync 면 이 프로세스의 시험 서버가 그동안 답하지 못한다)
  await reap();
  for (const c of conns) c.destroy();
  conns = [];
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 20000);

/** node test/fakeSsh.mjs --fake-reap — 끈 claude pid 들 */
async function reap(): Promise<string> {
  const child = spawn(process.execPath, [FAKE_SSH, '--fake-reap'], { env: env(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  await new Promise((r) => child.on('close', r));
  return out;
}

/** 이 시험의 환경 — 바깥의 FAKE_*·CLAUDE_CONFIG_DIR 는 버린다(진짜 ~/.claude 에 쓰지 않게) */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('FAKE_') && k !== 'CLAUDE_CONFIG_DIR') base[k] = v;
  return { ...base, FAKE_SSH_ROOT: root, FAKE_SSH_LOG: sshLog, FAKE_CLAUDE_LOG: claudeLog, ...extra };
}

interface Run {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exit: Promise<number | null>;
}
function ssh(args: string[], extra: Record<string, string> = {}): Run {
  const child = spawn(process.execPath, [FAKE_SSH, ...args], { env: env(extra), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d));
  child.stdin!.on('error', () => {});
  const exit = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  return { child, out: () => out, err: () => err, exit };
}
async function sshDone(args: string[], extra: Record<string, string> = {}, input: string | Buffer = '') {
  const r = ssh(args, extra);
  r.child.stdin!.end(input);
  const code = await r.exit;
  return { code, stdout: r.out(), stderr: r.err() };
}
/** 서버 명령 하나(확인·정리·기록 확인) — 엔진이 보낼 모양 그대로(정리만 bash -c) */
const remote = (script: string, host = 'dev') => runArgs({ host, script, login: !script.includes('DURE_RUN=$m') });
/** 윈도우 OpenSSH 가 연결 도중 끊길 때의 종료 코드(-1) — 윈도우 부모에겐 4294967295 */
const DROP_CODE = process.platform === 'win32' ? 4294967295 : 255;

async function until(pred: () => boolean, ms = 8000, what = '조건'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`기다린 ${what} 이(가) 오지 않음`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
async function listen(s: net.Server): Promise<number> {
  servers.push(s);
  s.on('connection', (c: net.Socket) => {
    c.on('error', () => {});
    conns.push(c);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as net.AddressInfo).port;
}

const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
const results = (out: string) =>
  out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((m) => m.type === 'result').map((m) => m.result as string);

/** 서버에서 claude 띄우기 — 엔진이 보낼 인자·스크립트 그대로(buildArgs 의 MCP·안내문 경로는 서버 run 폴더) */
async function launch(
  o: { launchId?: string; folder?: string; env?: Record<string, string>; remotePort?: number; localPort?: number; sessionId?: string; addDir?: boolean } = {},
) {
  const launchId = o.launchId ?? LAUNCH;
  const files = remoteRunFiles(AGENT, launchId);
  const remotePort = o.remotePort ?? (await freePort());
  const localPort = o.localPort ?? (await freePort());
  const claudeArgs = buildArgs({
    sessionId: o.sessionId ?? 'sess-1', resume: false, mcpConfigPath: files.mcp, promptPath: files.prompt, model: 'haiku', name: 'A', allowBypass: false,
    ...(o.addDir ? { addDirs: [remoteAttachDir(AGENT)] } : {}),
  });
  const script = remoteLaunchScript({ agentId: AGENT, launchId, folder: o.folder ?? '/home/a/web', claudeArgs });
  const run = ssh(launchArgs({ host: 'dev', remotePort, localPort, script }), o.env);
  const mcp = JSON.stringify({ mcpServers: { dure: { type: 'http', url: `http://127.0.0.1:${remotePort}/mcp`, headers: { Authorization: 'Bearer t0k' } } } });
  const prompt = `방 안내 — 따옴표 ' " $HOME \`x\`\n둘째 줄`;
  return { run, mcp, prompt, remotePort, localPort, launchId, runDir: path.join(home, '.dure', 'run', AGENT, launchId) };
}
async function pidOf(run: Run): Promise<number> {
  await until(() => parsePid(run.err()) !== null, 8000, 'DURE_PID');
  return parsePid(run.err())!;
}
function logLines(): any[] {
  if (!fs.existsSync(sshLog)) return [];
  return fs.readFileSync(sshLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('확인 명령', () => {
  it('폴더가 있으면 펼친 경로와 버전', async () => {
    const r = await sshDone(remote(checkScript('/home/a/web')));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('\nDURE_DIR=/home/a/web\n2.1.304 (Claude Code)\n');
    expect(parseCheckOutput(r.stdout)).toEqual({ folder: '/home/a/web', claudeVersion: '2.1.304' });
  });
  it('~ 는 가짜 사용자 a 의 $HOME', async () => {
    expect(parseCheckOutput((await sshDone(remote(checkScript('~/web')))).stdout).folder).toBe('/home/a/web');
    expect(parseCheckOutput((await sshDone(remote(checkScript('~')))).stdout).folder).toBe('/home/a');
  });
  it('폴더 없이 — 버전만', async () => {
    const r = await sshDone(remote(checkScript()));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('2.1.304 (Claude Code)');
  });
  it('공백·작은따옴표·$ 가 든 폴더도 그대로', async () => {
    const weird = `/home/a/my app/it's $HOME`;
    fs.mkdirSync(path.join(root, ...weird.split('/').filter(Boolean)), { recursive: true });
    const r = await sshDone(remote(checkScript(weird)));
    expect(r.code).toBe(0);
    expect(parseCheckOutput(r.stdout).folder).toBe(weird);
  });
  it('없는 폴더 → 3', async () => {
    const r = await sshDone(remote(checkScript('/home/a/nope')));
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('No such file or directory');
    expect(classifyExit({ code: r.code, stderr: r.stderr, started: false })?.kind).toBe('no-folder');
  });
  it('설정 파일의 RemoteForward·RemoteCommand 가 있어도 — 확인은 전달을 지우고(ClearAllForwardings) RemoteCommand=none 이라 된다', async () => {
    const cfg = { FAKE_SSH_CONFIG_RFWD: String(await freePort()), FAKE_SSH_CONFIG_REMOTECOMMAND: '1' };
    const r = await sshDone(remote(checkScript('/home/a/web')), cfg);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('forwarding failed');
    // 흉내가 진짜처럼 깨진다 — 옛 확인 모양(ExitOnForwardFailure=yes·설정 파일 전달 그대로·RemoteCommand 그대로)
    const old = ['-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', 'dev', 'bash -lc ' + shq(checkScript())];
    expect((await sshDone(old, { FAKE_SSH_CONFIG_RFWD: cfg.FAKE_SSH_CONFIG_RFWD })).code).toBe(255);
    const rc = await sshDone(old, { FAKE_SSH_CONFIG_REMOTECOMMAND: '1' });
    expect(rc.code).toBe(255);
    expect(rc.stderr).toContain('Cannot execute command-line and remote command.');
  });
  it('noclaude → 127', async () => {
    const r = await sshDone(remote(checkScript('/home/a/web')), { FAKE_SSH_MODE: 'noclaude' });
    expect(r.code).toBe(127);
    expect(classifyExit({ code: r.code, stderr: r.stderr, started: false })?.kind).toBe('no-claude');
  });
  it('FAKE_SSH_LOG — 받은 인자와 명령을 JSON 한 줄씩', async () => {
    await sshDone(remote(checkScript('/home/a/web')));
    const [line] = logLines();
    expect(line.argv).toContain('BatchMode=yes');
    expect(line.host).toBe('dev');
    expect(line.kind).toBe('check');
    expect(line.script).toBe(checkScript('/home/a/web'));
  });
});

describe('update 갈래', () => {
  it('update 갈래 — 기록 kind update · 종료 0 · FAKE_SSH_UPDATE_CODE 면 그 코드 · noclaude 면 127', async () => {
    const r = await sshDone(remote(updateScript()));
    expect(r.code).toBe(0);
    const [line] = logLines();
    expect(line.kind).toBe('update');
    expect(line.script).toBe(updateScript());
    expect((await sshDone(remote(updateScript()), { FAKE_SSH_UPDATE_CODE: '1' })).code).toBe(1);
    expect((await sshDone(remote(updateScript()), { FAKE_SSH_MODE: 'noclaude' })).code).toBe(127);
  });
});

describe('접속 실패 흉내', () => {
  it('refused → 255 Connection refused', async () => {
    const r = await sshDone(remote(checkScript()), { FAKE_SSH_MODE: 'refused' });
    expect(r.code).toBe(255);
    expect(r.stderr).toContain('ssh: connect to host dev port 22: Connection refused');
    expect(classifyExit({ code: r.code, stderr: r.stderr, started: false })).toEqual({
      kind: 'unreachable', detail: 'ssh: connect to host dev port 22: Connection refused',
    });
  });
  it('denied → 255 Permission denied (publickey)', async () => {
    const r = await sshDone(remote(checkScript(), 'me@h:2222'), { FAKE_SSH_MODE: 'denied' });
    expect(r.code).toBe(255);
    expect(r.stderr).toContain('me@h: Permission denied (publickey).');
    expect(classifyExit({ code: r.code, stderr: r.stderr, started: false })?.kind).toBe('denied');
  });
  it('hostkey → 255 서버 키 바뀜', async () => {
    const r = await sshDone(remote(checkScript()), { FAKE_SSH_MODE: 'hostkey' });
    expect(r.code).toBe(255);
    expect(r.stderr).toContain('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!');
    expect(r.stderr).toContain('Host key verification failed.');
    expect(classifyExit({ code: r.code, stderr: r.stderr, started: false })?.kind).toBe('hostkey');
  });
});

describe('띄우기', () => {
  it('머리말이 run 폴더에 풀리고 가짜 claude 가 echo 하나 에 답한다', async () => {
    const l = await launch();
    l.run.child.stdin!.write(launchPreamble(l.mcp, l.prompt) + userLine('echo 하나')); // 머리말과 첫 말을 한 번에(probe25 D3)
    await until(() => results(l.run.out()).includes('받음: echo 하나'), 10000, '받음');
    expect(fs.readFileSync(path.join(l.runDir, 'mcp.json'), 'utf8')).toBe(l.mcp);
    expect(fs.readFileSync(path.join(l.runDir, 'prompt.md'), 'utf8')).toBe(l.prompt);
    const pid = parsePid(l.run.err());
    expect(pid).not.toBeNull();
    expect(alive(pid!)).toBe(true);
    // 가짜 claude 는 서버 run 폴더의 mcp.json 을 이 PC 경로로 받아 읽는다 — 그 pid 가 DURE_PID
    const argvLine = fs.readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).find((x) => x.argv);
    expect(argvLine.pid).toBe(pid);
    expect(argvLine.mcpToolTimeout).toBe('86400000'); // 스크립트의 export 로(이 시험 환경엔 없다)
    const mcpArg = argvLine.argv[argvLine.argv.indexOf('--mcp-config') + 1];
    expect(path.resolve(mcpArg)).toBe(path.resolve(l.runDir, 'mcp.json'));
    const launched = logLines().find((x) => x.event === 'launch');
    expect(launched).toMatchObject({ pid, marker: `${AGENT}.${LAUNCH}`, folder: '/home/a/web' });
    expect(path.resolve(launched.cwd)).toBe(path.resolve(home, 'web'));
    // 입력을 닫으면 claude 가 끝나고 ssh 도 0 으로
    l.run.child.stdin!.end();
    expect(await l.run.exit).toBe(0);
    await until(() => !alive(pid!), 5000, '가짜 claude 끝남');
  }, 20000);

  it('-R 중계 — 원격 포트로 보낸 HTTP 요청이 이 PC 의 서버에 닿는다', async () => {
    const local = http.createServer((req, res) => res.end(`pong:${req.url}`));
    const localPort = await listen(local);
    const l = await launch({ localPort });
    l.run.child.stdin!.write(launchPreamble(l.mcp, l.prompt));
    await pidOf(l.run);
    const res = await fetch(`http://127.0.0.1:${l.remotePort}/mcp?x=1`);
    expect(await res.text()).toBe('pong:/mcp?x=1');
  }, 20000);

  it('없는 폴더 → 3, claude 는 안 뜨고 run 폴더(토큰 파일)도 만들지 않는다', async () => {
    const l = await launch({ folder: '/home/a/nope' });
    l.run.child.stdin!.end(launchPreamble(l.mcp, l.prompt));
    expect(await l.run.exit).toBe(3);
    expect(fs.existsSync(l.runDir)).toBe(false);
    expect(fs.existsSync(path.join(home, '.dure'))).toBe(false);
    expect(parsePid(l.run.err())).toBeNull();
    expect(classifyExit({ code: 3, stderr: l.run.err(), started: false })?.kind).toBe('no-folder');
  }, 20000);

  it('noclaude → 127 — claude 찾기가 run 폴더보다 먼저라 DURE_PID·run 폴더(토큰 파일) 없음', async () => {
    const l = await launch({ env: { FAKE_SSH_MODE: 'noclaude' } });
    l.run.child.stdin!.end(launchPreamble(l.mcp, l.prompt));
    expect(await l.run.exit).toBe(127);
    expect(parsePid(l.run.err())).toBeNull();
    expect(fs.existsSync(path.join(home, '.dure'))).toBe(false);
    expect(classifyExit({ code: 127, stderr: l.run.err(), started: false })?.kind).toBe('no-claude');
  }, 20000);

  it('-R 은 서버 쪽 주소 127.0.0.1 을 받아 그 주소에 묶는다', async () => {
    const l = await launch();
    l.run.child.stdin!.write(launchPreamble(l.mcp, l.prompt));
    await pidOf(l.run);
    expect(logLines().find((x) => x.event === 'start').forwards).toEqual([`127.0.0.1:${l.remotePort}:127.0.0.1:${l.localPort}`]);
  }, 20000);

  it('portclash-once → 첫 번째만 전달 실패 — 띄우기(ExitOnForwardFailure=yes)는 명령 전에 255 · 둘째는 정상', async () => {
    const first = await launch({ env: { FAKE_SSH_MODE: 'portclash-once' } });
    first.run.child.stdin!.end(launchPreamble(first.mcp, first.prompt));
    expect(await first.run.exit).toBe(255);
    expect(first.run.err()).toContain(`Error: remote port forwarding failed for listen port ${first.remotePort}`);
    expect(parsePid(first.run.err())).toBeNull(); // 서버 셸이 돌지 않았다
    expect(classifyExit({ code: 255, stderr: first.run.err(), started: false, port: first.remotePort })?.kind).toBe('port');
    expect(fs.existsSync(path.join(home, '.dure'))).toBe(false); // 머리말(토큰)이 서버 파일로 가지 않았다

    const second = await launch({ env: { FAKE_SSH_MODE: 'portclash-once' } });
    second.run.child.stdin!.write(launchPreamble(second.mcp, second.prompt) + userLine('echo 둘'));
    await until(() => results(second.run.out()).includes('받음: echo 둘'), 10000, '받음');
    expect(forwardFailed(second.run.err(), second.remotePort)).toBe(false);
  }, 20000);

  it('원격 포트를 서버에서 남이 쓰는 중이면 — 명령 전에 255(그 포트 줄) · 남의 리스너에는 아무것도 오지 않는다', async () => {
    const got: string[] = [];
    const busy = net.createServer((c) => c.on('data', (d) => got.push(String(d))));
    const remotePort = await listen(busy);
    const l = await launch({ remotePort });
    l.run.child.stdin!.end(launchPreamble(l.mcp, l.prompt));
    expect(await l.run.exit).toBe(255);
    expect(l.run.err()).toContain(`Error: remote port forwarding failed for listen port ${remotePort}`);
    expect(classifyExit({ code: 255, stderr: l.run.err(), started: false, port: remotePort })?.kind).toBe('port');
    expect(fs.existsSync(path.join(home, '.dure'))).toBe(false);
    expect(got).toEqual([]);
  }, 20000);

  it('설정 파일의 RemoteForward 가 실패해도 띄우기는 명령 전에 255 — 그 포트 줄이라 port 가 아니라 접속 실패', async () => {
    const cfgPort = await freePort();
    const l = await launch({ env: { FAKE_SSH_CONFIG_RFWD: String(cfgPort) } });
    l.run.child.stdin!.end(launchPreamble(l.mcp, l.prompt));
    expect(await l.run.exit).toBe(255);
    expect(l.run.err()).toContain(`Error: remote port forwarding failed for listen port ${cfgPort}`);
    expect(classifyExit({ code: 255, stderr: l.run.err(), started: false, port: l.remotePort })).toEqual({
      kind: 'unreachable', detail: `Error: remote port forwarding failed for listen port ${cfgPort}`,
    });
    expect(fs.existsSync(path.join(home, '.dure'))).toBe(false);
  }, 20000);

  it('기록 확인 — 가짜 claude 가 남긴 대화 파일(CLAUDE_CONFIG_DIR) 의 id 만', async () => {
    const cfg = path.join(root, '.claude');
    const extra = { CLAUDE_CONFIG_DIR: cfg, FAKE_TRANSCRIPTS: '1' };
    const l = await launch({ env: extra, sessionId: 'aaa-111' });
    l.run.child.stdin!.write(launchPreamble(l.mcp, l.prompt) + userLine('echo 하나'));
    await until(() => results(l.run.out()).length > 0, 10000, 'result');
    const r = await sshDone(remote(transcriptCheckScript(['aaa-111', 'bbb-222'])), extra);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split(/\r?\n/)).toEqual(['aaa-111']);
    // CLAUDE_CONFIG_DIR 이 없으면 $HOME/.claude
    fs.mkdirSync(path.join(home, '.claude', 'projects', '-home-a-web'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'projects', '-home-a-web', 'bbb-222.jsonl'), '');
    expect((await sshDone(remote(transcriptCheckScript(['aaa-111', 'bbb-222'])))).stdout.trim()).toBe('bbb-222');
  }, 20000);
});

describe('끊김·정리', () => {
  it('drop:<ms> → -1(윈도우 4294967295) Connection closed, 가짜 claude 는 남는다 · 정리 명령이 끈다', async () => {
    const l = await launch({ env: { FAKE_SSH_MODE: 'drop:300' } });
    l.run.child.stdin!.write(launchPreamble(l.mcp, l.prompt));
    const pid = await pidOf(l.run);
    const code = await l.run.exit;
    expect(code).toBe(DROP_CODE);
    expect(l.run.err()).toContain('Connection to dev closed by remote host.');
    expect(classifyExit({ code, stderr: l.run.err(), started: true })?.kind).toBe('disconnected');
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(true); // 진짜처럼 서버에 남았다

    const c = await sshDone(remote(cleanupScript({ pid, agentId: AGENT, launchId: l.launchId })));
    expect(c.code).toBe(0);
    await until(() => !alive(pid), 5000, '가짜 claude 꺼짐');
    expect(fs.existsSync(l.runDir)).toBe(false);
    expect(fs.existsSync(path.join(home, '.dure', 'run', AGENT))).toBe(false);
    expect(logLines().find((x) => x.event === 'cleanup')).toMatchObject({ pid, marker: `${AGENT}.${LAUNCH}`, killed: [pid] });
  }, 20000);

  it('정리 명령 — 붙어 있는 가짜 claude 도 죽고 ssh 가 끝난다', async () => {
    const l = await launch();
    l.run.child.stdin!.write(launchPreamble(l.mcp, l.prompt));
    const pid = await pidOf(l.run);
    const c = await sshDone(remote(cleanupScript({ pid, agentId: AGENT, launchId: l.launchId })));
    expect(c.code).toBe(0);
    await until(() => !alive(pid), 5000, '가짜 claude 꺼짐');
    expect(await l.run.exit).toBe(255); // 진짜: 서버 claude 가 신호로 끝나면 ssh 는 255
    expect(fs.existsSync(l.runDir)).toBe(false);
  }, 20000);

  it('drop 모드라도 끊기기 전에 입력이 닫히면 claude 는 EOF 로 끝나고 ssh 는 0', async () => {
    const l = await launch({ env: { FAKE_SSH_MODE: 'drop:10000' } });
    l.run.child.stdin!.write(launchPreamble(l.mcp, l.prompt));
    const pid = await pidOf(l.run);
    l.run.child.stdin!.end();
    expect(await l.run.exit).toBe(0);
    await until(() => !alive(pid), 5000, '가짜 claude 꺼짐');
  }, 20000);

  it('남은 기록의 pid·포트가 남의 것이 됐어도 정리·뒷정리는 아무것도 끄지 않는다', async () => {
    // 우리가 띄우지 않은 살아 있는 프로세스 — 낡은 기록이 그 pid 를 가리킨다
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
    children.push(other);
    const otherPid = other.pid!;
    await until(() => alive(otherPid), 5000, '남의 프로세스');
    const deadPort = await freePort(); // 지킴이가 죽어 아무도 안 듣는 포트
    const chatty = await listen(net.createServer((s) => s.end('HTTP/1.1 400 Bad Request\r\n\r\n'))); // 포트를 다른 프로그램이 물려받음
    const silent = await listen(net.createServer((s) => s.on('error', () => {}))); // 답하지 않는 남의 서버
    const rec = (port: number, n: number) => JSON.stringify({ launch: { marker: `${AGENT}.${LAUNCH}`, pid: otherPid, port, token: String(n).repeat(32) } });
    fs.mkdirSync(path.join(root, '.fake-ssh'), { recursive: true });
    fs.writeFileSync(path.join(root, '.fake-ssh', 'procs.jsonl'), [rec(deadPort, 1), rec(chatty, 2), rec(silent, 3)].join('\n') + '\n');

    const c = await sshDone(remote(cleanupScript({ pid: otherPid, agentId: AGENT, launchId: LAUNCH })));
    expect(c.code).toBe(0);
    expect(logLines().find((x) => x.event === 'cleanup')).toMatchObject({ pid: otherPid, killed: [] });
    expect(await reap()).toBe('');
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(otherPid)).toBe(true);
  }, 30000);

  it('뒷정리(--fake-reap)는 우리 지킴이에게 비밀을 대고 남은 claude 를 끈다', async () => {
    const l = await launch({ env: { FAKE_SSH_MODE: 'drop:200' } });
    l.run.child.stdin!.write(launchPreamble(l.mcp, l.prompt));
    const pid = await pidOf(l.run);
    expect(await l.run.exit).toBe(DROP_CODE);
    expect(alive(pid)).toBe(true);
    expect((await reap()).trim()).toBe(String(pid));
    await until(() => !alive(pid), 5000, '가짜 claude 꺼짐');
  }, 20000);

  it('정리 명령 — 표식(띄우기 id)이 다르면 그 pid 를 건드리지 않는다', async () => {
    const l = await launch();
    l.run.child.stdin!.write(launchPreamble(l.mcp, l.prompt));
    const pid = await pidOf(l.run);
    const c = await sshDone(remote(cleanupScript({ pid, agentId: AGENT, launchId: 'other999' })));
    expect(c.code).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(true);
    expect(fs.existsSync(l.runDir)).toBe(true);
    expect(logLines().find((x) => x.event === 'cleanup')).toMatchObject({ pid, killed: [] });
  }, 20000);
});

describe('첨부 — 올리기·지우기·--add-dir', () => {
  // 공백·작은따옴표·$·;·& 가 든 사본 이름(review focus 1)
  const FILE = `20261104-101010-a b'$;&.txt`;
  /** 엔진이 보낼 올리기 ssh 그대로 — 전달 없음, bash -c */
  const up = (file = FILE) => runArgs({ host: 'dev', script: uploadScript(AGENT, file), login: false });
  const served = (file = FILE, agent = AGENT) => path.join(home, '.dure', 'attachments', agent, file);
  const BYTES = Buffer.from([0, 1, 2, 13, 10, 255, 0xea, 0xb0, 0x80, 0x27, 0x24, 0x3b, 0x26, 0, 10]);

  it('upload — 바이트 그대로', async () => {
    const r = await sshDone(up(), {}, BYTES);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(served())).toEqual(BYTES);
    expect(r.stdout).toBe('\nDURE_HOME=/home/a\n');
    expect(parseUploadHome(r.stdout)).toBe('/home/a');
    const [start, done] = logLines();
    expect(start).toMatchObject({ event: 'start', kind: 'upload', forwards: [] });
    expect(start.script).toBe(uploadScript(AGENT, FILE));
    expect(done).toMatchObject({ event: 'upload', agentId: AGENT, file: FILE, bytes: BYTES.length });
    // 여러 조각으로 오는 큰 stdin 도
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, 0);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const r2 = await sshDone(up('20261104-101010-큰.bin'), {}, big);
    expect(r2.code).toBe(0);
    expect(fs.readFileSync(served('20261104-101010-큰.bin')).equals(big)).toBe(true);
  }, 20000);

  it('FAKE_SSH_UPLOAD_CODE — 255 는 반쯤 쓰고 끊김 줄 · 그 밖은 서버 명령 오류 · 어느 쪽도 DURE_HOME 없음', async () => {
    const r = await sshDone(up(), { FAKE_SSH_UPLOAD_CODE: '255' }, BYTES);
    expect(r.code).toBe(255);
    expect(r.stdout).not.toContain('DURE_HOME=');
    expect(r.stderr).toContain('Connection to dev closed by remote host.');
    expect(classifyUploadExit(r.code, r.stderr)).toEqual({ kind: 'disconnected', detail: null });
    expect(fs.readFileSync(served())).toEqual(BYTES.subarray(0, Math.floor(BYTES.length / 2)));
    const w = await sshDone(up('20261104-101010-b.txt'), { FAKE_SSH_UPLOAD_CODE: '1' }, BYTES);
    expect(w.code).toBe(1);
    expect(w.stderr).toContain('No space left on device');
    expect(classifyUploadExit(w.code, w.stderr)).toBeNull();
    // FAKE_SSH_UPLOAD_ERR — 서버 명령 오류의 글(디스크 할당량 등)
    const q = await sshDone(up('20261104-101010-q.txt'), { FAKE_SSH_UPLOAD_CODE: '1', FAKE_SSH_UPLOAD_ERR: 'cat: write error: Disk quota exceeded' }, BYTES);
    expect(q.code).toBe(1);
    expect(q.stderr).toContain('cat: write error: Disk quota exceeded');
    expect(q.stderr).not.toContain('No space left');
    // 접속 단계 흉내는 그대로 — 아무것도 쓰지 않는다
    const refused = await sshDone(up('20261104-101010-c.txt'), { FAKE_SSH_MODE: 'refused' }, BYTES);
    expect(refused.code).toBe(255);
    expect(fs.existsSync(served('20261104-101010-c.txt'))).toBe(false);
  }, 20000);

  it('FAKE_SSH_UPLOAD_HOLD — 이름에 그 글자가 든 올리기는 다 쓴 뒤 끝내지 않는다(끌 때까지)', async () => {
    const r = ssh(up('20261104-101010-느린.txt'), { FAKE_SSH_UPLOAD_HOLD: '느린' });
    r.child.stdin!.end(BYTES);
    await until(() => logLines().some((x) => x.event === 'upload'), 8000, '올림');
    expect(fs.readFileSync(served('20261104-101010-느린.txt'))).toEqual(BYTES);
    await new Promise((res) => setTimeout(res, 300));
    expect(r.child.exitCode).toBeNull();
    r.child.kill();
    await r.exit;
    expect(r.out()).not.toContain('DURE_HOME=');
    // 다른 이름은 그대로 끝난다
    expect((await sshDone(up(), { FAKE_SSH_UPLOAD_HOLD: '느린' }, BYTES)).code).toBe(0);
    // FAKE_SSH_UPLOAD_RELEASE — 그 파일이 생기면 붙잡기를 풀고 보통처럼 끝난다(DURE_HOME)
    const release = path.join(root, 'release');
    const held = ssh(up('20261104-101010-느린2.txt'), { FAKE_SSH_UPLOAD_HOLD: '느린', FAKE_SSH_UPLOAD_RELEASE: release });
    held.child.stdin!.end(BYTES);
    await until(() => logLines().some((x) => x.event === 'upload' && x.file.endsWith('느린2.txt')), 8000, '올림');
    await new Promise((res) => setTimeout(res, 300));
    expect(held.child.exitCode).toBeNull();
    fs.writeFileSync(release, '');
    expect(await held.exit).toBe(0);
    expect(held.out()).toContain('DURE_HOME=/home/a');
  }, 20000);

  it('FAKE_SSH_UPLOAD_PROXY — 붙잡은 올리기가 같은 stdio 를 쥔 자식(ProxyJump 흉내)을 둔다', async () => {
    const r = ssh(up('20261104-101010-느린.txt'), { FAKE_SSH_UPLOAD_HOLD: '느린', FAKE_SSH_UPLOAD_PROXY: '1' });
    r.child.stdin!.end(BYTES);
    await until(() => logLines().some((x) => x.event === 'upload-proxy'), 8000, '자식');
    const proxy = logLines().find((x) => x.event === 'upload-proxy').pid;
    expect(alive(proxy)).toBe(true);
    process.kill(proxy);
    r.child.kill();
    await r.exit;
  }, 20000);

  it('모양이 다르면 모른다(2) — 따옴표 없는 이름(끼어든 명령)·다른 폴더·빠진 표식', async () => {
    const bad = [
      `umask 077; d="$HOME/.dure/attachments/ag1"; mkdir -p "$d" && cat > "$d"/a;touch x && printf '\\nDURE_HOME=%s\\n' "$HOME"`,
      `umask 077; d="$HOME/.dure/other/ag1"; mkdir -p "$d" && cat > "$d"/'a' && printf '\\nDURE_HOME=%s\\n' "$HOME"`,
      `umask 077; d="$HOME/.dure/attachments/ag1"; mkdir -p "$d" && cat > "$d"/'a'`,
      `d="$HOME/.dure/attachments/ag1"; rm -f "$d"/'a'/'..'`,
      `rm -rf "$HOME/.dure/attachments"`,
    ];
    for (const script of bad) {
      expect((await sshDone(runArgs({ host: 'dev', script, login: false }), {}, 'x')).code).toBe(2);
    }
    expect(fs.existsSync(path.join(home, '.dure'))).toBe(false);
  }, 20000);

  it('사본 이름은 작은따옴표(shq) 글자만 — 따옴표 밖의 & · $( ) · 큰따옴표 이름은 모른다(2)', async () => {
    const shape = (name: string) => `umask 077; d="$HOME/.dure/attachments/ag1"; mkdir -p "$d" && cat > "$d"/${name} && printf '\\nDURE_HOME=%s\\n' "$HOME"`;
    // 모양은 uploadScript 그대로 — 이름 자리만 바꾼다(이름이 다르면 다른 까닭으로 모르는 것이 아니게)
    expect(shape(shq('a'))).toBe(uploadScript('ag1', 'a'));
    const bad = [
      shape('a&b'),
      shape('$(touch_x).txt'),
      shape("'a'b"),
      shape('"a"'),
      shape('a'),
      `d="$HOME/.dure/attachments/ag1"; rm -f "$d"/a&b`,
      `d="$HOME/.dure/attachments/ag1"; rm -f "$d"/'a' "$d"/$(touch_x)`,
    ];
    for (const script of bad) {
      expect((await sshDone(runArgs({ host: 'dev', script, login: false }), {}, 'x')).code).toBe(2);
    }
    expect(fs.existsSync(path.join(home, '.dure'))).toBe(false);
    // shq 그대로면 작은따옴표가 든 이름(따옴표 밖의 \' 하나)도 받는다
    expect(shape(shq("a'b"))).toBe(uploadScript('ag1', "a'b"));
    expect((await sshDone(runArgs({ host: 'dev', script: shape(shq("a'b")), login: false }), {}, 'x')).code).toBe(0);
    expect(fs.readFileSync(served("a'b"), 'utf8')).toBe('x');
  }, 20000);

  it('첨부 지우기 — 그 파일들만 · 지울 때는 그 에이전트 폴더째', async () => {
    for (const f of [FILE, '20261104-101010-keep.txt']) await sshDone(up(f), {}, BYTES);
    fs.mkdirSync(path.dirname(served('x', 'ag2')), { recursive: true });
    fs.writeFileSync(served('x', 'ag2'), 'y');
    const rm = await sshDone(runArgs({ host: 'dev', script: attachmentRemoveScript(AGENT, [FILE, '20261104-101010-없음.txt']), login: false }));
    expect(rm.code).toBe(0);
    expect(fs.existsSync(served())).toBe(false);
    expect(fs.existsSync(served('20261104-101010-keep.txt'))).toBe(true);
    expect(logLines().find((x) => x.event === 'attachment-remove')).toMatchObject({ agentId: AGENT, files: [FILE, '20261104-101010-없음.txt'], removed: [FILE] });
    const all = await sshDone(runArgs({ host: 'dev', script: attachmentsCleanupScript(AGENT), login: false }));
    expect(all.code).toBe(0);
    expect(fs.existsSync(path.dirname(served()))).toBe(false);
    expect(fs.existsSync(served('x', 'ag2'))).toBe(true); // 다른 에이전트 것은 그대로
    expect(logLines().find((x) => x.event === 'attachments-cleanup')).toMatchObject({ agentId: AGENT, removed: true });
    expect(logLines().filter((x) => x.event === 'start').map((x) => x.kind).slice(-2)).toEqual(['attachment-remove', 'attachments-cleanup']);
  }, 20000);

  it('띄우기 — 서버 첨부 폴더를 만들고 --add-dir 은 펼친 경로(이 PC 경로로 가짜 claude 에)', async () => {
    const l = await launch({ addDir: true });
    l.run.child.stdin!.write(launchPreamble(l.mcp, l.prompt));
    const pid = await pidOf(l.run);
    expect(fs.statSync(path.join(home, '.dure', 'attachments', AGENT)).isDirectory()).toBe(true);
    const argvOf = () => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, 'utf8') : '').split('\n').filter(Boolean).map((x) => JSON.parse(x)).find((x) => x.argv);
    await until(() => !!argvOf(), 8000, '가짜 claude 기록');
    const argvLine = argvOf();
    expect(argvLine.pid).toBe(pid);
    const dir = argvLine.argv[argvLine.argv.indexOf('--add-dir') + 1];
    expect(path.resolve(dir)).toBe(path.resolve(home, '.dure', 'attachments', AGENT));
  }, 20000);
});
