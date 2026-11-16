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

export function createPowerMode(deps: PowerDeps): { set(on: boolean): void; isOn(): boolean; release(): void } {
  let on = false
  let blockerId: number | null = null
  let wasFull = false
  let wasMax = false

  const stopBlocker = () => {
    if (blockerId !== null) deps.blocker.stop(blockerId)
    blockerId = null
  }

  return {
    set(next) {
      if (next === on) return
      on = next
      const w = deps.win()
      if (next) {
        blockerId = deps.blocker.start()
        if (w) {
          wasFull = w.isFullScreen()
          wasMax = w.isMaximized()
          w.show()
          if (!wasFull) w.setFullScreen(true)
          w.focus()
        }
      } else {
        stopBlocker()
        // 켜기 전부터 전체 화면이었으면 그대로 둔다
        if (w && !wasFull) {
          w.setFullScreen(false)
          if (wasMax) w.maximize()
        }
      }
    },
    isOn: () => on,
    /** 창이 다시 불리거나 사라질 때·앱이 꺼질 때 — 켜져 있을 때만 막기를 풀고 꺼진 것으로(창 모양은 건드리지 않는다) */
    release() {
      if (!on) return
      on = false
      stopBlocker()
    },
  }
}
