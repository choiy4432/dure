import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { TailscaleState } from '../src/shared/phoneTypes'
import { DEFAULT_PHONE_SETTINGS } from '../src/shared/phoneTypes'
import {
  UNINSTALL_CLEANUP_ARG, UNINSTALL_HARD_CAP_MS, UNINSTALL_ROUTE_WAIT_MS, uninstallCleanup, uninstallHardCap,
} from '../src/main/uninstallCleanup'

// 제거 프로그램이 부르는 정리(`Dure.exe --uninstall-cleanup`) — 두레가 연 tailscale serve 길 · 그 빌드의 로그인 항목만.
// 🔴 가짜 tailscale·가짜 로그인 항목만, 임시 폴더만(진짜 %APPDATA%\Dure·레지스트리는 건드리지 않는다)

const DNS = 'fake-pc.tail0000.ts.net'
const NEW = 'renamed-pc.tail0000.ts.net'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-uninstall-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const file = () => path.join(dir, 'phone.json')
const seed = (v: Record<string, unknown>) =>
  fs.writeFileSync(file(), JSON.stringify({ settings: { ...DEFAULT_PHONE_SETTINGS, enabled: true, openAtLogin: true }, devices: [], ...v }))
const saved = () => JSON.parse(fs.readFileSync(file(), 'utf8'))

/** 가짜 tailscale — 두레 길(routes, 이름까지)만. serveOff 는 그 짝(포트·로컬 포트·이름)이 맞을 때만 끈다 */
function fakeTailscale(state: TailscaleState = { kind: 'ready', dnsName: DNS }) {
  const order: string[] = []
  const routes = new Map<number, { localPort: number; dnsName?: string }>()
  const t = {
    order,
    routes,
    offError: null as Error | null,
    status: vi.fn(async () => {
      order.push('status')
      return state
    }),
    serveOff: vi.fn(async (h: number, l: number, d?: string) => {
      order.push(`off ${h} ${l} ${d ?? '-'}`)
      if (t.offError) throw t.offError
      const r = routes.get(h)
      if (!r || r.localPort !== l || (d !== undefined && r.dnsName !== d)) return false
      routes.delete(h)
      return true
    }),
  }
  return t
}

test('인자 이름 — NSIS 의 customUnInstall 이 이것으로 부른다', () => {
  expect(UNINSTALL_CLEANUP_ARG).toBe('--uninstall-cleanup')
})

test('적어 둔 두레 길을 끄고 기록을 지운 뒤 로그인 항목을 지운다 — 켜짐 설정·기기는 그대로(앱 데이터는 지우지 않는다)', async () => {
  seed({ serve: { httpsPort: 443, localPort: 47615, dnsName: DNS }, httpsPort: 443 })
  const ts = fakeTailscale()
  ts.routes.set(443, { localPort: 47615, dnsName: DNS })
  const removeLoginItem = vi.fn(() => ts.order.push('login'))
  await uninstallCleanup({ dataDir: dir, tailscale: ts, removeLoginItem })
  expect(ts.order).toEqual([`off 443 47615 ${DNS}`, 'login'])
  expect(ts.routes.size).toBe(0)
  expect(saved().serve).toBeUndefined()
  expect(saved().settings.enabled).toBe(true)
  expect(saved().httpsPort).toBe(443)
})

test('PC 이름이 바뀌어 그 길이 지금 이름 아래로 옮겨졌어도 — 같은 https 포트·같은 로컬 포트면 끈다', async () => {
  seed({ serve: { httpsPort: 443, localPort: 47615, dnsName: DNS } })
  const ts = fakeTailscale({ kind: 'ready', dnsName: NEW })
  ts.routes.set(443, { localPort: 47615, dnsName: NEW })
  await uninstallCleanup({ dataDir: dir, tailscale: ts, removeLoginItem: () => {} })
  expect(ts.order).toEqual([`off 443 47615 ${DNS}`, 'status', `off 443 47615 ${NEW}`])
  expect(ts.routes.size).toBe(0)
  expect(saved().serve).toBeUndefined()
})

