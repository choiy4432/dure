// E2E — 제거 정리(`두레 --uninstall-cleanup`, build/installer.nsh 의 customUnInstall 이 부른다): 빌드된 main 을 그 인자로 띄우면
// 창·엔진 없이 phone.json 에 적어 둔 두레 serve 길만 끄고(사용자 길은 그대로) 0 으로 끝난다. 앱 데이터(설정·기기)는 그대로.
// 가짜 tailscale + 임시 user-data — 진짜 Tailscale·로그인 항목(개발 실행이라 안 부름)·%APPDATA%\Dure 는 건드리지 않는다.
// 진짜 제거 프로그램(NSIS)으로 지우는 것은 시험 빌드(dure-…)로 진짜 확인에서만.
// 실행: `npm run build` 다음 `npx playwright test e2e/uninstall.spec.ts`.
import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const FAKE_TAILSCALE = path.join(ROOT, 'test', 'fakeTailscale.mjs')
const DNS = 'fake-pc.tail0000.ts.net'
/** electron 꾸러미는 node 에서 부르면 실행 파일 경로를 준다 */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string

const OURS = { '/': { Proxy: 'http://127.0.0.1:47615' } }
/** 사용자가 직접 연 길(8443 → 127.0.0.1:3000) — 그대로 남아야 한다 */
const USER = {
  TCP: { '8443': { HTTPS: true } },
  Web: { [`${DNS}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
}

function tailscaleCalls(log: string): string[] {
  if (!fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv.join(' '))
}

test('제거 정리 — 창 없이 두레가 연 serve 길만 끄고 0 으로 끝남 · 앱 데이터는 그대로', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-e2e-uninstall-'))
  const userData = path.join(dir, 'userData')
  const tsRoot = path.join(dir, 'tailscale')
  const tsLog = path.join(dir, 'fake-tailscale.log')
  for (const d of [userData, tsRoot]) fs.mkdirSync(d, { recursive: true })
  const phoneFile = path.join(userData, 'phone.json')
  const settings = { enabled: true, keepAwake: true, openAtLogin: true, notify: { asks: true, finished: false }, port: 47615 }
  fs.writeFileSync(phoneFile, JSON.stringify({ settings, devices: [], serve: { httpsPort: 443, localPort: 47615, dnsName: DNS }, httpsPort: 443 }))
  fs.writeFileSync(
    path.join(tsRoot, 'serve.json'),
    JSON.stringify({ TCP: { ...USER.TCP, '443': { HTTPS: true } }, Web: { ...USER.Web, [`${DNS}:443`]: { Handlers: OURS } } }),
  )

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('FAKE_TAILSCALE_') || k.startsWith('DURE_')) continue
    env[k] = v
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  try {
    const child = spawn(ELECTRON, [MAIN, '--uninstall-cleanup'], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...env,
        DURE_USER_DATA: userData,
        DURE_TAILSCALE_COMMAND: process.execPath,
        DURE_TAILSCALE_ARGS: JSON.stringify([FAKE_TAILSCALE]),
        FAKE_TAILSCALE_STATE: 'ready',
        FAKE_TAILSCALE_ROOT: tsRoot,
        FAKE_TAILSCALE_LOG: tsLog,
        DURE_NO_DIALOG: '1',
      },
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => {
        child.kill()
        reject(new Error('제거 정리가 30초 안에 끝나지 않았어요'))
      }, 30_000)
      child.once('error', reject)
      child.once('exit', (c) => {
        clearTimeout(t)
        resolve(c)
      })
    })
    expect(code).toBe(0)

    // 두레 길만 껐다 — 사용자 길은 그대로
    expect(JSON.parse(fs.readFileSync(path.join(tsRoot, 'serve.json'), 'utf8'))).toEqual(USER)
    const calls = tailscaleCalls(tsLog)
    expect(calls).toContain('serve --https=443 off')
    expect(calls.some((c) => c.startsWith('serve --bg'))).toBe(false)
    expect(calls.some((c) => /\b(reset|funnel)\b/.test(c))).toBe(false)
    // 길 기록만 지웠다 — 설정(켜짐·자동 켜기)·포트 기억은 그대로(앱 데이터를 지우지 않는다)
    const after = JSON.parse(fs.readFileSync(phoneFile, 'utf8')) as { serve?: unknown; settings: unknown; httpsPort?: number }
    expect(after.serve).toBeUndefined()
    expect(after.settings).toEqual(settings)
    expect(after.httpsPort).toBe(443)
    // 보통 시작(앱 설정 쓰기·엔진·창)은 돌지 않았다
    expect(fs.existsSync(path.join(userData, 'settings.json'))).toBe(false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
