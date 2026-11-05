import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { APP_ID, TEST_ENV_KEYS, appEnv, appIconFor, appUserModelId, loginItemName, loginItemSettings } from '../src/main/appEnv'

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
    expect(loginItemName({ name: 'dure-finalfix', productName: 'Dure' }, 'Dure')).toBe('dure-finalfix')
    expect(loginItemName({ name: 'dure', productName: 'Dure' }, 'Dure')).toBe('dure')
    // 못 읽거나 꼴이 틀리면 app.getName()
    for (const bad of [null, undefined, 'dure', [], {}, { name: '' }, { name: '   ' }, { name: 5 }]) expect(loginItemName(bad, 'Dure'), JSON.stringify(bad)).toBe('Dure')
  })

  it('index.ts 는 로그인 항목을 이 함수로만 부르고, 이름은 빌드마다(loginName — package.json name)', () => {
    const main = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8')
    const calls = main.match(/setLoginItemSettings\(.*$/gm) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c).toMatch(/^setLoginItemSettings\(loginItemSettings\((open|false), loginName\(\), process\.execPath\)\)/)
    expect(main).toMatch(/loginItemName\(JSON\.parse\(readFileSync\(join\(app\.getAppPath\(\), 'package\.json'\), 'utf8'\)\), app\.getName\(\)\)/)
  })
})
