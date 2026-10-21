// Probe(모델 토큰 조금 — Haiku): 묻지 않음(bypassPermissions)에서 권한 확인이 호스트로 오는가.
// --permission-prompt-tool stdio 로 띄우면 권한 확인이 control_request can_use_tool 로 호스트(이 스크립트)에 온다 — 두레의 승인 도구와 같은 자리.
//   A. 평소 모드에서 Write → can_use_tool 이 오는가(대조군)
//   B. bypass 에서 Write → 오지 않고 실행되는가
//   C. bypass 에서 AskUserQuestion → can_use_tool 이 오는가, 안 오면 도구 결과는 무엇인가
//   D. 평소 모드로 시작 → 첫 Write 확인 요청이 떠 있는 동안 bypass 로 바꿈 → 같은 차례의 두 번째 Write 도 묻는가
// Usage: node probe11.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const work = join(os.tmpdir(), 'dure-probe11'); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true })

async function session(label, launchMode, prompt, onAsk) {
  console.log(`\n=== ${label}`)
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--strict-mcp-config', '--disallowedTools', 'SendMessage', 'ListAgents', '--permission-prompt-tool', 'stdio',
    '--allow-dangerously-skip-permissions']
  const p = spawn('claude', args, { cwd: work, shell: true })
  const waiting = new Map(); let n = 0; let buf = ''; let done
  const finished = new Promise((r) => (done = r))
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n')
  const ask = (request) => new Promise((r) => { const id = `p11-${++n}`; waiting.set(id, r); send({ type: 'control_request', request_id: id, request }) })
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', async (d) => {
    buf += d; let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue
      let j; try { j = JSON.parse(l) } catch { continue }
      if (j.type === 'control_response') { const w = waiting.get(j.response.request_id); if (w) { waiting.delete(j.response.request_id); w(j.response) } continue }
      if (j.type === 'control_request' && j.request?.subtype === 'can_use_tool') {
        console.log(`  ASK can_use_tool ${j.request.tool_name} ${JSON.stringify(j.request.input).slice(0, 90)}`)
        const answer = await onAsk(j.request, ask)
        send({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: answer } })
        continue
      }
      if (j.type === 'system' && j.subtype === 'init') console.log('  init permissionMode =', j.permissionMode)
      if (j.type === 'assistant') for (const c of j.message?.content ?? []) if (c.type === 'tool_use') console.log(`  tool_use ${c.name} ${JSON.stringify(c.input).slice(0, 90)}`)
      if (j.type === 'user') for (const c of j.message?.content ?? []) if (c.type === 'tool_result') console.log(`  tool_result ${c.is_error ? 'ERROR ' : ''}${JSON.stringify(c.content).slice(0, 160)}`)
      if (j.type === 'result') { console.log(`  result ${j.subtype} cost=${j.total_cost_usd}`); done() }
    }
  })
  if (launchMode === 'bypass') console.log('  set_permission_mode →', JSON.stringify((await ask({ subtype: 'set_permission_mode', mode: 'bypassPermissions' })).response ?? {}))
  send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })
  await Promise.race([finished, new Promise((r) => setTimeout(r, 90000))])
  p.stdin.end(); await new Promise((r) => p.on('close', r))
}

const allow = async (req) => ({ behavior: 'allow', updatedInput: req.input })
await session('A 평소 모드 · Write', 'default', 'Use the Write tool to create the file a.txt containing the text hi. Do nothing else and do not explain.', allow)
await session('B bypass · Write', 'bypass', 'Use the Write tool to create the file b.txt containing the text hi. Do nothing else and do not explain.', allow)
await session('C bypass · AskUserQuestion', 'bypass', 'Use the AskUserQuestion tool exactly once to ask me "A or B?" with the two options "A" and "B". After you get the answer, reply with only the letter I chose.', async (req) => {
  if (req.tool_name === 'AskUserQuestion') return { behavior: 'allow', updatedInput: { ...req.input, answers: { 'A or B?': 'B' } } }
  return { behavior: 'allow', updatedInput: req.input }
})
let switched = false
await session('D 평소 모드 → 첫 확인 중 bypass 로 → 두 번째 Write', 'default', 'Use the Write tool twice, as two separate tool calls one after the other: first create d1.txt containing hi, then create d2.txt containing hi. Do nothing else and do not explain.', async (req, ask) => {
  if (!switched) { switched = true; console.log('  (첫 확인 중) set_permission_mode →', JSON.stringify((await ask({ subtype: 'set_permission_mode', mode: 'bypassPermissions' })).response ?? {})) }
  return { behavior: 'allow', updatedInput: req.input }
})
