import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude 설정 폴더 — 엔진 옵션 env → 프로세스 env → ~/.claude */
export function claudeDirOf(env: NodeJS.ProcessEnv | undefined): string {
  return env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** projects/ 아래 폴더마다 <id>.jsonl 이 있는지만 본다(열지 않는다) — 없거나 못 읽으면 빈 Set, 던지지 않는다 */
export function existingSessions(claudeDir: string, ids: string[]): Set<string> {
  const found = new Set<string>();
  try {
    const root = path.join(claudeDir, 'projects');
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const id of ids) {
      if (dirs.some((d) => fs.existsSync(path.join(root, d.name, `${id}.jsonl`)))) found.add(id);
    }
  } catch { /* projects 가 없다 */ }
  return found;
}
