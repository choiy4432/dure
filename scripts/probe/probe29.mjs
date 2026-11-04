// probe29 — PDF 를 Claude 문서 블록으로(Task 7 Step 1): 두레처럼 띄운 `claude -p` stream-json 에 user content
// [{type:'document', source:{type:'base64', media_type:'application/pdf', data}}, {type:'text'}] 를 보내면 poppler(pdftoppm) 없이 PDF 를 읽나.
// P1  작은 PDF(첫 줄 표식) — 이 PC · 서버(WSL, ssh localhost). 답에 표식이 있나 · 오류 줄 · 도구 부름 · 승인 요청(can_use_tool)
// P2a 쪽수 많은 PDF(첫 쪽에 표식, PROBE29_PAGES) · P2b 큰 PDF(PROBE29_MB — 참조 없는 스트림으로 부풀려 쪽수는 1) — 이 PC 만. 받나 · 오류 글 · 시간
// P2c 누적 — 같은 세션에 PDF A 다음 차례에 PDF B(PROBE29_ACC_MB). B 차례에 A 가 아직 보이나(CLI 의 미디어 바이트 상한은 요청 전체에 걸린다)
// P3  되돌림(--replay-user-messages)의 user 줄 모양 — 문서 블록이 돌아오나, 글 블록만 이으면 보낸 글(sentText 꼴)과 같나. 두레 꼴(물음 + 문서 + 경로 줄)로 한 번 더.
// 결과(2026-11-04, claude 2.1.317, claude-haiku-5-5 · contextWindow 1000000): P1 이 PC·WSL 둘 다 표식을 말함(도구·승인 없음).
//   P2a 120쪽 받음(~1.55k 토큰/Letter 쪽) · 600쪽(작은 쪽) 받음(~1.1k 토큰/쪽 — 작은 쪽도 싸지 않다) · 601쪽 = API invalid_request →
//   CLI 가 문서를 빼고 "API Error: a document in the conversation could not be processed and was removed. …" 를 보이고 이어 감.
//   P2b base64 24,466,804 자(17.5MiB) 받음 · 25,864,904 자(18.5MiB) 부터 오류 없이 문서를 조용히 뺌(되돌림엔 그대로 있다) —
//   CLI 의 미디어 상한(요청 전체 문서·그림 base64 합 24MiB, 넘으면 오래된 것부터 14MiB 아래로 뺌). P2c 10MiB 둘 = B 차례엔 B 만 보임.
//   P3 되돌림 = 보낸 content 그대로(document 블록 type·source 만, data 같음) — 글 블록만 이은 것 == 보낸 글.
// Haiku 로 한 차례씩(사용자 허락). 승인 요청이 오면 언제나 거절한다. base64 는 찍지 않는다(길이만). 대화 기록(jsonl)은 열지 않고 크기만 잰다.
// 한계: 두레의 --mcp-config · --permission-prompt-tool · --append-system-prompt-file · -n 은 붙이지 않는다(문서 블록 받기와 상관없음).
//   만든 PDF 는 Helvetica 글 줄뿐(Letter 쪽) — 그림·스캔 PDF 의 쪽당 토큰은 다를 수 있다. P2b 는 크기 상한만 본다(쪽 1).
//   P2b 는 기본으로 --no-session-persistence(수십 MB 대화 기록을 남기지 않게 — PROBE29_PERSIST_BIG=1 이면 두레처럼 남김).
// WSL 은 이 스크립트가 깨우지 않는다 — 서버 단계 전에 따로 `wsl.exe -d Ubuntu -- sleep 3600` 을 띄워 두고 끝나면 끈다.
// 환경: DURE_PROBE_KEY · DURE_PROBE_KNOWN_HOSTS · PROBE29_SKIP_WSL=1 · PROBE29_ONLY_WSL=1 · PROBE29_CASES(쉼표: p1,p2a,p2b,p2c,p3 — 기본 전부)
//   PROBE29_PAGES(쉼표, 기본 120) · PROBE29_TINY=1(P2a 를 작은 쪽 216x72pt 로 — 쪽당 토큰은 거의 그대로, 600쪽이면 ~69만 토큰) · PROBE29_MB(쉼표, MiB, 기본 25) · PROBE29_ACC_MB(P2c, 기본 10) · PROBE29_NO_FOLLOW=1 · PROBE29_MODEL(기본 haiku) · PROBE29_TIMEOUT_MS(기본 큰 것 600000 · 작은 것 180000)
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const MARK = 'PROBE29-FIRST-LINE-K8R2'
const ASK = '이 PDF 의 첫 줄만 그대로 말해. 다른 말 없이.'
const MODEL = process.env.PROBE29_MODEL ?? 'haiku'
const CASES = new Set((process.env.PROBE29_CASES ?? 'p1,p2a,p2b,p2c,p3').split(',').map((s) => s.trim()))
const PAGES = (process.env.PROBE29_PAGES ?? '120').split(',').map(Number)
const MBS = (process.env.PROBE29_MB ?? '25').split(',').map(Number)
const BIG_MS = Number(process.env.PROBE29_TIMEOUT_MS ?? 600000)
const SMALL_MS = Number(process.env.PROBE29_TIMEOUT_MS ?? 180000)
const TINY = !!process.env.PROBE29_TINY
/** P2 에서 결과 뒤 같은 세션에 이어 보내는 글 — 막힌 PDF 가 세션에 남아 다음 차례도 막는지 */
const FOLLOW = process.env.PROBE29_NO_FOLLOW ? null : 'PDF 얘기는 빼고, 그냥 "네" 라고만 답해.'

