// probe19 — 재우자마자 깨우기: 옛 claude 가 입력이 닫혀 끝나는 동안(엔진 endSession 과 같다 — stdin.end 뒤 기다림) 같은 세션 id 로
// 새 claude 를 --resume 으로 곧바로 띄운다. 두 프로세스가 같은 대화 기록을 잠깐 겹쳐 쥘 때 대화가 이어지는가·기록 파일이 깨지지 않는가.
// 단어를 하나씩 기억시키며 세 번 이어 깨우고, 모두 끝난 뒤 한 번 더 띄워 전부 기억하는지 묻는다. Haiku(사용자 동의 2026-10-27).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

const work = join(os.tmpdir(), 'dure-probe19')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const sid = randomUUID()
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`
const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
  '--replay-user-messages', '--disallowedTools', 'SendMessage', 'ListAgents']

/** claude 하나 — 사람 말 하나를 쓰고 result 를 기다린다. 끝(exit)은 따로 알린다 */
function turn(label, extra, text) {
  const p = spawn('claude', [...base, ...extra], { cwd: work, shell: true })
  let buf = ''
  const exited = new Promise((r) => p.on('close', (code) => { console.log(ts(), `  [${label}] 끝남 code ${code}`); r() }))
  p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => process.stderr.write(d))
  p.stdout.setEncoding('utf8')
  const result = new Promise((resolve) => {
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1)
        let j; try { j = JSON.parse(l) } catch { continue }
        if (j.type === 'system' && j.subtype === 'init') console.log(ts(), `  [${label}] init`)
        if (j.type === 'result') {
          console.log(ts(), `  [${label}] result ${j.subtype} | ${String(j.result).replace(/\n/g, ' / ').slice(0, 160)}`)
          resolve(String(j.result))
        }
      }
    })
  })
  console.log(ts(), `[${label}] 띄움 ${extra.join(' ')}`)
  p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
  return { result, exited, end: () => { console.log(ts(), `  [${label}] 입력 닫음(재우기)`); p.stdin.end() } }
}

const a = turn('A', ['--session-id', sid], '다음 단어를 기억해: 사과. "알았어" 한 마디만 답해.')
await a.result
a.end() // 재운다 — 끝나기를 기다리지 않고 곧바로 깨운다
const b = turn('B', ['--resume', sid], '다음 단어도 기억해: 바나나. 지금까지 기억한 단어를 쉼표로 전부 말해. 다른 말 없이.')
const rb = await b.result
b.end()
const c = turn('C', ['--resume', sid], '다음 단어도 기억해: 체리. 지금까지 기억한 단어를 쉼표로 전부 말해. 다른 말 없이.')
const rc = await c.result
c.end()
await Promise.all([a.exited, b.exited, c.exited])
const d = turn('D', ['--resume', sid], '지금까지 기억한 단어를 쉼표로 전부 말해. 다른 말 없이.')
const rd = await d.result
d.end()
await d.exited

const has = (s, ws) => ws.every((w) => s.includes(w))
console.log('\n== 판정')
console.log('B 이어짐(사과·바나나):', has(rb, ['사과', '바나나']))
console.log('C 이어짐(사과·바나나·체리):', has(rc, ['사과', '바나나', '체리']))
console.log('D 끝난 뒤 전부(사과·바나나·체리):', has(rd, ['사과', '바나나', '체리']))

// 대화 기록 파일 — 모든 줄이 JSON 인가 · 같은 uuid 가 두 번 없는가 · 우리가 쓴 말이 각 한 번씩인가
const root = join(os.homedir(), '.claude', 'projects')
const file = readdirSync(root).map((d) => join(root, d, `${sid}.jsonl`)).find((f) => existsSync(f))
if (!file) { console.log('기록 파일을 못 찾음'); process.exit(0) }
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
let bad = 0; const uuids = new Map(); const said = { 사과: 0, 바나나: 0, 체리: 0, 전부: 0 }
for (const l of lines) {
  let j; try { j = JSON.parse(l) } catch { bad++; continue }
  if (j.uuid) uuids.set(j.uuid, (uuids.get(j.uuid) ?? 0) + 1)
  if (j.type === 'user' && !j.isMeta) {
    const c = j.message?.content
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('') : ''
    if (t.startsWith('다음 단어를 기억해: 사과')) said.사과++
    if (t.startsWith('다음 단어도 기억해: 바나나')) said.바나나++
    if (t.startsWith('다음 단어도 기억해: 체리')) said.체리++
    if (t.startsWith('지금까지 기억한 단어를 쉼표로 전부')) said.전부++
  }
}
const dup = [...uuids.values()].filter((n) => n > 1).length
console.log(`기록 파일 ${lines.length}줄 · 깨진 줄 ${bad} · 겹친 uuid ${dup} · 쓴 말 횟수 ${JSON.stringify(said)}`)
console.log('--- 끝')
