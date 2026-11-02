import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ~/.ssh/config 의 서버 목록 — 읽기만 한다(쓰거나 만들지 않는다). 리터럴 Host 별칭만.

export interface SshHostEntry {
  host: string;
  user: string | null;
  hostName: string | null;
  port: number | null;
}

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
        for (const p of value.split(/\s+/).map(unquote)) {
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

/** Include 패턴 → 글들. 상대 경로는 <home>/.ssh 기준, `~/` 는 <home>, 마지막 조각의 `*` 만 */
function includeTexts(home: string, pattern: string): string[] {
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
  return files.map(readText).filter((t): t is string => t !== null);
}

/** `<home>/.ssh/config` 의 서버 목록 — 없거나 못 읽으면 [] (던지지 않음) */
export function readSshHosts(home: string = os.homedir()): SshHostEntry[] {
  try {
    const text = readText(path.join(home, '.ssh', 'config'));
    if (text === null) return [];
    return parseSshConfig(text, (p) => includeTexts(home, p));
  } catch {
    return [];
  }
}
