import { describe, it, expect, vi } from 'vitest'
import { createUpdater, RELEASE_URL, type UpdaterLike } from '../src/main/updater'
import { createQuitControl } from '../src/main/quit'
import type { UpdateState } from '../src/shared/appTypes'

type Handler = (arg?: unknown) => void

/** 가짜 electron-updater — 네트워크 없이 */
function fakeUpdater(over: Record<string, unknown> = {}) {
  const handlers: Record<string, Handler> = {}
  const u = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '0.2.0', releaseNotes: '<ul><li>새 기능</li><li>고침</li></ul>' },
    })),
    downloadUpdate: vi.fn(async () => {
      handlers['download-progress']?.({ percent: 41.6 })
      handlers['update-downloaded']?.({})
      return []
    }),
    quitAndInstall: vi.fn(),
    on: vi.fn((ev: string, fn: Handler) => {
      handlers[ev] = fn
    }),
    ...over,
  } as unknown as UpdaterLike
  return { u, handlers }
}

function setup(over: Record<string, unknown> = {}, beforeInstall: () => Promise<void> = async () => {}) {
  const { u, handlers } = fakeUpdater(over)
  const states: UpdateState[] = []
  const up = createUpdater({ updater: u, current: '0.1.0', beforeInstall, emit: (s) => states.push(s) })
  return { u, handlers, states, up }
}

