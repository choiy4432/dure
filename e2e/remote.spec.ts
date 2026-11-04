// E2E — 서버(SSH) 방: 새 방(서버) → 에이전트 추가(서버 폴더 확인) → 대화 → 첨부(서버로 올리기) → 새 대화(서버 정리) → 에이전트 지우기(첨부 정리).
// 가짜 ssh(test/fakeSsh.mjs) + 가짜 claude + 임시 HOME(.ssh/config) + 임시 user-data — 실제 ~/.ssh·%APPDATA%/Dure 는 건드리지 않는다.
// 실행: `npm run build` 다음 `npx playwright test e2e/remote.spec.ts`.
import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { markOnboarded } from './onboarded'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fakeClaude.mjs')
const FAKE_SSH = path.join(ROOT, 'test', 'fakeSsh.mjs')

const AGENT = { name: '서버일꾼', role: '웹 · 서버' }
const ATTACH_TEXT = '이 파일 봐 주세요'
const BIN_NAME = 'bytes.bin'
/** 0x00·0x1A·CRLF·0xFF 가 섞인 바이트(0..255 + \r\n) — 올리기(ssh stdin)가 바이트를 바꾸지 않는지 */
const BIN_BYTES = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('\r\n')])

const node = (page: Page, name: string): Locator =>
  page.locator('.react-flow__node').filter({ has: page.locator('.nn b', { hasText: new RegExp(`^${name}$`) }) })
const panel = (page: Page, name: string): Locator => page.locator(`aside.pnl[aria-label="${name}"]`)

interface SshLine {
  event?: string
  kind?: string
  argv?: string[]
  script?: string
}
function sshLines(log: string): SshLine[] {
  if (!fs.existsSync(log)) return []
  const out: SshLine[] = []
  for (const line of fs.readFileSync(log, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as SshLine)
    } catch {
      /* 다른 줄 */
    }
  }
  return out
}

