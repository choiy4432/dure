// probe16 — 헤드리스 계획 모드(plan): set_permission_mode plan → ExitPlanMode 가 승인 도구로 오는가·입력 칸 이름·
// 의견 붙여 거절하면 고친 계획을 다시 내는가·승인 뒤 모드(다음 Write 가 다시 묻는가)·initialize 의 current_permission_mode.
// Haiku 로 짧게(사용자 허락 2026-10-23). 결과는 이 폴더의 plan-calls.jsonl + 표준 출력.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
rmSync(join(here, 'plan-calls.jsonl'), { force: true })
const work = join(os.tmpdir(), 'dure-probe16')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const mcp = join(work, 'mcp.json')
writeFileSync(mcp, JSON.stringify({ mcpServers: { dure: { type: 'stdio', command: process.execPath, args: [join(here, 'planMcp.mjs')] } } }))
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
  '--strict-mcp-config', '--mcp-config', mcp, '--permission-prompt-tool', 'mcp__dure__approve', '--disallowedTools', 'SendMessage', 'ListAgents']
const p = spawn('claude', args, { cwd: work, shell: true })
const waiting = new Map(); let n = 0; let buf = ''
let results = 0; let onResult = null
const t0 = Date.now(); const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => process.stderr.write(d))
p.stdout.setEncoding('utf8')
p.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1)
    let j; try { j = JSON.parse(l) } catch { continue }
    if (j.type === 'control_response') { const w = waiting.get(j.response.request_id); if (w) { waiting.delete(j.response.request_id); w(j.response) } continue }
    if (j.type === 'system' && j.subtype === 'init') console.log(ts(), 'init permissionMode =', j.permissionMode)
    if (j.type === 'system' && j.subtype === 'status') console.log(ts(), 'status', JSON.stringify(j).slice(0, 200))
    if (j.type === 'assistant') for (const b of j.message?.content ?? []) {
      if (b.type === 'tool_use') console.log(ts(), 'tool_use', b.name, JSON.stringify(b.input).slice(0, 300))
      if (b.type === 'text') console.log(ts(), 'text', b.text.slice(0, 200).replace(/\n/g, ' / '))
    }
    if (j.type === 'user') for (const b of j.message?.content ?? []) if (b.type === 'tool_result') console.log(ts(), 'tool_result', String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 200))
    if (j.type === 'result') { results++; console.log(ts(), 'result', j.subtype, 'cost $', j.total_cost_usd); onResult?.() }
  }
})
const ask = (request) => new Promise((r) => { const id = `p16-${++n}`; waiting.set(id, r); p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n'); setTimeout(() => r({ subtype: 'timeout' }), 20000) })
const say = (text) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
const mode = async (tag) => { const r = await ask({ subtype: 'initialize' }); console.log(ts(), tag, 'current_permission_mode =', r.response?.current_permission_mode ?? JSON.stringify(r).slice(0, 160)) }
const turn = () => new Promise((r) => { onResult = r })

await mode('start:')
console.log(ts(), 'set plan →', JSON.stringify((await ask({ subtype: 'set_permission_mode', mode: 'plan' })).response))
await mode('after set:')
say('이 폴더에 hello.txt 파일을 만들고 안에 hello 라고 쓰는 일이에요. 먼저 아주 짧은 계획(단계 2개)을 세워 승인받은 뒤에 하세요.')
await turn()
await mode('after turn:')
p.stdin.end()
await new Promise((r) => p.on('close', r))
console.log('--- 폴더:', (await import('node:fs')).readdirSync(work).join(', '))