describe('createUpdater', () => {
  it('dev — updater 없음', async () => {
    const states: UpdateState[] = []
    const up = createUpdater({ updater: null, current: '0.1.0', beforeInstall: async () => {}, emit: (s) => states.push(s) })
    expect(up.state()).toEqual({ kind: 'dev' })
    expect(await up.check()).toEqual({ kind: 'dev' })
    await up.download()
    await up.install()
    expect(up.state()).toEqual({ kind: 'dev' })
  })

  it('설정 — autoDownload 끔 · autoInstallOnAppQuit 켬 · 처음엔 idle', () => {
    const { u, up } = setup()
    expect(u.autoDownload).toBe(false)
    expect(u.autoInstallOnAppQuit).toBe(true)
    expect(up.state()).toEqual({ kind: 'idle' })
  })

  it('check — 새 버전', async () => {
    const { up, states } = setup()
    const s = await up.check()
    expect(s).toEqual({
      kind: 'available', version: '0.2.0', current: '0.1.0',
      highlights: ['새 기능', '고침'], url: RELEASE_URL('0.2.0'),
    })
    expect(states.map((x) => x.kind)).toEqual(['checking', 'available'])
    expect(up.state()).toEqual(s)
    expect(RELEASE_URL('0.2.0')).toBe('https://github.com/choiy4432/dure/releases/tag/v0.2.0')
  })

  it('check — 없음', async () => {
    const { up, states } = setup({
      checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } })),
    })
    expect(await up.check()).toEqual({ kind: 'none' })
    expect(states.map((x) => x.kind)).toEqual(['checking', 'none'])
  })

  it('check — null 결과도 없음', async () => {
    const { up } = setup({ checkForUpdates: vi.fn(async () => null) })
    expect(await up.check()).toEqual({ kind: 'none' })
  })

  it('check 실패 — error', async () => {
    const { up, states } = setup({ checkForUpdates: vi.fn(async () => { throw new Error('offline') }) })
    expect(await up.check()).toEqual({ kind: 'error', message: 'offline', version: null })
    expect(states.map((x) => x.kind)).toEqual(['checking', 'error'])
  })

  it('download 진행 → ready', async () => {
    const { up, states } = setup()
    await up.check()
    await up.download()
    expect(states.slice(2)).toEqual([
      { kind: 'downloading', version: '0.2.0', percent: 0 },
      { kind: 'downloading', version: '0.2.0', percent: 42 },
      { kind: 'ready', version: '0.2.0' },
    ])
    expect(up.state()).toEqual({ kind: 'ready', version: '0.2.0' })
  })

  it('download 실패 — error 상태(version 유지)', async () => {
    const { up } = setup({ downloadUpdate: vi.fn(async () => { throw new Error('끊김') }) })
    await up.check()
    await up.download()
    expect(up.state()).toEqual({ kind: 'error', message: '끊김', version: '0.2.0' })
  })

  it('available 가 아니면 download 는 아무것도 안 한다', async () => {
    const { u, up } = setup()
    await up.download()
    expect(u.downloadUpdate).not.toHaveBeenCalled()
  })

  it('install — beforeInstall 뒤 quitAndInstall(true,true)', async () => {
    const order: string[] = []
    const { u, up } = setup(
      { quitAndInstall: vi.fn(() => { order.push('quit') }) },
      async () => { order.push('before') },
    )
    await up.check()
    await up.download()
    await up.install()
    expect(order).toEqual(['before', 'quit'])
    expect(u.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('install — 정리가 실패하면 quitAndInstall 없이 error 상태(짧은 말 · version 유지)', async () => {
    const { u, up, states } = setup({}, async () => {
      throw new Error('mcp.close: socket hang up\n    at Server.close (node:net:1)')
    })
    await up.check()
    await up.download()
    await up.install()
    expect(u.quitAndInstall).not.toHaveBeenCalled()
    expect(up.state()).toEqual({ kind: 'error', message: '업데이트를 설치하지 못했어요', version: '0.2.0' })
    expect(states.at(-1)).toEqual(up.state())
  })

  it('install — quitAndInstall 이 던져도 error 상태', async () => {
    const { up } = setup({ quitAndInstall: vi.fn(() => { throw new Error('spawn EPERM') }) })
    await up.check()
    await up.download()
    await up.install()
    expect(up.state()).toEqual({ kind: 'error', message: '업데이트를 설치하지 못했어요', version: '0.2.0' })
  })

  it('ready 가 아니면 install 은 아무것도 안 한다', async () => {
    const { u, up } = setup()
    await up.install()
    expect(u.quitAndInstall).not.toHaveBeenCalled()
  })

  it('check — ready 에선 그대로(다시 확인해 available 로 내려가지 않는다)', async () => {
    const { u, up, states } = setup()
    await up.check()
    await up.download()
    const n = states.length
    expect(await up.check()).toEqual({ kind: 'ready', version: '0.2.0' })
    expect(u.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(states.length).toBe(n) // checking 도 내지 않는다
    expect(up.state()).toEqual({ kind: 'ready', version: '0.2.0' })
  })

  it('install 실패 뒤 다시 켜기 — 받아 둔 버전이면 error 에서도 설치(정리는 다시 부르지 않는다)', async () => {
    const before = vi.fn(async () => {})
    let fail = true
    const { u, up } = setup({ quitAndInstall: vi.fn(() => { if (fail) throw new Error('spawn EPERM') }) }, before)
    await up.check()
    await up.download()
    await up.install()
    expect(up.state()).toEqual({ kind: 'error', message: '업데이트를 설치하지 못했어요', version: '0.2.0' })
    fail = false
    await up.install()
    expect(u.quitAndInstall).toHaveBeenCalledTimes(2)
    expect(u.quitAndInstall).toHaveBeenLastCalledWith(true, true)
    expect(before).toHaveBeenCalledTimes(1)
  })

  it('정리가 실패한 뒤 다시 켜기 — 정리를 건너뛰고 받아 둔 것을 설치(한 번뿐인 정리는 다시 해도 또 실패)', async () => {
    const before = vi.fn(async () => { throw new Error('mcp.close: socket hang up') })
    const { u, up } = setup({}, before)
    await up.check()
    await up.download()
    await up.install()
    expect(u.quitAndInstall).not.toHaveBeenCalled()
    expect(up.state()).toMatchObject({ kind: 'error', message: '업데이트를 설치하지 못했어요' })
    await up.install()
    expect(before).toHaveBeenCalledTimes(1)
    expect(u.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('quit.ts 와 함께 — 정리가 실패한 뒤 다시 켜기의 끄기(before-quit)는 막히지 않고 그대로 나간다', async () => {
    const exit = vi.fn()
    const qc = createQuitControl({ shutdown: async () => { throw new Error('engine.shutdown 실패') }, exit })
    const prevented: boolean[] = []
    // electron-updater 의 quitAndInstall 은 설치 파일을 띄운 뒤 app.quit() → before-quit
    const quitAndInstall = vi.fn(() => {
      let p = false
      qc.beforeQuit({ preventDefault: () => { p = true } })
      prevented.push(p)
    })
    const { up } = setup({ quitAndInstall }, () => qc.prepareInstall())
    await up.check()
    await up.download()
    await up.install()
    expect(quitAndInstall).not.toHaveBeenCalled() // 첫 번째는 정리 실패로 멈춤
    await up.install()
    expect(prevented).toEqual([false])
    expect(exit).not.toHaveBeenCalled()
  })

  it('받기 실패의 error(받은 게 없음)에선 install 은 아무것도 안 한다', async () => {
    const before = vi.fn(async () => {})
    const { u, up } = setup({ downloadUpdate: vi.fn(async () => { throw new Error('끊김') }) }, before)
    await up.check()
    await up.download()
    expect(up.state()).toEqual({ kind: 'error', message: '끊김', version: '0.2.0' })
    await up.install()
    expect(before).not.toHaveBeenCalled()
    expect(u.quitAndInstall).not.toHaveBeenCalled()
  })

  it('확인 실패의 error(version 없음)에선 install 은 아무것도 안 한다', async () => {
    const { u, up } = setup({ checkForUpdates: vi.fn(async () => { throw new Error('offline') }) })
    await up.check()
    await up.install()
    expect(u.quitAndInstall).not.toHaveBeenCalled()
  })

  it('install 이 도는 중 또 누르면 무시', async () => {
    let release!: () => void
    const before = vi.fn(() => new Promise<void>((r) => { release = r }))
    const { u, up } = setup({}, before)
    await up.check()
    await up.download()
    const first = up.install()
    await up.install()
    expect(before).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(u.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