/** 글 줄만 있는 PDF — 1쪽 첫 줄 표식, 나머지 쪽은 쪽 번호. padBytes 만큼 참조 없는 스트림을 덧붙여 크기만 키운다 */
function makePdf({ pages = 1, padBytes = 0, tiny = false, mark = MARK } = {}) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids = []
  // tiny = 작은 쪽(216x72pt) — 쪽 그림 토큰이 줄 줄 알았지만 실측 ~1.1k/쪽(Letter ~1.55k). 기본은 Letter(612x792pt)
  const [box, x, y, size] = tiny ? ['0 0 216 72', 8, 50, 10] : ['0 0 612 792', 72, 720, 14]
  for (let p = 1; p <= pages; p++) {
    const text = p === 1 ? `BT /F1 ${size} Tf ${x} ${y} Td (${mark}) Tj 0 -${size + 6} Td (second line of page one) Tj ET` : `BT /F1 ${size} Tf ${x} ${y} Td (page ${p} filler text) Tj ET`
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
    const content = objs.length
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
    kids.push(`${objs.length} 0 R`)
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`
  if (padBytes > 0) {
    const pad = randomBytes(Math.ceil(padBytes / 2)).toString('hex').slice(0, padBytes)
    objs.push(`<< /Length ${pad.length} >>\nstream\n${pad}\nendstream`)
  }
  const parts = ['%PDF-1.4\n']; let len = parts[0].length; const off = []
  objs.forEach((o, i) => { off.push(len); const s = `${i + 1} 0 obj\n${o}\nendobj\n`; parts.push(s); len += s.length })
  parts.push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''))
  parts.push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`)
  return Buffer.from(parts.join(''), 'latin1')
}
/** 목표 바이트에 맞춘 1쪽 PDF */
function pdfOfSize(bytes, mark = MARK) { const base = makePdf({ mark }).length + 60; return makePdf({ padBytes: Math.max(0, bytes - base), mark }) }

const doc = (buf) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } })
const textOf = (content) => content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
/** 두레 attachmentLines 와 같은 꼴 */
const pathLines = (paths) => `\n\n첨부 파일:\n${paths.map((p) => `- ${p}`).join('\n')}`

const CLAUDE_ARGS = (extra) => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--replay-user-messages', '--permission-prompts', 'host', '--disallowedTools', 'SendMessage', 'ListAgents', '--model', MODEL, ...extra]

const treeKill = (child) => {
  if (!child.pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else try { child.kill('SIGKILL') } catch {}
}
const clip = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)
/** user 줄 요약 — base64 는 길이와 보낸 것과 같은지만 */
function summarizeUser(j, sentB64, lineLen) {
  const c = j.message?.content
  const blocks = typeof c === 'string' ? [{ t: 'string', text: clip(c, 80) }] : (Array.isArray(c) ? c : []).map((b) => {
    if (b?.type === 'document' || b?.type === 'image') return { t: b.type, src: b.source?.type, mt: b.source?.media_type, len: b.source?.data?.length, same: sentB64 != null ? b.source?.data === sentB64 : undefined, keys: Object.keys(b) }
    if (b?.type === 'text') return { t: 'text', text: clip(b.text, 80) }
    if (b?.type === 'tool_result') return { t: 'tool_result', text: clip(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 80) }
    return { t: b?.type, keys: Object.keys(b ?? {}) }
  })
  const top = Object.keys(j).filter((k) => !['type', 'message', 'session_id', 'uuid', 'parent_tool_use_id'].includes(k))
  return { isReplay: j.isReplay === true, lineLen, top, blocks, text: Array.isArray(c) ? textOf(c) : c }
}

