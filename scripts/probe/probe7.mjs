// Probe: timing and edge cases for usage / effort / context (uses a few Haiku tokens).
//   a. cold spawn → first control response time (the throwaway usage process path)
//   b. apply_flag_settings with a level the model doesn't support (Haiku has no effort)
//   c. get_usage / get_context_usage sent mid-turn — do they answer during the turn or after result?
//   d. "/compact" as user input — local-output then result? context after
//   e. --resume <id> --effort low → does get_settings show it?
// Usage: node probe7.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const work = join(here, 'work7'); mkdirSync(work, { recursive: true });
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

function launch(extra) {
  const p = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--disallowedTools', 'SendMessage', 'ListAgents', ...extra], { cwd: work });
  const waiting = new Map(); let n = 0; let buf = ''; const seen = [];
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'control_response') { const w = waiting.get(j.response.request_id); if (w) { waiting.delete(j.response.request_id); w(j.response); } continue; }
    const tag = j.type === 'system' ? `system/${j.subtype}` : j.type;
    if (tag === 'user') { const c = j.message?.content; const s = typeof c === 'string' ? c : JSON.stringify(c); if (s.includes('local-command-stdout')) seen.push(`${at()} local-output ${s.slice(0, 80)}`); }
    else if (tag === 'result') seen.push(`${at()} result ${j.subtype}`);
    else if (tag === 'system/init') seen.push(`${at()} init`);
    else if (tag === 'system/compact_boundary') seen.push(`${at()} compact_boundary`);
    p.emit('line', j);
  } });
  p.stderr.setEncoding('utf8'); p.stderr.on('data', d => seen.push(`${at()} stderr ${d.trim().slice(0, 120)}`));
  const ask = (request, ms = 60000) => new Promise(r => { const id = `p7-${++n}`; const sent = Date.now(); waiting.set(id, x => r({ ...x, ms: Date.now() - sent })); p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n'); setTimeout(() => r({ subtype: 'timeout', ms }), ms); });
  const say = (text) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
  const result = () => new Promise(r => { const f = j => { if (j.type === 'result') { p.off('line', f); r(j); } }; p.on('line', f); });
  const close = async () => { p.stdin.end(); await new Promise(r => p.on('close', r)); };
  return { p, ask, say, result, close, seen };
}
const eff = s => s.response?.effective?.effortLevel ?? '(none)';

// a + b
console.log('a/b — cold spawn, Haiku');
{
  const s = launch(['--model', 'haiku']);
  const first = await s.ask({ subtype: 'get_settings' });
  console.log(`  first control response after ${first.ms} ms (spawn→answer)`, first.subtype, 'effort =', eff(first));
  const bad = await s.ask({ subtype: 'apply_flag_settings', settings: { effortLevel: 'max' } });
  console.log('  apply effortLevel=max on Haiku:', bad.subtype, bad.error ?? '');
  const after = await s.ask({ subtype: 'get_settings' });
  console.log('  get_settings after:', eff(after));
  await s.close();
}

// c + d
const sid = randomUUID();
console.log('c/d — mid-turn requests and /compact (Haiku, session', sid.slice(0, 8) + '…)');
{
  const s = launch(['--model', 'haiku', '--session-id', sid]);
  const done = s.result();
  s.say('Write the numbers from one to two hundred as English words, comma-separated, nothing else.');
  await new Promise(r => setTimeout(r, 1500));
  const sentAt = at();
  const [u, c] = await Promise.all([s.ask({ subtype: 'get_usage', skip_behaviors: true }), s.ask({ subtype: 'get_context_usage', detail: 'summary' })]);
  const r1 = await done;
  console.log(`  sent mid-turn at ${sentAt}: get_usage ${u.subtype} in ${u.ms} ms · get_context_usage ${c.subtype} in ${c.ms} ms · turn result at ${at()}`);
  console.log('  context mid-turn:', c.response?.totalTokens, '/', c.response?.maxTokens, `(${c.response?.percentage}%)`);
  const c2 = await s.ask({ subtype: 'get_context_usage', detail: 'summary' });
  console.log('  context after turn:', c2.response?.totalTokens, '/', c2.response?.maxTokens, `(${c2.response?.percentage}%)`, 'result usage:', JSON.stringify(r1.usage ?? {}).slice(0, 160));
  const done2 = s.result();
  s.say('/compact');
  const r2 = await Promise.race([done2, new Promise(r => setTimeout(() => r(null), 120000))]);
  console.log('  /compact →', r2 ? `result ${r2.subtype}` : 'no result in 120 s');
  const c3 = await s.ask({ subtype: 'get_context_usage', detail: 'summary' });
  console.log('  context after /compact:', c3.response?.totalTokens, '/', c3.response?.maxTokens, `(${c3.response?.percentage}%)`);
  await s.close();
  for (const l of s.seen) console.log('   ·', l);
}

// e
console.log('e — --resume with --effort low');
{
  const s = launch(['--resume', sid, '--effort', 'low']);
  const g = await s.ask({ subtype: 'get_settings' });
  console.log('  get_settings on resumed session with --effort low:', g.subtype, 'effort =', eff(g), '· sources with effortLevel:', JSON.stringify(Object.fromEntries(Object.entries(g.response?.sources ?? {}).map(([k, v]) => [k, v?.effortLevel]).filter(([, v]) => v !== undefined))));
  await s.close();
}
