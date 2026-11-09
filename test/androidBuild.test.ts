// 안드로이드 앱 굽기(scripts/android/build.mjs)의 순수 부분 — 옵션 · 환경 변수(빠지면 한국어로, 값은 글에 넣지 않음) · 앱 판 파일 · 공유 상수 · 서명 지문
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { androidConsts, parseArgs, readVersion, requireEnv, signerSha256 } from '../scripts/android/lib.mjs'
import { ANDROID_CERT_SHA256, ANDROID_PACKAGE, ANDROID_TEST_CERT_SHA256, ANDROID_TEST_PACKAGE } from '../src/shared/androidApp'

const ROOT = path.join(__dirname, '..')

/** 던진 오류의 글(안 던지면 시험 실패) */
function errorOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('던지지 않았어요')
}

describe('parseArgs', () => {
  it('없으면 진짜 앱, --test 면 시험 앱', () => {
    expect(parseArgs([])).toEqual({ test: false })
    expect(parseArgs(['--test'])).toEqual({ test: true })
  })
  it('모르는 옵션은 한국어로 멈춘다(잘못 쳐서 진짜 앱을 굽지 않게)', () => {
    expect(errorOf(() => parseArgs(['--tset']))).toMatch(/모르는 옵션/)
  })
})

describe('requireEnv', () => {
  const TOOLS = 'D:\\tools-dir\\android'

  it('도구 폴더가 없거나 비었으면 한국어로 멈춘다', () => {
    for (const env of [{}, { DURE_ANDROID_TOOLS: '' }]) {
      for (const test of [true, false]) {
        const err = errorOf(() => requireEnv(env, test))
        expect(err).toMatch(/DURE_ANDROID_TOOLS/)
        expect(err).toMatch(/[가-힣]/)
      }
    }
  })

  it('시험 앱은 도구 폴더의 시험 열쇠 — 진짜 비밀번호는 쓰지 않는다', () => {
    expect(requireEnv({ DURE_ANDROID_TOOLS: TOOLS, DURE_ANDROID_KEYSTORE_PASS: 'real-secret' }, true)).toEqual({
      tools: TOOLS,
      keystore: path.join(TOOLS, 'test-keys', 'android-test.jks'),
      alias: 'dure-test',
      pass: 'dure-test',
    })
  })

  it('진짜 앱은 비밀번호가 없거나 비었으면 멈추고, 글에 경로를 넣지 않는다', () => {
    for (const pass of [undefined, '']) {
      const env = { DURE_ANDROID_TOOLS: TOOLS, USERPROFILE: 'C:\\Users\\someone', DURE_ANDROID_KEYSTORE: 'E:\\keys\\k.jks', DURE_ANDROID_KEYSTORE_PASS: pass }
      const err = errorOf(() => requireEnv(env, false))
      expect(err).toMatch(/DURE_ANDROID_KEYSTORE_PASS/)
      expect(err).toMatch(/[가-힣]/)
      for (const v of [TOOLS, 'C:\\Users\\someone', 'E:\\keys\\k.jks', 'someone']) expect(err).not.toContain(v)
    }
  })

  it('진짜 앱은 열쇠 자리를 모르면(DURE_ANDROID_KEYSTORE·USERPROFILE 둘 다 없음) 멈추고, 글에 비밀번호·경로를 넣지 않는다', () => {
    const err = errorOf(() => requireEnv({ DURE_ANDROID_TOOLS: TOOLS, DURE_ANDROID_KEYSTORE_PASS: 's3cret-pass' }, false))
    expect(err).toMatch(/DURE_ANDROID_KEYSTORE 환경 변수/)
    expect(err).toMatch(/[가-힣]/)
    expect(err).not.toContain('s3cret-pass')
    expect(err).not.toContain(TOOLS)
  })

  it('진짜 열쇠는 기본이 %USERPROFILE%\\.dure-release\\android-release.jks(별칭 dure), DURE_ANDROID_KEYSTORE 로 바꾼다', () => {
    const base = { DURE_ANDROID_TOOLS: TOOLS, USERPROFILE: 'C:\\Users\\someone', DURE_ANDROID_KEYSTORE_PASS: 'pw' }
    expect(requireEnv(base, false)).toEqual({
      tools: TOOLS,
      keystore: path.join('C:\\Users\\someone', '.dure-release', 'android-release.jks'),
      alias: 'dure',
      pass: 'pw',
    })
    expect(requireEnv({ ...base, DURE_ANDROID_KEYSTORE: 'E:\\keys\\k.jks' }, false).keystore).toBe('E:\\keys\\k.jks')
  })
})

