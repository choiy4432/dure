// Probe: HTTP MCP transport with per-agent headers (one server, many agents), built-in SendMessage disabled,
// app's own tools pre-allowed.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const work = join(here, 'work3'); mkdirSync(work, { recursive: true });
const calls = [];
const TOKEN = 'secret-123';
const srv = createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, agent: req.headers['x-dure-agent'], body: body.slice(0, 300) });
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end(); }
    const m = JSON.parse(body);
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    let result = {};
    if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dure', version: '0.0.1' } };
    else if (m.method === 'tools/list') result = { tools: [
      { name: 'list_agents', description: 'List the other agents in this Dure room', inputSchema: { type: 'object', properties: {} } },
      { name: 'send_message', description: 'Send a message to another agent in this Dure room', inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] } },
      { name: 'approve', description: 'Permission prompt', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: ['tool_name', 'input'] } }] };
    else if (m.method === 'tools/call') {
      const { name, arguments: a } = m.params; let text;
      if (name === 'list_agents') text = JSON.stringify([{ name: 'B', role: '웹 화면 담당', status: 'idle' }]);
      else if (name === 'send_message') text = `queued for ${a.to} (from ${req.headers['x-dure-agent']})`;
      else if (name === 'approve') text = JSON.stringify({ behavior: 'deny', message: `not expected: ${a.tool_name}` });
      result = { content: [{ type: 'text', text }] };
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const mcpCfg = join(here, 'mcp3.json');
writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { dure: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${TOKEN}`, 'X-Dure-Agent': 'agent-A' } } } }));

const log = [];
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
  '--strict-mcp-config', '--mcp-config', mcpCfg, '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__dure__approve',
  '--allowedTools', 'mcp__dure__list_agents', 'mcp__dure__send_message',
  '--disallowedTools', 'SendMessage', 'ListAgents',
  '--append-system-prompt', 'You are agent "A" (기획 담당) in a Dure room. To hand work to another agent in the room, use the mcp__dure__send_message tool; use mcp__dure__list_agents to see who is in the room.'];
const p = spawn('claude', args, { cwd: work });
let buf = ''; let done;
p.stdout.setEncoding('utf8');
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const j = JSON.parse(l); log.push(j); if (j.type === 'result') done?.(); } });
p.stderr.setEncoding('utf8'); p.stderr.on('data', d => log.push({ stderr: d }));
p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Ask agent B to make the signup button blue. Then reply with the tool result text.' }] } }) + '\n');
await new Promise(r => { done = r; setTimeout(r, 120000); });
p.stdin.end(); await new Promise(r => p.on('close', r)); srv.close();
for (const j of log) {
  if (j.type === 'system' && j.subtype === 'init') console.log('INIT mcp=', JSON.stringify(j.mcp_servers), 'hasSendMessage=', j.tools.includes('SendMessage'), 'dureTools=', j.tools.filter(t => t.startsWith('mcp__dure')).join(','));
  else if (j.type === 'assistant') console.log('ASSIST', JSON.stringify(j.message.content.map(c => c.type === 'text' ? c.text.slice(0, 120) : c.type === 'tool_use' ? `tool_use:${c.name} ${JSON.stringify(c.input).slice(0, 120)}` : c.type)));
  else if (j.type === 'user') console.log('USER', JSON.stringify(j.message.content).slice(0, 200));
  else if (j.type === 'result') console.log('RESULT', j.subtype, 'denials=', JSON.stringify(j.permission_denials));
  else if (j.stderr) console.log('STDERR', j.stderr.slice(0, 200));
}
console.log('HTTP calls:'); for (const c of calls) console.log(JSON.stringify(c).slice(0, 220));