/** child: claude(이 PC 또는 ssh). content 를 한 줄로 보내고 result 까지. follow(글 또는 content)가 있으면 그 뒤 같은 세션에 하나 더 */
function drive(child, content, timeoutMs, follow = null) {
  return new Promise((resolve) => {
    const sentB64 = content.find((b) => b.type === 'document')?.source.data ?? null
    const r = { requests: [], answer: '', tools: [], results: [], users: [], systems: [], apiErr: [], raw: [], result: null, resultObj: null, err: '', model: null, t: {} }
    let turn = r
    const t0 = r.t0 = Date.now(); const at = (k) => { turn.t[k] ??= Date.now() - turn.t0 }
    const timer = setTimeout(() => { r.result = r.result ?? `timeout ${timeoutMs}ms`; treeKill(child) }, timeoutMs)
    const done = () => { try { child.stdin.end() } catch {} }
    child.stdin.on('error', (e) => { r.stdinErr = e.code ?? String(e) })
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { if (r.err.length < 4000) r.err += d })
    const onLine = (l) => {
      at('firstLine')
      let j; try { j = JSON.parse(l) } catch { if (l.trim()) r.raw.push(clip(l)); return }
      if (j.type === 'system') {
        if (j.subtype === 'init') r.model = j.model
        else if (!['status', 'thinking_tokens'].includes(j.subtype) && !String(j.subtype).startsWith('hook_')) r.systems.push(clip(JSON.stringify(j).replace(/"session_id":"[^"]*",?/, ''), 300))
      }
      if (j.type === 'control_request' && j.request?.subtype === 'can_use_tool') {
        r.requests.push({ tool: j.request.tool_name, input: clip(JSON.stringify(j.request.input), 160) })
        child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: { behavior: 'deny', message: 'probe: 거절' } } }) + '\n')
      }
      if (j.type === 'assistant') {
        if (j.error || j.isApiErrorMessage) turn.apiErr.push(clip(`${j.error ?? ''} ${JSON.stringify(j.message?.content)}`, 400))
        for (const b of j.message?.content ?? []) {
          if (b.type === 'tool_use') r.tools.push(`${b.name} ${clip(JSON.stringify(b.input), 120)}`)
          if (b.type === 'text') { at('firstText'); turn.answer += b.text }
        }
      }
      if (j.type === 'user') {
        if (j.isReplay === true) at('replay')
        r.users.push(summarizeUser(j, sentB64, l.length))
        for (const b of j.message?.content ?? []) if (b?.type === 'tool_result') r.results.push(clip(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 120))
      }
      if (j.type === 'result') {
        at('result'); turn.result = j.subtype
        const u = j.usage ?? {}
        const ctx = Object.entries(j.modelUsage ?? {}).map(([m, v]) => `${m}:${v?.contextWindow}`).join(',')
        turn.resultObj = { is_error: j.is_error, text: clip(j.result, 400), in: u.input_tokens, cacheW: u.cache_creation_input_tokens, cacheR: u.cache_read_input_tokens, out: u.output_tokens, api_ms: j.duration_api_ms, errors: j.errors, ctx }
        if (follow && turn === r) {
          turn = r.follow = { answer: '', apiErr: [], result: null, resultObj: null, t: {}, t0: Date.now() }
          child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: typeof follow === 'string' ? [{ type: 'text', text: follow }] : follow } }) + '\n')
        } else done()
      }
    }
    // 큰 줄(되돌림에 base64 가 다시 실려 온다)도 새 조각만 훑는다
    let pending = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      let s = 0, i
      while ((i = d.indexOf('\n', s)) >= 0) { pending.push(d.slice(s, i)); const l = pending.join(''); pending = []; s = i + 1; onLine(l) }
      if (s < d.length) pending.push(d.slice(s))
    })
    child.on('close', (code) => { clearTimeout(timer); if (pending.length) onLine(pending.join('')); r.code = code; r.t.close = Date.now() - t0; resolve(r) })
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
    r.lineBytes = Buffer.byteLength(line)
    child.stdin.write(line)
  })
}