describe('readVersion', () => {
  let dir = ''
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-android-version-'))
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
  const write = (name: string, text: string) => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, text)
    return f
  }

  it('정수 판 + 글 이름을 읽는다(다른 칸은 버린다)', () => {
    expect(readVersion(write('ok.json', '{ "versionCode": 7, "versionName": "1.2.0", "x": 1 }'))).toEqual({ versionCode: 7, versionName: '1.2.0' })
  })

  it('판이 1 이상의 정수가 아니거나 이름이 비지 않은 글이 아니면 한국어로 던진다', () => {
    const bad = [
      '{ "versionCode": "1", "versionName": "1.0.0" }',
      '{ "versionCode": 1.5, "versionName": "1.0.0" }',
      '{ "versionCode": 0, "versionName": "1.0.0" }',
      '{ "versionName": "1.0.0" }',
      '{ "versionCode": 1, "versionName": 1 }',
      '{ "versionCode": 1, "versionName": "" }',
      '{ "versionCode": 1 }',
      'null',
      'not json',
    ]
    bad.forEach((text, i) => expect(errorOf(() => readVersion(write(`bad${i}.json`, text)))).toMatch(/[가-힣]/))
  })

  it('없는 파일도 한국어로 던진다', () => {
    expect(errorOf(() => readVersion(path.join(dir, 'none.json')))).toMatch(/[가-힣]/)
  })

  it('레포의 android/version.json 은 읽힌다', () => {
    const v = readVersion(path.join(ROOT, 'android', 'version.json'))
    expect(Number.isInteger(v.versionCode)).toBe(true)
    expect(v.versionName).not.toBe('')
  })
})

describe('androidConsts', () => {
  it('src/shared/androidApp.ts 의 패키지·지문을 그대로 읽는다(스크립트는 TS 를 부르지 않는다)', () => {
    expect(androidConsts(fs.readFileSync(path.join(ROOT, 'src/shared/androidApp.ts'), 'utf8'))).toEqual({
      packageName: ANDROID_PACKAGE,
      testPackageName: ANDROID_TEST_PACKAGE,
      sha256: ANDROID_CERT_SHA256,
      testSha256: ANDROID_TEST_CERT_SHA256,
    })
  })
  it('못 찾으면 한국어로 던진다', () => {
    expect(errorOf(() => androidConsts('export const X = 1'))).toMatch(/[가-힣]/)
  })
})

describe('signerSha256', () => {
  it('apksigner verify --print-certs 의 글에서 첫 서명자 SHA-256 을 AB:CD:… 꼴로', () => {
    const out = [
      'Verifies',
      'Signer #1 certificate DN: CN=dure-test',
      'Signer #1 certificate SHA-256 digest: 046273661cbb59231c50b62cec414f2d41c1005d01412079d30dc3a50199a080',
      'Signer #1 certificate SHA-1 digest: 0123456789abcdef0123456789abcdef01234567',
    ].join('\r\n')
    expect(signerSha256(out)).toBe(ANDROID_TEST_CERT_SHA256)
  })
  it('없으면 null', () => {
    expect(signerSha256('DOES NOT VERIFY')).toBeNull()
  })
})
