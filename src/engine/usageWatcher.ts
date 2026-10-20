import type { ClaudeSession } from './claudeSession';
import type { PlanUsage } from './types';
import { toPlanUsage } from './usage';

// 플랜 사용량을 언제·누구에게 묻나(spec §4.1). 사용량 API 를 직접 부르지 않는다 — 언제나 사용자의 claude 에 get_usage.

export interface UsageTiming {
  /** 엔진이 뜬 뒤 첫 받기 */
  startDelayMs: number;
  /** 일하는 에이전트가 있는 동안 이 간격마다 */
  pollMs: number;
  /** 차례 끝·펼침 열기는 마지막 값이 이보다 오래됐을 때만 */
  minAgeMs: number;
  /** 답을 기다리는 한도 — 넘으면 그만두고 다시 시도하지 않는다 */
  timeoutMs: number;
}

export const USAGE_TIMING: UsageTiming = { startDelayMs: 2000, pollMs: 300_000, minAgeMs: 60_000, timeoutMs: 15_000 };

export interface UsageWatcherDeps {
  /** 떠 있는(idle·working) 에이전트 세션 아무거나 — 없으면 null */
  liveSession(): ClaudeSession | null;
  /** 사용량 전용 claude(아직 start 안 한 세션) */
  spawnProbe(): ClaudeSession;
  anyWorking(): boolean;
  now(): number;
  /** 답을 받을 때마다 — 모르는 모양·한도 없음이면 null */
  emit(u: PlanUsage | null): void;
  timing: UsageTiming;
}

export class UsageWatcher {
  private value: PlanUsage | null = null;
  private receivedAt: number | null = null; // 마지막으로 답을 받은 시각(값이 null 이어도)
  private inflight: Promise<void> | null = null;
  /** 떠 있는 사용량 전용 claude — 끄기가 끝날 때까지 붙잡는다(끄는 중에 앱이 꺼져도 함께 끄게) */
  private probes = new Set<ClaudeSession>();
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private d: UsageWatcherDeps) {}

  start(): void {
    if (this.stopped || this.startTimer || this.pollTimer) return;
    const t = this.d.timing;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.refresh();
    }, t.startDelayMs);
    this.pollTimer = setInterval(() => {
      if (this.d.anyWorking()) void this.refresh();
    }, t.pollMs);
  }

  current(): PlanUsage | null {
    return this.value;
  }

  /** 어느 에이전트든 한 차례가 끝났다 */
  turnEnded(): void {
    this.refreshIfOld();
  }

  /** 화면이 사용량 펼침을 열었다 */
  requested(): void {
    this.refreshIfOld();
  }

  /** 한 번에 하나만 — 묻는 중이면 그 약속을 돌려준다. 실패해도 던지지 않는다 */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.inflight ??= this.ask().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.startTimer = null;
    this.pollTimer = null;
    // 끄는 중인 것도 다시 stop() — 같은 끝을 기다린다(ClaudeSession.stop 은 두 번 불러도 된다)
    await Promise.all([...this.probes].map((p) => p.stop().catch(() => undefined)));
  }

  private refreshIfOld(): void {
    if (this.receivedAt === null || this.d.now() - this.receivedAt > this.d.timing.minAgeMs) void this.refresh();
  }

  private async ask(): Promise<void> {
    let probe: ClaudeSession | null = null;
    try {
      let s = this.d.liveSession();
      if (!s) {
        probe = this.d.spawnProbe();
        this.probes.add(probe);
        probe.start();
        s = probe;
      }
      const raw = await s.request({ subtype: 'get_usage', skip_behaviors: true }, this.d.timing.timeoutMs);
      if (this.stopped) return;
      const at = this.d.now();
      this.value = toPlanUsage(raw, at);
      this.receivedAt = at;
      this.d.emit(this.value);
    } catch {
      /* 실패·시간 초과·세션 종료 — 전 값 그대로, 다음 계기(차례 끝·주기·펼침)에 다시 묻는다 */
    } finally {
      if (probe) this.endProbe(probe); // 답을 받았든 못 받았든 바로 끈다
    }
  }

  /** 끄기를 기다리지 않는다 — 끄기가 멈춰도 다음 받기(inflight)를 막지 않게. 끝나면 놓는다 */
  private endProbe(p: ClaudeSession): void {
    void p
      .stop()
      .catch(() => undefined)
      .then(() => {
        this.probes.delete(p);
      });
  }
}
