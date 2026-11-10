import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeEnv } from '../src/engine/claudeEnv'
import { authStatus, claudeVersion } from '../src/engine/claudeSetup'
import { createEngine } from '../src/engine/engine'
import { updateClaude } from '../src/main/claudeUpdate'

const FAKE = path.resolve('test/fakeClaude.mjs')
let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-env-'))
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-key')
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'tok-test')
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'cfg'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

type Row = Record<string, string>
const readRows = (file: string): Row[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Row) : []
function expectClean(rows: Row[]): void {
  for (const r of rows) {
    expect(r.ANTHROPIC_API_KEY).toBeUndefined()
    expect(r.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(r.PATH ?? r.Path).toBeTruthy()
    expect(r.CLAUDE_CONFIG_DIR).toBe(path.join(dir, 'cfg'))
  }
}

test('claudeEnv: 두 변수만 빼고 나머지는 그대로', () => {
  const out = claudeEnv({ ANTHROPIC_API_KEY: 'a', anthropic_auth_token: 'b', PATH: 'p', HOME: 'h', USERPROFILE: 'u', CLAUDE_CONFIG_DIR: 'c' })
  expect(out).toEqual({ PATH: 'p', HOME: 'h', USERPROFILE: 'u', CLAUDE_CONFIG_DIR: 'c' })
})

async function runEngine(withAgent: boolean): Promise<Row[]> {
  const tag = withAgent ? 'agent' : 'probe'
  const envLog = path.join(dir, `env-${tag}.jsonl`)
  const e = await createEngine({
    dataDir: path.join(dir, `data-${tag}`),
    claude: { command: process.execPath, argsPrefix: [FAKE] },
    // 엔진 옵션 env 에 API 키가 들어 있어도 걸러져야 한다
    env: { FAKE_CLAUDE_LOG: path.join(dir, 'argv.log'), FAKE_ENV_LOG: envLog, ANTHROPIC_API_KEY: 'sk-from-opts' },
    usage: withAgent ? false : { startDelayMs: 0 },
  })
  try {
    if (withAgent) {
      const room = e.addRoom('방')
      const folder = path.join(dir, 'a')
      fs.mkdirSync(folder)
      const a = e.addAgent({ roomId: room.id, name: 'A', role: '기획', folder })
      await e.sendUser(a.id, [{ type: 'text', text: '안녕' }])
    }
    for (let i = 0; i < 100 && readRows(envLog).length < 1; i++) await new Promise((r) => setTimeout(r, 100))
  } finally {
    await e.shutdown()
  }
  return readRows(envLog)
}

test('spawnEnvDropsApiKeys: 에이전트 claude 에 안 넘어간다', async () => {
  const rows = await runEngine(true)
  expect(rows.length).toBeGreaterThanOrEqual(1)
  expectClean(rows)
}, 30_000)

test('spawnEnvDropsApiKeys: 사용량 전용 claude 에도 안 넘어간다', async () => {
  const rows = await runEngine(false)
  expect(rows.length).toBeGreaterThanOrEqual(1)
  expectClean(rows)
}, 30_000)

test('spawnEnvDropsApiKeys: 준비(로그인 확인·버전)와 claude update 도 걸러서 띄운다', async () => {
  const envLog = path.join(dir, 'setup-env.jsonl')
  vi.stubEnv('FAKE_ENV_LOG', envLog)
  const c = { command: process.execPath, argsPrefix: [FAKE] }
  expect((await authStatus(c)).loggedIn).toBe(true)
  await claudeVersion(c)
  await updateClaude(c, { timeoutMs: 15000 }).done
  const rows = readRows(envLog)
  expect(rows.length).toBe(3)
  expectClean(rows)
})
