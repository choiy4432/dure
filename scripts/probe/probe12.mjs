import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
const work = join(os.tmpdir(), 'dure-probe12'); mkdirSync(work, { recursive: true })
const p = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--disallowedTools', 'SendMessage', 'ListAgents', '--allow-dangerously-skip-permissions'], { cwd: work, shell: true })
const waiting = new Map(); let n = 0; let buf = ''
p.stdout.setEncoding('utf8')
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let j; try { j = JSON.parse(l) } catch { continue } if (j.type === 'control_response') { const w = waiting.get(j.response.request_id); if (w) { waiting.delete(j.response.request_id); w(j.response) } } } })
const ask = (request) => new Promise((r) => { const id = `p12-${++n}`; waiting.set(id, r); p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n'); setTimeout(() => r({ subtype: 'timeout' }), 20000) })
const dm = async (tag) => { const g = await ask({ subtype: 'get_settings' }); console.log(tag, 'defaultMode =', JSON.stringify(g.response?.effective?.permissions?.defaultMode ?? null), '· applied keys', Object.keys(g.response?.applied ?? {}).join(',')) }
await dm('before:')
console.log('set bypass →', JSON.stringify((await ask({ subtype: 'set_permission_mode', mode: 'bypassPermissions' })).response))
await dm('in bypass:')
p.stdin.end(); await new Promise((r) => p.on('close', r))
