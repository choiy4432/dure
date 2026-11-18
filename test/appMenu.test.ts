import { describe, it, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from '../src/main/appMenu'

const roles = (items: MenuItemConstructorOptions[]) => items.map((m) => m.role)
const submenuRoles = (m: MenuItemConstructorOptions | undefined) =>
  (Array.isArray(m?.submenu) ? m.submenu : []).filter((x) => x.type !== 'separator').map((x) => x.role)

describe('appMenuTemplate — 앱 메뉴', () => {
  it('win32_는_null — 지금처럼 메뉴를 건드리지 않는다(Menu.setApplicationMenu 를 부르지 않는다)', () => {
    expect(appMenuTemplate('win32')).toBeNull()
    expect(appMenuTemplate('linux')).toBeNull()
  })

  it('darwin_은_edit_역할(복사·붙여넣기)이_있다 — 없으면 입력칸에서 Cmd+C/V/A 가 안 된다', () => {
    const t = appMenuTemplate('darwin')!
    expect(roles(t)).toEqual(['appMenu', 'editMenu', 'windowMenu'])
    const edit = t.find((m) => m.role === 'editMenu')
    expect(submenuRoles(edit)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'])
  })

  it('darwin — 앱 메뉴는 기본 역할(두레 정보·숨기기·끝내기 Cmd+Q → before-quit 의 끄는 길) · 창 메뉴에 닫기(Cmd+W → 창 닫기 = 숨기기)', () => {
    const t = appMenuTemplate('darwin')!
    // appMenu 는 Electron 기본 묶음(about·services·hide·hideOthers·unhide·quit)을 쓴다 — 끝내기는 app.quit() 이라 before-quit 을 지난다
    expect(t[0]).toEqual({ role: 'appMenu' })
    const win = t.find((m) => m.role === 'windowMenu')
    expect(submenuRoles(win)).toEqual(['minimize', 'zoom', 'close', 'front'])
    // 다시 불러오기·개발자 도구(Electron 기본 메뉴의 보기 묶음)는 싣지 않는다
    const all = JSON.stringify(t)
    for (const bad of ['reload', 'forceReload', 'toggleDevTools', 'viewMenu']) expect(all).not.toContain(bad)
  })
})
