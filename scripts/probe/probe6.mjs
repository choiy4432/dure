// Probe: effort and plan usage over the stream-json control channel (no model turn — no tokens).
//   1. initialize → each model's supportsEffort / supportedEffortLevels (account is NOT printed)
//   2. get_settings → effective effortLevel before
//   3. apply_flag_settings { effortLevel: 'low' } → does the live session take it?
//   4. get_settings → effective effortLevel after
//   5. get_usage { skip_behaviors: true } → rate_limits shape (five_hour / seven_day / model_scoped …)
//   6. get_context_usage { detail: 'summary' } → context ring numbers (total / max / percentage / auto-compact)
// Usage: node probe6.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const work = join(here, 'work6'); mkdirSync(work, { recursive: true });

const p = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--disallowedTools', 'SendMessage', 'ListAgents'], { cwd: work });
const waiting = new Map(); let n = 0; let buf = '';
p.stdout.setEncoding('utf8');
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { continue; }
  if (j.type === 'control_response') { const w = waiting.get(j.response.request_id); if (w) { waiting.delete(j.response.request_id); w(j.response); } }
  else if (j.type === 'rate_limit_event') console.log('rate_limit_event', JSON.stringify(j.rate_limit_info)); } });
p.stderr.setEncoding('utf8'); p.stderr.on('data', d => process.stderr.write(d));
const ask = (request) => new Promise(r => { const id = `p6-${++n}`; waiting.set(id, r); p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n'); setTimeout(() => r({ subtype: 'timeout' }), 30000); });

const init = await ask({ subtype: 'initialize' });
console.log('models:', JSON.stringify((init.response?.models ?? []).map(m => ({ value: m.value, displayName: m.displayName, supportsEffort: m.supportsEffort, levels: m.supportedEffortLevels }))));
const effort = (s) => s.response?.effective?.effortLevel ?? s.response?.settings?.effortLevel ?? '(none)';
const before = await ask({ subtype: 'get_settings' });
console.log('get_settings before:', before.subtype, 'effortLevel =', effort(before), 'keys:', Object.keys(before.response ?? {}).join(','));
const apply = await ask({ subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } });
console.log('apply_flag_settings:', apply.subtype, apply.error ?? '');
const after = await ask({ subtype: 'get_settings' });
console.log('get_settings after:', after.subtype, 'effortLevel =', effort(after));
const usage = await ask({ subtype: 'get_usage', skip_behaviors: true });
console.log('get_usage:', usage.subtype, usage.error ?? '');
console.log('  rate_limits_available =', usage.response?.rate_limits_available);
console.log('  rate_limits =', JSON.stringify(usage.response?.rate_limits, null, 1));
const ctx = await ask({ subtype: 'get_context_usage', detail: 'summary' });
console.log('get_context_usage(summary):', ctx.subtype, ctx.error ?? '');
const c = ctx.response ?? {};
console.log('  totalTokens =', c.totalTokens, 'maxTokens =', c.maxTokens, 'percentage =', c.percentage, 'autoCompactThreshold =', c.autoCompactThreshold, 'isAutoCompactEnabled =', c.isAutoCompactEnabled, 'model =', c.model);
console.log('  categories =', JSON.stringify((c.categories ?? []).map(k => ({ name: k.name, tokens: k.tokens, color: k.color, kind: k.kind }))));
p.stdin.end(); await new Promise(r => p.on('close', r));
