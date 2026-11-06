// E2E — 휴대폰으로 쓰기: PC 설정의 휴대폰 창에서 켜기 → 짝 맺기 숫자 → 휴대폰 크기 페이지(http://127.0.0.1:<포트>, DURE_PHONE_ALLOW_LOCAL)로
// 숫자 넣기 → 방 고르기 → 판 → 카드 → 대화 → 보내기(가짜 claude 로그) → 승인 허용(PC 의 요청도 풀림) → PC 에서 끊기(휴대폰은 4401 → 짝 맺기 화면)
// → 창 닫기(트레이로 숨고 연결은 그대로) → 트레이 메뉴 '휴대폰 연결 끄기'(가짜 tailscale 로그에 serve off). 짝 안 맺은 요청은 401/403.
// 가짜 claude + 가짜 tailscale(ready) + 임시 user-data·HOME·CLAUDE_CONFIG_DIR — 진짜 Tailscale·로그인 항목(개발 실행이라 안 부름)·절전 막기(켜기 전에 끈다,
// 그래도 불리면 기록만 하는 가짜)·웹 푸시(알림을 켜지 않는다)·트레이 첫 안내(이미 본 것으로)는 건드리지 않는다.
// 휴대폰 브라우저: CHROMIUM_PATH → Playwright 크로미움 → Edge 순(내려받지 않는다).
// 실행: `npm run build` 다음 `npx playwright test e2e/phone.spec.ts`.
import { test, expect, chromium, _electron as electron, type Browser, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import NodeWebSocket from 'ws'
import type { PhoneState } from '../src/shared/phoneTypes'
import { phoneCookieName } from '../src/shared/phoneWire'
import { markOnboarded } from './onboarded'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fakeClaude.mjs')
const FAKE_TAILSCALE = path.join(ROOT, 'test', 'fakeTailscale.mjs')
const DNS = 'fake-pc.tail0000.ts.net' // 가짜 tailscale 의 이 기기 이름
const RENAMED = 'renamed-pc.tail0000.ts.net' // 켠 채 Tailscale 에서 바꾼 이름(가짜의 <root>/dns-name)

const ROOM = '휴대폰 방'
const AGENT = { name: '바깥일꾼', role: '밖에서 보기' }
const PHONE_TEXT = '휴대폰에서 보내요'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const TRAY_MENU = ['두레 열기', '휴대폰 연결 끄기', '두레 끄기']

/** 휴대폰 페이지 브라우저 — 내려받지 않는다. 있는 것 중 첫째 */
function phoneBrowserPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  try {
    if (fs.existsSync(chromium.executablePath())) return undefined // Playwright 크로미움
  } catch {
    // 깔려 있지 않음
  }
  const edges = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  const edge = edges.find((p) => fs.existsSync(p))
  if (!edge) throw new Error('휴대폰 페이지를 띄울 크로미움이 없어요 — CHROMIUM_PATH 로 알려 주세요')
  return edge
}

const node = (page: Page, name: string): Locator =>
  page.locator('.react-flow__node').filter({ has: page.locator('.nn b', { hasText: new RegExp(`^${name}$`) }) })

async function addAgent(page: Page, a: { name: string; role: string }, folder: string): Promise<void> {
  await page.getByRole('main', { name: '관계도' }).getByRole('button', { name: '추가', exact: true }).click()
  const dlg = page.getByRole('dialog', { name: '에이전트 추가' })
  await dlg.getByRole('button', { name: '폴더 고르기' }).click()
  await expect(dlg.getByText(folder, { exact: true })).toBeVisible()
  await dlg.getByLabel('이름').fill(a.name)
  await dlg.getByLabel('역할').fill(a.role)
  await dlg.getByRole('button', { name: '추가', exact: true }).click()
  await expect(dlg).toBeHidden()
  await expect(node(page, a.name)).toBeVisible()
}

/** 가짜 claude 가 받은 사용자 줄의 글 조각들 */
function sentTexts(log: string): string[] {
  if (!fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8').split(/\r?\n/).flatMap((l) => {
    try {
      const m = JSON.parse(l) as { type?: string; message?: { content?: unknown } }
      if (m.type !== 'user') return []
      const c = m.message?.content
      if (typeof c === 'string') return [c]
      return Array.isArray(c) ? c.flatMap((p: { type?: string; text?: string }) => (p?.type === 'text' && typeof p.text === 'string' ? [p.text] : [])) : []
    } catch {
      return []
    }
  })
}

