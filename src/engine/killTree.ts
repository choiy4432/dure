import { execFile } from 'node:child_process';

export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 이미 끝남 */
    }
    resolve();
  });
}
