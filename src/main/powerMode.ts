/** 파워 모드의 창 쪽 일 — 전체 화면 + 화면 꺼짐 막기. 끄면 켜기 전 모양(최대화·전체 화면)으로 돌린다 */
type PowerWin = {
  isFullScreen(): boolean
  isMaximized(): boolean
  setFullScreen(v: boolean): void
  maximize(): void
  show(): void
  focus(): void
}

export type PowerDeps = {
  win: () => PowerWin | null
  /** 진짜는 powerSaveBlocker 'prevent-display-sleep' */
  blocker: { start(): number; stop(id: number): void }
}

export function createPowerMode(deps: PowerDeps): { set(on: boolean): void; isOn(): boolean; release(): void; setVisible(visible: boolean): void } {
  let on = false
  let blockerId: number | null = null
  let wasFull = false
  let wasMax = false

  const stopBlocker = () => {
    if (blockerId !== null) deps.blocker.stop(blockerId)
    blockerId = null
  }

  /** 막기를 풀고 창을 켜기 전 모양으로 — 켜기 전부터 전체 화면이었으면 그대로 둔다 */
  const restore = () => {
    stopBlocker()
    const w = deps.win()
    if (w && !wasFull) {
      w.setFullScreen(false)
      if (wasMax) w.maximize()
    }
  }

  return {
    set(next) {
      if (next === on) return
      if (next) {
        // 창이 없던 때의 값이 남아 나중에 maximize() 를 부르지 않게 켤 때마다 다시 잡는다
        wasFull = false
        wasMax = false
        const w = deps.win()
        const id = deps.blocker.start() // 던지면 켜진 것으로 치지 않는다
        blockerId = id
        on = true
        if (w) {
          wasFull = w.isFullScreen()
          wasMax = w.isMaximized()
          w.show()
          if (!wasFull) w.setFullScreen(true)
          w.focus()
        }
      } else {
        on = false
        restore()
      }
    },
    isOn: () => on,
    /** 화면이 다시 불리거나 사라질 때·앱이 꺼질 때 — 켜져 있을 때만, 끄는 것과 똑같이 막기·전체 화면을 푼다 */
    release() {
      if (!on) return
      on = false
      restore()
    },
    /**
     * 창이 숨거나(트레이·최소화) 다시 보일 때 — 켜진 동안만, 숨으면 막기를 풀고 보이면 다시 건다(두레가 안 보이는데 모니터만 깨워 두지 않게).
     * 파워 모드 자체는 켜진 채다. 다시 걸기가 실패해도 던지지 않는다(창 사건에서 불린다) — 그땐 끌 때 풀 것이 없다
     */
    setVisible(visible) {
      if (!on) return
      if (!visible) stopBlocker()
      else if (blockerId === null) {
        try {
          blockerId = deps.blocker.start()
        } catch {
          blockerId = null
        }
      }
    },
  }
}
