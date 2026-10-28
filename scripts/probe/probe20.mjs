// probe20 — 멈추기 = 대기열도 멈춤: 일하는 중 끼워 넣은 말을 Claude 가 읽기 전에 claude 를 내리면(프로세스 트리 강제 종료 — 엔진 killTree)
// ① 그 말은 대화 기록에 남지 않는가(돌려받아 붙잡기로 옮겨도 두 번 들어가지 않는가) ② 도구가 돌던 중 내린 세션을 --resume 하면 대화가 이어지는가
// ③ 기록 파일이 깨지지 않는가 · 내린 도구(tool_use)는 어떻게 남는가. Haiku(사용자 동의 2026-10-28).
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

const work = join(os.tmpdir(), 'dure-probe20')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const sid = randomUUID()
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`
const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
  '--replay-user-messages', '--disallowedTools', 'SendMessage', 'ListAgents', '--allowedTools', '"Bash(sleep:*)"']
const say = (p, text) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')

/** claude 하나 — 줄마다 on(j) 를 부른다 */
function launch(label, extra, on) {
  const p = spawn('claude', [...base, ...extra], { cwd: work, shell: true })
  let buf = ''
  const exited = new Promise((r) => p.on('close', (code) => { console.log(ts(), `  [${label}] 끝남 code ${code}`); r() }))
  p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => process.stderr.write(d))
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1)
      let j; try { j = JSON.parse(l) } catch { continue }
      on(j)
    }
  })
  console.log(ts(), `[${label}] 띄움 ${extra.join(' ')}`)
  return { p, exited }
}

// ── A: 사과를 기억하고 sleep 20 — 도는 동안 바나나를 끼워 넣고, 읽기 전에 내린다
let replays = []
let toolSeen
const toolStarted = new Promise((r) => { toolSeen = r })
const a = launch('A', ['--session-id', sid], (j) => {
  if (j.type === 'system' && j.subtype === 'init') console.log(ts(), '  [A] init')
  if (j.type === 'user' && j.isReplay) {
    const c = j.message?.content
    const t = typeof c === 'string' ? c : (c ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('')
    replays.push(t); console.log(ts(), `  [A] 되돌림 "${t.slice(0, 40)}"`)
  }
  if (j.type === 'assistant') for (const b of j.message?.content ?? []) {
    if (b.type === 'tool_use') { console.log(ts(), `  [A] 도구 ${b.name} ${JSON.stringify(b.input).slice(0, 80)}`); if (b.name === 'Bash') toolSeen() }
    if (b.type === 'text') console.log(ts(), `  [A] 글 ${b.text.slice(0, 80).replace(/\n/g, ' / ')}`)
  }
  if (j.type === 'result') console.log(ts(), `  [A] result ${j.subtype} | ${String(j.result).slice(0, 80)}`)
})
say(a.p, '다음 단어를 기억해: 사과. 그다음 Bash 로 `sleep 20` 을 실행하고, 끝나면 "끝" 한 마디만 답해.')
const started = await Promise.race([toolStarted.then(() => true), new Promise((r) => setTimeout(() => r(false), 90_000))])
if (!started) { console.log('Bash 를 90초 안에 안 불렀다 — 그만'); execSync(`taskkill /pid ${a.p.pid} /T /F`, { stdio: 'ignore' }); process.exit(1) }
await new Promise((r) => setTimeout(r, 1500)) // 명령이 도는 중
console.log(ts(), '[A] 끼워 넣음: 바나나')
say(a.p, '다음 단어도 기억해: 바나나.')
await new Promise((r) => setTimeout(r, 1500))
const readBeforeKill = replays.some((t) => t.includes('바나나'))
console.log(ts(), `[A] 내림(taskkill /T /F) — 바나나 되돌림 받았나: ${readBeforeKill}`)
try { execSync(`taskkill /pid ${a.p.pid} /T /F`, { stdio: 'ignore' }) } catch {}
await a.exited

// ── B: --resume — 기억한 단어를 묻는다
let rb = ''
let bInit = 0
const bDone = new Promise((resolve) => {
  const b = launch('B', ['--resume', sid], (j) => {
    if (j.type === 'system' && j.subtype === 'init') { bInit = Date.now(); console.log(ts(), '  [B] init') }
    if (j.type === 'assistant') for (const x of j.message?.content ?? []) if (x.type === 'tool_use') console.log(ts(), `  [B] 도구 ${x.name}`)
    if (j.type === 'result') { rb = String(j.result); console.log(ts(), `  [B] result ${j.subtype} | ${rb.replace(/\n/g, ' / ').slice(0, 160)}`); b.p.stdin.end(); resolve() }
  })
  say(b.p, '지금까지 기억한 단어를 쉼표로 전부 말해. 도구는 쓰지 말고 다른 말 없이.')
})
const bStart = Date.now()
await bDone
console.log(`B 띄움 → init ${((bInit - bStart) / 1000).toFixed(1)}s`)

console.log('\n== 판정')
console.log('내리기 전 바나나 읽힘(되돌림):', readBeforeKill)
console.log('B 대답:', JSON.stringify(rb), '· 사과 있음', rb.includes('사과'), '· 바나나 있음', rb.includes('바나나'))

const root = join(os.homedir(), '.claude', 'projects')
const file = readdirSync(root).map((d) => join(root, d, `${sid}.jsonl`)).find((f) => existsSync(f))
if (!file) { console.log('기록 파일을 못 찾음'); process.exit(0) }
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
let bad = 0; const said = { 사과: 0, 바나나: 0, 전부: 0 }
const tail = []
for (const l of lines) {
  let j; try { j = JSON.parse(l) } catch { bad++; continue }
  if (j.type === 'user' || j.type === 'assistant') {
    const c = j.message?.content
    const kinds = typeof c === 'string' ? ['text'] : (c ?? []).map((x) => x.type === 'tool_result' ? `tool_result${x.is_error ? '(err)' : ''}:${String(typeof x.content === 'string' ? x.content : JSON.stringify(x.content)).slice(0, 50)}` : x.type)
    tail.push(`${j.type}${j.isMeta ? '(meta)' : ''} ${kinds.join(',')}`)
  }
  if (j.type === 'user' && !j.isMeta) {
    const c = j.message?.content
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('') : ''
    if (t.startsWith('다음 단어를 기억해: 사과')) said.사과++
    if (t.includes('바나나')) said.바나나++
    if (t.startsWith('지금까지 기억한 단어를 쉼표로 전부')) said.전부++
  }
}
console.log(`기록 파일 ${lines.length}줄 · 깨진 줄 ${bad} · 쓴 말 횟수 ${JSON.stringify(said)}`)
console.log('대화 줄 차례:\n  ' + tail.join('\n  '))
console.log('--- 끝')