test('서버(SSH) 방 — 만들기 · 에이전트 추가 · 대화 · 첨부 · 새 대화 정리 · 지우기', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-e2e-remote-'))
  const userData = path.join(dir, 'userData')
  const fakeHome = path.join(dir, 'home')
  const serverRoot = path.join(dir, 'server')
  const claudeDir = path.join(dir, 'claude-config')
  const claudeLog = path.join(dir, 'fake-claude.log')
  const sshLog = path.join(dir, 'fake-ssh.log')
  const picks = path.join(dir, 'picks')
  let agentId = ''
  fs.mkdirSync(picks)
  fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(fakeHome, '.ssh', 'config'), 'Host dev\n  HostName 10.0.0.12\n  User a\n')
  fs.mkdirSync(path.join(serverRoot, 'home', 'a', 'web'), { recursive: true })
  fs.mkdirSync(claudeDir)
  markOnboarded(userData) // 안내 투어·승인 한 번은 이 시험의 일이 아니다

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const sshEnv = { FAKE_SSH_ROOT: serverRoot, FAKE_SSH_LOG: sshLog }
  const app = await electron.launch({
    args: [MAIN],
    cwd: ROOT,
    env: {
      ...env,
      DURE_CLAUDE_COMMAND: process.execPath,
      DURE_CLAUDE_ARGS: JSON.stringify([FAKE_CLAUDE]),
      FAKE_CLAUDE_LOG: claudeLog,
      DURE_SSH_COMMAND: process.execPath,
      DURE_SSH_ARGS: JSON.stringify([FAKE_SSH]),
      ...sshEnv,
      USERPROFILE: fakeHome,
      HOME: fakeHome,
      DURE_USER_DATA: userData,
      DURE_E2E_FOLDERS: JSON.stringify([]),
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

    await test.step('새 방 → 서버(SSH) → dev → 접속됨 → 만들기', async () => {
      await page.getByRole('button', { name: '방 만들기' }).click()
      const room = page.getByRole('dialog', { name: '새 방' })
      await room.getByLabel('이름').fill('서버 방')
      await room.getByRole('radiogroup', { name: '어디서 일하나요' }).getByRole('radio', { name: '서버(SSH)' }).click()
      await room.locator('button.srv-sel').click()
      await page.getByRole('option', { name: /^dev/ }).click()
      await expect(room.getByText('접속됨 · claude 2.1.304')).toBeVisible({ timeout: 15_000 })
      await room.getByRole('button', { name: '만들기', exact: true }).click()
      await expect(room).toBeHidden()
      await expect(page.locator('.srv-tag, header').getByText('dev', { exact: true }).first()).toBeVisible()
    })

    await test.step('에이전트 추가 — 서버 폴더 확인', async () => {
      const opener = page.getByRole('main', { name: '관계도' }).getByRole('button', { name: '추가', exact: true })
      await opener.click()
      const dlg = page.getByRole('dialog', { name: '에이전트 추가' })
      await dlg.getByLabel('폴더', { exact: true }).fill('/home/a/web')
      await dlg.getByRole('button', { name: '확인', exact: true }).click()
      await expect(dlg.getByText('폴더가 있어요 · claude 2.1.304')).toBeVisible({ timeout: 15_000 })
      await dlg.getByLabel('이름').fill(AGENT.name)
      await dlg.getByLabel('역할').fill(AGENT.role)
      await dlg.getByRole('button', { name: '추가', exact: true }).click()
      await expect(dlg).toBeHidden()
      await expect(node(page, AGENT.name)).toBeVisible()
    })

    const chat = panel(page, AGENT.name)
    await test.step('echo 하나 → 받음', async () => {
      const box = page.getByRole('textbox', { name: `${AGENT.name}에게 보낼 메시지` })
      await box.fill('echo 하나')
      await box.press('Enter')
      await expect(chat.locator('.ci-claude', { hasText: '받음: echo 하나' })).toBeVisible({ timeout: 20_000 })
      await expect(node(page, AGENT.name).locator('.nd')).toHaveAttribute('data-status', 'idle')
    })

    await test.step('첨부 — 서버로 올라간 바이트 그대로 · 경로 줄은 서버 경로 · 파일 칩', async () => {
      const snap = (await page.evaluate(() => (window as unknown as { dure: { snapshot(): Promise<unknown> } }).dure.snapshot())) as {
        agents: { id: string; name: string }[]
      }
      agentId = snap.agents.find((a) => a.name === AGENT.name)!.id
      const original = path.join(picks, BIN_NAME)
      fs.writeFileSync(original, BIN_BYTES)
      await chat.locator('input[type="file"]').setInputFiles(original)
      await expect(chat.locator('.atts .att-file')).toHaveCount(1)
      const box = page.getByRole('textbox', { name: `${AGENT.name}에게 보낼 메시지` })
      await box.fill(ATTACH_TEXT)
      await box.press('Enter')
      await expect(chat.locator('.ci-claude', { hasText: `받음: ${ATTACH_TEXT}` })).toBeVisible({ timeout: 20_000 })

      // 올리기 한 번 — 그 에이전트 폴더에 그 사본 이름으로, 바이트 그대로
      const uploads = sshLines(sshLog).filter((l) => l.event === 'upload')
      expect(uploads).toHaveLength(1)
      const { file } = uploads[0] as { agentId?: string; file?: string; bytes?: number; partial?: boolean }
      expect(uploads[0]).toMatchObject({ agentId, bytes: BIN_BYTES.length })
      expect(file).toMatch(/^\d{8}-\d{6}-bytes\.bin$/)
      const onServer = path.join(serverRoot, 'home', 'a', '.dure', 'attachments', agentId, file!)
      expect(fs.readFileSync(onServer).equals(BIN_BYTES)).toBe(true)
      // 이 PC 사본도 같은 이름으로 남는다(대화의 칩이 연다)
      expect(fs.readFileSync(path.join(userData, 'attachments', agentId, file!)).equals(BIN_BYTES)).toBe(true)

      // Claude 에게 간 경로 줄 — 서버 경로(서버의 $HOME 을 펼친 것)
      const sent = fs
        .readFileSync(claudeLog, 'utf8')
        .split(/\r?\n/)
        .flatMap((l) => {
          try {
            const m = JSON.parse(l) as { type?: string; message?: { content?: { type?: string; text?: string }[] } }
            return m.type === 'user' && Array.isArray(m.message?.content) ? [m.message!.content!.map((c) => c.text ?? '')] : []
          } catch {
            return []
          }
        })
        .find((texts) => texts[0] === ATTACH_TEXT)
      expect(sent).toEqual([ATTACH_TEXT, `\n\n첨부 파일:\n- /home/a/.dure/attachments/${agentId}/${file}`])

      const me = chat.locator('.me', { hasText: ATTACH_TEXT })
      await expect(me.locator('.me-file')).toHaveCount(1)
      await expect(me.locator('.me-file')).toHaveAttribute('aria-label', new RegExp(`^${BIN_NAME.replace('.', '\\.')} .* · ${BIN_BYTES.length} B$`))
    })

    await test.step('띄우기 — -R · BatchMode · 토큰 없음', async () => {
      const launches = sshLines(sshLog).filter((l) => l.event === 'start' && l.kind === 'launch')
      expect(launches.length).toBeGreaterThan(0)
      const l = launches[0]
      const argv = l.argv ?? []
      expect(argv).toContain('-R')
      expect(argv.join(' ')).toContain('BatchMode=yes')
      const all = JSON.stringify(argv) + (l.script ?? '')
      expect(all).not.toContain('Bearer')
      // mcp__dure__* 는 도구 이름이다 — 토큰·MCP 설정(JSON·주소·Authorization)이 인자에 없어야 한다
      expect(all).not.toContain('mcpServers')
      expect(all).not.toContain('Authorization')
      expect(all).not.toMatch(/"?(type|url)"?\s*:\s*"?(http|sse)/)
      expect(all).not.toMatch(/--mcp-config\s+'?\{/)
    })

    await test.step('메뉴 → 새 대화 → 서버 정리', async () => {
      await chat.getByRole('button', { name: '메뉴', exact: true }).click()
      await page.getByRole('menuitem', { name: '새 대화' }).click()
      const ask = page.getByRole('alertdialog')
      await ask.getByRole('button', { name: '새로 시작', exact: true }).click()
      await expect(ask).toBeHidden()
      await expect
        .poll(() => sshLines(sshLog).some((l) => l.event === 'start' && l.kind === 'cleanup'), { timeout: 15_000 })
        .toBe(true)
    })

    await test.step('에이전트 지우기 → 서버·이 PC 첨부 폴더 정리', async () => {
      const serverDir = path.join(serverRoot, 'home', 'a', '.dure', 'attachments', agentId)
      expect(fs.existsSync(serverDir)).toBe(true)
      await chat.getByRole('button', { name: '메뉴', exact: true }).click()
      await page.getByRole('menuitem', { name: '지우기' }).click()
      const ask = page.getByRole('alertdialog')
      await ask.getByRole('button', { name: '지우기', exact: true }).click()
      await expect(ask).toBeHidden()
      await expect(node(page, AGENT.name)).toHaveCount(0)
      await expect
        .poll(() => sshLines(sshLog).some((l) => l.event === 'attachments-cleanup' && (l as { agentId?: string }).agentId === agentId), { timeout: 15_000 })
        .toBe(true)
      expect(fs.existsSync(serverDir)).toBe(false)
      expect(fs.existsSync(path.join(userData, 'attachments', agentId))).toBe(false)
    })

    expect(pageErrors).toEqual([])
  } finally {
    await app.close().catch(() => undefined)
    spawnSync(process.execPath, [FAKE_SSH, '--fake-reap'], { env: { ...process.env, ...sshEnv }, timeout: 20_000 })
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
