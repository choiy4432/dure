// Probe(모델 토큰 조금 — Haiku 1회): 앞에서 도는(foreground) 서브에이전트가 도는 중에 interrupt 를 보내면
// task_notification 이 오는가(status), 부모 차례의 result 는 어떻게 끝나는가. probe14 C 는 백그라운드만 쟀다.
// Usage: node probe15.mjs [원본 기록 파일 경로]
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const work = join(os.tmpdir(), 'dure-probe15'); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'note.txt'), 'blue whale\nsecond line\n')
const rawPath = process.argv[2] ?? join(work, 'raw.jsonl')
writeFileSync(rawPath, '')

const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--model', 'haiku', '--strict-mcp-config', '--disallowedTools', 'SendMessage', 'ListAgents', '--permission-prompt-tool', 'stdio']
const p = spawn('claude', args, { cwd: work, shell: true })
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n')
let buf = ''; let done; let deltas = 0; let subDeltas = 0; let results = 0; let notified = false; let interrupted = false
const finished = new Promise((r) => (done = r))
const short = (v, n = 110) => JSON.stringify(v)?.slice(0, n)

p.stdout.setEncoding('utf8')
p.stdout.on('data', (d) => {
  buf += d; let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue
    appendFileSync(rawPath, l + '\n')
    let j; try { j = JSON.parse(l) } catch { continue }
    const parent = j.parent_tool_use_id ? ` parent=${j.parent_tool_use_id}` : ''
    if (j.type === 'stream_event') { if (j.parent_tool_use_id) subDeltas++; else deltas++; continue }
    if (j.type === 'control_request' && j.request?.subtype === 'can_use_tool') {
      const { input, ...rest } = j.request
      console.log(`ASK can_use_tool ${short(rest, 300)} input=${short(input, 80)}`)
      send({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: { behavior: 'allow', updatedInput: input } } })
      continue
    }
    if (j.type === 'system') {
      if (j.subtype === 'init') { console.log(`system/init model=${j.model}`); continue }
      if (j.subtype === 'task_notification') notified = true
      if (j.subtype === 'task_started' && !interrupted) { interrupted = true; setTimeout(() => { console.log('>>> interrupt'); send({ type: 'control_request', request_id: 'p15-int', request: { subtype: 'interrupt' } }) }, 2500); setTimeout(() => done(), 14000) }
      if (j.subtype === 'hook_started' || j.subtype === 'hook_response' || j.subtype === 'thinking_tokens' || j.subtype === 'status') continue
      const { uuid, session_id, ...rest } = j
      console.log(`system/${j.subtype} ${short(rest, 400)}`)
      continue
    }
    if (j.type === 'assistant') {
      for (const c of j.message?.content ?? []) {
        if (c.type === 'text') console.log(`assistant text${parent} ${short(c.text)}`)
        if (c.type === 'tool_use') console.log(`assistant tool_use${parent} id=${c.id} ${c.name} ${short(c.input, 200)}`)
      }
      continue
    }
    if (j.type === 'user') {
      const content = j.message?.content
      if (typeof content === 'string') { console.log(`user string${parent} ${short(content)}`); continue }
      for (const c of content ?? []) {
        if (c.type === 'tool_result') console.log(`user tool_result${parent} for=${c.tool_use_id} ${c.is_error ? 'ERROR ' : ''}${short(c.content, 300)}`)
        else if (c.type === 'text') console.log(`user text${parent} ${short(c.text)}`)
      }
      if (j.tool_use_result !== undefined) console.log(`  (tool_use_result keys: ${Object.keys(j.tool_use_result ?? {}).join(',')})`)
      continue
    }
    // 서브에이전트는 백그라운드로 돈다 — 부모 차례(result)가 먼저 끝나므로, 끝 알림 뒤의 다음 차례까지 연결을 연다
    if (j.type === 'result') { results++; console.log(`result#${results} ${j.subtype} cost=${j.total_cost_usd}`); continue }
    console.log(`other ${j.type}${parent}`)
  }
})

send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text:
  'Use the Agent tool exactly once with run_in_background set to false, subagent_type "general-purpose", model "haiku", description "slow fg", and this prompt: ' +
  '"Read note.txt with the Read tool six separate times, one call after another, then reply with its first line." ' +
  'Then reply with only what it returned.' }] } })
await Promise.race([finished, new Promise((r) => setTimeout(r, 60000))])
p.stdin.end(); await new Promise((r) => p.on('close', r))
console.log(`raw → ${rawPath}`)
