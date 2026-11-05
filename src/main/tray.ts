// 트레이 — 휴대폰 연결을 켜 둔 동안만 있다. 그동안 창을 닫으면(×) 두레는 끄지 않고 창을 숨긴다(설계 §4.4).
// electron 없이 시험할 수 있게 Tray·창·알림은 주입한다(index.ts 가 진짜를 끼운다)

/** 트레이 메뉴 — 이 차례로 */
export const TRAY_MENU = { open: '두레 열기', phoneOff: '휴대폰 연결 끄기', quit: '두레 끄기' } as const
/** 트레이 아이콘에 마우스를 올리면 */
export const TRAY_TOOLTIP = '두레 · 휴대폰 연결 켜짐'
/** 처음 숨을 때 한 번 — Windows 알림 본문(제목은 '두레') */
export const TRAY_TIP = '두레는 트레이에서 계속 돌아요'

export type CloseAction = 'hide' | 'close'

/**
 * 창 'close' 를 받았을 때 — 휴대폰 연결이 켜져 있으면 숨기고, 꺼져 있으면 지금처럼 닫는다(마지막 창 → 두레 끄기).
 * 끄는 중(두레 끄기·업데이트 설치 정리 뒤 app.quit)이면 켜져 있어도 닫는다 — 막으면 끄기·설치가 멈춘다
 */
export function closeDecision(o: { phoneOn: boolean; quitting: boolean }): CloseAction {
  return o.phoneOn && !o.quitting ? 'hide' : 'close'
}

/**
 * 숨겨 시작(로그인 항목의 --hidden) — 창을 띄우지 않아도 될 때만 true.
 * 휴대폰 연결이 켜져 있고 트레이가 정말 있어야 한다(new Tray 가 던지면 기록만 남아 창도 트레이도 없는 두레가 된다).
 * 창이 생기기 전(엔진 준비 중)에 두레를 또 켰으면(showRequested) 그 요청대로 보인다
 */
export function startHidden(o: {
  launchedHidden: boolean
  phoneOn: boolean
  trayActive: boolean
  showRequested: boolean
}): boolean {
  return o.launchedHidden && o.phoneOn && o.trayActive && !o.showRequested
}

export interface TrayMenuItem {
  label: string
  click(): void
}

/** 트레이를 만들 때 넘기는 것 — 진짜는 Tray(앱 아이콘) + setToolTip + setContextMenu + 'click' */
export interface TraySpec {
  tooltip: string
  menu: TrayMenuItem[]
  /** 아이콘을 눌렀을 때 */
  onClick(): void
}

export interface TrayLike {
  destroy(): void
}

export interface TrayControlOptions {
  makeTray(spec: TraySpec): TrayLike
  /** 창을 보이고 앞으로(숨었으면 보이고, 최소화면 되살린다) — focusExisting */
  showWindow(): void
  /** 창이 지금 보이나 — 트레이가 없어질 때 숨은 창을 다시 보이려고 */
  isWindowVisible(): boolean
  /** 휴대폰 연결 끄기 — phone.set({ enabled: false }) */
  phoneOff(): void
  /** 두레 끄기 — app.quit()(before-quit 의 끄는 길 그대로) */
  quit(): void
  /** 처음 숨을 때 안내 — 한 번은 trayTipOnce 가 기억한다 */
  notifyOnce(): void
  /** 기본 console.error — 고정된 글만 */
  log?: (...args: unknown[]) => void
}

export interface TrayControl {
  /** 휴대폰 연결 켜짐/꺼짐에 맞춘다 — 켜지면 트레이를 만들고, 꺼지면 없앤다(그때 창이 숨어 있으면 보인다) */
  sync(phoneOn: boolean): void
  /** 트레이가 지금 있나 — 켜져 있어도 만들기가 실패했으면 false(숨겨 시작이 이걸 본다) */
  active(): boolean
  /**
   * 창 'close' — closeDecision 이 hide 면 막고(preventDefault) 숨긴 뒤 처음 한 번 안내.
   * 숨긴 창엔 늘 트레이가 있다: 켜기가 도는 중이라 아직 트레이가 없으면 여기서 만들고, 못 만들면 숨기지 않고 닫는다
   */
  close(e: { preventDefault(): void }, o: { phoneOn: boolean; quitting: boolean; hide(): void }): CloseAction
  /** 두레를 끌 때 — 트레이를 거두고, 그 뒤엔 다시 만들지 않는다. 여러 번 불러도 한 번 */
  dispose(): void
}

export function createTrayControl(o: TrayControlOptions): TrayControl {
  const log = o.log ?? console.error
  let tray: TrayLike | null = null
  let disposed = false

  /** 트레이 메뉴·누름에서 던져도 main 이 오류 상자를 띄우지 않게 — 기록만 */
  const safely = (what: string, f: () => void): void => {
    try {
      f()
    } catch {
      log(`[두레] 트레이 — ${what}에 실패했어요`)
    }
  }

  const spec: TraySpec = {
    tooltip: TRAY_TOOLTIP,
    onClick: () => safely('창 열기', o.showWindow),
    menu: [
      { label: TRAY_MENU.open, click: () => safely('창 열기', o.showWindow) },
      { label: TRAY_MENU.phoneOff, click: () => safely('휴대폰 연결 끄기', o.phoneOff) },
      { label: TRAY_MENU.quit, click: () => safely('두레 끄기', o.quit) },
    ],
  }

  /** 트레이가 있게 — 있으면 true */
  const ensure = (): boolean => {
    if (disposed) return false
    if (!tray) safely('만들기', () => (tray = o.makeTray(spec)))
    return tray !== null
  }

  /** 트레이를 거둔다 — 있었으면 true */
  const remove = (): boolean => {
    const t = tray
    tray = null
    if (t) safely('거두기', () => t.destroy())
    return t !== null
  }

  return {
    sync(phoneOn) {
      if (disposed) return
      if (phoneOn) {
        ensure()
        return
      }
      // 트레이가 있다가 없어질 때만 — 숨은 창을 보인다(트레이도 창도 없는 두레가 되지 않게).
      // 처음부터 없었으면(꺼진 채 시작) 창을 건드리지 않는다 — 화면이 뜨기 전(ready-to-show)에 보이지 않게
      if (remove()) safely('창 보이기', () => {
        if (!o.isWindowVisible()) o.showWindow()
      })
    },

    active: () => tray !== null,

    close(e, c) {
      if (closeDecision(c) === 'close' || !ensure()) return 'close'
      e.preventDefault()
      c.hide()
      safely('첫 안내', o.notifyOnce)
      return 'hide'
    },

    dispose() {
      if (disposed) return
      disposed = true
      remove()
    },
  }
}

/**
 * 처음 숨을 때 안내를 한 번만 — 본 적 있으면(appPrefs.trayTipSeen) 띄우지 않고, 띄우면 써 둔다.
 * 이번 실행에선 한 번만 해 본다(알림·써 두기가 실패해도 숨길 때마다 또 하지 않는다). 알림이 실패하면 써 두지 않는다 — 다음 실행에 다시
 */
export function trayTipOnce(o: {
  seen(): boolean
  markSeen(): void
  notify(): void
  log?: (...args: unknown[]) => void
}): () => void {
  const log = o.log ?? console.error
  let tried = false
  return () => {
    if (tried) return
    tried = true
    try {
      if (o.seen()) return
      o.notify()
    } catch {
      log('[두레] 트레이 첫 안내를 띄우지 못했어요')
      return
    }
    try {
      o.markSeen()
    } catch {
      log('[두레] 트레이 첫 안내를 본 것으로 적어 두지 못했어요')
    }
  }
}
