// Probe: which concrete model each alias resolves to (initialize only — no tokens).
// Usage: node probe8.mjs [path-to-claude]   (default: `claude` on PATH)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const work = join(here, 'work8'); mkdirSync(work, { recursive: true });
const cmd = process.argv[2] ?? 'claude';
const p = spawn(cmd, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--strict-mcp-config', '--disallowedTools', 'SendMessage', 'ListAgents'], { cwd: work });
let buf = '';
const done = new Promise((resolve) => {
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type === 'control_response' && j.response?.request_id === 'p8') resolve(j.response.response);
    }
  });
});
p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'p8', request: { subtype: 'initialize' } }) + '\n');
const init = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 30000))]);
for (const m of init?.models ?? []) {
  // account is never printed
  console.log(JSON.stringify({ value: m.value, displayName: m.displayName, resolvedModel: m.resolvedModel, description: m.description }));
}
p.stdin.end(); await new Promise((r) => p.on('close', r));
