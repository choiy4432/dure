// probe21 — 지난 대화로 돌아가기(--resume <끝낸 세션>) 실측. Haiku(사용자 동의 2026-11-02).
// ① 없는 세션 id 로 --resume 하면 — init 이 오는가, 종료 코드·stderr·걸린 시간
// ② 다른 세션(B)을 쓴 뒤 끝낸 세션(A)으로 돌아가면 Claude 가 A 의 내용만 기억하는가
// ③ --resume A 의 init session_id 가 A 그대로인가 · 돌아간 차례가 A 의 기록 파일에 붙는가(새 파일이 생기지 않는가)
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

const work = join(os.tmpdir(), 'dure-probe21')
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
const projectFiles = () => {
  const f = fileOf(sidA)
  if (!f) return []
  const dir = join(f, '..')
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()
}

const sidA = randomUUID()
const sidB = randomUUID()

const a = await run('A', ['--session-id', sidA], '다음 단어를 기억해: 사과. "알았어" 한 마디만 답해. 도구는 쓰지 마.')
const b = await run('B', ['--session-id', sidB], '다음 단어를 기억해: 바나나. "알았어" 한 마디만 답해. 도구는 쓰지 마.')
const fileA = fileOf(sidA)
const sizeA = fileA ? statSync(fileA).size : null
const before = projectFiles()

// ②③ 끝낸 세션 A 로 돌아가기
const c = await run('C', ['--resume', sidA], '지금까지 기억하라고 한 단어를 전부 말해. 다른 말 없이, 도구는 쓰지 마.')
const after = projectFiles()
const sizeA2 = fileA ? statSync(fileA).size : null

// 돌아간 뒤 한 번 더 — 다시 --resume A 하면 C 의 차례까지 이어지는가
const d = await run('D', ['--resume', sidA], '바로 앞 차례에 네가 한 답을 그대로 다시 말해. 도구는 쓰지 마.')

// ① 없는 세션
const ghost = randomUUID()
const e = await run('E', ['--resume', ghost], '안녕', 60_000)

console.log('\n== 판정')
console.log('① 없는 세션 --resume:', JSON.stringify({ init: e.initSid, code: e.code, subtype: e.subtype, result: e.result?.slice(0, 160), secs: (e.tEnd / 1000).toFixed(1), stderr: e.stderr.trim().slice(0, 400), stdoutOther: e.stdoutOther.slice(0, 5) }, null, 1))
console.log('② C 답:', JSON.stringify(c.result), '· 사과', !!c.result?.includes('사과'), '· 바나나', !!c.result?.includes('바나나'))
console.log('③ C init session_id = A?', c.initSid === sidA, `(${c.initSid})`, '· D init = A?', d.initSid === sidA)
console.log('   A 파일 크기', sizeA, '→', sizeA2, '· 프로젝트 폴더 jsonl', before.length, '→', after.length, after.filter((n) => !before.includes(n)))
console.log('   D 답:', JSON.stringify(d.result))
console.log('A 답:', JSON.stringify(a.result), '· B 답:', JSON.stringify(b.result), '· A init = A?', a.initSid === sidA)
rmSync(work, { recursive: true, force: true })
console.log('--- 끝')
