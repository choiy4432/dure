// E2E — 빌드된 앱(out/)을 가짜 claude(test/fakeClaude.mjs)로 띄워 처음부터 끝까지 한 번 써 본다.
// 방 만들기 → 에이전트 둘 → 넘김(확인 대기 → 일 시키기 → 전달됨) → 승인 → 큰 이미지 → 다시 켜기 → 검수 캡처 두 장
// → 펼침 캡처 → 받은 메시지 접기(실제 배치로 잰다).
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
/** 접기 확인용 — 한 줄 문단 셋(접지 않는다) · 한 줄 문단 여섯(접는다) */
const THREE_PARAS = ['첫째 줄이에요', '둘째 줄이에요', '셋째 줄이에요']
const SIX_PARAS = ['하나', '둘', '셋', '넷', '다섯', '여섯'].map((n) => `${n}째 문단이에요`)
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
function appEnv(w: Work, extra: Record<string, string> = {}): Record<string, string> {
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
    ...extra,
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

async function launch(w: Work, extraEnv: Record<string, string> = {}): Promise<Running> {
  const app = await electron.launch({ args: [MAIN], env: appEnv(w, extraEnv), cwd: ROOT })
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
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
  // 관계도 왼쪽 아래 '에이전트 추가' — 에이전트가 없는 방은 빈 화면의 '추가'가 그 자리
  const fromMap = page.getByRole('button', { name: '에이전트 추가', exact: true })
  const opener = (await fromMap.count()) > 0 ? fromMap : page.getByRole('main', { name: '관계도' }).getByRole('button', { name: '추가', exact: true })
  await opener.click()
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
        await expect(node(page, a.name).locator('.au')).toHaveCount(0) // 자동이 꺼진 카드엔 꼬리표가 없다(흘끗 보기 — 잡음 줄이기)
        await expect(node(page, a.name).locator('.nr')).toContainText(a.role)
        // 역할은 모델·effort 에 밀려 잘리지 않는다 — 말줄임 없이 다 보인다
        const clipped = await node(page, a.name).locator('.nr-role .trunc').evaluate((el) => el.scrollWidth > el.clientWidth)
        expect(clipped).toBe(false)
        // 역할 칸은 글보다 넓어지지 않는다 — 모델·effort 가 역할 바로 뒤에 붙는다(오른쪽 끝으로 밀리지 않는다)
        const role = await node(page, a.name).locator('.nr-role .trunc').evaluate((el) => {
          const text = document.createRange()
          text.selectNodeContents(el)
          return { box: el.getBoundingClientRect().width, text: text.getBoundingClientRect().width }
        })
        expect(role.box - role.text).toBeLessThan(1)
      }
      // 긴 역할은 6em 아래로 줄지 않는다 — 모자라면 모델·effort 가 다음 줄로(같은 카드에 긴 역할 줄을 잠깐 넣어 잰다)
      const long = await node(page, PLAN.name).locator('.nr').evaluate((nr) => {
        const probe = nr.cloneNode(true) as HTMLElement
        const roleText = probe.querySelector('.nr-role .trunc') as HTMLElement
        const role = probe.querySelector('.nr-role') as HTMLElement
        // 모델·effort 는 고른 때만 보인다 — 없으면 잴 칸을 만든다
        let meta = probe.querySelector('.nr-meta') as HTMLElement | null
        if (!meta) {
          meta = document.createElement('span')
          meta.className = 'nr-meta keep'
          probe.append(meta)
        }
        roleText.textContent = '기획서 · 문구 · 행사 페이지 카피 전부 · 보도자료 · 이벤트 안내'
        role.className = 'nr-role floor'
        meta.textContent = 'Opus 5 (긴 대화) · xhigh'
        nr.after(probe)
        const r = role.getBoundingClientRect()
        const m = meta.getBoundingClientRect()
        const out = {
          role: r.width,
          em6: 6 * parseFloat(getComputedStyle(role).fontSize),
          metaInside: m.right <= probe.getBoundingClientRect().right + 0.5,
        }
        probe.remove()
        return out
      })
      expect(long.role).toBeGreaterThanOrEqual(long.em6 - 0.5)
      expect(long.metaInside).toBe(true)
      // 새로 만든 에이전트가 골라져 있다 — 자동 스위치는 꺼짐
      await expect(panel(page, WEB.name).getByRole('switch', { name: '자동' })).toHaveAttribute('aria-checked', 'false')

      // 누르는 동안 손이 2px 흔들려도 한 번에 열린다(예전엔 1px 만 움직여도 클릭이 끌기로 버려져 두 번 눌러야 했다)
      const box = (await node(page, PLAN.name).boundingBox())!
      await page.mouse.move(box.x + 60, box.y + 60)
      await page.mouse.down()
      await page.mouse.move(box.x + 62, box.y + 60, { steps: 2 })
      await page.mouse.up()
      await expect(panel(page, PLAN.name)).toBeVisible()
      // 흔들림만으로는 카드가 끌려 자리가 바뀌지 않는다
      expect((await node(page, PLAN.name).boundingBox())!.x).toBeCloseTo(box.x, 0)
    })

    await test.step('3. 기획 → 웹 화면 넘김: 확인 대기 → 일 시키기 → 전달됨', async () => {
      const ids = await agentIds(page)
      const edge = page.locator(`.react-flow__edge[data-id="${ids[PLAN.name]}>${ids[WEB.name]}"]`)

      await node(page, PLAN.name).locator('.nh').click()
      await expect(panel(page, PLAN.name)).toBeVisible()
      await say(page, PLAN.name, `SEND ${WEB.name}: ${HANDOFF_TEXT}`)

      await expect(edge).toHaveCount(1)
      await expect(page.locator('.el')).toHaveText('내 확인 필요')
      await expect(node(page, WEB.name).locator('.um')).toHaveText(/받은 메시지\s*1/)

      // 받은 메시지는 패널 위에 고정하지 않는다 — 메시지 탭(내 확인 필요는 펼친 채)에서 일 시키기
      await node(page, WEB.name).locator('.nh').click()
      const web = panel(page, WEB.name)
      await expect(web.locator('.pin.msg')).toHaveCount(0)
      await web.getByRole('tab', { name: /메시지/ }).click()
      const row = web.locator('.mrow', { hasText: HANDOFF_TEXT })
      await row.getByRole('button', { name: '일 시키기' }).click()
      await expect(row.locator('.tag')).toHaveText('전달됨')
      await web.getByRole('tab', { name: '대화' }).click()

      const relay = web.locator('.ci-relay')
      await expect(relay).toContainText(HANDOFF_TEXT)
      await expect(relay.locator('.who')).toContainText(PLAN.name)
      await expect(page.locator('.el')).toHaveText(/^전달됨/)
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
      // 보낸 그림은 썸네일 — 저장한 그림을 엔진에서 읽어 온다
      await expect(me.getByRole('button', { name: '이미지 1/1 크게 보기' }).locator('img')).toHaveAttribute('src', /^data:image\//)
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
      const usage = page.locator('footer.sbar .usg-btn')
      for (const t of ['5시간', '12%', 'Fable', '81%']) await expect(usage).toContainText(t, { timeout: 5000 })

      // 링 — 차례가 끝난 뒤 % 글자, 누르면 토큰 수
      const ring = web.locator('.ctx-btn')
      await expect(ring).toHaveText(/^\d+%$/)
      ringBefore = (await ring.textContent()) ?? ''
      await ring.click()
      await expect(web.getByRole('dialog', { name: /^대화 공간/ })).toContainText(/만 \/ 20만 토큰/)
      await page.keyboard.press('Escape')
      await expect(web.locator('.ctx-pop')).toHaveCount(0)

      // effort — 칩 high → 슬라이더 오른쪽 한 칸 → xhigh, Claude 로 세션 명령 /effort xhigh 가 간다(대화엔 안 보인다)
      const chip = web.locator('.eff-chip')
      await expect(chip).toContainText('high')
      const chipBox = await chip.boundingBox()
      await chip.click()
      const slider = web.getByRole('slider', { name: '생각하는 정도' })
      await expect(slider).toBeFocused({ timeout: 10_000 })
      const popLeft = async () => (await web.locator('.eff-pop').boundingBox())?.x
      const popBefore = await popLeft()
      await page.keyboard.press('ArrowRight')
      await expect(chip).toContainText('xhigh')
      await expect
        .poll(() => fs.readFileSync(w.log, 'utf8').split(/\r?\n/)
        .filter((l) => l.includes('"/effort xhigh"')).length)
        .toBeGreaterThan(0)
      // 단계 이름이 바뀌어도 칩 너비·펼침 자리는 그대로
      expect((await chip.boundingBox())?.width).toBe(chipBox?.width)
      expect(await popLeft()).toBe(popBefore)
      await expect(web.locator('.me', { hasText: '/effort' })).toHaveCount(0)
      await expect(chip).toHaveText('xhigh') // Claude 의 답(지금 값)이 와도 xhigh 그대로
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
      // 다시 켜도 보낸 그림은 썸네일로 열린다(그림 칸에 저장돼 있다)
      await expect(web.locator('.me', { hasText: IMAGE_TEXT }).getByRole('button', { name: '이미지 1/1 크게 보기' }).locator('img')).toHaveAttribute('src', /^data:image\//)
      await expect(web.locator('.pin.msg')).toHaveCount(0)
      // 지난 승인 요청은 남지 않는다
      await expect(page.locator('.ap')).toHaveCount(0)
      await expect(page.locator('.el')).toHaveText(/^전달됨/)
      // 저장해 둔 마지막 context — 다시 켠 직후에도 켜기 전과 같은 %
      await expect(web.locator('.ctx-btn')).toHaveText(ringBefore)
    })

    await test.step('6. 검수 캡처 — 1440×900 · 1280×800', async () => {
      fs.mkdirSync(REVIEW_DIR, { recursive: true })
      // 다시 켠 뒤 사용량 전용 프로세스가 값을 가져올 때까지 — 캡처에 위 띠 막대가 보이게
      await expect(page.locator('footer.sbar .usg-btn')).toContainText('81%', { timeout: 10_000 })
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
      await shot('usage-open.png', page.locator('footer.sbar .usg-btn'), page.locator('.usg-pop'))
      await page.keyboard.press('Escape')
      await shot('effort-open.png', web.locator('.eff-chip'), web.locator('.eff-pop'))
      await expect(web.getByRole('slider', { name: '생각하는 정도' })).toBeFocused()
      await page.keyboard.press('Escape')
      await shot('context-open.png', web.locator('.ctx-btn'), web.locator('.ctx-pop'))
      await page.keyboard.press('Escape')

      // 좁은 끝(창 1100×700, 패널 360) — 링 펼침이 패널·창 안에 머문다
      await run!.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [1100, 700])
      await page.waitForFunction(() => window.innerWidth === 1100 && window.innerHeight === 700)
      // 12px 글자로도 아래 상태 띠 막대 셋이 1100px 에 들어간다(한 막대 모드는 1100 미만부터) · 위 띠도 넘치지 않는다
      await expect(page.locator('footer.sbar .usg')).toHaveCount(3)
      const fit = await page.evaluate(() => {
        const top = document.querySelector('header.top') as HTMLElement
        const bar = document.querySelector('footer.sbar') as HTMLElement
        const btn = (document.querySelector('footer.sbar .usg-btn') as HTMLElement).getBoundingClientRect()
        const last = top.lastElementChild!.getBoundingClientRect()
        return { over: Math.max(top.scrollWidth - top.clientWidth, bar.scrollWidth - bar.clientWidth), btnRight: btn.right, lastRight: last.right, w: window.innerWidth }
      })
      expect(fit.over).toBeLessThanOrEqual(0)
      expect(fit.btnRight).toBeLessThanOrEqual(fit.w)
      expect(fit.lastRight).toBeLessThanOrEqual(fit.w + 0.5)
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

    await test.step('8. 받은 메시지 접기(할 일 목록) — 한 줄 문단 셋은 그대로, 여섯은 3줄 + 흐림', async () => {
      await node(page, PLAN.name).locator('.nh').click()
      await expect(panel(page, PLAN.name)).toBeVisible()
      await say(page, PLAN.name, `SEND ${WEB.name}: ${THREE_PARAS.join('\n\n')}`)
      // 첫 SEND 차례가 끝난 뒤에 — 일하는 중에 보낸 말은 같은 차례에 끼어드는데, 가짜 claude 는 끼어든 SEND 를 실행하지 않는다
      await expect(node(page, PLAN.name).locator('.nd')).toHaveAttribute('data-status', 'idle')
      await say(page, PLAN.name, `SEND ${WEB.name}: ${SIX_PARAS.join('\n\n')}`)
      await expect(node(page, PLAN.name).locator('.nd')).toHaveAttribute('data-status', 'idle')
      // 받은 메시지 카드는 할 일 목록에 — 위 띠의 할 일 단추가 고른 에이전트를 풀어 패널을 돌린다
      await page.locator('.top').getByRole('button', { name: /^할 일/ }).click()
      const inbox = page.locator('aside.pnl[aria-label="에이전트"]')
      const short = inbox.locator('.pin', { hasText: THREE_PARAS[2] })
      const long = inbox.locator('.pin', { hasText: SIX_PARAS[0] })
      await expect(short.locator('.md p')).toHaveCount(3)
      await expect(long.locator('.md p')).toHaveCount(6)
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      await expect(short.locator('.clamp-box')).not.toHaveClass(/\bclamped\b/)
      await expect(short.getByRole('button', { name: '더 보기' })).toHaveCount(0)
      await expect(long.locator('.clamp-box')).toHaveClass(/\bclamped\b/)
      await expect(long.getByRole('button', { name: '더 보기' })).toHaveCount(1)
    })

    expect(run.pageErrors).toEqual([])
  } finally {
    await run?.app.close().catch(() => undefined)
    fs.rmSync(w.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('재우기 — 쉬면 잠들고, 말을 걸면 --resume 으로 깨어난다', async () => {
  const w = makeWork()
  let run: Running | null = null
  try {
    // 재우는 시간의 '1분' 을 50ms 로 줄인다(DURE_SLEEP_MINUTE_MS) — 15분 설정이 0.75초
    run = await launch(w, { DURE_SLEEP_MINUTE_MS: '50' })
    const { page } = run

    await test.step('방 · 에이전트 둘', async () => {
      await page.getByRole('button', { name: '방 만들기' }).click()
      const dlg = page.getByRole('dialog', { name: '새 방' })
      await dlg.getByLabel('이름').fill(ROOM)
      await dlg.getByRole('button', { name: '만들기', exact: true }).click()
      await expect(dlg).toBeHidden()
      await addAgent(page, PLAN, w.planFolder)
      await addAgent(page, WEB, w.webFolder)
    })

    await test.step('설정에서 15분 고르고 저장', async () => {
      await page.getByRole('button', { name: '설정', exact: true }).click()
      const dlg = page.getByRole('dialog', { name: '설정' })
      await dlg.getByRole('radiogroup', { name: '쉬는 에이전트 재우기' }).getByRole('radio', { name: '15분' }).click()
      await dlg.getByRole('button', { name: '저장', exact: true }).click()
      await expect(dlg).toBeHidden()
    })

    await test.step('말 걸고 끝난 뒤 다른 에이전트를 고르면 카드가 잠듦', async () => {
      await node(page, PLAN.name).locator('.nh').click()
      await say(page, PLAN.name, '첫 번째 말')
      await expect(panel(page, PLAN.name).locator('.ci-claude', { hasText: '받음: 첫 번째 말' })).toBeVisible({ timeout: 15_000 })
      await node(page, WEB.name).locator('.nh').click()
      await expect(node(page, PLAN.name).locator('.av-moon')).toBeVisible({ timeout: 15_000 })
      await expect(node(page, PLAN.name).locator('.nf .st-l')).toHaveText('잠듦')
    })

    await test.step('말을 걸면 깨어나 이어서 답한다(--resume)', async () => {
      await node(page, PLAN.name).locator('.nh').click()
      await say(page, PLAN.name, '두 번째 말')
      await expect(panel(page, PLAN.name).locator('.ci-claude', { hasText: '받음: 두 번째 말' })).toBeVisible({ timeout: 15_000 })
      await expect.poll(() => fs.readFileSync(w.log, 'utf8').includes('"--resume"')).toBe(true)
    })

    expect(run.pageErrors).toEqual([])
  } finally {
    await run?.app.close().catch(() => undefined)
    fs.rmSync(w.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
