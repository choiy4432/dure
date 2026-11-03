import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateClaude, authStatus, claudeVersion } from '../src/engine/claudeSetup';

describe('locateClaude', () => {
  it('PATH 앞쪽 폴더가 우선', () => {
    const a = path.join('C_a', 'claude.exe');
    const b = path.join('C_b', 'claude.exe');
    const r = locateClaude({ PATH: 'C_a;;C_b', USERPROFILE: 'C_u' }, (p) => p === a || p === b);
    expect(r).toBe(a);
  });
  it('Path(대소문자 다름) 도 읽는다', () => {
    const a = path.join('C_a', 'claude.exe');
    expect(locateClaude({ Path: 'C_a' }, (p) => p === a)).toBe(a);
  });
  it('PATH 에 없고 USERPROFILE 에 있음', () => {
    const u = path.join('C_u', '.local', 'bin', 'claude.exe');
    expect(locateClaude({ PATH: 'C_a', USERPROFILE: 'C_u' }, (p) => p === u)).toBe(u);
  });
  it('둘 다 없으면 null', () => {
    expect(locateClaude({ PATH: 'C_a', USERPROFILE: 'C_u' }, () => false)).toBeNull();
    expect(locateClaude({}, () => true)).toBeNull();
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
