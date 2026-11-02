// probe22 — 지난 대화로 새 에이전트 만들기(--resume <끝낸 세션> --fork-session) 실측. Haiku(사용자 동의 2026-11-02).
// ① 갈래 친 실행의 init session_id 가 새 id 인가 · 옛 내용을 기억하는가 · 원래 파일은 그대로인가(새 파일이 생기는가)
// ② 갈래와 원래 대화가 서로 섞이지 않는가(갈래에서 한 말을 원래가 모르고, 원래에서 한 말을 갈래가 모른다)
// ③ --fork-session 에 --session-id 를 같이 주면 새 id 를 고를 수 있는가
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

const work = join(os.tmpdir(), 'dure-probe22')
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
const sizeA = sizeOf(sidA)

// ① 갈래 치기
const f = await run('F', ['--resume', sidA, '--fork-session'], '다음 단어도 기억해: 바나나. 그리고 지금까지 기억하라고 한 단어를 전부 말해. 다른 말 없이, 도구는 쓰지 마.')
const sidF = f.initSid
const sizeA1 = sizeOf(sidA)

// ② 원래 대화에 다른 말 → 서로 모르는가
const a2 = await run('A2', ['--resume', sidA], '다음 단어도 기억해: 포도. 그리고 지금까지 기억하라고 한 단어를 전부 말해. 다른 말 없이, 도구는 쓰지 마.')
const f2 = sidF ? await run('F2', ['--resume', sidF], '지금까지 기억하라고 한 단어를 전부 말해. 다른 말 없이, 도구는 쓰지 마.') : null

// ③ 새 id 고르기
const sidG = randomUUID()
const g = await run('G', ['--resume', sidA, '--fork-session', '--session-id', sidG], '"알았어" 한 마디만 답해. 도구는 쓰지 마.')

console.log('\n== 판정')
console.log('① F init:', sidF, '· 새 id?', !!sidF && sidF !== sidA, '· 답', JSON.stringify(f.result), '· 사과', has(f.result, '사과'))
console.log('   A 파일 크기', sizeA, '→ 갈래 뒤', sizeA1, '(같으면 원래 파일 안 건드림) · F 파일 있음', !!(sidF && fileOf(sidF)))
console.log('② A2 답', JSON.stringify(a2.result), '· 바나나(갈래에서 한 말) 모름?', !has(a2.result, '바나나'), '· A2 init = A?', a2.initSid === sidA)
console.log('   F2 답', JSON.stringify(f2?.result), '· 포도(원래에서 한 말) 모름?', !has(f2?.result, '포도'), '· F2 init = F?', f2?.initSid === sidF)
console.log('③ G init', g.initSid, '· 고른 id 그대로?', g.initSid === sidG, '· code', g.code, '· stderr', JSON.stringify(g.stderr.trim().slice(0, 300)), '· result', g.subtype)
rmSync(work, { recursive: true, force: true })
console.log('--- 끝')
