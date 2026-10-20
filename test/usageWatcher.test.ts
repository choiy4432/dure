import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RESET_GRACE_MS, UsageWatcher, USAGE_TIMING } from '../src/engine/usageWatcher';
import { toPlanUsage } from '../src/engine/usage';
import type { ClaudeSession } from '../src/engine/claudeSession';
import type { PlanUsage } from '../src/engine/types';

const RAW = {
  rate_limits_available: true,
  rate_limits: {
    limits: [
      { kind: 'session', percent: 12 },
      { kind: 'weekly_all', percent: 34 },
    ],
  },
};
const ANSWER_MS = 10;
const USAGE_REQ = { subtype: 'get_usage', skip_behaviors: true };
const MIN = 60_000;
/** 5시간 창·1주 창의 초기화가 지금부터 ms 뒤인 답 — null 이면 그 창엔 초기화 시각이 없다 */
const rawResets = (session: number | null, week: number | null) => {
  const at = (ms: number | null) => (ms === null ? {} : { resets_at: new Date(Date.now() + ms).toISOString() });
  return {
    rate_limits_available: true,
    rate_limits: { limits: [{ kind: 'session', percent: 100, ...at(session) }, { kind: 'weekly_all', percent: 34, ...at(week) }] },
  };
};

/**
 * ClaudeSession 흉내 — 답은 ANSWER_MS 뒤, hang 이면 진짜처럼 timeoutMs 뒤 거부, stop() 은 남은 요청을 거부한다.
 * stopMs 를 주면 진짜처럼 끝나기까지 시간이 걸린다(여러 번 불러도 같은 끝을 기다린다) — 'never' 면 끝나지 않는다.
 */
function fakeSession(o: { raw?: unknown; hang?: boolean; status?: string; stopMs?: number | 'never' } = {}) {
  let ending: Promise<void> | null = null;
  const f = {
    status: o.status ?? 'idle',
    log: [] as string[],
    requests: [] as { req: unknown; timeoutMs: number }[],
    pending: null as null | { reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> },
    ended: false,
    start() {
      f.log.push('start');
    },
    request(req: unknown, timeoutMs: number): Promise<unknown> {
      f.log.push('request');
      f.requests.push({ req, timeoutMs });
      return new Promise((resolve, reject) => {
        const timer = o.hang
          ? setTimeout(() => {
              f.pending = null;
              reject(new Error('요청 시간이 초과되었습니다'));
            }, timeoutMs)
          : setTimeout(() => {
              f.pending = null;
              resolve(o.raw ?? RAW);
            }, ANSWER_MS);
        f.pending = { reject, timer };
      });
    },
    stop(): Promise<void> {
      f.log.push('stop');
      if (f.pending) {
        clearTimeout(f.pending.timer);
        f.pending.reject(new Error('프로세스가 종료되었습니다'));
        f.pending = null;
      }
      const ms = o.stopMs ?? 0;
      ending ??=
        ms === 'never'
          ? new Promise<void>(() => {})
          : ms === 0
            ? Promise.resolve()
            : new Promise<void>((r) => setTimeout(r, ms));
      return ending.then(() => {
        f.ended = true;
      });
    },
  };
  return f;
}
type Fake = ReturnType<typeof fakeSession>;

