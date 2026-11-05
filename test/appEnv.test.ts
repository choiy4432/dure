import { describe, it, expect } from 'vitest'
import { APP_ID, TEST_ENV_KEYS, appEnv, appIconFor, appUserModelId } from '../src/main/appEnv'

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
