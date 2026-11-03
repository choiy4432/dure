// E2E — 준비 화면: claude 가 없는 PC 를 흉내 내(PATH·USERPROFILE 을 빈 임시 폴더로) 띄우고, 가짜 설치(test/fakeInstall.mjs)가 실패하는 길을 따라간다.
// 설치 성공·로그인은 단위 시험(setupFlow)과 Windows Sandbox 에서 본다.
import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { markOnboarded } from './onboarded'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const FAKE_INSTALL = path.join(ROOT, 'test', 'fakeInstall.mjs')

test('claude 없음 → 준비 화면 → [설치] → 줄·실패 글 → [다시 시도] 가 다시 부른다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-e2e-setup-'))
  const userData = path.join(dir, 'userData')
  const fakeHome = path.join(dir, 'home')
  const emptyBin = path.join(dir, 'bin')
  const installLog = path.join(dir, 'install.log')
  fs.mkdirSync(fakeHome)
  fs.mkdirSync(emptyBin)
  markOnboarded(userData) // 투어는 이 시험의 일이 아니다
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.DURE_CLAUDE_COMMAND
  delete env.DURE_CLAUDE_ARGS
  delete env.Path // Windows 는 PATH/Path 가 한 칸 — 대소문자 두 개가 남지 않게
  Object.assign(env, {
    PATH: emptyBin,
    USERPROFILE: fakeHome,
    HOME: fakeHome,
    DURE_USER_DATA: userData,
    DURE_NO_DIALOG: '1',
    DURE_SETUP_INSTALL: JSON.stringify([process.execPath, FAKE_INSTALL]),
    FAKE_INSTALL_CODE: '1',
    FAKE_INSTALL_LOG: installLog,
  })
  const runs = () => (fs.existsSync(installLog) ? fs.readFileSync(installLog, 'utf8').split('\n').filter(Boolean).length : 0)
  const app = await electron.launch({ args: [MAIN], env, cwd: ROOT })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByRole('heading', { name: '준비가 두 가지 필요해요' })).toBeVisible()
    await page.getByRole('button', { name: '설치', exact: true }).click()
    const log = page.getByRole('log', { name: '설치 진행' })
    await expect(log).toContainText('가짜 설치: 내려받는 중')
    await expect(page.getByText('설치하지 못했어요')).toBeVisible()
    await expect(log).toContainText('가짜 설치: 마무리')
    expect(runs()).toBe(1)
    await page.getByRole('button', { name: '다시 시도' }).click()
    await expect.poll(runs).toBe(2)
    await expect(page.getByText('설치하지 못했어요')).toBeVisible()
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
