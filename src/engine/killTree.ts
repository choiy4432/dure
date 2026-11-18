import { execFile } from 'node:child_process';
import { isPosix, type Platform } from './platform';

/** POSIX — 그룹에 SIGTERM 을 보낸 뒤 남아 있으면 이만큼 뒤에 SIGKILL */
export const KILL_GRACE_MS = 1500;
/** 그 사이 그룹이 다 끝났나 이만큼마다 본다 — 다 끝났으면 상한까지 기다리지 않는다(멈춤·다시 띄우기가 늦지 않게) */
const KILL_POLL_MS = 100;

export interface KillTreeOptions {
  /** 기본 process.platform */
  platform?: Platform;
  /** 시험용 — process.kill 자리. 신호 0 은 살아 있나만 본다 */
  kill?: (pid: number, sig: NodeJS.Signals | 0) => void;
  /** 시험용 — execFile 자리(taskkill) */
  exec?: typeof execFile;
  /** 시험용 — 기다리기. 바로 풀리는 것을 주면 TERM 뒤 곧 KILL(forceKill) */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 프로세스 나무를 끈다 — 던지지 않는다.
 * win32: `taskkill /PID <pid> /T /F`(지금 그대로).
 * POSIX: spawnOpts 로(detached) 띄운 자식은 그룹 리더라 -pid 가 그 그룹(손자까지) — 그룹에 SIGTERM → KILL_GRACE_MS 까지 다 끝나길 기다리고
 *   → 남았으면 SIGKILL. -pid 가 안 되면(ESRCH — 그룹으로 띄우지 않음 · EPERM) 그 pid 하나로 물러선다. 그것도 던지면 이미 끝난 것 — 아무것도 안 한다.
 *   🔴 pid 가 1 이하(또는 정수가 아님)면 아무것도 안 한다 — kill(-0) 은 두레 자신의 그룹, kill(-1) 은 보낼 수 있는 모든 프로세스다
 */
export async function killTree(pid: number, o: KillTreeOptions = {}): Promise<void> {
  const platform = o.platform ?? (process.platform as Platform);
  if (!isPosix(platform)) {
    const exec = o.exec ?? execFile;
    return new Promise((resolve) => {
      exec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  }
  if (!Number.isInteger(pid) || pid <= 1) return;
  const kill = o.kill ?? ((p: number, sig: NodeJS.Signals | 0) => void process.kill(p, sig));
  const wait = o.wait ?? sleep;
  /** 보냈으면 true — 던지면(ESRCH 끝남 · EPERM) false */
  const send = (target: number, sig: NodeJS.Signals | 0): boolean => {
    try {
      kill(target, sig);
      return true;
    } catch {
      return false;
    }
  };
  let target = -pid;
  if (!send(target, 'SIGTERM')) {
    target = pid;
    if (!send(target, 'SIGTERM')) return; // 이미 끝남
  }
  for (let waited = 0; waited < KILL_GRACE_MS; waited += KILL_POLL_MS) {
    await wait(KILL_POLL_MS);
    if (!send(target, 0)) return; // 다 끝났다 — 같은 번호를 물려받은 남을 SIGKILL 하지 않게 여기서 멈춘다
  }
  send(target, 'SIGKILL');
}
