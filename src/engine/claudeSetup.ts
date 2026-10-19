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

export async function authStatus(
  claudePath: string,
  run: Run = defaultRun,
): Promise<{ loggedIn: boolean; authMethod: string | null }> {
  const none = { loggedIn: false, authMethod: null };
  try {
    const { stdout, code } = await run(claudePath, ['auth', 'status', '--json']);
    if (code !== 0) return none;
    const j = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
    if (j.loggedIn !== true) return none;
    return { loggedIn: true, authMethod: typeof j.authMethod === 'string' ? j.authMethod : null };
  } catch {
    return none;
  }
}
