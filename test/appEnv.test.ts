import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { APP_ID, TEST_ENV_KEYS, appEnv, appIconFor, appUserModelId, loginItemName, loginItemNamer, loginItemSettings } from '../src/main/appEnv'

describe('appEnv', () => {
  it('설치본이면 시험용 키를 빼고 나머지는 남긴다', () => {
    const out = appEnv({ DURE_USER_DATA: 'x', PATH: 'p', CLAUDE_CONFIG_DIR: 'c', ELECTRON_RENDERER_URL: 'u' }, true)
    expect(out.DURE_USER_DATA).toBeUndefined()
    expect(out.ELECTRON_RENDERER_URL).toBeUndefined()
    expect(out.PATH).toBe('p')
    expect(out.CLAUDE_CONFIG_DIR).toBe('c')
  })
  it('설치본이 아니면 그대로(사본)', () => {
    const src = { DURE_USER_DATA: 'x', PATH: 'p' }
    const out = appEnv(src, false)
    expect(out).toEqual(src)
    expect(out).not.toBe(src)
  })
  it('모든 시험용 키를 뺀다', () => {
    const src = Object.fromEntries(TEST_ENV_KEYS.map((k) => [k, '1']))
    expect(appEnv(src, true)).toEqual({})
  })
  it('새 시험 키도 설치본에서 지움', () => {
    const keys = ['DURE_TAILSCALE_COMMAND', 'DURE_TAILSCALE_ARGS', 'DURE_PHONE_ALLOW_LOCAL']
    for (const k of keys) expect(TEST_ENV_KEYS).toContain(k)
    const src = { ...Object.fromEntries(keys.map((k) => [k, '1'])), PATH: 'p' }
    expect(appEnv(src, true)).toEqual({ PATH: 'p' })
    expect(appEnv(src, false)).toEqual(src)
  })
  it('앱 id — 설치본은 고정 id, 아니면 execPath', () => {
    expect(appUserModelId(true, 'e')).toBe('io.github.choiy4432.dure')
    expect(APP_ID).toBe('io.github.choiy4432.dure')
    expect(appUserModelId(false, 'e')).toBe('e')
  })
})

describe('appIconFor', () => {
  it('설치본은 exe 자신(asar 안은 셸이 못 읽는다), 개발 실행은 아이콘 파일', () => {
    expect(appIconFor(true, 'app.exe', 'dev.ico')).toEqual({ appIconPath: 'app.exe', appIconIndex: 0 })
    expect(appIconFor(false, 'electron.exe', 'dev.ico')).toEqual({ appIconPath: 'dev.ico', appIconIndex: 0 })
  })
})

describe('loginItemSettings — 로그인 항목은 빌드마다 따로', () => {
  it('이름을 늘 준다 — 안 주면 Windows 값 이름이 앱 id(모든 설치본이 같다)라 시험 빌드가 진짜 두레의 값을 덮거나 지운다', () => {
    expect(loginItemSettings(true, 'dure', 'C:\\Apps\\Dure\\Dure.exe')).toEqual({
      openAtLogin: true,
      name: 'dure',
      path: 'C:\\Apps\\Dure\\Dure.exe',
      args: ['--hidden'],
    })
    // 끌 때도 같은 이름 — 그 빌드의 값만 지운다
    expect(loginItemSettings(false, 'dure-phonetest', 'C:\\Apps\\T\\T.exe')).toEqual({
      openAtLogin: false,
      name: 'dure-phonetest',
      path: 'C:\\Apps\\T\\T.exe',
      args: ['--hidden'],
    })
  })

  it('이름 = 빌드의 package.json name(시험 빌드는 -c.extraMetadata.name=dure-… 로 늘 바뀐다) — productName(app.getName() 이 먼저 봄)은 안 바뀔 수 있다', () => {
    // 실측(2026-11-05 시험 빌드): -c.productName 만 바꾸면 꾸러미의 package.json 엔 productName "Dure" 가 그대로 — app.getName() 은 'Dure'
    expect(loginItemName({ name: 'dure-finalfix', productName: 'Dure' })).toBe('dure-finalfix')
    expect(loginItemName({ name: 'dure', productName: 'Dure' })).toBe('dure')
    // 못 읽거나 꼴이 틀리면 null — app.getName()('Dure')으로 대신하지 않는다(시험 빌드가 진짜 두레의 값을 덮거나 지울 수 있다)
    for (const bad of [null, undefined, 'dure', [], {}, { name: '' }, { name: '   ' }, { name: 5 }]) expect(loginItemName(bad), JSON.stringify(bad)).toBeNull()
  })

  it('loginItemNamer — 처음 한 번만 읽는다 · 못 읽으면(파일 없음·JSON 아님·이름 없음) null 이고 로그는 한 번만(고정된 글, 경로 없이)', () => {
    const read = vi.fn(() => JSON.stringify({ name: 'dure-fix2', productName: 'Dure' }))
    const log = vi.fn()
    const name = loginItemNamer(read, log)
    expect(name()).toBe('dure-fix2')
    expect(name()).toBe('dure-fix2')
    expect(read).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()

    for (const reader of [
      () => {
        throw Object.assign(new Error('ENOENT: no such file, open C:\\Apps\\T\\resources\\app.asar\\package.json'), { code: 'ENOENT' })
      },
      () => '{ not json',
      () => JSON.stringify({ productName: 'Dure' }),
    ]) {
      const r = vi.fn(reader)
      const l = vi.fn()
      const n = loginItemNamer(r, l)
      expect(n()).toBeNull()
      expect(n()).toBeNull()
      expect(r).toHaveBeenCalledTimes(1)
      expect(l).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(l.mock.calls)).not.toMatch(/Apps|asar|ENOENT/)
    }
  })

  it('index.ts 는 로그인 항목을 setLoginItem 하나로만 — 이름(loginName)을 못 읽으면 건드리지 않고, app.getName() 으로 대신하지 않는다', () => {
    const main = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8')
    const calls = main.match(/setLoginItemSettings\(.*$/gm) ?? []
    expect(calls).toEqual(['setLoginItemSettings(loginItemSettings(open, name, process.execPath))'])
    expect(main).toMatch(/const name = loginName\(\)\s*\n\s*if \(name !== null\) app\.setLoginItemSettings\(/)
    expect(main).toMatch(/const loginName = loginItemNamer\(\(\) => readFileSync\(join\(app\.getAppPath\(\), 'package\.json'\), 'utf8'\), console\.error\)/)
    expect(main).not.toMatch(/app\.getName\(\)/)
    // 휴대폰 설정의 자동 켜기와 제거 정리가 같은 함수를 쓴다(설치본만)
    expect(main.match(/setLoginItem\(open\)/g)).toHaveLength(1)
    expect(main.match(/setLoginItem\(false\)/g)).toHaveLength(1)
  })
})
