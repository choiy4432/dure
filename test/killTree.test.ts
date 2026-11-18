import { describe, expect, it, vi } from 'vitest';
import { KILL_GRACE_MS, killTree } from '../src/engine/killTree';

// 나무째 끄기 — 진짜 신호는 보내지 않는다(kill·exec·wait 를 갈아끼운다)

const esrch = () => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });

/** 가짜 process.kill — 부른 차례를 적는다. dead(target, sig) 가 참이면 ESRCH 로 던진다 */
function fakeKill(dead: (target: number, sig: NodeJS.Signals | 0) => boolean = () => false) {
  const calls: [number, NodeJS.Signals | 0][] = [];
  const kill = vi.fn((target: number, sig: NodeJS.Signals | 0) => {
    calls.push([target, sig]);
    if (dead(target, sig)) throw esrch();
  });
  /** 신호 0(살아 있나 보기)을 뺀 것 */
  const signals = () => calls.filter(([, s]) => s !== 0);
  return { kill, calls, signals };
}

/** 가짜 기다리기 — 기다린 ms 를 더한다. 신호를 보낸 때의 누적을 적어 둘 수 있게 */
function fakeWait() {
  const w = { total: 0, wait: vi.fn(async (ms: number) => { w.total += ms; }) };
  return w;
}

describe('killTree', () => {
  it('win32_는_taskkill_인자_그대로', async () => {
    const exec = vi.fn((_c: string, _a: string[], _o: object, cb: () => void) => cb());
    const { kill } = fakeKill();
    await killTree(4242, { platform: 'win32', exec: exec as any, kill });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]!.slice(0, 3)).toEqual(['taskkill', ['/PID', '4242', '/T', '/F'], { windowsHide: true }]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('win32 — taskkill 이 실패해도(콜백 오류) resolve', async () => {
    const exec = vi.fn((_c: string, _a: string[], _o: object, cb: (e: Error) => void) => cb(new Error('없음')));
    await expect(killTree(7, { platform: 'win32', exec: exec as any })).resolves.toBeUndefined();
  });

  it('darwin_은_그룹에_TERM_뒤_1500ms_에_KILL', async () => {
    expect(KILL_GRACE_MS).toBe(1500);
    const k = fakeKill();
    const w = fakeWait();
    let killAt = -1;
    k.kill.mockImplementation((target, sig) => {
      k.calls.push([target, sig]);
      if (sig === 'SIGKILL') killAt = w.total;
    });
    await killTree(4242, { platform: 'darwin', kill: k.kill, wait: w.wait });
    expect(k.signals()).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
    expect(killAt).toBe(1500);
    // 그 사이 살아 있나 보는 것도 그룹(-pid)에
    expect(k.calls.filter(([, s]) => s === 0).every(([t]) => t === -4242)).toBe(true);
  });

  it('TERM 에 그룹이 다 끝나면 KILL 은 보내지 않고 바로 돌아온다', async () => {
    let termed = false;
    const k = fakeKill();
    k.kill.mockImplementation((target, sig) => {
      k.calls.push([target, sig]);
      if (sig === 'SIGTERM') termed = true;
      else if (sig === 0 && termed) throw esrch();
    });
    const w = fakeWait();
    await killTree(4242, { platform: 'darwin', kill: k.kill, wait: w.wait });
    expect(k.signals()).toEqual([[-4242, 'SIGTERM']]);
    expect(w.total).toBeLessThan(KILL_GRACE_MS);
  });

  it('그룹이_없으면(ESRCH)_pid_하나로_물러선다', async () => {
    const k = fakeKill((target) => target < 0); // 그룹으로 띄우지 않은 pid — -pid 는 늘 ESRCH
    const w = fakeWait();
    await killTree(4242, { platform: 'darwin', kill: k.kill, wait: w.wait });
    expect(k.signals()).toEqual([[-4242, 'SIGTERM'], [4242, 'SIGTERM'], [4242, 'SIGKILL']]);
    expect(w.total).toBe(1500);
  });

  it('EPERM 도 pid 하나로 물러선다', async () => {
    const k = fakeKill();
    k.kill.mockImplementation((target, sig) => {
      k.calls.push([target, sig]);
      if (target < 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    await killTree(4242, { platform: 'darwin', kill: k.kill, wait: fakeWait().wait });
    expect(k.signals()).toEqual([[-4242, 'SIGTERM'], [4242, 'SIGTERM'], [4242, 'SIGKILL']]);
  });

  it('둘_다_던져도_resolve — 이미 끝났으니 기다리지도 KILL 하지도 않는다', async () => {
    const k = fakeKill(() => true);
    const w = fakeWait();
    await expect(killTree(4242, { platform: 'darwin', kill: k.kill, wait: w.wait })).resolves.toBeUndefined();
    expect(k.signals()).toEqual([[-4242, 'SIGTERM'], [4242, 'SIGTERM']]);
    expect(w.wait).not.toHaveBeenCalled();
  });

  it('KILL 이 던져도 resolve', async () => {
    const k = fakeKill((_t, sig) => sig === 'SIGKILL');
    await expect(killTree(4242, { platform: 'darwin', kill: k.kill, wait: fakeWait().wait })).resolves.toBeUndefined();
    expect(k.signals()).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  });

  it('pid_가_0_이하면_아무것도_안_한다(자기 그룹 보호) — 1(-1 은 모든 프로세스)·정수 아님도', async () => {
    for (const pid of [0, -5, 1, Number.NaN, 2.5]) {
      const k = fakeKill();
      const w = fakeWait();
      await killTree(pid, { platform: 'darwin', kill: k.kill, wait: w.wait });
      await killTree(pid, { platform: 'linux', kill: k.kill, wait: w.wait });
      expect(k.kill).not.toHaveBeenCalled();
      expect(w.wait).not.toHaveBeenCalled();
    }
  });

  it('기다리지 않게(wait 가 바로 풀림) 주면 TERM 뒤 곧 KILL — forceKill 이 쓴다', async () => {
    const k = fakeKill();
    await killTree(4242, { platform: 'darwin', kill: k.kill, wait: () => Promise.resolve() });
    expect(k.signals()).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  });
});