test('기록이 없으면 tailscale 을 부르지 않는다 · phone.json 이 없어도 로그인 항목은 지운다', async () => {
  const ts = fakeTailscale()
  const removeLoginItem = vi.fn()
  await uninstallCleanup({ dataDir: dir, tailscale: ts, removeLoginItem })
  expect(ts.order).toEqual([])
  expect(removeLoginItem).toHaveBeenCalledTimes(1)
  expect(fs.existsSync(file())).toBe(false) // 없던 파일을 만들지 않는다
})

test('끄지 못하면(설정을 못 읽음) 기록을 남기고 — 던지지 않고 로그인 항목은 지운다', async () => {
  seed({ serve: { httpsPort: 47615, localPort: 47615, dnsName: DNS } })
  const ts = fakeTailscale()
  ts.offError = new Error('Tailscale 의 serve 설정을 읽지 못했어요')
  const removeLoginItem = vi.fn()
  await expect(uninstallCleanup({ dataDir: dir, tailscale: ts, removeLoginItem })).resolves.toBeUndefined()
  expect(saved().serve).toEqual({ httpsPort: 47615, localPort: 47615, dnsName: DNS })
  expect(removeLoginItem).toHaveBeenCalledTimes(1)
})

test('tailscale 이 답하지 않으면 상한(5초 기본)까지만 기다린다 — 제거를 붙잡지 않는다', async () => {
  seed({ serve: { httpsPort: 443, localPort: 47615, dnsName: DNS } })
  const ts = fakeTailscale()
  ts.serveOff.mockImplementation(() => new Promise<boolean>(() => {}))
  const removeLoginItem = vi.fn()
  const t0 = Date.now()
  await uninstallCleanup({ dataDir: dir, tailscale: ts, removeLoginItem, timeoutMs: 50 })
  expect(Date.now() - t0).toBeLessThan(2000)
  expect(removeLoginItem).toHaveBeenCalledTimes(1)
  expect(saved().serve).toEqual({ httpsPort: 443, localPort: 47615, dnsName: DNS })
})

test('phone.json 이 깨졌거나·로그인 항목 지우기가 던져도 — 던지지 않는다', async () => {
  fs.writeFileSync(file(), '{ not json')
  const ts = fakeTailscale()
  const log = vi.fn()
  await expect(
    uninstallCleanup({ dataDir: dir, tailscale: ts, log, removeLoginItem: () => { throw new Error('registry') } }),
  ).resolves.toBeUndefined()
  expect(ts.order).toEqual([])
  expect(log).toHaveBeenCalled()
  expect(JSON.stringify(log.mock.calls)).not.toContain(dir) // 경로를 로그에 싣지 않는다
})

test('전체 상한 — 무엇이 멈춰도(whenReady·로그인 항목 …) 15초 뒤엔 0 으로 나간다 · 길 끄기 상한보다 길다', () => {
  vi.useFakeTimers()
  try {
    const exit = vi.fn()
    uninstallHardCap(exit)
    vi.advanceTimersByTime(UNINSTALL_HARD_CAP_MS - 1)
    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(exit).toHaveBeenCalledWith(0)
    expect(exit).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
  expect(UNINSTALL_HARD_CAP_MS).toBe(15_000)
  expect(UNINSTALL_HARD_CAP_MS).toBeGreaterThan(UNINSTALL_ROUTE_WAIT_MS)
})

test('index.ts — --uninstall-cleanup 갈래는 맨 먼저 전체 상한을 건다(정리가 멈춰도 제거 프로그램의 ExecWait 를 붙잡지 않게)', () => {
  const main = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8')
  const at = main.indexOf('if (process.argv.includes(UNINSTALL_CLEANUP_ARG)) {')
  expect(at).toBeGreaterThan(-1)
  // 주석 줄을 빼면 갈래의 첫 문장이 상한
  const first = main
    .slice(at)
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('//'))
  expect(first).toBe('uninstallHardCap((code) => app.exit(code))')
})
