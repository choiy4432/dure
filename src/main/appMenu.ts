// 앱 메뉴 — electron 없이 시험할 수 있게 틀(template)만 만든다(index.ts 가 Menu.buildFromTemplate 으로 단다. electron 은 타입만)
import type { MenuItemConstructorOptions } from 'electron'
import type { Platform } from '../engine/platform'

/**
 * 앱 메뉴 틀 — win32 는 null(지금처럼 메뉴를 건드리지 않는다).
 * darwin 은 기본 역할 메뉴(영어 — 한국어화는 나중): 앱(두레 정보·숨기기·끝내기 — Cmd+Q 는 app.quit() 이라 before-quit 의 끄는 길을 지난다) ·
 * 편집(없으면 입력칸에서 Cmd+C/V/X/A/Z 가 안 된다) · 창(최소화·확대·닫기 — Cmd+W 는 창 닫기 = 숨기기).
 * Electron 기본 메뉴의 보기 묶음(다시 불러오기·개발자 도구)은 싣지 않는다
 */
export function appMenuTemplate(p: Platform): MenuItemConstructorOptions[] | null {
  if (p !== 'darwin') return null
  return [
    { role: 'appMenu' },
    {
      role: 'editMenu',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      role: 'windowMenu',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }],
    },
  ]
}
