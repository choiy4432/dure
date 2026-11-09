// 안드로이드 앱 굽기(scripts/android/build.mjs)의 순수 부분 — 옵션 · 환경 변수(빠지면 한국어로, 값은 글에 넣지 않음) · 앱 판 파일 · 공유 상수 · 서명 지문
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BACKUP_REMINDER, androidConsts, androidSourceHash, parseArgs, readVersion, requireEnv, signerSha256 } from '../scripts/android/lib.mjs'
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

describe('androidSourceHash — android/ 소스의 SHA-256(dure.apk.json 의 sourceHash · 릴리스 가드)', () => {
  let base = ''
  let n = 0
  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-android-hash-'))
  })
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }))
  /** 새 폴더에 파일들(상대 경로 → 내용)을 이 순서로 쓴다 */
  const tree = (files: Record<string, string | Buffer>) => {
    const dir = path.join(base, `t${n++}`)
    for (const [rel, body] of Object.entries(files)) {
      const f = path.join(dir, ...rel.split('/'))
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, body)
    }
    return dir
  }
  const SRC = {
    'settings.gradle': "include ':app'\n",
    'version.json': '{ "versionCode": 1, "versionName": "1.0.0" }\n',
    'app/src/main/AndroidManifest.xml': '<manifest />\n',
    'app/src/main/java/A.java': 'class A {}\n',
  }

  it('64자리 16진수 · 같은 소스면 같은 값(파일을 쓴 순서와 상관없이)', () => {
    const h = androidSourceHash(tree(SRC))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    const reversed = Object.fromEntries(Object.entries(SRC).reverse())
    expect(androidSourceHash(tree(reversed))).toBe(h)
  })

  it('내용·파일 이름·자리가 바뀌거나 파일이 늘면 다른 값', () => {
    const h = androidSourceHash(tree(SRC))
    expect(androidSourceHash(tree({ ...SRC, 'app/src/main/java/A.java': 'class A { int x; }\n' }))).not.toBe(h)
    const { 'app/src/main/java/A.java': a, ...rest } = SRC
    expect(androidSourceHash(tree({ ...rest, 'app/src/main/java/B.java': a }))).not.toBe(h)
    expect(androidSourceHash(tree({ ...rest, 'app/src/A.java': a }))).not.toBe(h)
    expect(androidSourceHash(tree({ ...SRC, 'app/src/main/res/values/x.xml': '<resources />\n' }))).not.toBe(h)
  })

  it('구운 것(어느 깊이의 build/)·.gradle/·local.properties 는 셈에서 빠진다', () => {
    const h = androidSourceHash(tree(SRC))
    expect(
      androidSourceHash(tree({
        ...SRC,
        'build/x.bin': 'out',
        'app/build/outputs/apk/release/app-release.apk': Buffer.from([0, 1, 2]),
        '.gradle/8.14.3/fileHashes.lock': 'lock',
        'local.properties': 'sdk.dir=D\\:\\\\sdk\n',
      })),
    ).toBe(h)
  })

  it('글 파일의 줄 끝(CRLF·LF)은 같게 센다 · NUL 이 있는 파일(그림 등)은 바이트 그대로', () => {
    const h = androidSourceHash(tree(SRC))
    const crlf = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, v.replace(/\n/g, '\r\n')]))
    expect(androidSourceHash(tree(crlf))).toBe(h)
    const bin = (eol: string) => Buffer.concat([Buffer.from([0x89, 0x00]), Buffer.from(`x${eol}y`)])
    expect(androidSourceHash(tree({ ...SRC, 'app/i.png': bin('\r\n') }))).not.toBe(androidSourceHash(tree({ ...SRC, 'app/i.png': bin('\n') })))
  })

  it('레포의 android/ 도 센다', () => {
    expect(androidSourceHash(path.join(ROOT, 'android'))).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('build.mjs — dure.apk.json 의 sourceHash · 진짜 앱을 다 구운 뒤 백업 한 줄', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/android/build.mjs'), 'utf8')
  it('굽기 전에 android/ 를 세어 dure.apk.json 에 판·패키지와 같이 적는다', () => {
    expect(src).toMatch(/sourceHash = androidSourceHash\(ANDROID\)/)
    expect(src).toMatch(/const info = \{ versionCode: version\.versionCode, versionName: version\.versionName, packageName, sourceHash \}/)
    expect(src.indexOf('androidSourceHash(ANDROID)')).toBeLessThan(src.indexOf('spawnSync(`"${gradle}"'))
  })
  it('백업 한 줄은 진짜 앱에서만 · 맨 끝에 — 열쇠 파일과 비밀번호를 백업 · 잃으면 업데이트 못 함', () => {
    expect(src).toMatch(/if \(!opts\.test\) console\.log\(BACKUP_REMINDER\)/)
    expect(src.lastIndexOf('console.log(BACKUP_REMINDER)')).toBeGreaterThan(src.indexOf("writeFileSync(path.join(OUT, 'dure.apk.json')"))
    expect(BACKUP_REMINDER).toMatch(/열쇠 파일/)
    expect(BACKUP_REMINDER).toMatch(/비밀번호/)
    expect(BACKUP_REMINDER).toMatch(/백업/)
    expect(BACKUP_REMINDER).toMatch(/업데이트할 수 없어요/)
    expect(BACKUP_REMINDER).not.toMatch(/[A-Z]:\\|Users/)
  })
})
