// E2E — 지난 대화: 새 대화 → 지난 대화 탭 → 읽기 → 이 대화로 돌아가기(--resume) → 새 에이전트로 이어 가기(--fork-session).
// 가짜 claude(test/fakeClaude.mjs) + 임시 user-data + 임시 Claude 설정 폴더 — 실제 %APPDATA%/Dure·~/.claude 는 건드리지 않는다.
// 실행: `npm run build` 다음 `npx playwright test e2e/past.spec.ts`.
import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fakeClaude.mjs')

const AGENT = { name: '기획', role: '기획서 · 문구' }

const node = (page: Page, name: string): Locator =>
  page.locator('.react-flow__node').filter({ has: page.locator('.nn b', { hasText: new RegExp(`^${name}$`) }) })
const panel = (page: Page, name: string): Locator => page.locator(`aside.pnl[aria-label="${name}"]`)

/** 가짜 claude 가 남긴 실행 인자들(실행 순서대로) */
function spawnArgvs(log: string): string[][] {
  if (!fs.existsSync(log)) return []
  const out: string[][] = []
  for (const line of fs.readFileSync(log, 'utf8').split(/\r?\n/)) {
    if (!line.includes('"argv"')) continue
    try {
      const j = JSON.parse(line) as { argv?: string[] }
      if (Array.isArray(j.argv)) out.push(j.argv)
    } catch {
      /* 다른 줄 */
    }
  }
  return out
}
const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

