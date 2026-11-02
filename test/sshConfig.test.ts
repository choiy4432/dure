import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSshConfig, readSshHosts } from '../src/engine/sshConfig';

const e = (host: string, o: Partial<{ user: string; hostName: string; port: number }> = {}) =>
  ({ host, user: o.user ?? null, hostName: o.hostName ?? null, port: o.port ?? null });

describe('parseSshConfig', () => {
  it('Host 한 줄 여러 별칭 — 같은 설정을 나눠 갖는다', () => {
    const r = parseSshConfig('Host a b\n  HostName 10.0.0.12\n  User me\n  Port 2222\n');
    expect(r).toEqual([e('a', { hostName: '10.0.0.12', user: 'me', port: 2222 }), e('b', { hostName: '10.0.0.12', user: 'me', port: 2222 })]);
  });
  it('와일드카드·부정 패턴은 뺀다', () => {
    const r = parseSshConfig('Host *\n User x\nHost *.corp\nHost !x\nHost ?ab\nHost dev *.y\n');
    expect(r.map((h) => h.host)).toEqual(['dev']);
  });
  it('키워드 대소문자 무시 · = 구분 · 주석·빈 줄', () => {
    const r = parseSshConfig('# c\n\nhost dev\n  hostname=gpu-box\n  USER = me\n  port 22\n');
    expect(r).toEqual([e('dev', { hostName: 'gpu-box', user: 'me', port: 22 })]);
  });
  it('따옴표 값은 한 쌍만 벗긴다', () => {
    expect(parseSshConfig('Host dev\n HostName "my host"\n')[0].hostName).toBe('my host');
  });
  it('Port 가 정수 1..65535 가 아니면 null', () => {
    for (const p of ['0', '65536', 'abc', '22x', '-1']) {
      expect(parseSshConfig(`Host dev\n Port ${p}\n`)[0].port).toBeNull();
    }
    expect(parseSshConfig('Host dev\n Port 65535\n')[0].port).toBe(65535);
  });
  it('Match 블록은 무시하고 다음 Host 부터', () => {
    const r = parseSshConfig('Host a\n User ua\nMatch host a\n User zzz\n HostName bad\nHost b\n User ub\n');
    expect(r).toEqual([e('a', { user: 'ua' }), e('b', { user: 'ub' })]);
  });
  it('첫 Host 앞 전역 옵션은 무시', () => {
    expect(parseSshConfig('User g\nHost a\n')).toEqual([e('a')]);
  });
  it('같은 별칭 두 번이면 처음 것', () => {
    const r = parseSshConfig('Host a\n User first\nHost a\n User second\n');
    expect(r).toEqual([e('a', { user: 'first' })]);
  });
  it('같은 키워드가 두 번이면 처음 값(ssh 와 같다)', () => {
    expect(parseSshConfig('Host a\n User one\n User two\n')[0].user).toBe('one');
  });
  it('Include — readInclude 글을 그 자리에 파싱', () => {
    const got: string[] = [];
    const r = parseSshConfig('Host a\nInclude other\nHost c\n', (p) => { got.push(p); return ['Host b\n User ub\n']; });
    expect(got).toEqual(['other']);
    expect(r.map((h) => h.host)).toEqual(['a', 'b', 'c']);
    expect(r[1].user).toBe('ub');
  });
  it('Include 순환은 깊이 제한으로 끊긴다', () => {
    const r = parseSshConfig('Host a\nInclude self\n', () => ['Host a\nInclude self\n']);
    expect(r.map((h) => h.host)).toEqual(['a']);
  });
  it('readInclude 없으면 Include 는 무시', () => {
    expect(parseSshConfig('Include x\nHost a\n').map((h) => h.host)).toEqual(['a']);
  });
});

describe('readSshHosts', () => {
  const mk = () => mkdtempSync(join(tmpdir(), 'dure-ssh-'));
  it('config 없으면 []', () => {
    const home = mk();
    try { expect(readSshHosts(home)).toEqual([]); } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('config 를 읽고 Include(상대·~/·* )를 푼다', () => {
    const home = mk();
    try {
      mkdirSync(join(home, '.ssh', 'conf.d'), { recursive: true });
      writeFileSync(join(home, '.ssh', 'config'),
        'Host top\n User t\nInclude conf.d/*.conf\nInclude ~/.ssh/extra\nInclude missing\n');
      writeFileSync(join(home, '.ssh', 'conf.d', 'a.conf'), 'Host gpu-box\n HostName 10.0.0.12\n');
      writeFileSync(join(home, '.ssh', 'conf.d', 'b.txt'), 'Host nope\n');
      writeFileSync(join(home, '.ssh', 'extra'), 'Host ex\n');
      const r = readSshHosts(home);
      expect(r.map((h) => h.host)).toEqual(['top', 'gpu-box', 'ex']);
      expect(r[1].hostName).toBe('10.0.0.12');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('config 가 디렉터리여도 던지지 않는다', () => {
    const home = mk();
    try {
      mkdirSync(join(home, '.ssh', 'config'), { recursive: true });
      expect(readSshHosts(home)).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
