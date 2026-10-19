// Minimal stdio MCP server (no deps): tools `approve` (permission prompt) and `send_message`.
// Logs every call with the AGENT_ID env to calls.jsonl next to this file.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const logf = join(here, 'calls.jsonl');
const agent = process.env.AGENT_ID || '?';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
function handle(m) {
  appendFileSync(logf, JSON.stringify({ agent, in: m }) + '\n');
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dure', version: '0.0.1' } } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'approve', description: 'Permission prompt', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } },
    { name: 'send_message', description: 'Send a message to another agent in this room', inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] } },
  ] } });
  if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params;
    let text;
    if (name === 'approve') {
      if (a.tool_name === 'AskUserQuestion') {
        const answers = {};
        for (const q of a.input.questions || []) answers[q.question] = q.options?.[1]?.label ?? 'yes';
        text = JSON.stringify({ behavior: 'allow', updatedInput: { ...a.input, answers } });
      } else if (a.tool_name === 'Bash' || a.tool_name === 'PowerShell') {
        text = JSON.stringify({ behavior: 'deny', message: 'The user declined running commands.' });
      } else {
        text = JSON.stringify({ behavior: 'allow', updatedInput: a.input });
      }
    } else if (name === 'send_message') {
      text = `delivered to ${a.to}`;
    }
    appendFileSync(logf, JSON.stringify({ agent, reply: text }) + '\n');
    return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } });
  }
  if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, result: {} });
}
