import type { ContextUsage, PlanUsage, UsageWindow } from './types';

// Claude 의 get_usage / get_context_usage 답을 두레 모양으로. 모르는 모양은 null — 던지지 않는다.

const MAX_WINDOWS = 4;

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function cell(key: UsageWindow['key'], label: string, src: Rec | null): UsageWindow | null {
  const pct = num(src?.utilization);
  if (pct === null) return null;
  const at = typeof src?.resets_at === 'string' ? Date.parse(src.resets_at) : NaN;
  return { key, label, percent: Math.max(0, Math.round(pct)), resetsAt: Number.isFinite(at) ? at : null };
}

function modelName(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function fromLimits(limits: unknown[]): UsageWindow[] {
  const session: UsageWindow[] = [];
  const week: UsageWindow[] = [];
  const models: UsageWindow[] = [];
  for (const item of limits) {
    const l = rec(item);
    if (!l) continue;
    if (l.kind === 'session') {
      const w = cell('session', '5시간', l);
      if (w) session.push(w);
    } else if (l.kind === 'weekly_all') {
      const w = cell('week', '1주', l);
      if (w) week.push(w);
    } else if (l.kind === 'weekly_scoped') {
      const name = modelName(rec(rec(rec(l.scope)?.model))?.display_name);
      const w = name ? cell(`model:${name}`, name, l) : null;
      if (w) models.push(w);
    }
  }
  return [...session, ...week, ...models];
}

function fromLegacy(rl: Rec): UsageWindow[] {
  const out: (UsageWindow | null)[] = [
    cell('session', '5시간', rec(rl.five_hour)),
    cell('week', '1주', rec(rl.seven_day)),
  ];
  if (Array.isArray(rl.model_scoped)) {
    for (const item of rl.model_scoped) {
      const m = rec(item);
      const name = modelName(m?.display_name);
      out.push(name ? cell(`model:${name}`, name, m) : null);
    }
  }
  return out.filter((w): w is UsageWindow => w !== null);
}

export function toPlanUsage(raw: unknown, at: number): PlanUsage | null {
  try {
    const r = rec(raw);
    if (!r || r.rate_limits_available !== true) return null;
    const rl = rec(r.rate_limits);
    if (!rl) return null;
    const windows = (Array.isArray(rl.limits) ? fromLimits(rl.limits) : fromLegacy(rl)).slice(0, MAX_WINDOWS);
    return windows.length > 0 ? { windows, at } : null;
  } catch {
    return null;
  }
}

export function toContextUsage(raw: unknown, at: number): ContextUsage | null {
  try {
    const r = rec(raw);
    if (!r) return null;
    const total = num(r.totalTokens);
    const max = num(r.maxTokens);
    if (total === null || max === null || max <= 0) return null;
    const pct = num(r.percentage);
    const threshold = num(r.autoCompactThreshold);
    return {
      total,
      max,
      percent: Math.round(pct ?? (total / max) * 100),
      autoCompactAt: r.isAutoCompactEnabled === true && threshold !== null && threshold > 0 ? threshold : null,
      at,
    };
  } catch {
    return null;
  }
}
