import { defineConfig } from '@playwright/test'

// E2E — 빌드된 앱(out/)을 가짜 claude 로 띄운다. 먼저 `npm run build`.
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
})
