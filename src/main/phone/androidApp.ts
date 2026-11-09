import fs from 'node:fs'
import path from 'node:path'
import {
  ANDROID_CERT_SHA256, ANDROID_PACKAGE, ANDROID_TEST_CERT_SHA256, ANDROID_TEST_PACKAGE, type AndroidApk,
} from '../../shared/androidApp'

const statement = (packageName: string, sha256: string) => ({
  relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: [sha256] },
})

/** /.well-known/assetlinks.json 의 내용 — 진짜 앱 하나, 시험 빌드면 시험 앱도 */
export function assetStatements(o: { includeTest: boolean }): object[] {
  const list: object[] = [statement(ANDROID_PACKAGE, ANDROID_CERT_SHA256)]
  if (o.includeTest) list.push(statement(ANDROID_TEST_PACKAGE, ANDROID_TEST_CERT_SHA256))
  return list
}

/** `<dir>/dure.apk` 와 옆의 `dure.apk.json` 이 둘 다 있고 꼴이 맞을 때만 — 아니면 null(던지지 않음) */
export function readApk(dir: string): { path: string; info: AndroidApk } | null {
  try {
    const apk = path.join(dir, 'dure.apk')
    if (!fs.statSync(apk).isFile()) return null
    const j: unknown = JSON.parse(fs.readFileSync(`${apk}.json`, 'utf8'))
    if (typeof j !== 'object' || j === null) return null
    const { versionCode, versionName, packageName } = j as Record<string, unknown>
    if (typeof versionCode !== 'number' || !Number.isInteger(versionCode)) return null
    if (typeof versionName !== 'string' || typeof packageName !== 'string') return null
    return { path: apk, info: { versionCode, versionName, packageName } }
  } catch {
    return null
  }
}
