// E2E — 빌드된 앱(out/)을 가짜 claude(test/fakeClaude.mjs)로 띄워 처음부터 끝까지 한 번 써 본다.
// 방 만들기 → 에이전트 둘 → 넘김(확인 대기 → 일 시키기 → 전달됨) → 승인 → 큰 이미지 → 다시 켜기 → 검수 캡처 두 장.
// 실행: `npm run build` 다음 `npm run e2e`.
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fakeClaude.mjs')
const REVIEW_DIR = path.join(ROOT, '.impeccable', 'review')

const ROOM = '여름 캠페인'
const PLAN = { name: '기획', role: '기획서 · 문구' }
const WEB = { name: '웹 화면', role: '화면 만들기' }
const HANDOFF_TEXT = '배너 문구 바꿔 주세요'
const IMAGE_TEXT = '이 시안 봐 주세요'
/** 한 장 상한 — 보낸 base64 글 기준(renderer lib/image.ts 와 같은 수) */
const MAX_SENT = 5 * 1024 * 1024

interface Work {
  dir: string
  userData: string
  log: string
  planFolder: string
  webFolder: string
  bigPng: string
}

function makeWork(): Work {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-e2e-'))
  const w: Work = {
    dir,
    userData: path.join(dir, 'userData'),
    log: path.join(dir, 'fake-claude.log'),
    planFolder: path.join(dir, 'plan'),
    webFolder: path.join(dir, 'web'),
    bigPng: path.join(dir, 'big.png'),
  }
  fs.mkdirSync(w.planFolder)
  fs.mkdirSync(w.webFolder)
  return w
}

/** 앱에 줄 환경 — ELECTRON_RUN_AS_NODE 가 남아 있으면 electron 이 그냥 node 로 돈다 */
function appEnv(w: Work): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return {
    ...env,
    DURE_CLAUDE_COMMAND: process.execPath,
    DURE_CLAUDE_ARGS: JSON.stringify([FAKE_CLAUDE]),
    FAKE_CLAUDE_LOG: w.log,
    DURE_USER_DATA: w.userData,
    DURE_E2E_FOLDERS: JSON.stringify([w.planFolder, w.webFolder]),
    DURE_NO_DIALOG: '1',
  }
}

interface Running {
  app: ElectronApplication
  page: Page
  /** 렌더러가 죽었는가 */
  crashed: () => boolean
  /** 잡히지 않은 렌더러 예외 */
  pageErrors: string[]
}

async function launch(w: Work): Promise<Running> {
  const app = await electron.launch({ args: [MAIN], env: appEnv(w), cwd: ROOT })
  const page = await app.firstWindow()
  let crashed = false
  const pageErrors: string[] = []
  page.on('crash', () => {
    crashed = true
  })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.waitForLoadState('domcontentloaded')
  return { app, page, crashed: () => crashed, pageErrors }
}

/** 6000×3000 PNG(약 20MB) — 그라데이션에 잡음을 섞어 잘 줄지 않게. 바이너리는 커밋하지 않고 테스트 때 만든다 */
function writeBigPng(file: string, width: number, height: number): number {
  const rowLen = 1 + width * 3
  const raw = Buffer.alloc(rowLen * height)
  const noise = crypto.randomBytes(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * rowLen // 줄 머리 0 = 거르개 없음
    const g = Math.floor((y * 255) / height)
    for (let x = 0; x < width; x++) {
      const n = noise[y * width + x]
      const p = row + 1 + x * 3
      raw[p] = Math.floor((x * 255) / width) ^ (n & 0x0f)
      raw[p + 1] = g ^ (n >> 4)
      raw[p + 2] = 160
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 비트 깊이
  ihdr[9] = 2 // RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  fs.writeFileSync(file, png)
  return png.length
}

/** 가짜 claude 가 받은 stdin 줄 중 이미지가 든 사용자 줄의 이미지 조각들 */
function loggedImages(log: string): { mediaType: string; length: number }[] {
  if (!fs.existsSync(log)) return []
  const found: { mediaType: string; length: number }[] = []
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (!line.includes('"image"')) continue
    let msg: { type?: string; message?: { content?: unknown } }
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type !== 'user' || !Array.isArray(msg.message?.content)) continue
    for (const part of msg.message.content as { type?: string; source?: { media_type?: string; data?: string } }[]) {
      if (part.type === 'image' && typeof part.source?.data === 'string') {
        found.push({ mediaType: part.source.media_type ?? '', length: part.source.data.length })
      }
    }
  }
  return found
}

const node = (page: Page, name: string): Locator =>
  page.locator('.react-flow__node').filter({ has: page.locator('.nn b', { hasText: new RegExp(`^${name}$`) }) })

const panel = (page: Page, name: string): Locator => page.locator(`aside.pnl[aria-label="${name}"]`)

