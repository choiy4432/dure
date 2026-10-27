// probe18 — 쉬는 에이전트 재우기(세션을 끄고 다음 말에 --resume)의 두 가지 근거. Haiku 로 짧게(사용자 동의 2026-10-27).
// PROBE=bg    : Bash run_in_background 로 20초 명령을 띄우고 차례를 끝낸다 — 뒤에서 도는 명령을 system 줄(task_started ·
//               background_tasks_changed · task_notification)로 알려 주는가, 끝나면 Claude 가 스스로 차례를 여는가.
// PROBE=cache : 같은 세션을 ① 한 프로세스에서 두 번 ② 끄고 --resume(git 그대로) ③ 끄고 git 커밋을 하나 더 한 뒤 --resume —
//               차례마다 result usage 의 cache_read / cache_creation 을 본다(깨운 뒤 첫 말이 대화 전체를 다시 쓰는가).
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

const mode = process.env.PROBE ?? 'bg'
const work = join(os.tmpdir(), `dure-probe18-${mode}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
  '--disallowedTools', 'SendMessage', 'ListAgents']

/** claude 하나 — 줄마다 onLine(json). say(text) 로 사람 말, end() 로 닫기 */
function run(extra, onLine) {
  const p = spawn('claude', [...base, ...extra], { cwd: work, shell: true })
  let buf = ''
  p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => process.stderr.write(d))
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1)
      let j; try { j = JSON.parse(l) } catch { continue }
      onLine(j)
    }
  })
  return {
    say: (text) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'),
    end: () => p.stdin.end(),
    closed: new Promise((r) => p.on('close', r)),
  }
}

const usageOf = (j) => {
  const u = j.usage ?? {}
  return `input ${u.input_tokens} · cache_creation ${u.cache_creation_input_tokens} · cache_read ${u.cache_read_input_tokens} · $${j.total_cost_usd}`
}

if (mode === 'bg') {
  let results = 0
  const c = run(['--allowedTools', 'Bash'], (j) => {
    if (j.type === 'system' && j.subtype !== 'init') console.log(ts(), 'system', j.subtype, JSON.stringify(j).slice(0, 400))
    if (j.type === 'system' && j.subtype === 'init') console.log(ts(), 'init')
    if (j.type === 'assistant') for (const b of j.message?.content ?? []) {
      if (b.type === 'tool_use') console.log(ts(), 'tool_use', b.name, JSON.stringify(b.input).slice(0, 200))
      if (b.type === 'text') console.log(ts(), 'text', b.text.slice(0, 160).replace(/\n/g, ' / '))
    }
    if (j.type === 'result') { results++; console.log(ts(), 'result', j.subtype, '|', String(j.result).slice(0, 120).replace(/\n/g, ' / ')) }
  })
  c.say('Bash 도구를 run_in_background: true 로 써서 이 명령을 띄워: node -e "setTimeout(()=>console.log(\'done\'),20000)" . 띄웠으면 기다리지 말고 "띄웠어" 한 마디만 답하고 끝내.')
  // 명령이 끝난 뒤(20초)에도 15초 더 열어 둔다 — 끝 알림·스스로 연 차례를 본다
  setTimeout(() => { console.log(ts(), '닫는다 (result 수', results, ')'); c.end() }, 50_000)
  await c.closed
} else {
  const sid = randomUUID()
  execSync('git init -q && git -c user.name=p -c user.email=p@p add -A && git -c user.name=p -c user.email=p@p commit -q --allow-empty -m first', { cwd: work, shell: true })
  /** 한 프로세스에서 말 여러 개를 차례로 — 각 result 의 usage 를 찍는다 */
  async function session(label, extra, asks) {
    console.log(`\n== ${label}`)
    let k = 0
    let c
    await new Promise((done) => {
      c = run(extra, (j) => {
        if (j.type !== 'result') return
        console.log(ts(), `  [${asks[k]}]`, usageOf(j))
        k++
        if (k < asks.length) c.say(asks[k])
        else done()
      })
      c.say(asks[0])
    })
    c.end()
    await c.closed
  }
  await session('① 처음 띄움 — 두 번', ['--session-id', sid], ['1+1? 숫자만', '2+2? 숫자만'])
  await session('② 끄고 --resume (git 그대로)', ['--resume', sid], ['3+3? 숫자만'])
  writeFileSync(join(work, 'new.txt'), 'x\n')
  execSync('git -c user.name=p -c user.email=p@p add -A && git -c user.name=p -c user.email=p@p commit -q -m second', { cwd: work, shell: true })
  await session('③ 커밋 하나 더 하고 --resume', ['--resume', sid], ['4+4? 숫자만'])
  writeFileSync(join(work, 'dirty.txt'), 'y\n')
  await session('④ 커밋 안 한 새 파일 두고 --resume', ['--resume', sid], ['5+5? 숫자만'])
}
console.log('--- 끝')
