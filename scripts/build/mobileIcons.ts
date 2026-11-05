import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

/** 휴대폰 아이콘(scripts/icon/build.mjs 가 굽는 resources/icon/mobile/*.png) — 매니페스트·알림이 /icons/… 로 부른다 */
export const MOBILE_ICONS = ['dure-192.png', 'dure-512.png', 'dure-badge-96.png'] as const

/** 렌더러 빌드에 휴대폰 아이콘을 icons/ 로 싣는다 — 한 벌(resources/icon/mobile)만 두려고 public 에 사본을 두지 않는다 */
export function mobileIcons(dir: string): Plugin {
  return {
    name: 'dure:mobile-icons',
    apply: 'build',
    generateBundle() {
      for (const f of MOBILE_ICONS) {
        this.emitFile({ type: 'asset', fileName: `icons/${f}`, source: fs.readFileSync(path.join(dir, f)) })
      }
    },
  }
}
