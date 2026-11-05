import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { woff2Only } from './scripts/build/woff2Only'
import { mobileIcons } from './scripts/build/mobileIcons'

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
      // index = PC 창 · mobile = 휴대폰(main 의 휴대폰 서버가 out/renderer 를 내어 준다 — public/ 의 sw.js·manifest 도 그 맨 위에)
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), mobile: resolve(__dirname, 'src/renderer/mobile.html') } },
      // 글꼴은 파일로만 — 작은 글꼴 조각을 data: 로 넣으면 CSP font-src 'self' 에 막힌다
      assetsInlineLimit: (file: string) => (/\.woff2?$/.test(file) ? false : undefined),
    },
    plugins: [woff2Only(), react(), mobileIcons(resolve(__dirname, 'resources/icon/mobile'))],
  },
})
