// E2E — 이 PC 방 파일 첨부: 고르기(숨은 file input) → 칩 → 보내기 → Claude 에게 간 글의 '첨부 파일:' 경로 줄 = 사본의 절대 경로
// (<userData>/attachments/<에이전트>/), 사본 바이트 = 원본, 원본은 그대로, 띄울 때 그 폴더를 --add-dir, 대화의 내 말에 파일 칩.
// 가짜 claude(test/fakeClaude.mjs) + 임시 user-data·폴더 — %APPDATA%/Dure 는 건드리지 않는다.
// 실행: `npm run build` 다음 `npx playwright test e2e/attach.spec.ts`.
import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { markOnboarded } from './onboarded'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fakeClaude.mjs')

const AGENT = { name: '정리', role: '회의록 정리' }
const FILE_NAME = '회의 메모.txt'
/** 한글 · CRLF · 탭 · 0x1A — 사본이 바이트 그대로인지 */
const FILE_BYTES = Buffer.concat([Buffer.from('첫 줄 ATTACH-E2E-1\r\n둘째 줄\t끝\r\n', 'utf8'), Buffer.from([0x1a, 0x00, 0xff, 0x0a])])
const TEXT = '이 메모 정리해 주세요'

const node = (page: Page, name: string): Locator =>
  page.locator('.react-flow__node').filter({ has: page.locator('.nn b', { hasText: new RegExp(`^${name}$`) }) })
const panel = (page: Page, name: string): Locator => page.locator(`aside.pnl[aria-label="${name}"]`)

/** 가짜 claude 기록의 줄들(JSON 만) */
function logLines(log: string): Record<string, unknown>[] {
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split(/\r?\n/)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

/** 사용자 줄 중 '첨부 파일:' 글 블록이 든 것 — 그 줄의 글 블록들과 경로들 */
function attachSends(log: string): { texts: string[]; paths: string[] }[] {
  const out: { texts: string[]; paths: string[] }[] = []
  for (const l of logLines(log)) {
    const content = (l.message as { content?: unknown } | undefined)?.content
    if (l.type !== 'user' || !Array.isArray(content)) continue
    const texts = (content as { type?: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '')
    const block = texts.find((t) => t.startsWith('\n\n첨부 파일:\n'))
    if (!block) continue
    out.push({ texts, paths: block.split('\n').filter((s) => s.startsWith('- ')).map((s) => s.slice(2)) })
  }
  return out
}

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

test('이 PC 방 — 파일 첨부: 사본 경로 줄 · 바이트 그대로 · --add-dir · 대화의 파일 칩', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-e2e-attach-'))
  const userData = path.join(dir, 'userData')
  const folder = path.join(dir, 'work')
  const picks = path.join(dir, 'picks')
  const log = path.join(dir, 'fake-claude.log')
  fs.mkdirSync(folder)
  fs.mkdirSync(picks)
  const original = path.join(picks, FILE_NAME)
  fs.writeFileSync(original, FILE_BYTES)
  markOnboarded(userData) // 안내 투어·승인 한 번은 이 시험의 일이 아니다

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
    },
  })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.waitForLoadState('domcontentloaded')

    await test.step('방 · 에이전트 하나', async () => {
      await page.getByRole('button', { name: '방 만들기' }).click()
      const room = page.getByRole('dialog', { name: '새 방' })
      await room.getByLabel('이름').fill('첨부 방')
      await room.getByRole('button', { name: '만들기', exact: true }).click()
      await expect(room).toBeHidden()
      await page.getByRole('main', { name: '관계도' }).getByRole('button', { name: '추가', exact: true }).click()
      const dlg = page.getByRole('dialog', { name: '에이전트 추가' })
      await dlg.getByRole('button', { name: '폴더 고르기' }).click()
      await expect(dlg.getByText(folder, { exact: true })).toBeVisible()
      await dlg.getByLabel('이름').fill(AGENT.name)
      await dlg.getByLabel('역할').fill(AGENT.role)
      await dlg.getByRole('button', { name: '추가', exact: true }).click()
      await expect(dlg).toBeHidden()
      await node(page, AGENT.name).locator('.nh').click()
      await expect(panel(page, AGENT.name)).toBeVisible()
    })

    const chat = panel(page, AGENT.name)
    await test.step('고르기 → 파일 칩 → 보내기', async () => {
      await chat.locator('input[type="file"]').setInputFiles(original)
      const chip = chat.locator('.atts .att-file')
      await expect(chip).toHaveCount(1)
      await expect(chip).toContainText(`${FILE_BYTES.length} B`)
      await expect(chat.getByRole('button', { name: `${FILE_NAME} 빼기` })).toBeVisible()
      const box = page.getByRole('textbox', { name: `${AGENT.name}에게 보낼 메시지` })
      await box.fill(TEXT)
      await box.press('Enter')
      await expect(box).toHaveValue('')
      await expect(chat.locator('.atts .att-file')).toHaveCount(0) // 보낸 칩은 입력창에서 빠진다
      await expect(chat.locator('.ci-claude', { hasText: `받음: ${TEXT}` })).toBeVisible({ timeout: 20_000 })
    })

    await test.step('Claude 에게 간 글 — 사람 글 뒤 첨부 파일: 경로 줄 = 사본(바이트 그대로) · 원본은 그대로', async () => {
      const snap = (await page.evaluate(() => (window as unknown as { dure: { snapshot(): Promise<unknown> } }).dure.snapshot())) as {
        agents: { id: string; name: string }[]
      }
      const id = snap.agents.find((a) => a.name === AGENT.name)!.id
      await expect.poll(() => attachSends(log).length).toBe(1)
      const [sent] = attachSends(log)
      expect(sent.texts[0]).toBe(TEXT) // 사람 글이 먼저, 경로 줄은 맨 끝 블록
      expect(sent.paths).toHaveLength(1)
      const copy = sent.paths[0]
      const attachDir = path.join(userData, 'attachments', id)
      expect(path.isAbsolute(copy)).toBe(true)
      expect(same(path.dirname(copy), attachDir)).toBe(true)
      expect(path.basename(copy)).toMatch(/^\d{8}-\d{6}-회의 메모\.txt$/) // 시각 접두 + 원래 이름
      expect(fs.readFileSync(copy).equals(FILE_BYTES)).toBe(true)
      expect(fs.readFileSync(original).equals(FILE_BYTES)).toBe(true) // 원본은 읽기만
      expect(fs.readdirSync(picks)).toEqual([FILE_NAME])

      // 띄울 때 그 첨부 폴더를 --add-dir 로 — Read 가 승인 없이 읽는다(probe27 A1)
      const launches = logLines(log).filter((l) => Array.isArray(l.argv)) as { argv: string[] }[]
      expect(launches.length).toBeGreaterThan(0)
      const argv = launches[launches.length - 1].argv
      const at = argv.indexOf('--add-dir')
      expect(at).toBeGreaterThanOrEqual(0)
      expect(same(argv[at + 1], attachDir)).toBe(true)
    })

    await test.step('대화의 내 말 — 파일 칩(이름 · 크기)', async () => {
      const me = chat.locator('.me', { hasText: TEXT })
      const file = me.locator('.me-file')
      await expect(file).toHaveCount(1)
      await expect(file).toHaveAttribute('aria-label', `${FILE_NAME} 열기 · ${FILE_BYTES.length} B`)
      await expect(me).not.toContainText('첨부 파일:') // 경로 줄은 Claude 에게만 — 화면엔 칩
    })

    expect(pageErrors).toEqual([])
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
