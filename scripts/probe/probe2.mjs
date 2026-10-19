// Probe: permission prompt tool via MCP, AskUserQuestion through it, send_message tool, image input, Korean UTF-8.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const work = join(here, 'work2');
mkdirSync(work, { recursive: true });
rmSync(join(here, 'calls.jsonl'), { force: true });
const mcpCfg = join(here, 'mcp2.json');
writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { dure: { type: 'stdio', command: 'node', args: [join(here, 'miniMcp.mjs')], env: { AGENT_ID: 'agent-A' } } } }));

// 8x8 solid red PNG
function png(r, g, b) {
  const crc = (buf) => { let c, crcTable = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } let x = 0xffffffff; for (const v of buf) x = crcTable[(x ^ v) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const w = 8, h = 8; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const log = [];
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--model', 'haiku', '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', mcpCfg,
  '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__dure__approve',
  '--append-system-prompt', 'You are agent "A" (기획 담당) in a Dure room. Peer agent: "B" (웹 화면 담당). To hand work to B, call the send_message tool.'];
const p = spawn('claude', args, { cwd: work });
let buf = ''; const waiters = [];
p.stdout.setEncoding('utf8');
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let j; try { j = JSON.parse(line); } catch { log.push({ raw: line }); continue; } log.push(j); for (const w of [...waiters]) if (w.test(j)) { waiters.splice(waiters.indexOf(w), 1); w.res(j); } } });
p.stderr.setEncoding('utf8'); p.stderr.on('data', d => log.push({ stderr: d }));
const waitFor = (test, ms = 120000) => new Promise((res, rej) => { waiters.push({ test, res }); setTimeout(() => rej(new Error('timeout')), ms); });
const send = o => p.stdin.write(JSON.stringify(o) + '\n');
const user = content => send({ type: 'user', message: { role: 'user', content } });
const step = async (label, content) => { log.push({ step: label }); user(content); await waitFor(j => j.type === 'result').catch(e => log.push({ error: label + ' ' + e })); };

await step('write', [{ type: 'text', text: 'Create a file named hello.txt containing exactly: 안녕 두레. Use the Write tool. Then reply "done".' }]);
await step('bash', [{ type: 'text', text: 'Run the shell command `echo hi` with the Bash or PowerShell tool and tell me its output.' }]);
await step('ask', [{ type: 'text', text: 'Use the AskUserQuestion tool to ask me ONE question: "어떤 색이 좋아요?" with options 빨강, 파랑. Then tell me exactly which answer you received.' }]);
await step('send', [{ type: 'text', text: 'Tell agent B (use send_message) to make the button blue. Then reply with the tool result text.' }]);
await step('image', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(220, 20, 20).toString('base64') } }, { type: 'text', text: '이 이미지의 색을 한 단어 한국어로.' }]);
p.stdin.end();
await new Promise(r => p.on('close', c => { log.push({ exit: c }); r(); }));
writeFileSync(join(here, 'probe2.jsonl'), log.map(x => JSON.stringify(x)).join('\n'));
console.log('hello.txt:', existsSync(join(work, 'hello.txt')) ? JSON.stringify(readFileSync(join(work, 'hello.txt'), 'utf8')) : 'MISSING');
for (const j of log) {
  if (j.step) console.log('\n## STEP', j.step);
  else if (j.type === 'system' && j.subtype === 'init') console.log('INIT mcp_servers=', JSON.stringify(j.mcp_servers), 'permissionMode=', j.permissionMode);
  else if (j.type === 'assistant') console.log('ASSIST', JSON.stringify(j.message.content.map(c => c.type === 'text' ? c.text.slice(0, 120) : c.type === 'tool_use' ? `tool_use:${c.name}` : c.type)));
  else if (j.type === 'user') console.log('USER', JSON.stringify(j.message.content).slice(0, 220));
  else if (j.type === 'result') console.log('RESULT', j.subtype, 'denials=', JSON.stringify(j.permission_denials).slice(0, 200), '|', String(j.result).slice(0, 100));
  else if (j.type === 'control_request') console.log('CTRL_REQ', JSON.stringify(j).slice(0, 300));
  else if (j.stderr || j.error || j.raw) console.log('MISC', JSON.stringify(j).slice(0, 200));
}
console.log('\n## MCP calls'); if (existsSync(join(here, 'calls.jsonl'))) for (const l of readFileSync(join(here, 'calls.jsonl'), 'utf8').trim().split('\n')) { const o = JSON.parse(l); if (o.in?.method === 'tools/call' || o.reply) console.log(JSON.stringify(o).slice(0, 400)); }
