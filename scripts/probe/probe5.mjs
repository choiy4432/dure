// Probe: does the CLI's per-call MCP idle limit (300 s) go away with
//   variant "server-timeout" — a per-server "timeout" (ms) in the --mcp-config entry, or
//   variant "env-idle"       — env CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0 ?
// The approve handler answers allow only after WAIT_MS (default 330 s), with a plain JSON reply.
// Usage: node probe5.mjs server-timeout|env-idle
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const variant = process.argv[2];
if (!['server-timeout', 'env-idle'].includes(variant)) { console.error('usage: probe5.mjs server-timeout|env-idle'); process.exit(2); }
const WAIT_MS = Number(process.env.WAIT_MS || 330000);
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const work = join(here, `work5-${variant}`); mkdirSync(work, { recursive: true });
const TOKEN = 'probe5';
const t0 = Date.now();
const at = () => `${Math.round((Date.now() - t0) / 1000)}s`;

const srv = createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', async () => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const m = JSON.parse(body);
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    let result = {};
    if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dure', version: '0.0.1' } };
    else if (m.method === 'tools/list') result = { tools: [{ name: 'approve', description: 'Permission prompt', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: ['tool_name', 'input'] } }] };
    else if (m.method === 'tools/call') {
      const a = m.params.arguments;
      console.log(`${at()} approve called for ${a.tool_name} — answering allow in ${WAIT_MS / 1000}s`);
      let closed = false; res.on('close', () => { if (!res.writableEnded) { closed = true; console.log(`${at()} client closed the approve connection`); } });
      await new Promise(r => setTimeout(r, WAIT_MS));
      if (closed) return;
      result = { content: [{ type: 'text', text: JSON.stringify({ behavior: 'allow', updatedInput: a.input }) }] };
      console.log(`${at()} approve answered`);
    }
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); }
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const entry = { type: 'http', url: `http://127.0.0.1:${srv.address().port}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } };
if (variant === 'server-timeout') entry.timeout = 86400000;
const mcpCfg = join(here, `mcp5-${variant}.json`);
writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { dure: entry } }));
const env = { ...process.env, MCP_TOOL_TIMEOUT: '86400000' };
if (variant === 'env-idle') env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = '0';

const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
  '--strict-mcp-config', '--mcp-config', mcpCfg, '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__dure__approve',
  '--disallowedTools', 'SendMessage', 'ListAgents'];
const p = spawn('claude', args, { cwd: work, env });
let buf = ''; let done; const toolResults = [];
p.stdout.setEncoding('utf8');
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { continue; }
  if (j.type === 'user') for (const c of j.message.content || []) if (c.type === 'tool_result') toolResults.push((typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 300));
  if (j.type === 'result') done?.(j); } });
p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: "Create a file named note.txt containing exactly: 두레. Use the Write tool once. Do not retry if it fails; just report the error." }] } }) + '\n');
const result = await new Promise(r => { done = r; setTimeout(() => r(null), WAIT_MS + 120000); });
p.stdin.end(); await new Promise(r => p.on('close', r)); srv.close();
const file = join(work, 'note.txt');
const content = existsSync(file) ? readFileSync(file, 'utf8') : null;
const aborted = toolResults.some(t => /no response or progress/i.test(t));
console.log(`${at()} RESULT variant=${variant} file=${JSON.stringify(content)} aborted=${aborted} turnOk=${result ? !result.is_error : 'timeout'}`);
for (const t of toolResults) console.log('  tool_result:', t.replace(/\s+/g, ' '));
console.log(content === '두레' && !aborted ? `PASS ${variant}` : `FAIL ${variant}`);