/** 가짜 tailscale 이 받은 명령들 */
function tailscaleCalls(log: string): string[] {
  if (!fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8').split(/\r?\n/).flatMap((l) => {
    try {
      return [(JSON.parse(l) as { argv: string[] }).argv.join(' ')]
    } catch {
      return []
    }
  })
}

/** 휴대폰 서버에 날것 HTTP — 답 코드만(Host·Origin·쿠키를 마음대로 — 브라우저는 Host 를 못 바꾼다) */
function httpStatus(port: number, o: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? 'GET', headers: o.headers, agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(o.body)
  })
}

/** WebSocket 열기 — 열리면 그 소켓, 거절되면 답 코드 */
function wsOpen(port: number, headers: Record<string, string>): Promise<NodeWebSocket | number> {
  return new Promise((resolve, reject) => {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers })
    ws.once('open', () => resolve(ws))
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
      ws.terminate()
    })
    ws.on('error', (e) => reject(e)) // 거절 뒤 terminate 가 내는 오류도 받는다(이미 풀린 약속이라 그냥 지나간다)
  })
}

/** 열린 소켓으로 메서드 하나 부르기 — 답(result)만 */
function wsCall(ws: NodeWebSocket, method: string, args: unknown[] = []): Promise<{ ok: boolean; error?: string }> {
  const id = Math.floor(Math.random() * 1e9)
  return new Promise((resolve) => {
    const on = (raw: NodeWebSocket.RawData) => {
      const m = JSON.parse(String(raw)) as { t: string; id?: number; ok: boolean; error?: string }
      if (m.t !== 'result' || m.id !== id) return
      ws.off('message', on)
      resolve(m)
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ t: 'call', id, method, args }))
  })
}

const phoneStateOf = (page: Page): Promise<PhoneState> =>
  page.evaluate(() => (window as unknown as { dure: { phoneState(): Promise<PhoneState> } }).dure.phoneState())

