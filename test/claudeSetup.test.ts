// 가짜 claude 의 설치·로그인·갱신 갈래 — auth status · auth login · update · --version
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
