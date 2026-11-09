import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assetStatements, readApk } from '../src/main/phone/androidApp'
import { ANDROID_CERT_SHA256, ANDROID_PACKAGE, ANDROID_TEST_CERT_SHA256, ANDROID_TEST_PACKAGE } from '../src/shared/androidApp'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-android-'))
  dirs.push(d)
  return d
}

describe('assetStatements', () => {
  it('진짜 앱 하나 — 관계·패키지·지문', () => {
    const s = assetStatements({ includeTest: false })
    expect(s).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: [ANDROID_CERT_SHA256] },
      },
    ])
    expect(ANDROID_CERT_SHA256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  })

  it('includeTest 면 시험 앱이 하나 더', () => {
    const s = assetStatements({ includeTest: true }) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[]
    expect(s).toHaveLength(2)
    expect(s[1].target.package_name).toBe(ANDROID_TEST_PACKAGE)
    expect(s[1].target.sha256_cert_fingerprints).toEqual([ANDROID_TEST_CERT_SHA256])
  })
})

describe('readApk', () => {
  const good = { versionCode: 3, versionName: '1.0.2', packageName: ANDROID_PACKAGE }

  it('없는 폴더 — null', () => {
    expect(readApk(path.join(tempDir(), 'nope'))).toBeNull()
  })

  it('apk 만 있고 json 이 없으면 null', () => {
    const d = tempDir()
    fs.writeFileSync(path.join(d, 'dure.apk'), 'x')
    expect(readApk(d)).toBeNull()
  })

  it('json 만 있고 apk 가 없으면 null', () => {
    const d = tempDir()
    fs.writeFileSync(path.join(d, 'dure.apk.json'), JSON.stringify(good))
    expect(readApk(d)).toBeNull()
  })

  it('json 이 깨졌거나 꼴이 틀리면 null(던지지 않음)', () => {
    const d = tempDir()
    fs.writeFileSync(path.join(d, 'dure.apk'), 'x')
    for (const bad of ['{not json', JSON.stringify({ ...good, versionCode: 1.5 }), JSON.stringify({ ...good, versionCode: '3' }), JSON.stringify({ ...good, versionName: 1 }), JSON.stringify({ versionCode: 3, versionName: 'a' }), 'null']) {
      fs.writeFileSync(path.join(d, 'dure.apk.json'), bad)
      expect(readApk(d)).toBeNull()
    }
  })

  it('둘 다 맞으면 { path, info }', () => {
    const d = tempDir()
    fs.writeFileSync(path.join(d, 'dure.apk'), 'x')
    fs.writeFileSync(path.join(d, 'dure.apk.json'), JSON.stringify(good))
    expect(readApk(d)).toEqual({ path: path.join(d, 'dure.apk'), info: good })
  })
})
