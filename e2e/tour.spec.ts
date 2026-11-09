// E2E — 처음 켠 사람의 안내 투어를 실제 화면으로 끝까지: 환영 → 방 → 에이전트 → 카드 → 입력창 → 멈추기·자동 → 할 일 → 설정 → 끝.
// 다시 켜면 투어가 없고, 설정 → 두레 탭의 [다시 보기]는 방 단계가 방 고르기를 짚는다. markOnboarded 를 부르지 않는다(처음 쓰는 상태가 필요하다).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fakeClaude.mjs')

async function launch(dir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  Object.assign(env, {
    DURE_CLAUDE_COMMAND: process.execPath,
    DURE_CLAUDE_ARGS: JSON.stringify([FAKE_CLAUDE]),
    FAKE_CLAUDE_LOG: path.join(dir, 'fake-claude.log'),
    DURE_USER_DATA: path.join(dir, 'userData'),
    DURE_E2E_FOLDERS: JSON.stringify([path.join(dir, 'work')]),
    DURE_NO_DIALOG: '1',
  })
  const app = await electron.launch({ args: [MAIN], env, cwd: ROOT })
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test('안내 투어 — 끝까지 · 다시 켜면 없음 · 다시 보기는 방 고르기를 짚는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-e2e-tour-'))
  fs.mkdirSync(path.join(dir, 'work'))
  let app!: ElectronApplication
  try {
    let page: Page
    ;({ app, page } = await launch(dir))
    const card = page.locator('.tour-card')
    const title = (t: string) => expect(card.locator('.tour-t')).toHaveText(t)
    const ok = () => card.getByRole('button', { name: '확인했어요' }).click()

    // 창 단추 띠 색 — main 의 setTitleBarOverlay 호출을 엿본다(스크린샷엔 Windows 단추가 안 찍힌다)
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const g = globalThis as unknown as { overlays: { color: string }[] }
      g.overlays = []
      const orig = w.setTitleBarOverlay.bind(w)
      w.setTitleBarOverlay = (o: any) => { g.overlays.push(o); orig(o) }
    })
    const lastOverlay = () =>
      app.evaluate(() => {
        const g = globalThis as unknown as { overlays: { color: string }[] }
        return g.overlays[g.overlays.length - 1]?.color
      })
    const dark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
    const BG = dark ? '#111827' : '#FFFFFF'
    const VEILED = dark ? '#0B1121' : '#CFD1D4'

    await test.step('환영 → 시작하기', async () => {
      await title('두레에 오신 걸 환영해요')
      await expect.poll(lastOverlay).toBe(VEILED) // 막이 떠 있으면 창 단추 띠도 막 색
      await card.getByRole('button', { name: '시작하기' }).click()
    })
    await test.step('방 만들기', async () => {
      await title('방을 만들어 보세요')
      await expect(card.locator('.tour-n')).toHaveText('1 / 8')
      await page.getByRole('button', { name: '방 만들기' }).click()
      const dlg = page.getByRole('dialog', { name: '새 방' })
      await dlg.getByLabel('이름').fill('투어 방')
      await dlg.getByRole('button', { name: '만들기', exact: true }).click()
      await expect(dlg).toBeHidden()
    })
    await test.step('에이전트 추가', async () => {
      await title('에이전트를 추가해 보세요')
      await page.getByRole('main', { name: '관계도' }).getByRole('button', { name: '추가', exact: true }).click()
      const dlg = page.getByRole('dialog', { name: '에이전트 추가' })
      await dlg.getByRole('button', { name: '폴더 고르기' }).click()
      await dlg.getByLabel('이름').fill('도우미')
      await dlg.getByLabel('역할').fill('시험 역할')
      await dlg.getByRole('button', { name: '추가', exact: true }).click()
      await expect(dlg).toBeHidden()
    })
    await test.step('카드 확인', async () => {
      await title('에이전트 카드')
      await ok()
    })
    await test.step('일 시키기 — echo 하나', async () => {
      await title('일을 시켜 보세요')
      const box = page.getByRole('textbox', { name: '도우미에게 보낼 메시지' })
      await box.fill('echo 하나')
      await box.press('Enter')
    })
    await test.step('멈추기 · 자동 → 할 일', async () => {
      await title('멈추기 · 자동')
      await ok()
      await title('할 일은 여기 모여요')
      await ok()
    })
    await test.step('설정 열기 → 설정 안 카드 → 닫기', async () => {
      await title('설정을 열어 보세요')
      await page.getByRole('button', { name: '설정', exact: true }).click()
      const dlg = page.getByRole('dialog', { name: '설정', exact: true })
      await expect(dlg).toBeVisible()
      await title('설정 안에는')
      await expect.poll(lastOverlay).toBe(BG) // 설정 안 카드엔 막이 없다
      // 넓어진 설정 창과 카드가 겹치지 않는다(자리가 모자라면 설정 창이 비킨다)
      await expect
        .poll(async () => {
          const d = await dlg.boundingBox()
          const c = await page.locator('.tour-card').boundingBox()
          return !!d && !!c && (c.x >= d.x + d.width || c.x + c.width <= d.x)
        })
        .toBe(true)
      await ok() // [확인했어요] 가 설정 창을 닫고 끝 카드로 넘어간다
      await expect(dlg).toBeHidden()
    })
    await test.step('끝', async () => {
      await title('준비됐어요')
      await expect(card.getByRole('button', { name: '시작하기' })).toBeVisible()
      await expect.poll(lastOverlay).toBe(VEILED)
      await expect(card.locator('.tour-n')).toHaveText('8 / 8')
      await page.keyboard.press('Escape') // 카드에 초점이 있으면 Esc 로 끝낸다
      await expect(card).toBeHidden()
      await expect.poll(lastOverlay).toBe(BG) // 막이 사라지면 원래 색
    })

    await test.step('받은 답 — 가짜 claude 가 받았다', async () => {
      await expect(page.getByText('받음: echo 하나').first()).toBeVisible()
    })

    await test.step('다시 켜도 투어 없음', async () => {
      await app.close()
      ;({ app, page } = await launch(dir))
      await expect(page.locator('header.top')).toContainText('투어 방')
      await expect(page.locator('.tour-card')).toHaveCount(0)
      await page.waitForTimeout(1500) // 늦게 뜨는 일이 없는지
      await expect(page.locator('.tour-card')).toHaveCount(0)
    })

    await test.step('설정 → 안내 다시 보기 → 방 단계가 방 고르기를 짚는다 → 투어 끝내기', async () => {
      await page.getByRole('button', { name: '설정', exact: true }).click()
      const dlg = page.getByRole('dialog', { name: '설정', exact: true })
      await dlg.getByRole('tab', { name: '두레', exact: true }).click()
      await dlg.getByRole('button', { name: '다시 보기' }).click()
      const c = page.locator('.tour-card')
      await expect(c.locator('.tour-t')).toHaveText('두레에 오신 걸 환영해요')
      await c.getByRole('button', { name: '시작하기' }).click()
      await expect(c.locator('.tour-t')).toHaveText('방')
      const spot = page.locator('.tour-spot')
      await expect(spot).toBeVisible()
      const room = await page.locator('[data-tour="room-switcher"]').boundingBox()
      const hole = await spot.boundingBox()
      expect(room && hole).toBeTruthy()
      expect(hole!.x).toBeLessThanOrEqual(room!.x)
      expect(hole!.y).toBeLessThanOrEqual(room!.y)
      expect(hole!.x + hole!.width).toBeGreaterThanOrEqual(room!.x + room!.width)
      expect(hole!.y + hole!.height).toBeGreaterThanOrEqual(room!.y + room!.height)
      await c.getByRole('button', { name: '투어 끝내기' }).click()
      await expect(c).toBeHidden()
    })
  } finally {
    await app?.close().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
