import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { claudeEnv } from './claudeEnv';
import type { Platform } from './platform';

/**
 * 이 PC 의 claude — PATH 를 앞에서부터, 없으면 공식 설치기 자리. 못 찾으면 null.
 * win32: PATH 를 ';' 로 · claude.exe · %USERPROFILE%\.local\bin\claude.exe (지금 그대로).
 * POSIX(mac): PATH 를 ':' 로(절대 경로 칸만) · claude → 고정 후보 차례로 — ~/.local/bin(공식 install.sh) · /opt/homebrew/bin(Apple Silicon Homebrew) ·
 *   /usr/local/bin(Intel Homebrew) · ~/.claude/local(옛 로컬 설치). Finder 로 켠 앱의 PATH 는 main 이 로그인 셸에서 먼저 메운다(shellPath.ts) — 이 목록은 그게 안 될 때의 받침
 */
export function locateClaude(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
  platform: Platform = process.platform as Platform,
): string | null {
  const pathVar = env.PATH ?? env.Path ?? '';
  if (platform !== 'win32') {
    for (const candidate of [
      ...pathVar.split(':').filter((dir) => dir.startsWith('/')).map((dir) => path.posix.join(dir, 'claude')),
      ...posixFixed(env.HOME),
    ]) {
      if (exists(candidate)) return candidate;
    }
    return null;
  }
  for (const dir of pathVar.split(';')) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude.exe');
    if (exists(candidate)) return candidate;
  }
  if (env.USERPROFILE) {
    const candidate = path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe');
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** POSIX 고정 후보 — 홈이 없거나 절대 경로가 아니면 홈 기준 둘은 건너뛴다 */
function posixFixed(home: string | undefined): string[] {
  const h = home?.startsWith('/') ? home : null;
  return [
    ...(h ? [path.posix.join(h, '.local', 'bin', 'claude')] : []),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    ...(h ? [path.posix.join(h, '.claude', 'local', 'claude')] : []),
  ];
}

type Run = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

const defaultRun: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, env: claudeEnv(process.env) }, (err, stdout) => {
      if (!err) return resolve({ stdout: String(stdout), code: 0 });
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      if (typeof code === 'number') return resolve({ stdout: String(stdout ?? ''), code });
      reject(err);
    });
  });

/** 로그인 확인 — `claude auth status --json` 의 loggedIn 만 읽는다(authMethod·이메일 등은 버린다) */
export async function authStatus(
  claude: { command: string; argsPrefix: string[] },
  run: Run = defaultRun,
): Promise<{ loggedIn: boolean }> {
  try {
    const { stdout, code } = await run(claude.command, [...claude.argsPrefix, 'auth', 'status', '--json']);
    if (code !== 0) return { loggedIn: false };
    const j = JSON.parse(stdout) as { loggedIn?: unknown };
    return { loggedIn: j.loggedIn === true };
  } catch {
    return { loggedIn: false };
  }
}

/** `claude --version` 의 맨 앞 x.y.z — 못 읽으면 null */
export async function claudeVersion(
  claude: { command: string; argsPrefix: string[] },
  run: Run = defaultRun,
): Promise<string | null> {
  try {
    const { stdout, code } = await run(claude.command, [...claude.argsPrefix, '--version']);
    if (code !== 0) return null;
    return /^\s*(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}