async function say(page: Page, name: string, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: `${name}에게 보낼 메시지` })
  await box.fill(text)
  await box.press('Enter')
  await expect(box).toHaveValue('')
}

async function addAgent(page: Page, a: { name: string; role: string }, folder: string): Promise<void> {
  await page.getByRole('button', { name: '에이전트 추가', exact: true }).click()
  const dlg = page.getByRole('dialog', { name: '에이전트 추가' })
  await dlg.getByRole('button', { name: '폴더 고르기' }).click()
  await expect(dlg.getByText(folder, { exact: true })).toBeVisible()
  await dlg.getByLabel('이름').fill(a.name)
  await dlg.getByLabel('역할').fill(a.role)
  await dlg.getByRole('button', { name: '추가', exact: true }).click()
  await expect(dlg).toBeHidden()
  await expect(node(page, a.name)).toBeVisible()
}

async function agentIds(page: Page): Promise<Record<string, string>> {
  const snap = (await page.evaluate(() => (window as unknown as { dure: { snapshot(): Promise<unknown> } }).dure.snapshot())) as {
    agents: { id: string; name: string }[]
  }
  return Object.fromEntries(snap.agents.map((a) => [a.name, a.id]))
}

async function capture(r: Running, width: number, height: number, file: string): Promise<void> {
  await r.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height])
  await r.page.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [width, height])
  await r.page.getByRole('button', { name: '모두 보기' }).click()
  await r.page.mouse.move(width - 4, Math.round(height / 2)) // 카드 위 hover 를 걷는다
  await r.page.evaluate(() => document.fonts.ready.then(() => undefined))
  await r.page.waitForTimeout(600) // 맞춤 움직임(200ms)과 그리기가 끝나게
  await r.page.screenshot({ path: file, scale: 'css' })
}

