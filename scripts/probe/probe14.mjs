// Probe(모델 토큰 조금 — Haiku 4회): probe13 뒤에 남은 서브에이전트 물음 — 두레와 같은 승인 경로(MCP 승인 도구)·두레 도구로.
//   A. 서브에이전트가 또 띄운 서브에이전트: parent_tool_use_id · task_started.tool_use_id · spawn_depth
//      + 서브에이전트가 두레 도구(send_message)를 이어받는가, 그 MCP 호출에 tool_use id 가 실리는가(_meta)
//      + 서브에이전트 승인(MCP approve)의 tool_use_id 가 서브에이전트의 것인가
//   B. 서브에이전트가 도는 동안(부모 차례는 끝남) 입력을 보내면 init…result 가 한 줄에 하나씩 오는가, 끝 알림이 섞이는가
//   C. 서브에이전트가 도는 동안 interrupt 가 서브에이전트도 멈추는가 — 아니면 stop_task {task_id} 가 되는가
//   D. 앞에서 도는 서브에이전트(run_in_background: false): 부모의 Agent tool_result 가 마지막 답인가, task 사건이 오는가
// 승인·두레 도구는 scripts/probe/miniMcp.mjs(stdio MCP)를 작업 폴더에 복사해 쓴다 — 호출 기록은 그 폴더의 calls.jsonl.
// Usage: node probe14.mjs [원본 기록 폴더]
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, appendFileSync, copyFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const work = join(os.tmpdir(), 'dure-probe14'); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true })
const rawDir = process.argv[2] ?? work
mkdirSync(rawDir, { recursive: true })
writeFileSync(join(work, 'note.txt'), 'blue whale\nsecond line\n')
copyFileSync(join(here, 'miniMcp.mjs'), join(work, 'miniMcp.mjs'))
const cfgPath = join(work, 'mcp.json')
writeFileSync(cfgPath, JSON.stringify({ mcpServers: { dure: { command: 'node', args: [join(work, 'miniMcp.mjs')], env: { AGENT_ID: 'probe' } } } }))
const short = (v, n = 140) => JSON.stringify(v)?.slice(0, n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 두레처럼 띄운 세션 하나 — onLine(j, ctx) 로 손을 대고, ctx.done() 이나 시간 초과로 끝 */
async function session(label, prompt, onLine = () => {}, limitMs = 150000) {
  console.log(`\n=== ${label}`)
  const raw = join(rawDir, `${label.split(' ')[0]}.jsonl`); writeFileSync(raw, '')
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', 'haiku', '--strict-mcp-config', '--mcp-config', cfgPath, '--permission-prompt-tool', 'mcp__dure__approve',
    '--allowedTools', 'mcp__dure__send_message', '--disallowedTools', 'SendMessage', 'ListAgents']
  const p = spawn('claude', args, { cwd: work, shell: true })
  let n = 0; let buf = ''; let done; const finished = new Promise((r) => (done = r))
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n')
  const ctx = {
    results: 0, tasks: new Map(), // task_id → tool_use_id
    done, send,
    user: (text) => { console.log(`>>> user ${short(text)}`); send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) },
    control: (request) => { const id = `p14-${++n}`; console.log(`>>> control ${short(request)}`); send({ type: 'control_request', request_id: id, request }) },
  }
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (d) => {
    buf += d; let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue
      appendFileSync(raw, l + '\n')
      let j; try { j = JSON.parse(l) } catch { continue }
      const parent = j.parent_tool_use_id ? ` parent=${j.parent_tool_use_id.slice(-6)}` : ''
      if (j.type === 'stream_event') continue
      if (j.type === 'system') {
        if (['hook_started', 'hook_response', 'thinking_tokens', 'status'].includes(j.subtype)) continue
        if (j.subtype === 'init') console.log('system/init')
        else { const { uuid, session_id, prompt: _p, ...rest } = j; console.log(`system/${j.subtype} ${short(rest, 260)}`) }
        if (j.subtype === 'task_started') ctx.tasks.set(j.task_id, j.tool_use_id)
      } else if (j.type === 'assistant') {
        for (const c of j.message?.content ?? []) {
          if (c.type === 'text') console.log(`assistant text${parent} ${short(c.text, 100)}`)
          if (c.type === 'tool_use') console.log(`assistant tool_use${parent} id=..${c.id.slice(-6)} ${c.name} ${short(c.input, 120)}`)
        }
      } else if (j.type === 'user') {
        const content = j.message?.content
        if (typeof content === 'string') console.log(`user string${parent} ${short(content, 100)}`)
        else for (const c of content ?? []) if (c.type === 'tool_result') console.log(`user tool_result${parent} for=..${c.tool_use_id.slice(-6)} ${c.is_error ? 'ERROR ' : ''}${short(c.content, 140)}`)
      } else if (j.type === 'result') { ctx.results++; console.log(`result#${ctx.results} ${j.subtype} ${short(j.result, 80)} cost=${j.total_cost_usd}`) }
      else if (j.type === 'control_response') console.log(`control_response ${short(j.response, 200)}`)
      else if (j.type !== 'rate_limit_event') console.log(`other ${j.type}${parent}`)
      try { onLine(j, ctx) } catch (e) { console.log('onLine error', e) }
    }
  })
  ctx.user(prompt)
  await Promise.race([finished, sleep(limitMs).then(() => console.log('(time limit)'))])
  p.stdin.end(); await new Promise((r) => p.on('close', r))
}

