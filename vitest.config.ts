import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        extends: false,
        test: { name: 'node', environment: 'node', include: ['test/**/*.test.{ts,tsx}'], exclude: ['test/ui/**'] },
      },
      {
        extends: false,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['test/ui/**/*.test.{ts,tsx}'],
          setupFiles: ['test/ui/setup.ts'],
        },
        esbuild: { jsx: 'automatic' },
      },
    ],
  },
})
