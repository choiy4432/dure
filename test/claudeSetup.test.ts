import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { locateClaude, authStatus } from '../src/engine/claudeSetup';

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

describe('authStatus', () => {
  it('정상 JSON — 이메일·조직은 결과에 없다', async () => {
    let seen: { cmd: string; args: string[] } | null = null;
    const r = await authStatus('claude.exe', async (cmd, args) => {
      seen = { cmd, args };
      return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', orgName: 'o', subscriptionType: 'max' }) };
    });
    expect(seen).toEqual({ cmd: 'claude.exe', args: ['auth', 'status', '--json'] });
    expect(r).toEqual({ loggedIn: true, authMethod: 'claude.ai' });
    expect(Object.keys(r)).toEqual(['loggedIn', 'authMethod']);
  });
  it('exit 1 → 로그인 안 됨', async () => {
    const r = await authStatus('claude.exe', async () => ({ code: 1, stdout: '{"loggedIn":true,"authMethod":"x"}' }));
    expect(r).toEqual({ loggedIn: false, authMethod: null });
  });
  it('깨진 JSON → 로그인 안 됨', async () => {
    expect(await authStatus('claude.exe', async () => ({ code: 0, stdout: 'not json' }))).toEqual({ loggedIn: false, authMethod: null });
  });
  it('실행 오류 → 로그인 안 됨', async () => {
    expect(await authStatus('claude.exe', async () => { throw new Error('ENOENT'); })).toEqual({ loggedIn: false, authMethod: null });
  });
  it('loggedIn 이 불리언 true 가 아니면 false', async () => {
    const r = await authStatus('claude.exe', async () => ({ code: 0, stdout: '{"loggedIn":"yes","authMethod":5}' }));
    expect(r).toEqual({ loggedIn: false, authMethod: null });
  });
});
