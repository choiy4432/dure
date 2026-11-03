import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export function locateClaude(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  const pathVar = env.PATH ?? env.Path ?? '';
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

type Run = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

const defaultRun: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
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
