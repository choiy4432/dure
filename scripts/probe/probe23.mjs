// probe23 — 갈래 첫 실행이 /effort 한 줄뿐이어도 갈래 세션이 저장되는가(두레는 effort 를 정해 둔 에이전트에 /effort 를 먼저 쓴다). Haiku 대화 + 로컬 명령(사용자 동의 2026-11-02 갈래 실측과 같은 범위).
// ① --resume A --fork-session --session-id X 로 띄워 '/effort low' 만 보내고 끝 → X 파일이 생기는가 ② 그다음 --resume X 로 물으면 A 의 단어를 기억하는가
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

const work = join(os.tmpdir(), 'dure-probe23')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`
const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
  '--disallowedTools', 'SendMessage', 'ListAgents']
const say = (p, text) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')

/** claude 한 번 — 말 하나를 보내고 result(또는 종료)까지. 돌려줌: init session_id·답·종료 코드·stderr·init 전 종료 여부 */
function run(label, extra, text, limitMs = 90_000) {
  return new Promise((resolve) => {
    const out = { label, initSid: null, result: null, subtype: null, code: null, stderr: '', stdoutOther: [], tInit: null, tEnd: null }
    const start = Date.now()
    const p = spawn('claude', [...base, ...extra], { cwd: work, shell: true })
    let buf = ''
    const timer = setTimeout(() => { console.log(ts(), `  [${label}] ${limitMs / 1000}초 넘김 — 끈다`); p.kill() }, limitMs)
    p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => { out.stderr += d })
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1)
        let j; try { j = JSON.parse(l) } catch { if (l.trim()) out.stdoutOther.push(l.slice(0, 200)); continue }
        if (j.type === 'system' && j.subtype === 'init') { out.initSid = j.session_id; out.tInit = Date.now() - start; console.log(ts(), `  [${label}] init session_id ${j.session_id}`) }
        else if (j.type === 'result') { out.result = String(j.result ?? ''); out.subtype = j.subtype; console.log(ts(), `  [${label}] result ${j.subtype} | ${out.result.replace(/\n/g, ' / ').slice(0, 120)}`); p.stdin.end() }
        else if (j.type !== 'assistant' && j.type !== 'user' && j.type !== 'stream_event' && j.type !== 'system') out.stdoutOther.push(l.slice(0, 200))
      }
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      out.code = code; out.tEnd = Date.now() - start
      if (buf.trim()) out.stdoutOther.push(buf.trim().slice(0, 200))
      console.log(ts(), `  [${label}] 끝남 code ${code} · ${(out.tEnd / 1000).toFixed(1)}s`)
      resolve(out)
    })
    console.log(ts(), `[${label}] 띄움 ${extra.join(' ')}`)
    say(p, text)
  })
}

const root = join(os.homedir(), '.claude', 'projects')
const fileOf = (sid) => readdirSync(root).map((d) => join(root, d, `${sid}.jsonl`)).find((f) => existsSync(f)) ?? null
const sizeOf = (sid) => { const f = fileOf(sid); return f ? statSync(f).size : null }
const has = (r, w) => !!r?.includes(w)

const sidA = randomUUID()
const a = await run('A', ['--session-id', sidA], '다음 단어를 기억해: 사과. "알았어" 한 마디만 답해. 도구는 쓰지 마.')
const sidX = randomUUID()
const e = await run('E', ['--resume', sidA, '--fork-session', '--session-id', sidX], '/effort low')
const fileX1 = !!fileOf(sidX)
const x = await run('X', ['--resume', sidX], '지금까지 기억하라고 한 단어를 전부 말해. 다른 말 없이, 도구는 쓰지 마.')
console.log('\n== 판정')
console.log('E(/effort 만) init', e.initSid, '= X?', e.initSid === sidX, '· result', e.subtype, JSON.stringify(e.result?.slice(0, 80)), '· code', e.code)
console.log('① /effort 뒤 X 파일 있음?', fileX1)
console.log('② --resume X: init', x.initSid, '· code', x.code, '· 답', JSON.stringify(x.result), '· 사과', has(x.result, '사과'), '· stderr', JSON.stringify(x.stderr.trim().slice(0, 200)))
rmSync(work, { recursive: true, force: true })
console.log('--- 끝')
