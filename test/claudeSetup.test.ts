import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locateClaude, authStatus, claudeVersion, isExecutableFile } from '../src/engine/claudeSetup';

describe('locateClaude', () => {
  // 아래 넷은 platform 을 안 넘긴다 — 기본값(process.platform)이 win32 인 Windows 에서만 Windows 꼴(';'·claude.exe·USERPROFILE)을 본다.
  // 같은 기대값을 platform 'win32' 으로 모든 러너에서 보는 쌍둥이가 'win32_는_지금과_같은_결과', mac 기본값은 '기본값은_process.platform'
  const onWindows = process.platform === 'win32';
  it.runIf(onWindows)('PATH 앞쪽 폴더가 우선', () => {
    const a = path.join('C_a', 'claude.exe');
    const b = path.join('C_b', 'claude.exe');
    const r = locateClaude({ PATH: 'C_a;;C_b', USERPROFILE: 'C_u' }, (p) => p === a || p === b);
    expect(r).toBe(a);
  });
  it.runIf(onWindows)('Path(대소문자 다름) 도 읽는다', () => {
    const a = path.join('C_a', 'claude.exe');
    expect(locateClaude({ Path: 'C_a' }, (p) => p === a)).toBe(a);
  });
  it.runIf(onWindows)('PATH 에 없고 USERPROFILE 에 있음', () => {
    const u = path.join('C_u', '.local', 'bin', 'claude.exe');
    expect(locateClaude({ PATH: 'C_a', USERPROFILE: 'C_u' }, (p) => p === u)).toBe(u);
  });
  it.runIf(onWindows)('둘 다 없으면 null', () => {
    expect(locateClaude({ PATH: 'C_a', USERPROFILE: 'C_u' }, () => false)).toBeNull();
    expect(locateClaude({}, () => true)).toBeNull();
  });
  it('기본값은_process.platform — platform 을 안 넘기면 이 운영체제의 길과 같다', () => {
    const p = process.platform as 'win32' | 'darwin' | 'linux';
    const envs = [
      { PATH: 'C_a;;C_b', USERPROFILE: 'C_u' },
      { PATH: '/usr/local/bin:/opt/x', HOME: '/Users/a' },
      {},
    ];
    for (const env of envs) {
      const seenDefault: string[] = [];
      const seenExplicit: string[] = [];
      expect(locateClaude(env, (x) => (seenDefault.push(x), false))).toBe(locateClaude(env, (x) => (seenExplicit.push(x), false), p));
      expect(seenDefault).toEqual(seenExplicit);
    }
  });

  it("win32_는_지금과_같은_결과 — platform 'win32' 을 줘도 위와 같다(';'·claude.exe·USERPROFILE)", () => {
    const a = path.join('C_a', 'claude.exe');
    const b = path.join('C_b', 'claude.exe');
    const u = path.join('C_u', '.local', 'bin', 'claude.exe');
    expect(locateClaude({ PATH: 'C_a;;C_b', USERPROFILE: 'C_u' }, (p) => p === a || p === b, 'win32')).toBe(a);
    expect(locateClaude({ Path: 'C_a' }, (p) => p === a, 'win32')).toBe(a);
    expect(locateClaude({ PATH: 'C_a', USERPROFILE: 'C_u' }, (p) => p === u, 'win32')).toBe(u);
    expect(locateClaude({ PATH: 'C_a', USERPROFILE: 'C_u' }, () => false, 'win32')).toBeNull();
    expect(locateClaude({}, () => true, 'win32')).toBeNull();
    // mac 후보(HOME·/opt/homebrew)는 보지 않는다
    const seen: string[] = [];
    locateClaude({ PATH: 'C_a', HOME: '/Users/a' }, (p) => (seen.push(p), false), 'win32');
    expect(seen).toEqual([a]);
  });

  it('win32_은_실행_파일_확인을_부르지_않는다 — 있기만 하면(exists) 지금처럼 그것', () => {
    const a = path.join('C_a', 'claude.exe');
    const u = path.join('C_u', '.local', 'bin', 'claude.exe');
    const exe = vi.fn(() => false); // 불렸다면 다 건너뛰었을 것
    expect(locateClaude({ PATH: 'C_a', USERPROFILE: 'C_u' }, (p) => p === a, 'win32', exe)).toBe(a);
    expect(locateClaude({ PATH: 'C_a', USERPROFILE: 'C_u' }, (p) => p === u, 'win32', exe)).toBe(u);
    expect(locateClaude({ PATH: 'C_a', USERPROFILE: 'C_u' }, () => false, 'win32', exe)).toBeNull();
    expect(exe).not.toHaveBeenCalled();
  });
});

