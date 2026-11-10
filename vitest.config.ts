import { defineConfig } from 'vitest/config'

// 전체 시험을 한꺼번에 돌리면 CPU 가 모자라 시간 초과로 흔들린다 — 시험·훅 상한을 넉넉히(안전망).
// 고정 시간 기다림이 원인이던 시험은 시험 쪽에서 결과를 기다리게 고쳤다(예: tourLayer 의 settingsStepPointsAtTabs)
const TIMEOUTS = { testTimeout: 30_000, hookTimeout: 30_000 }

export default defineConfig({
  test: {
    // 가짜 claude·ssh 를 띄우는 시험이 많아 파일을 너무 많이 한꺼번에 돌리면 CPU 를 다투다 시간 초과로 흔들린다 — 동시에 도는 파일 수를 줄인다
    maxWorkers: 6,
    projects: [
      {
        extends: false,
        test: { name: 'node', environment: 'node', include: ['test/**/*.test.{ts,tsx}'], exclude: ['test/ui/**'], ...TIMEOUTS },
      },
      {
        extends: false,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['test/ui/**/*.test.{ts,tsx}'],
          setupFiles: ['test/ui/setup.ts'],
          ...TIMEOUTS,
        },
        esbuild: { jsx: 'automatic' },
      },
    ],
  },
})
