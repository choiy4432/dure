import { describe, expect, test } from 'vitest';
import { toContextUsage, toPlanUsage } from '../src/engine/usage';

const AT = 1_700_000_000_000;
const R1 = '2026-10-20T04:49:59.821316+00:00';
const R2 = '2026-10-25T00:00:00+00:00';

const real = {
  rate_limits_available: true,
  rate_limits: {
    limits: [
      { kind: 'session', utilization: 2, resets_at: R1 },
      { kind: 'weekly_all', utilization: 5, resets_at: R2 },
      { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, utilization: 0, resets_at: R2 },
    ],
    five_hour: { utilization: 2, resets_at: R1 },
    seven_day: { utilization: 5, resets_at: R2 },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: null,
    spend: null,
  },
};

describe('toPlanUsage', () => {
  test('real shape: limits win, null extras ignored', () => {
    expect(toPlanUsage(real, AT)).toEqual({
      windows: [
        { key: 'session', label: '5시간', percent: 2, resetsAt: Date.parse(R1) },
        { key: 'week', label: '1주', percent: 5, resetsAt: Date.parse(R2) },
        { key: 'model:Fable', label: 'Fable', percent: 0, resetsAt: Date.parse(R2) },
      ],
      at: AT,
    });
  });

  test('legacy fields without limits', () => {
    const raw = {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 62.4, resets_at: R1 },
        seven_day: { utilization: 10, resets_at: R2 },
        model_scoped: [{ display_name: 'Fable', utilization: 81, resets_at: null }],
      },
    };
    const u = toPlanUsage(raw, AT)!;
    expect(u.windows).toEqual([
      { key: 'session', label: '5시간', percent: 62, resetsAt: Date.parse(R1) },
      { key: 'week', label: '1주', percent: 10, resetsAt: Date.parse(R2) },
      { key: 'model:Fable', label: 'Fable', percent: 81, resetsAt: null },
    ]);
  });

  test('unavailable / malformed → null, never throws', () => {
    expect(toPlanUsage({ ...real, rate_limits_available: false }, AT)).toBeNull();
    expect(toPlanUsage({ rate_limits_available: true, rate_limits: null }, AT)).toBeNull();
    expect(toPlanUsage({ rate_limits_available: true, rate_limits: { limits: {} } }, AT)).toBeNull();
    expect(toPlanUsage(null, AT)).toBeNull();
    expect(toPlanUsage(undefined, AT)).toBeNull();
    expect(toPlanUsage('x', AT)).toBeNull();
  });

  test('skips bad cells', () => {
    const raw = {
      rate_limits_available: true,
      rate_limits: {
        limits: [
          { kind: 'session', utilization: '12', resets_at: R1 },
          { kind: 'mystery', utilization: 3 },
          { kind: 'weekly_scoped', scope: { model: { display_name: '' } }, utilization: 3 },
          { kind: 'weekly_all', utilization: -4, resets_at: 'garbage' },
        ],
      },
    };
    expect(toPlanUsage(raw, AT)!.windows).toEqual([{ key: 'week', label: '1주', percent: 0, resetsAt: null }]);
  });

  test('at most 4 windows', () => {
    const scoped = ['A', 'B', 'C', 'D', 'E'].map((n) => ({
      kind: 'weekly_scoped', scope: { model: { display_name: n } }, utilization: 1, resets_at: R1,
    }));
    const raw = {
      rate_limits_available: true,
      rate_limits: { limits: [{ kind: 'session', utilization: 1 }, { kind: 'weekly_all', utilization: 1 }, ...scoped] },
    };
    const w = toPlanUsage(raw, AT)!.windows;
    expect(w).toHaveLength(4);
    expect(w.map((x) => x.key)).toEqual(['session', 'week', 'model:A', 'model:B']);
  });
});

describe('toContextUsage', () => {
  const probe = { totalTokens: 48990, maxTokens: 200000, percentage: 24, autoCompactThreshold: 167000, isAutoCompactEnabled: true };

  test('probe shape', () => {
    expect(toContextUsage(probe, AT)).toEqual({ total: 48990, max: 200000, percent: 24, autoCompactAt: 167000, at: AT });
  });
  test('auto-compact off → null', () => {
    expect(toContextUsage({ ...probe, isAutoCompactEnabled: false }, AT)!.autoCompactAt).toBeNull();
  });
  test('percentage missing → computed; fractional rounded', () => {
    const { percentage: _p, ...rest } = probe;
    expect(toContextUsage(rest, AT)!.percent).toBe(24);
    expect(toContextUsage({ ...probe, percentage: 24.6 }, AT)!.percent).toBe(25);
  });
  test('bad numbers → null', () => {
    expect(toContextUsage({ ...probe, maxTokens: 0 }, AT)).toBeNull();
    expect(toContextUsage({ ...probe, totalTokens: '48990' }, AT)).toBeNull();
    expect(toContextUsage(null, AT)).toBeNull();
    expect(toContextUsage('x', AT)).toBeNull();
  });
});
