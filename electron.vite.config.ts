import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
  },
  preload: {
    // sandboxed preload must be CommonJS (package.json is type: module, so .cjs)
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      // 글꼴은 파일로만 — 작은 글꼴 조각을 data: 로 넣으면 CSP font-src 'self' 에 막힌다
      assetsInlineLimit: (file: string) => (/\.woff2?$/.test(file) ? false : undefined),
    },
    plugins: [react()],
  },
})
