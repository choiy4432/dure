import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ~/.ssh/config 의 서버 목록 — 읽기만 한다(쓰거나 만들지 않는다). 리터럴 Host 별칭만.

import type { SshHostEntry } from './types'; // 화면(web 빌드)도 타입을 쓰니 정의는 types.ts
export type { SshHostEntry };

const MAX_DEPTH = 8; // Include 순환 방지

const unquote = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

/** 리터럴 이름만 — 와일드카드·부정 패턴은 목록에 못 올린다 */
const isLiteral = (p: string) => p !== '' && !/[*?]/.test(p) && !p.startsWith('!');

function parsePort(v: string): number | null {
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 65535 ? n : null;
}

/** `readInclude(패턴)` = 그 Include 가 가리키는 파일들의 글(없으면 []) */
export function parseSshConfig(text: string, readInclude?: (pattern: string) => string[]): SshHostEntry[] {
  const out: SshHostEntry[] = [];
  const seen = new Set<string>();
  // 지금 채우는 Host 블록 — Match 블록·첫 Host 앞은 null(옵션을 버린다)
  let block: SshHostEntry[] | null = null;

  const walk = (src: string, depth: number) => {
    for (const raw of src.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === 'include') {
        if (!readInclude || depth >= MAX_DEPTH) continue;
        for (const pat of value.split(/\s+/).map(unquote).filter(Boolean)) {
          for (const t of readInclude(pat)) walk(t, depth + 1);
        }
      } else if (key === 'host') {
        block = [];
        // `#` 로 시작하는 토큰부터는 주석(`Host dev # note`)
        const words = value.split(/\s+/);
        const cut = words.findIndex((w) => w.startsWith('#'));
        for (const p of (cut < 0 ? words : words.slice(0, cut)).map(unquote)) {
          if (!isLiteral(p) || seen.has(p)) continue;
          seen.add(p);
          const e: SshHostEntry = { host: p, user: null, hostName: null, port: null };
          out.push(e);
          block.push(e);
        }
      } else if (key === 'match') {
        block = null;
      } else if (block) {
        const v = unquote(value);
        // ssh 처럼 같은 키워드는 처음 값이 이긴다
        for (const e of block) {
          if (key === 'hostname' && e.hostName === null) e.hostName = v;
          else if (key === 'user' && e.user === null) e.user = v;
          else if (key === 'port' && e.port === null) e.port = parsePort(v);
        }
      }
    }
  };
  walk(text, 0);
  return out;
}

const readText = (f: string): string | null => {
  try { return fs.statSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null; } catch { return null; }
};

/** 같은 파일인지 — 링크를 풀고, 윈도우는 대소문자 무시 */
function fileKey(f: string): string {
  let r: string;
  try { r = fs.realpathSync.native(f); } catch { r = path.resolve(f); }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * Include 패턴 → 글들. 상대 경로는 <home>/.ssh 기준, `~/` 는 <home>, 마지막 조각의 `*` 만.
 * read = 이미 읽은 파일 — 자기 자신·`Include *` 가 config 를 다시 가리켜도 한 번만(동기 읽기라 늘어나면 앱이 멈춘다)
 */
function includeTexts(home: string, pattern: string, read: Set<string>): string[] {
  const sshDir = path.join(home, '.ssh');
  const full = pattern.startsWith('~/') || pattern.startsWith('~' + path.sep)
    ? path.join(home, pattern.slice(2))
    : path.isAbsolute(pattern) ? pattern : path.join(sshDir, pattern);
  const dir = path.dirname(full);
  const base = path.basename(full);
  const files: string[] = [];
  if (base.includes('*')) {
    const re = new RegExp('^' + base.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    try {
      for (const n of fs.readdirSync(dir).sort()) if (re.test(n)) files.push(path.join(dir, n));
    } catch { /* 디렉터리 없음 */ }
  } else {
    files.push(full);
  }
  const texts: string[] = [];
  for (const f of files) {
    const k = fileKey(f);
    if (read.has(k)) continue;
    read.add(k);
    const t = readText(f);
    if (t !== null) texts.push(t);
  }
  return texts;
}

/** `<home>/.ssh/config` 의 서버 목록 — 없거나 못 읽으면 [] (던지지 않음) */
export function readSshHosts(home: string = os.homedir()): SshHostEntry[] {
  try {
    const config = path.join(home, '.ssh', 'config');
    const text = readText(config);
    if (text === null) return [];
    const read = new Set([fileKey(config)]);
    return parseSshConfig(text, (p) => includeTexts(home, p, read));
  } catch {
    return [];
  }
}
