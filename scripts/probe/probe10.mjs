// Probe: 실행 중인 headless claude 의 권한 모드를 바꿀 수 있나(set_permission_mode), 띄울 때 플래그가 필요한가.
// 로컬 명령 '/effort high' 로 차례를 돌려 system/init 의 permissionMode 를 읽는다 — 모델 토큰 없음.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const work = join(os.tmpdir(), 'dure-probe10'); mkdirSync(work, { recursive: true })
async function run(label, extra) {
  console.log(`\n=== ${label}: claude ${extra.join(' ')}`)
  const p = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--disallowedTools', 'SendMessage', 'ListAgents', ...extra], { cwd: work, shell: true })
  const waiting = new Map(); let n = 0; let buf = ''; let onResult = null
  p.stdout.setEncoding('utf8')
  p.stderr.on('data', (d) => process.stdout.write('  stderr: ' + String(d).slice(0, 200)))
  p.stdout.on('data', (d) => {
    buf += d; let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue
      let j; try { j = JSON.parse(l) } catch { continue }
      if (j.type === 'control_response') { const w = waiting.get(j.response.request_id); if (w) { waiting.delete(j.response.request_id); w(j.response) } continue }
      if (j.type === 'system' && j.subtype === 'init') console.log('  init permissionMode =', j.permissionMode)
      else if (j.type === 'result') onResult?.()
    }
  })
  const ask = (request) => new Promise((r) => { const id = `p10-${++n}`; waiting.set(id, r); p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n'); setTimeout(() => r({ subtype: 'timeout' }), 20000) })
  const say = (text) => new Promise((r) => { onResult = r; p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'); setTimeout(r, 30000) })
  const g = await ask({ subtype: 'get_settings' })
  console.log('  get_settings effective.permissions.defaultMode =', JSON.stringify(g.response?.effective?.permissions?.defaultMode ?? null))
  await say('/effort high')
  for (const mode of ['bypassPermissions', 'default', 'manual']) {
    const r = await ask({ subtype: 'set_permission_mode', mode })
    console.log(`  set_permission_mode ${mode} →`, JSON.stringify(r).slice(0, 220))
    await say('/effort high')
  }
  p.stdin.end(); await new Promise((r) => p.on('close', r))
}
await run('A 플래그 없이', [])
await run('B --allow-dangerously-skip-permissions', ['--allow-dangerously-skip-permissions'])
await run('C --permission-mode bypassPermissions', ['--permission-mode', 'bypassPermissions'])