test('지난 대화 — 돌아가기 · 새 에이전트로 이어 가기', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-e2e-past-'))
  const userData = path.join(dir, 'userData')
  const claudeDir = path.join(dir, 'claude-config')
  const folder = path.join(dir, 'work')
  const log = path.join(dir, 'fake-claude.log')
  fs.mkdirSync(folder)
  fs.mkdirSync(claudeDir)

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: {
      ...env,
      DURE_CLAUDE_COMMAND: process.execPath,
      DURE_CLAUDE_ARGS: JSON.stringify([FAKE_CLAUDE]),
      FAKE_CLAUDE_LOG: log,
      DURE_USER_DATA: userData,
      DURE_E2E_FOLDERS: JSON.stringify([folder]),
      DURE_NO_DIALOG: '1',
      CLAUDE_CONFIG_DIR: claudeDir,
      FAKE_TRANSCRIPTS: '1',
    },
  })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.waitForLoadState('domcontentloaded')

    // 한 차례 말하고 끝(idle)까지 기다린다 — 일하는 중 보낸 말은 끼어들어 새 차례가 되지 않는다
    const say = async (name: string, text: string): Promise<void> => {
      const box = page.getByRole('textbox', { name: `${name}에게 보낼 메시지` })
      await box.fill(text)
      await box.press('Enter')
      await expect(box).toHaveValue('')
      await expect(panel(page, name).locator('.ci-claude', { hasText: `받음: ${text}` })).toBeVisible({ timeout: 15_000 })
      await expect(node(page, name).locator('.nd')).toHaveAttribute('data-status', 'idle')
    }
    const chat = panel(page, AGENT.name)

    await test.step('방 · 에이전트', async () => {
      await page.getByRole('button', { name: '방 만들기' }).click()
      const room = page.getByRole('dialog', { name: '새 방' })
      await room.getByLabel('이름').fill('지난 대화 방')
      await room.getByRole('button', { name: '만들기', exact: true }).click()
      await expect(room).toBeHidden()
      const opener = page.getByRole('main', { name: '관계도' }).getByRole('button', { name: '추가', exact: true })
      await opener.click()
      const dlg = page.getByRole('dialog', { name: '에이전트 추가' })
      await dlg.getByRole('button', { name: '폴더 고르기' }).click()
      await expect(dlg.getByText(folder, { exact: true })).toBeVisible()
      await dlg.getByLabel('이름').fill(AGENT.name)
      await dlg.getByLabel('역할').fill(AGENT.role)
      await dlg.getByRole('button', { name: '추가', exact: true }).click()
      await expect(dlg).toBeHidden()
      await expect(node(page, AGENT.name)).toBeVisible()
      await expect(chat).toBeVisible()
      await expect(chat.getByRole('tab', { name: /지난 대화/ })).toHaveCount(0) // 지난 대화가 없으면 탭도 없다
    })

    await say(AGENT.name, 'echo 하나')

    await test.step('메뉴 → 새 대화 → 확인', async () => {
      await chat.getByRole('button', { name: '메뉴', exact: true }).click()
      await page.getByRole('menuitem', { name: '새 대화' }).click()
      const ask = page.getByRole('alertdialog')
      await expect(ask).toContainText('지금 대화는 \'지난 대화\'에서 다시 볼 수 있어요.')
      await ask.getByRole('button', { name: '새로 시작', exact: true }).click()
      await expect(ask).toBeHidden()
    })

    await say(AGENT.name, 'echo 둘')

    const pastTab = chat.getByRole('tab', { name: /지난 대화/ })
    const rows = chat.locator('.pc-it')
    await test.step('지난 대화 탭(수 1) → 줄 → 읽기', async () => {
      await expect(pastTab.locator('.ptab-n')).toHaveText('1')
      await pastTab.click()
      await expect(rows).toHaveCount(2)
      await expect(rows.filter({ hasText: '지금' })).toHaveCount(1)
      await rows.filter({ hasText: 'echo 하나' }).click()
      const view = chat.locator('.pc-view')
      await expect(view).toContainText('echo 하나')
      await expect(view).not.toContainText('echo 둘')
      await expect(view.getByRole('button', { name: '목록으로' })).toBeVisible()
    })

    await test.step('이 대화로 돌아가기 → 대화 탭', async () => {
      await chat.getByRole('button', { name: '이 대화로 돌아가기' }).click()
      await expect(chat.getByRole('tab', { name: '대화', exact: true })).toHaveAttribute('aria-selected', 'true')
      const conv = chat.locator('section.conv')
      await expect(conv).toContainText('echo 하나')
      await expect(conv).toContainText('이 대화로 돌아왔어요')
      await expect(conv).not.toContainText('echo 둘')
    })

    const firstSession = flag(spawnArgvs(log)[0], '--session-id')
    expect(firstSession).toBeTruthy()

    await say(AGENT.name, 'echo 셋')
    await test.step('다음 실행은 --resume <첫 세션>', async () => {
      await expect.poll(() => spawnArgvs(log).some((a) => flag(a, '--resume') === firstSession)).toBe(true)
      const last = spawnArgvs(log).at(-1)!
      expect(flag(last, '--resume')).toBe(firstSession)
      expect(last).not.toContain('--fork-session')
    })

    await test.step('지난 대화 → 줄 → 새 에이전트로 이어 가기', async () => {
      await pastTab.click()
      await expect(rows).toHaveCount(2)
      const past = rows.filter({ hasNot: page.locator('.pc-cur') })
      await expect(past).toHaveCount(1)
      await expect(past).toContainText('echo 둘')
      await past.click()
      await expect(chat.locator('.pc-view')).toContainText('echo 둘')
      await chat.getByRole('button', { name: '새 에이전트로 이어 가기' }).click()
      const dlg = page.getByRole('dialog', { name: '새 에이전트로 이어 가기' })
      await expect(dlg).toContainText('원래 에이전트와 같은 폴더예요')
      await expect(dlg.getByRole('button', { name: '폴더 고르기' })).toHaveCount(0)
      await expect(dlg.getByLabel('이름')).toHaveValue(`${AGENT.name} 2`)
      await dlg.getByRole('button', { name: '추가', exact: true }).click()
      await expect(dlg).toBeHidden()
    })

    const forked = `${AGENT.name} 2`
    await test.step('새 카드가 골라지고 복사한 줄 + 이어 만들었어요', async () => {
      await expect(node(page, forked)).toBeVisible()
      const p = panel(page, forked)
      await expect(p).toBeVisible()
      await expect(p.locator('section.conv')).toContainText('echo 둘')
      await expect(p.locator('section.conv')).toContainText(new RegExp(`${AGENT.name}의 \\d+월 \\d+일 대화에서 이어 만들었어요`))
      await expect(p.locator('section.conv')).not.toContainText('echo 셋')
    })

    await say(forked, 'echo 넷')
    await test.step('첫 실행은 --resume <원래 세션> --fork-session --session-id <새 id>', async () => {
      const fork = spawnArgvs(log).find((a) => a.includes('--fork-session'))
      expect(fork).toBeTruthy()
      const source = flag(fork!, '--resume') ?? ''
      expect(source).toBeTruthy()
      expect(source).not.toBe(firstSession) // 둘째 대화(echo 둘)의 세션이다
      expect(flag(fork!, '--session-id')).toBeTruthy()
      expect(flag(fork!, '--session-id')).not.toBe(source)
    })

    expect(pageErrors).toEqual([])
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