const sec = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`)
function show(tag, r, sent) {
  const o = r.resultObj ?? {}
  console.log(`${tag}: 표식말함=${r.answer.includes(MARK)} · result=${r.result}${o.is_error ? '(is_error)' : ''} · 도구=${JSON.stringify(r.tools)} · can_use_tool=${r.requests.length ? 'O ' + JSON.stringify(r.requests) : 'X'}` +
    ` · model=${r.model} · ctx=${o.ctx} · in=${o.in}/cacheW=${o.cacheW}/cacheR=${o.cacheR}/out=${o.out} · 보낸줄=${r.lineBytes}B · 시간 첫줄=${sec(r.t.firstLine)} 되돌림=${sec(r.t.replay)} 첫글=${sec(r.t.firstText)} 끝=${sec(r.t.result)} close=${sec(r.t.close)} code=${r.code}`)
  console.log(`   답: ${clip(r.answer, 300)}`)
  if (o.text && o.text !== clip(r.answer, 400)) console.log(`   result 글: ${o.text}`)
  if (o.errors?.length) console.log(`   result errors: ${clip(JSON.stringify(o.errors), 400)}`)
  if (r.apiErr.length) console.log(`   API 오류 줄: ${JSON.stringify(r.apiErr)}`)
  if (r.systems.length) console.log(`   system 줄: ${JSON.stringify(r.systems)}`)
  if (r.results.length) console.log(`   tool_result: ${JSON.stringify(r.results)}`)
  if (r.raw.length) console.log(`   JSON 아닌 출력: ${JSON.stringify(r.raw.slice(0, 5))}`)
  if (r.err.trim()) console.log(`   stderr: ${clip(r.err, 400)}`)
  if (r.stdinErr) console.log(`   stdin 오류: ${r.stdinErr}`)
  if (sent != null) for (const u of r.users) {
    const { text, ...rest } = u
    console.log(`   user 줄: ${JSON.stringify(rest)} · 글만이음==보낸글: ${text === sent}`)
  }
  if (r.follow) {
    const f = r.follow; const fo = f.resultObj ?? {}
    console.log(`   이어 보낸 글: result=${f.result}${fo.is_error ? '(is_error)' : ''} · in=${fo.in}/cacheW=${fo.cacheW}/cacheR=${fo.cacheR}/out=${fo.out} · 끝=${sec(f.t.result)} · 답: ${clip(f.answer, 200)}`)
    if (fo.text && fo.text !== clip(f.answer, 400)) console.log(`   이어 보낸 글 result 글: ${fo.text}`)
    if (f.apiErr.length) console.log(`   이어 보낸 글 API 오류 줄: ${JSON.stringify(f.apiErr)}`)
  }
  if (r.transcript !== undefined) console.log(`   대화 기록(jsonl) 크기: ${r.transcript ?? '없음'}`)
}

/** ~/.claude/projects/<폴더>/<id>.jsonl 의 크기만(열지 않는다) */
function transcriptSize(id) {
  const root = join(os.homedir(), '.claude', 'projects')
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      const f = join(root, d.name, `${id}.jsonl`)
      if (d.isDirectory() && existsSync(f)) return `${statSync(f).size}B`
    }
  } catch {}
  return null
}

const tmp = mkdtempSync(join(os.tmpdir(), 'dure-probe29-'))
const cwd = join(tmp, 'cwd'); mkdirSync(cwd)
const save = (name, buf) => { const p = join(tmp, name); writeFileSync(p, buf); return p }
const local = async (content, { timeoutMs = SMALL_MS, persist = true, follow = null } = {}) => {
  const id = randomUUID()
  const extra = persist ? ['--session-id', id] : ['--no-session-persistence']
  const r = await drive(spawn('claude', CLAUDE_ARGS(extra), { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), content, timeoutMs, follow)
  if (persist) r.transcript = transcriptSize(id)
  return r
}
const small = makePdf()

try {
  if (!process.env.PROBE29_ONLY_WSL) {
    if (CASES.has('p1')) {
      save('small.pdf', small)
      console.log(`=== P1 이 PC: 작은 PDF ${small.length}B (b64 ${doc(small).source.data.length})`)
      const content = [doc(small), { type: 'text', text: ASK }]
      show('P1 이 PC', await local(content), textOf(content))
    }
    if (CASES.has('p2a')) for (const n of PAGES) {
      const pdf = makePdf({ pages: n, tiny: TINY }); save(`pages-${n}.pdf`, pdf)
      console.log(`=== P2a 이 PC: ${n}쪽${TINY ? '(작은 쪽)' : ''} PDF ${pdf.length}B (b64 ${doc(pdf).source.data.length})`)
      show(`P2a ${n}쪽${TINY ? '(작은 쪽)' : ''}`, await local([doc(pdf), { type: 'text', text: ASK }], { timeoutMs: BIG_MS, follow: FOLLOW }), null)
    }
    if (CASES.has('p2b')) for (const mb of MBS) {
      const pdf = pdfOfSize(Math.round(mb * 1024 * 1024)); save(`size-${mb}mb.pdf`, pdf)
      console.log(`=== P2b 이 PC: ${mb}MiB PDF ${pdf.length}B (b64 ${doc(pdf).source.data.length})`)
      const r = await local([doc(pdf), { type: 'text', text: ASK }], { timeoutMs: BIG_MS, persist: !!process.env.PROBE29_PERSIST_BIG, follow: FOLLOW })
      show(`P2b ${mb}MiB`, r, null)
      for (const u of r.users) console.log(`   user 줄: isReplay=${u.isReplay} 길이=${u.lineLen} 블록=${JSON.stringify(u.blocks.map((b) => [b.t, b.len, b.same]))}`)
    }
    if (CASES.has('p2c')) {
      // 누적 — 문서 바이트 상한은 한 메시지가 아니라 요청 전체(지난 차례의 문서·그림 포함)에 걸린다. A 뒤에 B 를 보내면 무엇이 남나
      const mb = Number(process.env.PROBE29_ACC_MB ?? 10)
      const a = pdfOfSize(Math.round(mb * 1024 * 1024), `${MARK}-A`); const b = pdfOfSize(Math.round(mb * 1024 * 1024), `${MARK}-B`)
      console.log(`=== P2c 이 PC: 누적 — ${mb}MiB PDF A (b64 ${doc(a).source.data.length}) 다음 차례에 B (같은 크기)`)
      const r = await local([doc(a), { type: 'text', text: ASK }], { timeoutMs: BIG_MS, persist: !!process.env.PROBE29_PERSIST_BIG,
        follow: [doc(b), { type: 'text', text: '지금 대화에 보이는 PDF 마다 첫 줄을 그대로 말해. 보이는 것만, 다른 말 없이.' }] })
      show('P2c 누적 A', r, null)
      console.log(`   B 차례: A보임=${r.follow?.answer.includes(`${MARK}-A`)} · B보임=${r.follow?.answer.includes(`${MARK}-B`)}`)
    }
    if (CASES.has('p3')) {
      const p = save('dure-shape.pdf', small)
      const content = [{ type: 'text', text: '첨부한 PDF 의 첫 줄만 그대로 말해. 다른 말 없이.' }, doc(small), { type: 'text', text: pathLines([p]) }]
      console.log('=== P3 이 PC: 두레 꼴(물음 · 문서 · 경로 줄)')
      show('P3 두레 꼴', await local(content), textOf(content))
    }
  }

  if (!process.env.PROBE29_SKIP_WSL && CASES.has('p1')) {
    // ---------- 서버(WSL) — ssh localhost. probe27 과 같은 부르기
    const key = process.env.DURE_PROBE_KEY ?? join(os.homedir(), '.ssh', 'dure_wsl_test')
    const known = process.env.DURE_PROBE_KNOWN_HOSTS ?? join(os.homedir(), '.ssh', 'dure_wsl_known_hosts')
    const FIND_CLAUDE = [
      'c=$(command -v claude)', '[ -x "$c" ] || c=',
      '[ -n "$c" ] || for x in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do [ -x "$x" ] && { c=$x; break; }; done',
      'if [ -z "$c" ]; then n="${NVM_DIR:-$HOME/.nvm}/nvm.sh"; [ -s "$n" ] && . "$n" >/dev/null 2>&1; c=$(command -v claude); [ -x "$c" ] || c=; fi',
      '[ -n "$c" ] || exit 127',
    ].join('; ')
    const sshArgs = ['-i', key, '-o', `UserKnownHostsFile=${known}`, '-o', 'BatchMode=yes', 'localhost']
    const b64 = (s) => Buffer.from(s).toString('base64')
    const remote = (script) => `bash -lc "$(echo ${b64(script)} | base64 -d)"`
    const sq = (a) => `'${a.replace(/'/g, `'\\''`)}'`
    const where = await new Promise((res) => {
      const c = spawn('ssh', [...sshArgs, remote(`${FIND_CLAUDE}; "$c" --version`)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let out = ''; c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { out += d })
      c.on('close', (code) => res(`${code} ${out.trim()}`)); c.stdin.end()
    })
    console.log(`=== P1 서버(WSL): claude ${where}`)
    const script = `${FIND_CLAUDE}; d=$(mktemp -d); cd "$d" || exit 3; "$c" ${CLAUDE_ARGS([]).map(sq).join(' ')}; rc=$?; cd /; rm -rf "$d"; exit $rc`
    const content = [doc(small), { type: 'text', text: ASK }]
    show('P1 서버', await drive(spawn('ssh', [...sshArgs, remote(script)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }), content, SMALL_MS), textOf(content))
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
  console.log(`정리: 임시 폴더 지움=${!existsSync(tmp)}`)
}