test('방·에이전트·넘김·승인·큰 이미지·다시 켜기 + 검수 캡처', async () => {
  const w = makeWork()
  let run: Running | null = null
  try {
    run = await launch(w)
    let { page } = run

    await test.step('1. 빈 상태 → 방 만들기', async () => {
      await expect(page.getByText('첫 방을 만들어 보세요')).toBeVisible()
      await page.getByRole('button', { name: '방 만들기' }).click()
      const dlg = page.getByRole('dialog', { name: '새 방' })
      await dlg.getByLabel('이름').fill(ROOM)
      await dlg.getByRole('button', { name: '만들기', exact: true }).click()
      await expect(dlg).toBeHidden()
      await expect(page.locator('header.top')).toContainText(ROOM)
      await expect(page.getByText('첫 에이전트를 추가해 보세요')).toBeVisible()
    })

    await test.step('2. 에이전트 둘 — 기획 · 웹 화면 (자동 끔)', async () => {
      await addAgent(page, PLAN, w.planFolder)
      await addAgent(page, WEB, w.webFolder)
      for (const a of [PLAN, WEB]) {
        await expect(node(page, a.name).locator('.au')).toHaveText('자동 끔')
        await expect(node(page, a.name).locator('.nr')).toContainText(a.role)
        // 역할은 모델·effort 에 밀려 잘리지 않는다 — 말줄임 없이 다 보인다
        const clipped = await node(page, a.name).locator('.nr .trunc').evaluate((el) => el.scrollWidth > el.clientWidth)
        expect(clipped).toBe(false)
      }
      // 새로 만든 에이전트가 골라져 있다 — 자동 스위치는 꺼짐
      await expect(panel(page, WEB.name).getByRole('switch', { name: '자동' })).toHaveAttribute('aria-checked', 'false')
    })

    await test.step('3. 기획 → 웹 화면 넘김: 확인 대기 → 일 시키기 → 전달됨', async () => {
      const ids = await agentIds(page)
      const edge = page.locator(`.react-flow__edge[data-id="${ids[PLAN.name]}>${ids[WEB.name]}"]`)

      await node(page, PLAN.name).locator('.nh').click()
      await expect(panel(page, PLAN.name)).toBeVisible()
      await say(page, PLAN.name, `SEND ${WEB.name}: ${HANDOFF_TEXT}`)

      await expect(edge).toHaveCount(1)
      await expect(page.locator('.el')).toHaveText('확인 대기')
      await expect(node(page, WEB.name).locator('.um')).toHaveText(/받은 메시지\s*1/)

      await node(page, WEB.name).locator('.nh').click()
      const web = panel(page, WEB.name)
      const card = web.getByRole('region', { name: `${PLAN.name}이 보낸 메시지` })
      await expect(card).toContainText(HANDOFF_TEXT)
      await card.getByRole('button', { name: '일 시키기' }).click()

      const relay = web.locator('.ci-relay')
      await expect(relay).toContainText(HANDOFF_TEXT)
      await expect(relay.locator('.who')).toContainText(PLAN.name)
      await expect(page.locator('.el')).toHaveText(/^전달됨/)
      await expect(card).toContainText('전달됨')
      await expect(node(page, WEB.name).locator('.um')).toHaveCount(0)
    })

    await test.step('4. 웹 화면 ASK Write → 노드의 앰버 칸 → 허용 → 하는 일 줄', async () => {
      const web = panel(page, WEB.name)
      await say(page, WEB.name, 'ASK Write')
      const ask = node(page, WEB.name).locator('.ap')
      await expect(ask).toContainText(`${WEB.name}이 파일을 만들려 해요`)
      await expect(node(page, WEB.name).locator('.nd')).toHaveClass(/\bpend\b/)
      await ask.getByRole('button', { name: '허용', exact: true }).click()
      await expect(ask).toHaveCount(0)
      await expect(web.locator('.acts li:not(.run)', { hasText: '만듦' })).toHaveCount(1)
    })

    await test.step('4+. 아주 큰 이미지(6000×3000) 붙여 보내기 — 줄여서 5MB 아래로', async () => {
      const size = writeBigPng(w.bigPng, 6000, 3000)
      expect(4 * Math.ceil(size / 3)).toBeGreaterThan(MAX_SENT) // 원본 그대로면 상한을 넘는다
      const web = panel(page, WEB.name)
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        web.getByRole('button', { name: '이미지 붙여 넣기' }).click(),
      ])
      await chooser.setFiles(w.bigPng)
      await expect(web.getByRole('img', { name: '붙인 이미지 1' })).toBeVisible({ timeout: 30_000 })
      await say(page, WEB.name, IMAGE_TEXT)

      const me = web.locator('.me', { hasText: IMAGE_TEXT })
      await expect(me).toContainText('이미지 1개')
      await expect.poll(() => loggedImages(w.log).length).toBe(1)
      const [img] = loggedImages(w.log)
      console.log(`큰 이미지: 원본 ${(size / 1048576).toFixed(1)}MB → 보낸 base64 ${(img.length / 1048576).toFixed(2)}MB (${img.mediaType})`)
      expect(img.length).toBeLessThanOrEqual(MAX_SENT)
      expect(img.length).toBeGreaterThan(0)
      // 앱이 살아 있다 — 창이 닫히거나 렌더러가 죽지 않았다
      expect(run!.crashed()).toBe(false)
      expect(page.isClosed()).toBe(false)
      expect(await run!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.isCrashed())).toBe(false)
      await expect(web.locator('.ci-claude', { hasText: `받음: ${IMAGE_TEXT}` })).toBeVisible()
    })

    let ringBefore = ''
    await test.step('4++. 위 띠 사용량 · effort 칩/슬라이더 · context 링', async () => {
      const web = panel(page, WEB.name)
      // 사용량 전용 프로세스가 앱을 켠 뒤 에이전트 없이도 값을 가져온다
      const usage = page.locator('header.top .usg-btn')
      for (const t of ['5시간', '12%', 'Fable', '81%']) await expect(usage).toContainText(t, { timeout: 5000 })

      // 링 — 차례가 끝난 뒤 % 글자, 누르면 토큰 수
      const ring = web.locator('.ctx-btn')
      await expect(ring).toHaveText(/^\d+%$/)
      ringBefore = (await ring.textContent()) ?? ''
      await ring.click()
      await expect(web.getByRole('dialog', { name: /^대화 공간/ })).toContainText(/만 \/ 20만 토큰/)
      await page.keyboard.press('Escape')
      await expect(web.locator('.ctx-pop')).toHaveCount(0)

      // effort — 칩 high → 슬라이더 오른쪽 한 칸 → xhigh, Claude 로 apply_flag_settings 가 간다
      const chip = web.locator('.eff-chip')
      await expect(chip).toContainText('high')
      await chip.click()
      const slider = web.getByRole('slider', { name: '생각하는 정도' })
      await expect(slider).toBeFocused({ timeout: 10_000 })
      await page.keyboard.press('ArrowRight')
      await expect(chip).toContainText('xhigh')
      await expect
        .poll(() => fs.readFileSync(w.log, 'utf8').split(/\r?\n/)
        .filter((l) => l.includes('apply_flag_settings') && l.includes('xhigh')).length)
        .toBeGreaterThan(0)
      await page.keyboard.press('Escape')
      await expect(web.locator('.eff-pop')).toHaveCount(0)
    })

    expect(run.pageErrors).toEqual([])

    await test.step('5. 종료 → 같은 userData 로 다시 켜기 → 대화가 남아 있다', async () => {
      await run!.app.close()
      run = null
      run = await launch(w)
      page = run.page
      await expect(node(page, WEB.name)).toBeVisible()
      await node(page, WEB.name).locator('.nh').click()
      const web = panel(page, WEB.name)
      await expect(web.locator('.ci-relay')).toContainText(HANDOFF_TEXT)
      await expect(web.locator('.acts li', { hasText: '만듦' })).toHaveCount(1)
      await expect(web.locator('.me', { hasText: IMAGE_TEXT })).toContainText('이미지 1개')
      await expect(web.getByRole('region', { name: `${PLAN.name}이 보낸 메시지` })).toContainText('전달됨')
      // 지난 승인 요청은 남지 않는다
      await expect(page.locator('.ap')).toHaveCount(0)
      await expect(page.locator('.el')).toHaveText(/^전달됨/)
      // 저장해 둔 마지막 context — 다시 켠 직후에도 켜기 전과 같은 %
      await expect(web.locator('.ctx-btn')).toHaveText(ringBefore)
    })

    await test.step('6. 검수 캡처 — 1440×900 · 1280×800', async () => {
      fs.mkdirSync(REVIEW_DIR, { recursive: true })
      // 다시 켠 뒤 사용량 전용 프로세스가 값을 가져올 때까지 — 캡처에 위 띠 막대가 보이게
      await expect(page.locator('header.top .usg-btn')).toContainText('81%', { timeout: 10_000 })
      // 마지막 대화 줄 — 창이 줄어도 대화 칸 밑으로 숨지 않는다(맨 아래에 붙어 있던 목록)
      const lastLine = panel(page, WEB.name).locator('.conv > *').last()
      await capture(run!, 1440, 900, path.join(REVIEW_DIR, 'desktop.png'))
      await expect(lastLine).toBeInViewport({ ratio: 1 })
      await capture(run!, 1280, 800, path.join(REVIEW_DIR, 'laptop.png'))
      await expect(lastLine).toBeInViewport({ ratio: 1 })
      // 좁은 창에서도 패널은 최소 360px, 관계도는 최소 400px, 가로로 넘치지 않는다
      const box = await panel(page, WEB.name).boundingBox()
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(360)
      const mapBox = await page.locator('main.cv').boundingBox()
      expect(mapBox?.width ?? 0).toBeGreaterThanOrEqual(400)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })

    await test.step('7. 펼침 캡처 — 사용량 · effort · context (1440×900) + 좁은 끝 context', async () => {
      const web = panel(page, WEB.name)
      const shot = async (file: string, open: Locator, pop: Locator): Promise<void> => {
        await open.click()
        await expect(pop).toBeVisible()
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        await page.waitForTimeout(300)
        await page.screenshot({ path: path.join(REVIEW_DIR, file), scale: 'css' })
        return
      }
      await run!.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [1440, 900])
      await page.waitForFunction(() => window.innerWidth === 1440 && window.innerHeight === 900)
      await shot('usage-open.png', page.locator('header.top .usg-btn'), page.locator('.usg-pop'))
      await page.keyboard.press('Escape')
      await shot('effort-open.png', web.locator('.eff-chip'), web.locator('.eff-pop'))
      await expect(web.getByRole('slider', { name: '생각하는 정도' })).toBeFocused()
      await page.keyboard.press('Escape')
      await shot('context-open.png', web.locator('.ctx-btn'), web.locator('.ctx-pop'))
      await page.keyboard.press('Escape')

      // 좁은 끝(창 1100×700, 패널 360) — 링 펼침이 패널·창 안에 머문다
      await run!.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [1100, 700])
      await page.waitForFunction(() => window.innerWidth === 1100 && window.innerHeight === 700)
      // 패널을 가장 좁게(360) — 가르는 줄에 키보드로 닿는다
      await page.getByRole('separator', { name: '관계도와 패널 너비' }).focus()
      for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight')
      await expect.poll(async () => (await web.boundingBox())!.width).toBeLessThanOrEqual(361)
      await shot('context-open-narrow.png', web.locator('.ctx-btn'), web.locator('.ctx-pop'))
      const pop = await web.locator('.ctx-pop').boundingBox()
      const pnl = await web.boundingBox()
      console.log(`context 펼침(좁은 끝): 패널 ${JSON.stringify(pnl)} · 펼침 ${JSON.stringify(pop)}`)
      expect(pop!.x).toBeGreaterThanOrEqual(pnl!.x - 0.5)
      expect(pop!.x + pop!.width).toBeLessThanOrEqual(pnl!.x + pnl!.width + 0.5)
      expect(pop!.y).toBeGreaterThanOrEqual(0)
      expect(pop!.y + pop!.height).toBeLessThanOrEqual(700)
      await page.keyboard.press('Escape')
    })

    expect(run.pageErrors).toEqual([])
  } finally {
    await run?.app.close().catch(() => undefined)
    fs.rmSync(w.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
