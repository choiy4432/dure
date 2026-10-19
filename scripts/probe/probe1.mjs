// Probe: stream-json init event, multi-turn in one process, set_model control, interrupt control.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const work = join(here, 'work1');
mkdirSync(work, { recursive: true });
const log = [];
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--model', 'haiku', '--permission-mode', 'default', '--strict-mcp-config'];
const p = spawn('claude', args, { cwd: work, shell: false });
let buf = '';
const waiters = [];
p.stdout.setEncoding('utf8');
p.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { log.push({ raw: line }); continue; }
    log.push(j);
    for (const w of [...waiters]) if (w.test(j)) { waiters.splice(waiters.indexOf(w), 1); w.res(j); }
  }
});
p.stderr.setEncoding('utf8');
p.stderr.on('data', d => log.push({ stderr: d }));
const waitFor = (test, ms = 90000) => new Promise((res, rej) => {
  const w = { test, res }; waiters.push(w);
  setTimeout(() => rej(new Error('timeout')), ms);
});
const send = obj => p.stdin.write(JSON.stringify(obj) + '\n');
const user = text => send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

try {
  user('Reply with exactly the word: one');
  await waitFor(j => j.type === 'result');
  send({ type: 'control_request', request_id: 'r1', request: { subtype: 'set_model', model: 'sonnet' } });
  await waitFor(j => j.type === 'control_response', 15000).catch(e => log.push({ note: 'no control_response for set_model' }));
  user('Reply with exactly the word: two. Then say which model you are in 3 words.');
  await waitFor(j => j.type === 'result');
  user('Write the numbers 1 to 300, one per line, nothing else.');
  await new Promise(r => setTimeout(r, 2500));
  send({ type: 'control_request', request_id: 'r2', request: { subtype: 'interrupt' } });
  await waitFor(j => j.type === 'result', 30000).catch(() => log.push({ note: 'no result after interrupt' }));
  user('Reply with exactly the word: three');
  await waitFor(j => j.type === 'result');
} catch (e) { log.push({ error: String(e) }); }
p.stdin.end();
await new Promise(r => p.on('close', code => { log.push({ exit: code }); r(); }));
writeFileSync(join(here, 'probe1.jsonl'), log.map(x => JSON.stringify(x)).join('\n'));
// summary
for (const j of log) {
  if (j.type === 'system') console.log('SYSTEM', j.subtype, JSON.stringify(Object.keys(j)), j.subtype === 'init' ? JSON.stringify({ model: j.model, permissionMode: j.permissionMode, slash: (j.slash_commands || []).slice(0, 40), tools: (j.tools || []).length, session: j.session_id }) : '');
  else if (j.type === 'assistant') console.log('ASSIST', JSON.stringify(j.message?.content?.map(c => c.type === 'text' ? c.text.slice(0, 60) : c.type)), j.message?.model);
  else if (j.type === 'result') console.log('RESULT', j.subtype, j.is_error, JSON.stringify(String(j.result).slice(0, 60)), 'keys=', Object.keys(j).join(','));
  else if (j.type === 'control_response') console.log('CTRL', JSON.stringify(j));
  else if (j.type === 'user') console.log('USER-ECHO', JSON.stringify(j).slice(0, 120));
  else console.log('OTHER', JSON.stringify(j).slice(0, 200));
}
