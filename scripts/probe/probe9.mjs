// Probe: can a headless session switch to 'max' effort? ('max' is not in the settings enum
// low|medium|high|xhigh, so apply_flag_settings ignores it.) Sends the local command "/effort max"
// and "/effort" and prints what comes back, plus get_settings before/after. Local commands don't call the model.
// Usage: node probe9.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const work = join(here, 'work9'); mkdirSync(work, { recursive: true });
const p = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--strict-mcp-config', '--disallowedTools', 'SendMessage', 'ListAgents'], { cwd: work });
const waiting = new Map(); let n = 0; let buf = ''; let onResult = null;
p.stdout.setEncoding('utf8');
p.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'control_response') { const w = waiting.get(j.response.request_id); if (w) { waiting.delete(j.response.request_id); w(j.response); } continue; }
    if (j.type === 'user') { const c = j.message?.content; console.log('  user-line:', (typeof c === 'string' ? c : JSON.stringify(c)).slice(0, 200)); }
    else if (j.type === 'assistant') console.log('  assistant:', JSON.stringify(j.message?.content).slice(0, 200));
    else if (j.type === 'result') { console.log('  result:', j.subtype, 'cost', j.total_cost_usd, 'usage', JSON.stringify(j.usage ?? {}).slice(0, 120)); onResult?.(); }
    else if (j.type === 'system') console.log('  system/' + j.subtype, j.subtype === 'init' ? `model=${j.model}` : '');
  }
});
const ask = (request) => new Promise(r => { const id = `p9-${++n}`; waiting.set(id, r); p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n'); setTimeout(() => r({ subtype: 'timeout' }), 20000); });
const say = (text) => new Promise(r => { onResult = r; p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'); setTimeout(r, 30000); });
const eff = async (tag) => { const g = await ask({ subtype: 'get_settings' }); console.log(tag, 'get_settings effective.effortLevel =', g.response?.effective?.effortLevel); };

await eff('before:');
console.log('> /effort max'); await say('/effort max');
await eff('after /effort max:');
console.log('> /effort'); await say('/effort');
console.log('> /effort xhigh'); await say('/effort xhigh');
await eff('after /effort xhigh:');
p.stdin.end(); await new Promise(r => p.on('close', r));
