// probe27 — 첨부 폴더 --add-dir: 두레처럼(--permission-prompts host) 띄우고 cwd 와 다른 첨부 폴더의 txt·pdf 를 Read 가
// 승인 요청(control_request can_use_tool) 없이 읽나. A1 = 이 PC, A2 = 서버(WSL, ssh), A3 = --allowedTools "Read(폴더/**)".
// Haiku 로 한 차례씩(사용자 허락). 승인 요청이 오면 언제나 거절한다.
// 한계: 두레는 --permission-prompt-tool(MCP approve) 도 붙이지만 이 실측은 붙이지 않는다 — 'can_use_tool=X' 는 host 쪽 요청이
// 없었다는 뜻일 뿐이다. 판정은 '첫 줄을 말했나'(+ 허용 없는 대조군이 막혔나)로 한다. 두레의 진짜 승인 길은 Task 6 진짜 확인에서 본다.
// 환경: DURE_PROBE_KEY · DURE_PROBE_KNOWN_HOSTS · DURE_PROBE_WSL(배포판, 기본 Ubuntu) · PROBE27_SKIP_WSL=1 · PROBE27_ONLY_WSL=1
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const LINE = 'PROBE27-FIRST-LINE-7Q3'
const PROMPT = (p) => `첨부 폴더의 ${p} 파일을 Read 도구로 읽고 첫 줄만 그대로 말해. 다른 말 없이.`

function makePdf(text) {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'; const off = []
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return out
}
const PDF = makePdf(LINE)

const CLAUDE_ARGS = (extra) => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--replay-user-messages', '--permission-prompts', 'host', '--disallowedTools', 'SendMessage', 'ListAgents', '--model', 'haiku', ...extra]

/** child: claude 프로세스(로컬 또는 ssh). 한 차례 돌리고 {requests, answer, tools, result} */
function drive(child, prompt) {
  return new Promise((resolve) => {
    const r = { requests: [], answer: '', tools: [], results: [], result: null, err: '' }
    let buf = ''
    const timer = setTimeout(() => { r.result = r.result ?? 'timeout'; child.kill() }, 120000)
    const done = () => { try { child.stdin.end() } catch {} }
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { r.err += d })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1)
        let j; try { j = JSON.parse(l) } catch { continue }
        if (j.type === 'control_request' && j.request?.subtype === 'can_use_tool') {
          r.requests.push({ tool: j.request.tool_name, input: JSON.stringify(j.request.input).slice(0, 200) })
          child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: { behavior: 'deny', message: 'probe: 거절' } } }) + '\n')
        }
        if (j.type === 'assistant') for (const b of j.message?.content ?? []) {
          if (b.type === 'tool_use') r.tools.push(`${b.name} ${JSON.stringify(b.input).slice(0, 120)}`)
          if (b.type === 'text') r.answer += b.text
        }
        if (j.type === 'user') for (const b of j.message?.content ?? []) if (b.type === 'tool_result') r.results.push(String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).replace(/\s+/g, ' ').slice(0, 90))
        if (j.type === 'result') { r.result = j.subtype; done() }
      }
    })
    child.on('close', () => { clearTimeout(timer); resolve(r) })
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n')
  })
}
const show = (tag, r) => {
  const asked = r.requests.length > 0
  console.log(`${tag}: can_use_tool=${asked ? 'O ' + JSON.stringify(r.requests) : 'X'} · 첫줄말함=${r.answer.includes(LINE)} · result=${r.result} · tool_result=${JSON.stringify(r.results)}`)
  if (!r.answer.includes(LINE)) console.log(`   답: ${r.answer.slice(0, 160).replace(/\n/g, ' / ')}${r.err ? ' · stderr: ' + r.err.slice(0, 160) : ''}`)
  return asked
}

if (!process.env.PROBE27_ONLY_WSL) {
  // ---------- A1 + A3: 이 PC
  const root = join(os.tmpdir(), 'dure-probe27')
  rmSync(root, { recursive: true, force: true })
  const cwd = join(root, 'cwd'); const att = join(root, 'attachments')
  mkdirSync(cwd, { recursive: true }); mkdirSync(att, { recursive: true })
  writeFileSync(join(att, 'note.txt'), `${LINE}\n둘째 줄\n`)
  writeFileSync(join(att, 'doc.pdf'), PDF)
  const local = (extra, prompt) => drive(spawn('claude', CLAUDE_ARGS(extra), { cwd, shell: true }), prompt)

  console.log('=== A1 이 PC: --add-dir 없음/있음')
  for (const f of ['note.txt', 'doc.pdf']) {
    const p = join(att, f)
    show(`A1 ${f} --add-dir 없음`, await local([], PROMPT(p)))
    show(`A1 ${f} --add-dir 있음`, await local(['--add-dir', att], PROMPT(p)))
  }
  console.log('=== A3 이 PC: --allowedTools "Read(폴더/**)"')
  const fwd = att.replace(/\\/g, '/')
  for (const [name, rule, withDir] of [['슬래시', `Read(${fwd}/**)`, false], ['// 앞', `Read(/${fwd}/**)`, false], ['윈도 경로', `Read(${att}\\**)`, false], ['--add-dir+슬래시', `Read(${fwd}/**)`, true]]) {
    const extra = withDir ? ['--add-dir', att, '--allowedTools', rule] : ['--allowedTools', rule]
    for (const f of ['note.txt', 'doc.pdf']) show(`A3 ${name} ${f}`, await local(extra, PROMPT(join(att, f))))
  }
  rmSync(root, { recursive: true, force: true })
}