function harness(o: { live?: Fake | null; probe?: () => Fake; spawnThrows?: boolean } = {}) {
  const h = {
    live: o.live ?? null,
    working: false,
    probes: [] as Fake[],
    emitted: [] as (PlanUsage | null)[],
    w: null as unknown as UsageWatcher,
  };
  h.w = new UsageWatcher({
    liveSession: () => h.live as unknown as ClaudeSession | null,
    spawnProbe: () => {
      if (o.spawnThrows) throw new Error('폴더를 만들 수 없어요');
      const p = (o.probe ?? (() => fakeSession()))();
      h.probes.push(p);
      return p as unknown as ClaudeSession;
    },
    anyWorking: () => h.working,
    now: () => Date.now(),
    emit: (u) => h.emitted.push(u),
    timing: USAGE_TIMING,
  });
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('usage: UsageWatcher', () => {
  test('시간 값은 정해진 그대로', () => {
    expect(USAGE_TIMING).toEqual({ startDelayMs: 2000, pollMs: 300_000, minAgeMs: 60_000, timeoutMs: 15_000 });
    expect(RESET_GRACE_MS).toBe(5000);
  });

  test('start() 2000 ms 뒤 한 번 받는다 — 세션이 없으면 사용량 전용 프로세스를 띄워 묻고 답 뒤 끈다', async () => {
    const h = harness();
    h.w.start();
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.probes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.probes).toHaveLength(1);
    const p = h.probes[0];
    expect(p.requests).toEqual([{ req: USAGE_REQ, timeoutMs: 15_000 }]);
    expect(p.log).toEqual(['start', 'request']);
    const at = Date.now() + ANSWER_MS;
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    const want = toPlanUsage(RAW, at);
    expect(want).not.toBeNull();
    expect(h.emitted).toEqual([want]);
    expect(h.w.current()).toEqual(want);
    expect(p.log).toEqual(['start', 'request', 'stop']);
  });

  test('살아 있는 세션이 있으면 거기에 묻고 사용량 전용 프로세스는 안 띄운다 — 그 세션은 끄지 않는다', async () => {
    const live = fakeSession({ status: 'working' });
    const h = harness({ live });
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    expect(live.requests).toEqual([{ req: USAGE_REQ, timeoutMs: 15_000 }]);
    expect(live.log).toEqual(['request']);
    expect(h.probes).toHaveLength(0);
    expect(h.emitted).toHaveLength(1);
    expect(h.w.current()?.windows.map((x) => x.percent)).toEqual([12, 34]);
  });

  test('동시에 두 번 불러도 요청 하나 — 같은 약속, 끝나면 다시 물을 수 있다', async () => {
    const h = harness();
    const a = h.w.refresh();
    const b = h.w.refresh();
    expect(b).toBe(a);
    expect(h.probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    await a;
    expect(h.probes[0].requests).toHaveLength(1);
    expect(h.emitted).toHaveLength(1);
    const c = h.w.refresh();
    expect(c).not.toBe(a);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    await c;
    expect(h.probes).toHaveLength(2);
    expect(h.emitted).toHaveLength(2);
  });

  test('turnEnded: 받은 적 없으면 받는다 · 30 초 뒤엔 무시 · 61 초 뒤엔 받는다', async () => {
    const h = harness();
    h.w.turnEnded();
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    expect(h.emitted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    h.w.turnEnded();
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    expect(h.probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    h.w.turnEnded();
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    expect(h.probes).toHaveLength(2);
    expect(h.emitted).toHaveLength(2);
  });

  test('requested(펼침 열기)도 같은 60 초 규칙', async () => {
    const h = harness();
    h.w.requested();
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    expect(h.probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    h.w.requested();
    expect(h.probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    h.w.requested();
    expect(h.probes).toHaveLength(2);
  });

  test('300 000 ms 마다 묻되 일하는 에이전트가 있을 때만', async () => {
    const h = harness();
    h.w.start();
    await vi.advanceTimersByTimeAsync(2000 + ANSWER_MS);
    expect(h.probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300_000 - 2000 - ANSWER_MS); // 첫 주기 — 아무도 일하지 않음
    expect(h.probes).toHaveLength(1);
    h.working = true;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.probes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.probes).toHaveLength(3);
    h.working = false;
    await vi.advanceTimersByTimeAsync(300_000 * 3);
    expect(h.probes).toHaveLength(3);
  });

  test('시간 초과면 사용량 전용 프로세스를 끄고 전 값 그대로 — 사건 없음, 다시 시도 안 함', async () => {
    let n = 0;
    const h = harness({ probe: () => fakeSession({ hang: ++n > 1 }) });
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    const before = h.w.current();
    expect(before).not.toBeNull();
    expect(h.emitted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(61_000);
    h.w.turnEnded();
    expect(h.probes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.probes[1].log).toEqual(['start', 'request']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.probes[1].log).toEqual(['start', 'request', 'stop']);
    expect(h.w.current()).toBe(before);
    expect(h.emitted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.probes).toHaveLength(2);
    expect(h.emitted).toHaveLength(1);
  });

  test('묻던 세션이 실패하면 전 값 그대로 — 사건 없음', async () => {
    const live = fakeSession();
    const h = harness({ live });
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    const before = h.w.current();
    live.request = () => Promise.reject(new Error('세션이 실행 중이 아닙니다'));
    await h.w.refresh();
    expect(h.w.current()).toBe(before);
    expect(h.emitted).toHaveLength(1);
    expect(h.probes).toHaveLength(0);
  });

  test('모르는 모양(toPlanUsage 가 null)이면 emit(null) — 받은 것으로 친다', async () => {
    const h = harness({ probe: () => fakeSession({ raw: { rate_limits_available: false } }) });
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    expect(h.emitted).toEqual([null]);
    expect(h.w.current()).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    h.w.turnEnded();
    expect(h.probes).toHaveLength(1);
  });

  test('사용량 전용 프로세스를 못 만들어도 던지지 않는다', async () => {
    const h = harness({ spawnThrows: true });
    await expect(h.w.refresh()).resolves.toBeUndefined();
    expect(h.emitted).toEqual([]);
  });

  test('stop(): 타이머가 없고 떠 있던 사용량 전용 프로세스를 끈다 — 그 뒤엔 묻지 않는다', async () => {
    const h = harness({ probe: () => fakeSession({ hang: true }) });
    h.w.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.probes).toHaveLength(1);
    await h.w.stop();
    expect(h.probes[0].log).toContain('stop');
    expect(vi.getTimerCount()).toBe(0);
    h.working = true;
    h.w.turnEnded();
    h.w.requested();
    await h.w.refresh();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.probes).toHaveLength(1);
    expect(h.emitted).toEqual([]);
  });

  test('stop() 뒤에 늦게 온 답은 알리지 않는다', async () => {
    const live = fakeSession();
    const h = harness({ live });
    const p = h.w.refresh();
    await h.w.stop();
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    await p;
    expect(h.emitted).toEqual([]);
    expect(h.w.current()).toBeNull();
  });

  test('stop(): 시간 초과 뒤 끄는 중인 사용량 전용 프로세스도 끄고, 끝날 때까지 기다린다', async () => {
    const h = harness({ probe: () => fakeSession({ hang: true, stopMs: 3000 }) });
    void h.w.refresh();
    await vi.advanceTimersByTimeAsync(15_000); // 시간 초과 → 끄기 시작(끝나기까지 3 초)
    const p = h.probes[0];
    expect(p.log).toEqual(['start', 'request', 'stop']);
    expect(p.ended).toBe(false);
    let done = false;
    const stopping = h.w.stop().then(() => {
      done = true;
    });
    expect(p.log).toEqual(['start', 'request', 'stop', 'stop']);
    await vi.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(done).toBe(true);
    expect(p.ended).toBe(true);
  });

  test('끄기가 끝나지 않는 사용량 전용 프로세스가 있어도 다음 받기는 막히지 않는다 — 살아 있는 세션에 묻는다', async () => {
    const h = harness({ probe: () => fakeSession({ stopMs: 'never' }) });
    let firstDone = false;
    void h.w.refresh().then(() => {
      firstDone = true;
    });
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    expect(h.emitted).toHaveLength(1);
    expect(h.probes[0].log).toEqual(['start', 'request', 'stop']);
    expect(firstDone).toBe(true);
    const live = fakeSession();
    h.live = live;
    const again = h.w.refresh();
    expect(live.requests).toEqual([{ req: USAGE_REQ, timeoutMs: 15_000 }]);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    await again;
    expect(h.emitted).toHaveLength(2);
    expect(h.probes).toHaveLength(1);
  });
});

describe('usage: 초기화 시각이 지나면 다시 묻는다', () => {
  test('답의 가장 이른 앞으로의 초기화 시각 + 5 초에 한 번 — 받은 답으로 다시 건다(하나만)', async () => {
    const h = harness({ probe: () => fakeSession({ raw: rawResets(10 * MIN, 3 * 86_400_000) }) });
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]); // 묻기는 ANSWER_MS 전에 시작
    expect(h.emitted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * MIN + RESET_GRACE_MS - ANSWER_MS - 1);
    expect(h.probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.probes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    expect(h.emitted).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  test('새 답이 오면 전에 건 것을 바꾼다 — 옛 시각엔 묻지 않는다', async () => {
    let n = 0;
    const h = harness({ probe: () => fakeSession({ raw: rawResets(++n === 1 ? 10 * MIN : 30 * MIN, null) }) });
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    await vi.advanceTimersByTimeAsync(MIN);
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    expect(h.probes).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(20 * MIN); // 첫 답의 10 분 + 5 초는 지났다
    expect(h.probes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(11 * MIN); // 둘째 답의 30 분 + 5 초가 지났다
    expect(h.probes).toHaveLength(3);
  });

  test('초기화 시각이 없거나 이미 지났으면 걸지 않는다 · 모르는 모양(null)이면 전에 건 것도 지운다', async () => {
    let n = 0;
    const raws = [rawResets(10 * MIN, null), rawResets(-MIN, null), { rate_limits_available: false }];
    const h = harness({ probe: () => fakeSession({ raw: raws[n++] }) });
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    expect(vi.getTimerCount()).toBe(1);
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    expect(vi.getTimerCount()).toBe(0);
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    expect(h.emitted.at(-1)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.probes).toHaveLength(3);
  });

  test('아주 먼 초기화 시각(60일)이어도 곧바로 묻지 않는다', async () => {
    const h = harness({ probe: () => fakeSession({ raw: rawResets(60 * 86_400_000, null) }) });
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.probes).toHaveLength(1);
  });

  test('묻는 중에 그 시각이 와도 요청은 하나 — 한 번에 하나만', async () => {
    let n = 0;
    const h = harness({ probe: () => fakeSession({ raw: rawResets(++n === 1 ? MIN : 10 * MIN, null) }) });
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    await vi.advanceTimersByTimeAsync(MIN + RESET_GRACE_MS - ANSWER_MS - 5); // 걸어 둔 시각 5 ms 전
    const p = h.w.refresh();
    expect(h.probes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(ANSWER_MS); // 그 사이 걸어 둔 시각이 온다
    await p;
    expect(h.probes).toHaveLength(2);
    expect(h.emitted).toHaveLength(2);
  });

  test('stop() 은 걸어 둔 다시 묻기를 지운다', async () => {
    const h = harness({ probe: () => fakeSession({ raw: rawResets(10 * MIN, null) }) });
    await Promise.all([h.w.refresh(), vi.advanceTimersByTimeAsync(ANSWER_MS)]);
    expect(vi.getTimerCount()).toBe(1);
    await h.w.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.probes).toHaveLength(1);
  });
});