const bgDone = (j, ctx) => j.type === 'system' && j.subtype === 'background_tasks_changed' && j.tasks.length === 0 && (ctx.idleAfter = true)
const untilQuiet = (j, ctx) => { bgDone(j, ctx); if (j.type === 'result' && ctx.idleAfter) ctx.done() }

await session('A 중첩·두레도구·승인',
  'Use the Agent tool exactly once with subagent_type "general-purpose", model "haiku", description "outer", and this prompt: ' +
  '"Step 1: call the mcp__dure__send_message tool with to set to design and text set to hello from sub. ' +
  'Step 2: use the Agent tool exactly once with subagent_type general-purpose, model haiku, description inner, and the prompt: Use the Write tool to create inner.txt containing hi, then reply with the word done. ' +
  'Step 3: wait for the inner agent to finish, then reply with what it returned." ' +
  'After the Agent tool finishes, reply with only what it returned. Do not use any other tool yourself.', untilQuiet, 170000)

await session('B 도는중_입력',
  'Use the Agent tool exactly once with subagent_type "general-purpose", model "haiku", description "slow read", and this prompt: ' +
  '"Read note.txt with the Read tool three separate times, one call after another, then reply with its first line." ' +
  'After launching it, reply with the single word LAUNCHED. When it finishes, reply with only what it returned.',
  (j, ctx) => {
    if (j.type === 'result' && ctx.results === 1) ctx.user('Reply with just the word PING. Do not use any tool.')
    untilQuiet(j, ctx)
  })

await session('C 멈추기',
  'Use the Agent tool exactly once with subagent_type "general-purpose", model "haiku", description "long job", and this prompt: ' +
  '"Read note.txt with the Read tool five separate times, one call after another. Then use the Write tool to create long.txt containing done. Then reply with done." ' +
  'After launching it, reply with the single word LAUNCHED. When it finishes, reply with only what it returned.',
  (j, ctx) => {
    if (j.type === 'result' && ctx.results === 1 && !ctx.stopped) {
      ctx.stopped = 'interrupt'
      ctx.control({ subtype: 'interrupt' })
      setTimeout(() => {
        if (ctx.idleAfter) return
        const [taskId] = ctx.tasks.keys()
        ctx.stopped = 'stop_task'
        ctx.control({ subtype: 'stop_task', task_id: taskId })
      }, 6000)
    }
    untilQuiet(j, ctx)
  }, 90000)

await session('D 앞에서',
  'Use the Agent tool exactly once with run_in_background set to false, subagent_type "general-purpose", model "haiku", description "fg read", and this prompt: ' +
  '"Read note.txt with the Read tool and reply with its first line." Then reply with only what it returned.',
  (j, ctx) => { bgDone(j, ctx); if (j.type === 'result') setTimeout(() => ctx.done(), 4000) }, 120000)

const calls = join(work, 'calls.jsonl')
console.log('\n=== MCP 호출(miniMcp)')
if (existsSync(calls)) for (const l of readFileSync(calls, 'utf8').trim().split('\n')) {
  const j = JSON.parse(l)
  if (j.in?.method === 'tools/call') console.log(`call ${j.in.params.name} meta=${short(j.in.params._meta, 160)} args=${short(j.in.params.arguments, 160)}`)
}
console.log(`raw → ${rawDir}`)