// ---------- A2: 서버(WSL) — ssh localhost
if (process.env.PROBE27_SKIP_WSL) process.exit(0)
const key = process.env.DURE_PROBE_KEY ?? join(os.homedir(), '.ssh', 'dure_wsl_test')
const known = process.env.DURE_PROBE_KNOWN_HOSTS ?? join(os.homedir(), '.ssh', 'dure_wsl_known_hosts')
const distro = process.env.DURE_PROBE_WSL ?? 'Ubuntu'
const hold = spawn('wsl.exe', ['-d', distro, '--', 'sleep', '600'], { stdio: 'ignore', windowsHide: true })
await new Promise((r) => setTimeout(r, 4000))
const FIND_CLAUDE = [
  'c=$(command -v claude)', '[ -x "$c" ] || c=',
  '[ -n "$c" ] || for x in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do [ -x "$x" ] && { c=$x; break; }; done',
  'if [ -z "$c" ]; then n="${NVM_DIR:-$HOME/.nvm}/nvm.sh"; [ -s "$n" ] && . "$n" >/dev/null 2>&1; c=$(command -v claude); [ -x "$c" ] || c=; fi',
  '[ -n "$c" ] || exit 127',
].join('; ')
const sshArgs = ['-i', key, '-o', `UserKnownHostsFile=${known}`, '-o', 'BatchMode=yes', 'localhost']
const b64 = (s) => Buffer.from(s).toString('base64')
// 스크립트는 base64 로 싸서 따옴표 문제를 피하고, stdin 은 claude 에게 남긴다
const remote = (script) => `bash -lc "$(echo ${b64(script)} | base64 -d)"`
const sh = (script) => new Promise((res) => {
  const c = spawn('ssh', [...sshArgs, remote(script)], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''; c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { out += d })
  c.on('close', (code) => res({ code, out })); c.stdin.end()
})
const dir = '$HOME/.dure/attachments/probe27'
try {
  const setup = await sh([`mkdir -p "${dir}"`, `printf '%s\\n둘째 줄\\n' '${LINE}' > "${dir}/note.txt"`, `echo ${b64(PDF)} | base64 -d > "${dir}/doc.pdf"`, `cd "${dir}" && pwd -P && ls`].join('; '))
  console.log('=== A2 서버 준비:', setup.code, setup.out.trim().replace(/\n/g, ' | '))
  const where = await sh(`${FIND_CLAUDE}; echo CLAUDE=$c; "$c" --version`)
  console.log('claude 위치:', where.out.trim().replace(/\n/g, ' | '))
  const sq = (a) => (a.includes('$HOME') ? `"${a}"` : `'${a.replace(/'/g, `'\\''`)}'`)
  const server = (extra, prompt) => {
    const script = `${FIND_CLAUDE}; d=$(mktemp -d); cd "$d" || exit 3; exec "$c" ${CLAUDE_ARGS(extra).map(sq).join(' ')}`
    return drive(spawn('ssh', [...sshArgs, remote(script)], { stdio: ['pipe', 'pipe', 'pipe'] }), prompt)
  }
  const sdir = (await sh(`cd "${dir}" && pwd -P`)).out.trim().split('\n').pop()
  for (const f of ['note.txt', 'doc.pdf']) {
    show(`A2 ${f} --add-dir 없음`, await server([], PROMPT(`${sdir}/${f}`)))
    show(`A2 ${f} --add-dir 있음`, await server(['--add-dir', dir], PROMPT(`${sdir}/${f}`)))
  }
  console.log('=== A3 서버: --allowedTools "Read(폴더/**)"')
  for (const f of ['note.txt', 'doc.pdf']) show(`A3 서버 ${f}`, await server(['--allowedTools', `Read(${sdir}/**)`], PROMPT(`${sdir}/${f}`)))
} finally {
  const clean = await sh(`rm -rf "$HOME/.dure/attachments/probe27"; echo cleaned`)
  console.log('정리:', clean.out.trim())
  hold.kill()
}