describe('locateClaude — darwin', () => {
  const FIXED = (home: string) => [`${home}/.local/bin/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude', `${home}/.claude/local/claude`];
  /** 실행 파일 확인 — 이 묶음의 위쪽 시험은 '있으면 실행 파일'로 친다(진짜 파일 시스템을 보지 않는다) */
  const EXE = () => true;

  it('darwin_PATH_는_콜론으로_나누고_claude_를_찾는다 — 앞쪽 폴더가 우선, 빈 칸·상대 경로는 건너뛴다', () => {
    const seen: string[] = [];
    const exists = (p: string) => (seen.push(p), p === '/b/bin/claude' || p === '/c/claude');
    expect(locateClaude({ PATH: '::bin:./x:/a:/b/bin:/c', HOME: '/Users/a' }, exists, 'darwin', EXE)).toBe('/b/bin/claude');
    expect(seen).toEqual(['/a/claude', '/b/bin/claude']); // claude.exe 도, 역슬래시도 아니다
  });

  it('darwin_PATH_에_없으면_고정_후보_순서대로(HOME 기준 네 곳)', () => {
    const seen: string[] = [];
    expect(locateClaude({ PATH: '/usr/bin:/bin', HOME: '/Users/a' }, (p) => (seen.push(p), false), 'darwin', EXE)).toBeNull();
    expect(seen).toEqual(['/usr/bin/claude', '/bin/claude', ...FIXED('/Users/a')]);
    // 하나씩 — 앞의 것이 있으면 그것
    for (const want of FIXED('/Users/a')) {
      expect(locateClaude({ PATH: '/usr/bin', HOME: '/Users/a' }, (p) => p === want, 'darwin', EXE)).toBe(want);
    }
    const two = FIXED('/Users/a').slice(1, 3);
    expect(locateClaude({ PATH: '/usr/bin', HOME: '/Users/a' }, (p) => two.includes(p), 'darwin', EXE)).toBe('/opt/homebrew/bin/claude');
  });

  it('홈 경로 끝의 / 도 한 번만', () => {
    expect(locateClaude({ HOME: '/Users/a/' }, (p) => p === '/Users/a/.local/bin/claude', 'darwin', EXE)).toBe('/Users/a/.local/bin/claude');
  });

  it('HOME_이_없어도_던지지_않는다 — 홈 기준 후보만 건너뛴다(USERPROFILE 도 보지 않는다)', () => {
    const seen: string[] = [];
    expect(locateClaude({ USERPROFILE: 'C_u' }, (p) => (seen.push(p), false), 'darwin', EXE)).toBeNull();
    expect(seen).toEqual(['/opt/homebrew/bin/claude', '/usr/local/bin/claude']);
    expect(locateClaude({}, (p) => p === '/usr/local/bin/claude', 'darwin', EXE)).toBe('/usr/local/bin/claude');
    expect(locateClaude({ HOME: 'relative' }, (p) => p.startsWith('relative'), 'darwin', EXE)).toBeNull();
  });

  // 가짜 파일 시스템 — 진짜 디스크·실행 권한을 보지 않는다(Windows 의 X_OK 는 있기만 보면 참이라 진짜로는 가를 수 없다)
  type Entry = 'dir' | 'file' | 'exe';
  function fakeFs(tree: Record<string, Entry>) {
    const access = vi.fn((p: string, mode: number) => {
      expect(mode).toBe(fs.constants.X_OK);
      if (tree[p] !== 'exe') throw Object.assign(new Error(`EACCES: permission denied, access '${p}'`), { code: 'EACCES' });
    });
    const io = {
      statSync: (p: string) => {
        const e = tree[p];
        if (!e) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: 'ENOENT' });
        return { isFile: () => e !== 'dir' };
      },
      accessSync: access,
    };
    return { io, access, exists: (p: string) => p in tree };
  }

  it('darwin_PATH_앞의_claude_가_폴더면_건너뛴다 — 뒤의 실행 파일을 고른다(폴더를 띄우면 EACCES)', () => {
    const f = fakeFs({ '/a/claude': 'dir', '/b/claude': 'exe' });
    expect(locateClaude({ PATH: '/a:/b' }, f.exists, 'darwin', (p) => isExecutableFile(p, f.io))).toBe('/b/claude');
  });

  it('darwin_실행_권한이_없는_파일도_건너뛴다 — 고정 후보까지 그렇다', () => {
    const f = fakeFs({ '/a/claude': 'file', '/b/claude': 'exe' });
    expect(locateClaude({ PATH: '/a:/b' }, f.exists, 'darwin', (p) => isExecutableFile(p, f.io))).toBe('/b/claude');
    const g = fakeFs({ '/Users/a/.local/bin/claude': 'file', '/opt/homebrew/bin/claude': 'dir', '/usr/local/bin/claude': 'exe' });
    expect(locateClaude({ PATH: '/usr/bin', HOME: '/Users/a' }, g.exists, 'darwin', (p) => isExecutableFile(p, g.io))).toBe('/usr/local/bin/claude');
    // 쓸 수 있는 것이 하나도 없으면 null
    const h = fakeFs({ '/a/claude': 'dir', '/Users/a/.local/bin/claude': 'file' });
    expect(locateClaude({ PATH: '/a', HOME: '/Users/a' }, h.exists, 'darwin', (p) => isExecutableFile(p, h.io))).toBeNull();
  });
});

describe('isExecutableFile — POSIX 의 claude 후보 확인', () => {
  const fail = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  it('보통 파일이고 X_OK 면 참 — 폴더·실행 권한 없음·없음은 거짓(던지지 않는다)', () => {
    const access = vi.fn();
    expect(isExecutableFile('/x/claude', { statSync: () => ({ isFile: () => true }), accessSync: access })).toBe(true);
    expect(access).toHaveBeenCalledWith('/x/claude', fs.constants.X_OK);
    const dirAccess = vi.fn();
    expect(isExecutableFile('/x/claude', { statSync: () => ({ isFile: () => false }), accessSync: dirAccess })).toBe(false);
    expect(dirAccess).not.toHaveBeenCalled(); // 폴더는 X_OK(들어가기)라도 실행 파일이 아니다
    expect(isExecutableFile('/x/claude', { statSync: () => ({ isFile: () => true }), accessSync: fail('EACCES') })).toBe(false);
    expect(isExecutableFile('/x/claude', { statSync: fail('ENOENT'), accessSync: vi.fn() })).toBe(false);
  });
});

const CL = { command: 'claude.exe', argsPrefix: [] as string[] };
describe('authStatus', () => {
  it('정상 JSON — authMethod·이메일·조직은 결과에 없다', async () => {
    let seen: { cmd: string; args: string[] } | null = null;
    const r = await authStatus({ command: 'node', argsPrefix: ['fake.mjs'] }, async (cmd, args) => {
      seen = { cmd, args };
      return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', orgName: 'o', subscriptionType: 'max' }) };
    });
    expect(seen).toEqual({ cmd: 'node', args: ['fake.mjs', 'auth', 'status', '--json'] });
    expect(r).toEqual({ loggedIn: true });
    expect(Object.keys(r)).toEqual(['loggedIn']);
  });
  it('exit 1 → 로그인 안 됨', async () => {
    expect(await authStatus(CL, async () => ({ code: 1, stdout: '{"loggedIn":true}' }))).toEqual({ loggedIn: false });
  });
  it('깨진 JSON → 로그인 안 됨', async () => {
    expect(await authStatus(CL, async () => ({ code: 0, stdout: 'not json' }))).toEqual({ loggedIn: false });
  });
  it('실행 오류 → 로그인 안 됨', async () => {
    expect(await authStatus(CL, async () => { throw new Error('ENOENT'); })).toEqual({ loggedIn: false });
  });
  it('loggedIn 이 불리언 true 가 아니면 false', async () => {
    expect(await authStatus(CL, async () => ({ code: 0, stdout: '{"loggedIn":"yes"}' }))).toEqual({ loggedIn: false });
  });
});

describe('claudeVersion', () => {
  it('맨 앞 x.y.z 만', async () => {
    let args: string[] = [];
    const v = await claudeVersion({ command: 'node', argsPrefix: ['f.mjs'] }, async (_c, a) => {
      args = a;
      return { code: 0, stdout: '2.1.304 (Claude Code)\n' };
    });
    expect(v).toBe('2.1.304');
    expect(args).toEqual(['f.mjs', '--version']);
  });
  it('못 읽으면 null', async () => {
    expect(await claudeVersion(CL, async () => ({ code: 0, stdout: 'hello' }))).toBeNull();
    expect(await claudeVersion(CL, async () => ({ code: 1, stdout: '2.1.1' }))).toBeNull();
    expect(await claudeVersion(CL, async () => { throw new Error('x'); })).toBeNull();
  });
});


// 가짜 claude 의 설치·로그인·갱신 갈래 — auth status · auth login · update · --version
const fake = path.resolve(__dirname, 'fakeClaude.mjs');
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-setup-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [fake, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, FAKE_CLAUDE_LOG: '', FAKE_CLAUDE_LOGGED_OUT: '', FAKE_CLAUDE_LOGIN_FILE: '', ...env },
  });

describe('가짜 claude 설치·로그인·갱신', () => {
  it('auth status --json 은 기본 loggedIn true', () => {
    const r = run(['auth', 'status', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ loggedIn: true });
  });

  it('FAKE_CLAUDE_LOGGED_OUT=1 이면 loggedIn false', () => {
    const r = run(['auth', 'status', '--json'], { FAKE_CLAUDE_LOGGED_OUT: '1' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ loggedIn: false });
  });

  it('auth login --claudeai 는 LOGIN_FILE 을 만들고, 그 뒤 로그아웃 가짜도 loggedIn true', () => {
    const loginFile = path.join(dir, 'logged-in');
    const env = { FAKE_CLAUDE_LOGGED_OUT: '1', FAKE_CLAUDE_LOGIN_FILE: loginFile };
    expect(JSON.parse(run(['auth', 'status', '--json'], env).stdout)).toEqual({ loggedIn: false });
    const login = run(['auth', 'login', '--claudeai'], env);
    expect(login.status).toBe(0);
    expect(fs.existsSync(loginFile)).toBe(true);
    expect(JSON.parse(run(['auth', 'status', '--json'], env).stdout)).toEqual({ loggedIn: true });
  });

  it('update 는 코드 0 과 기록 한 줄', () => {
    const logFile = path.join(dir, 'log.jsonl');
    const r = run(['update'], { FAKE_CLAUDE_LOG: logFile });
    expect(r.status).toBe(0);
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ event: 'update' });
  });

  it('FAKE_CLAUDE_UPDATE_CODE=1 이면 종료 코드 1', () => {
    expect(run(['update'], { FAKE_CLAUDE_UPDATE_CODE: '1' }).status).toBe(1);
  });

  it('--version 은 2.1.304 (Claude Code)', () => {
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('2.1.304 (Claude Code)');
  });
});