test('휴대폰으로 쓰기 — 켜기 · 짝 맺기 · 방·판·대화 · 보내기 · 승인 · 끊기 · 트레이 · 끄기', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-e2e-phone-'))
  const userData = path.join(dir, 'userData')
  const fakeHome = path.join(dir, 'home')
  const claudeDir = path.join(dir, 'claude-config')
  const folder = path.join(dir, 'work')
  const claudeLog = path.join(dir, 'fake-claude.log')
  const tsRoot = path.join(dir, 'tailscale')
  const tsLog = path.join(dir, 'fake-tailscale.log')
  for (const d of [fakeHome, claudeDir, folder, tsRoot]) fs.mkdirSync(d, { recursive: true })
  markOnboarded(userData) // 안내 투어·승인 한 번은 이 시험의 일이 아니다
  // 트레이 첫 안내(진짜 Windows 알림)는 이 PC 에 띄우지 않는다 — 이미 본 것으로
  const settingsFile = path.join(userData, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')), trayTipSeen: true }, null, 2))

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('FAKE_TAILSCALE_') || k.startsWith('DURE_TAILSCALE_')) continue
    env[k] = v
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: {
      ...env,
      DURE_CLAUDE_COMMAND: process.execPath,
      DURE_CLAUDE_ARGS: JSON.stringify([FAKE_CLAUDE]),
      FAKE_CLAUDE_LOG: claudeLog,
      DURE_TAILSCALE_COMMAND: process.execPath,
      DURE_TAILSCALE_ARGS: JSON.stringify([FAKE_TAILSCALE]),
      FAKE_TAILSCALE_STATE: 'ready',
      FAKE_TAILSCALE_ROOT: tsRoot,
      FAKE_TAILSCALE_LOG: tsLog,
      DURE_PHONE_ALLOW_LOCAL: '1',
      USERPROFILE: fakeHome,
      HOME: fakeHome,
      CLAUDE_CONFIG_DIR: claudeDir,
      FAKE_TRANSCRIPTS: '1',
      DURE_USER_DATA: userData,
      DURE_E2E_FOLDERS: JSON.stringify([folder]),
      DURE_NO_DIALOG: '1',
    },
  })
  let browser: Browser | null = null
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.waitForLoadState('domcontentloaded')

    // 🔴 로그인 항목은 설치본만 — 이 실행은 개발 실행이라 '처음 켤 때 자동 켜기'가 켬으로 가도 Windows 를 건드리지 않는다
    expect(await app.evaluate(({ app: a }) => a.isPackaged)).toBe(false)
    // 절전 막기는 아래에서 끄고 켠다 — 그래도 불리면 이 PC 를 깨워 두지 않게 기록만 하는 가짜로. 트레이 메뉴는 누를 수 있게 모양을 받아 둔다
    const guarded = await app.evaluate(({ powerSaveBlocker, Menu }) => {
      type Item = { label?: string; click?: () => void }
      const g = globalThis as unknown as { __e2e: { power: number; tray: Item[] | null } }
      g.__e2e = { power: 0, tray: null }
      const start = () => {
        g.__e2e.power++
        return -1
      }
      powerSaveBlocker.start = start
      powerSaveBlocker.stop = () => true
      const build = Menu.buildFromTemplate.bind(Menu)
      Menu.buildFromTemplate = (t: Parameters<typeof Menu.buildFromTemplate>[0]) => {
        const items = t as Item[]
        if (items.some((i) => i.label === '휴대폰 연결 끄기')) g.__e2e.tray = items
        return build(t)
      }
      return powerSaveBlocker.start === start
    })
    expect(guarded).toBe(true)

    await test.step('PC — 방 · 에이전트', async () => {
      await page.getByRole('button', { name: '방 만들기' }).click()
      const dlg = page.getByRole('dialog', { name: '새 방' })
      await dlg.getByLabel('이름').fill(ROOM)
      await dlg.getByRole('button', { name: '만들기', exact: true }).click()
      await expect(dlg).toBeHidden()
      await addAgent(page, AGENT, folder)
    })

    const dlg = page.getByRole('dialog', { name: '휴대폰', exact: true })
    const master = dlg.getByRole('switch', { name: /^휴대폰으로 쓰기/ })
    let port = 0
    await test.step('PC 설정 → 휴대폰 → 절전 막기 끄기 → 휴대폰으로 쓰기 켜기 → 주소 열림', async () => {
      await page.getByRole('button', { name: '설정', exact: true }).click()
      await page.getByRole('dialog', { name: '설정' }).getByRole('button', { name: '휴대폰 열기' }).click()
      await expect(dlg).toBeVisible()
      await expect(master).toHaveAttribute('aria-checked', 'false')
      // 처음 열면 Tailscale 을 한 번 본다(가짜 ready)
      await expect(dlg.getByText('로그인돼 있어요')).toBeVisible()

      const keepAwake = dlg.getByRole('switch', { name: '켜 둔 동안 PC 절전 막기' })
      await expect(keepAwake).toHaveAttribute('aria-checked', 'true') // 기본 켬
      await keepAwake.click()
      await expect(keepAwake).toHaveAttribute('aria-checked', 'false')
      await expect(keepAwake).not.toHaveAttribute('aria-busy', 'true')
      expect((await phoneStateOf(page)).settings.keepAwake).toBe(false)

      await master.click()
      await expect(master).toHaveAttribute('aria-checked', 'true')
      await expect(master).toHaveAccessibleName('휴대폰으로 쓰기 — 켜짐')
      await expect(dlg.getByText('휴대폰 주소가 열렸어요')).toBeVisible({ timeout: 30_000 })
      await expect(dlg.locator('.phn-url-t')).toHaveText(`https://${DNS}/mobile.html`)
      // 처음 켤 때 자동 켜기도 켬으로(개발 실행이라 로그인 항목은 그대로)
      await expect(dlg.getByRole('switch', { name: 'Windows 를 켜면 두레도 켜기' })).toHaveAttribute('aria-checked', 'true')
      await expect(page.locator('button.phn-top')).toHaveText('휴대폰 · 0')

      // 휴대폰 서버 포트 — 두레가 연 길 기록(phone.json 의 serve)과 설정의 포트가 같다
      const st = await phoneStateOf(page)
      const rec = (JSON.parse(fs.readFileSync(path.join(userData, 'phone.json'), 'utf8')) as { serve?: { httpsPort: number; localPort: number } }).serve
      expect(rec?.httpsPort).toBe(443) // 가짜 tailscale 의 443 이 비어 있다 — 주소에 포트 없음
      expect(rec?.localPort).toBe(st.settings.port)
      port = rec!.localPort
      expect(tailscaleCalls(tsLog)).toContain(`serve --bg --https=443 http://127.0.0.1:${port}`)
      expect(tailscaleCalls(tsLog).some((c) => /\b(reset|funnel)\b/.test(c))).toBe(false)
    })

    await test.step('짝 안 맺은 요청 — 401/403, 아무 메서드도 못 부름', async () => {
      const local = `127.0.0.1:${port}`
      const origin = `http://${local}`
      // 틀린 Host — 정적 파일도 안 준다(DNS 재바인딩 · PC 의 다른 웹 페이지)
      expect(await httpStatus(port, { path: '/mobile.html', headers: { host: 'evil.example' } })).toBe(403)
      expect(await httpStatus(port, { path: '/mobile.html', headers: { host: `localhost:${port}` } })).toBe(403)
      expect(await httpStatus(port, { path: '/mobile.html', headers: { host: local } })).toBe(200)
      // 토큰 없음 — 짝 여부·알림 열쇠·올리기 모두 401(tailnet 주소로 와도)
      expect(await httpStatus(port, { path: '/api/me', headers: { host: local } })).toBe(401)
      expect(await httpStatus(port, { path: '/api/me', headers: { host: DNS } })).toBe(401)
      expect(await httpStatus(port, { path: '/api/vapid', headers: { host: local } })).toBe(401)
      expect(await httpStatus(port, { path: '/api/upload?name=a.txt', method: 'POST', headers: { host: local, origin }, body: 'x' })).toBe(401)
      // 틀린 Origin — 짝 맺기도 못 한다
      expect(
        await httpStatus(port, {
          path: '/api/pair',
          method: 'POST',
          headers: { host: local, origin: 'http://evil.example', 'content-type': 'application/json' },
          body: JSON.stringify({ secret: '000000', name: 'x' }),
        }),
      ).toBe(403)
      // WebSocket — 토큰 없음 401 · 틀린 Origin 403 · 틀린 Host 403 · 틀린 쿠키 401
      expect(await wsOpen(port, { host: local, origin })).toBe(401)
      expect(await wsOpen(port, { host: local, origin: 'http://evil.example' })).toBe(403)
      expect(await wsOpen(port, { host: 'evil.example', origin: 'http://evil.example' })).toBe(403)
      expect(await wsOpen(port, { host: local, origin, cookie: `${phoneCookieName(port)}=not-a-token` })).toBe(401)
    })

    browser = await chromium.launch({ executablePath: phoneBrowserPath(), headless: true })
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: ANDROID_UA,
      locale: 'ko-KR',
      reducedMotion: 'reduce',
    })
    // 소켓이 닫힌 까닭(닫기 코드) — 끊기면 화면을 다시 읽으니 sessionStorage 에 남긴다
    await ctx.addInitScript(() => {
      const Base = window.WebSocket
      class Watched extends Base {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          this.addEventListener('close', (e) => {
            const k = '__e2eWsClose'
            const codes = JSON.parse(sessionStorage.getItem(k) ?? '[]') as number[]
            codes.push(e.code)
            sessionStorage.setItem(k, JSON.stringify(codes))
          })
        }
      }
      window.WebSocket = Watched
    })
    const phone = await ctx.newPage()
    const phoneErrors: string[] = []
    phone.on('pageerror', (e) => phoneErrors.push(String(e)))
    const mobileUrl = `http://127.0.0.1:${port}/mobile.html`
    const closeCodes = () => phone.evaluate(() => JSON.parse(sessionStorage.getItem('__e2eWsClose') ?? '[]') as number[])
    const meStatus = () => phone.evaluate(() => fetch('/api/me', { cache: 'no-store' }).then((r) => r.status))

    let deviceName = ''
    await test.step('PC 짝 맺기 숫자 → 휴대폰에 넣기 → 짝 맺음', async () => {
      await phone.goto(mobileUrl)
      const pinBox = phone.getByRole('textbox', { name: '숫자 6자리' })
      await expect(pinBox).toBeVisible()
      await expect(phone.getByRole('heading', { level: 1 })).toHaveText(/숫자 6자리를 넣어 주세요/)
      expect(await meStatus()).toBe(401) // 짝 맺기 전 페이지는 아무것도 못 부른다

      await dlg.getByRole('button', { name: '휴대폰 짝 맺기' }).click()
      const pairDlg = page.getByRole('dialog', { name: '휴대폰 짝 맺기' })
      const pinEl = pairDlg.locator('.phn-pin')
      await expect(pinEl).toHaveText(/^\d{3} \d{3}$/)
      const pin = (await pinEl.innerText()).replace(/\D/g, '')
      expect(pin).toHaveLength(6)

      await pinBox.fill(pin) // 6자리가 차면 바로 보낸다
      // 알림을 받을 수 있는 브라우저면 알림을 물어본다 — 켜지 않는다(웹 푸시를 보내지 않게)
      const later = phone.getByRole('button', { name: '나중에' })
      const rooms = phone.getByRole('region', { name: /^방/ })
      await expect(later.or(rooms)).toBeVisible({ timeout: 20_000 })
      if (await later.isVisible()) {
        await expect(phone.getByRole('heading', { name: '짝을 맺었어요' })).toBeVisible()
        await later.click()
      }
      await expect(rooms).toBeVisible()
      await expect(pairDlg.getByText('짝을 맺었어요')).toBeVisible()
      const st = await phoneStateOf(page)
      expect(st.devices).toHaveLength(1)
      deviceName = st.devices[0].name
      expect(st.pairing).toBeNull() // 숫자는 한 번만
      await pairDlg.getByRole('button', { name: '닫기', exact: true }).click()
      await expect(pairDlg).toBeHidden()
      // 쿠키는 HttpOnly — 휴대폰 화면의 JS 는 토큰을 못 본다
      expect(await phone.evaluate(() => document.cookie)).toBe('')
      expect(await meStatus()).toBe(200)
    })

    await test.step('PC 에 접속 표시 — 위 띠 휴대폰 · 1 · 기기 목록 지금 접속 중', async () => {
      await expect(page.locator('button.phn-top')).toHaveText('휴대폰 · 1')
      await expect(dlg.locator('.phn-dev', { hasText: deviceName })).toContainText('지금 접속 중')
    })

    await test.step('휴대폰 — 방 고르기 → 판 → 카드 → 대화 → 보내기 → 가짜 claude 가 받음', async () => {
      await expect(phone.locator('.m-pc')).toContainText('연결됨')
      await phone.getByRole('region', { name: /^방/ }).getByRole('button', { name: new RegExp(ROOM) }).click()
      await expect(phone.getByRole('heading', { level: 1, name: ROOM })).toBeVisible()
      await phone.locator('.react-flow__node', { hasText: AGENT.name }).click()
      await expect(phone.getByRole('heading', { level: 1, name: AGENT.name })).toBeVisible()
      const box = phone.getByRole('textbox', { name: `${AGENT.name}에게 보낼 메시지` })
      await box.fill(PHONE_TEXT)
      await phone.getByRole('button', { name: '보내기', exact: true }).click()
      await expect(box).toHaveValue('')
      await expect(phone.locator('.ci-claude', { hasText: `받음: ${PHONE_TEXT}` })).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => sentTexts(claudeLog).includes(PHONE_TEXT)).toBe(true)
      // PC 창에도 같은 대화가 보인다
      await expect(page.locator(`aside.pnl[aria-label="${AGENT.name}"] .ci-claude`, { hasText: `받음: ${PHONE_TEXT}` })).toBeVisible()
    })

    await test.step('승인 — 휴대폰 할 일 → 허용 → PC 의 요청도 풀림', async () => {
      const box = phone.getByRole('textbox', { name: `${AGENT.name}에게 보낼 메시지` })
      await box.fill('ASK Write')
      await phone.getByRole('button', { name: '보내기', exact: true }).click()
      const ask = phone.locator('section.pin.ask')
      await expect(ask).toBeVisible({ timeout: 20_000 })
      await expect(node(page, AGENT.name).locator('.ap')).toBeVisible() // PC 의 카드도 묻는 중

      // 방 고르기로 돌아가면 '할 일' 에 그 에이전트 — 누르면 그 대화로 바로
      await phone.getByRole('button', { name: '뒤로' }).click()
      await expect(phone.getByRole('heading', { level: 1, name: ROOM })).toBeVisible()
      await phone.getByRole('button', { name: '뒤로' }).click()
      const todo = phone.getByRole('region', { name: /^할 일/ })
      await expect(todo).toBeVisible()
      await todo.getByRole('button', { name: new RegExp(AGENT.name) }).click()
      await expect(phone.getByRole('heading', { level: 1, name: AGENT.name })).toBeVisible()

      await ask.getByRole('button', { name: '허용', exact: true }).click()
      await expect(ask).toHaveCount(0)
      await expect(node(page, AGENT.name).locator('.ap')).toHaveCount(0)
      const snap = (await page.evaluate(() => (window as unknown as { dure: { snapshot(): Promise<unknown> } }).dure.snapshot())) as { requests: unknown[] }
      expect(snap.requests).toEqual([])
    })

    await test.step('짝 맺은 소켓은 휴대폰 메서드만 — PC 전용(setPhone)은 거절', async () => {
      // 쿠키 이름은 휴대폰이 부르는 주소의 포트마다(여기선 http://127.0.0.1:<서버 포트>)
      const cookie = (await ctx.cookies()).find((c) => c.name === phoneCookieName(port))
      expect(cookie?.httpOnly).toBe(true)
      expect(cookie?.secure).toBe(true)
      expect(cookie?.sameSite).toBe('Strict')
      const ws = await wsOpen(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie: `${cookie!.name}=${cookie!.value}` })
      expect(ws).toBeInstanceOf(NodeWebSocket)
      const sock = ws as NodeWebSocket
      try {
        expect((await wsCall(sock, 'snapshot')).ok).toBe(true)
        expect((await wsCall(sock, 'setPhone', [{ enabled: false }])).ok).toBe(false)
        expect((await phoneStateOf(page)).settings.enabled).toBe(true)
      } finally {
        sock.close()
      }
      await expect(page.locator('button.phn-top')).toHaveText('휴대폰 · 1') // 시험 소켓이 닫혀도 휴대폰은 그대로
    })

    await test.step('PC 에서 끊기 → 휴대폰 소켓 4401 → 짝 맺기 화면 · 같은 토큰 거절', async () => {
      const cookie = (await ctx.cookies()).find((c) => c.name === phoneCookieName(port))!
      await dlg.getByRole('button', { name: `${deviceName} 끊기` }).click()
      const ask = page.getByRole('alertdialog')
      await ask.getByRole('button', { name: '끊기', exact: true }).click()
      await expect(ask).toBeHidden()
      await expect(dlg.getByText('아직 짝 맺은 휴대폰이 없어요')).toBeVisible()

      await expect(phone.getByRole('textbox', { name: '숫자 6자리' })).toBeVisible({ timeout: 20_000 })
      await expect(phone.getByRole('heading', { level: 1 })).toHaveText(/숫자 6자리를 넣어 주세요/)
      expect(await closeCodes()).toContain(4401)
      expect(await meStatus()).toBe(401)
      expect(await wsOpen(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie: `${cookie.name}=${cookie.value}` })).toBe(401)
      await expect(page.locator('button.phn-top')).toHaveText('휴대폰 · 0')
    })

    await test.step('켠 채 PC 이름을 바꿈 → 창으로 돌아오면 예전 이름의 길을 닫고 지금 이름으로 다시 연다', async () => {
      await expect(dlg.getByText('바꾸기 전에 휴대폰 연결을 끄고, 바꾼 뒤 다시 켜 주세요', { exact: false })).toBeVisible()
      const before = tailscaleCalls(tsLog).length
      fs.writeFileSync(path.join(tsRoot, 'dns-name'), RENAMED) // Tailscale 대시보드에서 바꾼 꼴
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(dlg.locator('.phn-url-t')).toHaveText(`https://${RENAMED}/mobile.html`)
      const calls = tailscaleCalls(tsLog).slice(before)
      expect(calls).toContain('serve --https=443 off')
      expect(calls).toContain(`serve --bg --https=443 http://127.0.0.1:${port}`)
      const serve = JSON.parse(fs.readFileSync(path.join(tsRoot, 'serve.json'), 'utf8')) as { Web?: Record<string, unknown> }
      expect(Object.keys(serve.Web ?? {})).toEqual([`${RENAMED}:443`])
      const rec = (JSON.parse(fs.readFileSync(path.join(userData, 'phone.json'), 'utf8')) as { serve?: { dnsName?: string; localPort: number } }).serve
      expect(rec).toMatchObject({ dnsName: RENAMED, localPort: port }) // 예전 서버는 닫고(소켓 끊김) 같은 포트로 다시 열었다
      await expect(page.locator('button.phn-top')).toHaveText('휴대폰 · 0')
    })

    await test.step('창 닫기 → 트레이로 숨음 · 두레와 휴대폰 연결은 그대로', async () => {
      const menu = await app.evaluate(() => (globalThis as unknown as { __e2e: { tray: { label?: string }[] | null } }).__e2e.tray?.map((i) => i.label) ?? null)
      expect(menu).toEqual(TRAY_MENU) // 켤 때 트레이가 생겼다
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false])
      const st = await phoneStateOf(page)
      expect(st.settings.enabled).toBe(true)
      expect(st.url).toBe(`https://${RENAMED}/mobile.html`)
      // 휴대폰 서버가 그대로 답한다 — 휴대폰 페이지도 다시 읽을 수 있다
      expect(await httpStatus(port, { path: '/mobile.html', headers: { host: `127.0.0.1:${port}` } })).toBe(200)
      await phone.reload()
      await expect(phone.getByRole('textbox', { name: '숫자 6자리' })).toBeVisible()
    })

    await test.step('트레이 메뉴 휴대폰 연결 끄기 → serve off · 서버 닫힘 · 창 다시 보임', async () => {
      const offs = () => tailscaleCalls(tsLog).filter((c) => c === 'serve --https=443 off').length
      const offsBefore = offs() // 이름을 바꿀 때 한 번 껐다
      await app.evaluate(() => {
        const items = (globalThis as unknown as { __e2e: { tray: { label?: string; click?: () => void }[] } }).__e2e.tray
        items.find((i) => i.label === '휴대폰 연결 끄기')!.click!()
      })
      await expect.poll(offs).toBe(offsBefore + 1)
      // 트레이가 없어지면 숨은 창을 보인다(창도 트레이도 없는 두레가 되지 않게)
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([true])
      await expect(master).toHaveAttribute('aria-checked', 'false')
      await expect(page.locator('button.phn-top')).toHaveCount(0)
      const st = await phoneStateOf(page)
      expect(st.url).toBeNull()
      const file = JSON.parse(fs.readFileSync(path.join(userData, 'phone.json'), 'utf8')) as { serve?: unknown }
      expect(file.serve).toBeUndefined() // 두레 길 기록도 지웠다
      await expect.poll(() => httpStatus(port, { path: '/mobile.html', headers: { host: `127.0.0.1:${port}` } }).catch((e: NodeJS.ErrnoException) => e.code)).toBe('ECONNREFUSED')
      // 사용자의 다른 serve 항목은 없었다 — 두레가 연 것만 지우고 남은 것 없음
      expect(JSON.parse(fs.readFileSync(path.join(tsRoot, 'serve.json'), 'utf8'))).toEqual({})
      expect(tailscaleCalls(tsLog).some((c) => /\b(reset|funnel)\b/.test(c))).toBe(false)
    })

    // 절전 막기는 끈 채였다 — 한 번도 불리지 않았다
    expect(await app.evaluate(() => (globalThis as unknown as { __e2e: { power: number } }).__e2e.power)).toBe(0)
    expect(pageErrors).toEqual([])
    expect(phoneErrors).toEqual([])
  } finally {
    await browser?.close().catch(() => undefined)
    await app.close().catch(() => undefined)
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
