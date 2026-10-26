// probe17 — 차례 도중에 둘째 사람 말을 쓰면? 같은 차례 안에 끼어드는가(Claude Code 의 '일하는 중에 말 넣기'), 아니면 차례가 끝난 뒤 새 차례인가.
// 첫 말 = 도구를 여러 번 차례로 쓰는 일 · 첫 tool_use 가 보이면 둘째 말을 쓴다 → result 수·둘째 말이 나온 자리(user 줄 · 차례 안 text)를 본다.
// Haiku 로 짧게(사용자 '그냥' — 2026-10-26). PROBE_STOP=1 이면 둘째 말을 쓴 바로 뒤 interrupt — 그 말이 버려지는가·다음 차례가 되는가.
// PROBE_REPLAY=1 이면 --replay-user-messages — 끼어든 말을 언제(쓸 때 · 읽을 때) 되돌려 주는가.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
const work = join(os.tmpdir(), 'dure-probe17')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
for (const f of ['a.md', 'b.md', 'c.md']) writeFileSync(join(work, f), `# ${f}\n`)
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
  '--permission-mode', 'default', '--disallowedTools', 'SendMessage', 'ListAgents', ...(process.env.PROBE_REPLAY === '1' ? ['--replay-user-messages'] : [])]
const p = spawn('claude', args, { cwd: work, shell: true })
let buf = ''; let results = 0; let injected = false
const t0 = Date.now(); const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const say = (text) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => process.stderr.write(d))
p.stdout.setEncoding('utf8')
p.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1)
    let j; try { j = JSON.parse(l) } catch { continue }
    if (j.type === 'system') console.log(ts(), 'system', j.subtype, JSON.stringify(j).slice(0, 160))
    if (j.type === 'assistant') for (const b of j.message?.content ?? []) {
      if (b.type === 'tool_use') {
        console.log(ts(), 'tool_use', b.name, JSON.stringify(b.input).slice(0, 120))
        if (!injected) {
          injected = true; console.log(ts(), '>>> 둘째 말을 쓴다'); say('그리고 마지막 답 맨 끝에 BANANA 라는 단어를 꼭 붙여 줘.')
          if (process.env.PROBE_STOP === '1') { console.log(ts(), '>>> 바로 멈춘다(interrupt)'); p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'stop1', request: { subtype: 'interrupt' } }) + '\n') }
        }
      }
      if (b.type === 'text') console.log(ts(), 'text', b.text.slice(0, 200).replace(/\n/g, ' / '))
    }
    if (j.type === 'user') {
      const c = j.message?.content
      if (typeof c === 'string') console.log(ts(), 'user(string)', c.slice(0, 160))
      else for (const b of c ?? []) {
        if (b.type === 'tool_result') console.log(ts(), 'tool_result', String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 100).replace(/\n/g, ' / '))
        else console.log(ts(), 'user', b.type, JSON.stringify(b).slice(0, 200))
      }
      if (j.isReplay || j.uuid) console.log(ts(), '   (user 줄 키:', Object.keys(j).join(','), ')')
    }
    if (j.type === 'result') {
      results++
      console.log(ts(), 'result', j.subtype, 'num_turns', j.num_turns, 'cost $', j.total_cost_usd, '| text:', String(j.result).slice(-120).replace(/\n/g, ' / '))
      if (results >= 2) p.stdin.end()
    }
  }
})
say('Glob 도구로 *.md 를 찾고, 찾은 파일 셋을 Read 도구로 하나씩 차례로 읽은 뒤(한 번에 하나씩), 각 파일의 첫 줄을 알려 줘.')
setTimeout(() => { console.log(ts(), '시간 끝 — 닫는다 (result 수', results, ')'); p.stdin.end() }, process.env.PROBE_STOP === '1' ? 45_000 : 90_000)
await new Promise((r) => p.on('close', r))
console.log('--- 끝. result 수 =', results)
