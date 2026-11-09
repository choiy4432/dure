// scripts/android/build.mjs 의 순수 부분 — 시험할 수 있게 따로 둔다(test/androidBuild.test.ts).
// 오류 글에는 경로·비밀번호를 넣지 않는다(화면·기록에 남지 않게) — 어느 환경 변수인지만 알린다.
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** 명령줄 → { test }. 모르는 옵션은 멈춘다(잘못 쳐서 진짜 앱을 굽지 않게) */
export function parseArgs(argv) {
  for (const a of argv) if (a !== '--test') throw new Error(`모르는 옵션이에요: ${a} (쓸 수 있는 것: --test)`)
  return { test: argv.includes('--test') }
}

const missing = (v) => typeof v !== 'string' || v === ''

/**
 * 굽는 데 필요한 환경 변수 → { tools, keystore, alias, pass }.
 * 시험 앱은 도구 폴더의 시험 열쇠(test-keys/android-test.jks · 별칭·비밀번호 dure-test — 시험 전용).
 * 진짜 앱은 DURE_ANDROID_KEYSTORE(기본 %USERPROFILE%\.dure-release\android-release.jks · 별칭 dure), 비밀번호는 DURE_ANDROID_KEYSTORE_PASS 로만.
 */
export function requireEnv(env, test) {
  if (missing(env.DURE_ANDROID_TOOLS)) {
    throw new Error('안드로이드 도구 폴더(JDK·SDK·Gradle)를 DURE_ANDROID_TOOLS 환경 변수로 알려 주세요.')
  }
  const tools = env.DURE_ANDROID_TOOLS
  if (test) return { tools, keystore: path.join(tools, 'test-keys', 'android-test.jks'), alias: 'dure-test', pass: 'dure-test' }
  let keystore = env.DURE_ANDROID_KEYSTORE
  if (missing(keystore)) {
    if (missing(env.USERPROFILE)) throw new Error('진짜 서명 열쇠가 어디 있는지 몰라요. DURE_ANDROID_KEYSTORE 환경 변수로 알려 주세요.')
    keystore = path.join(env.USERPROFILE, '.dure-release', 'android-release.jks')
  }
  if (missing(env.DURE_ANDROID_KEYSTORE_PASS)) {
    throw new Error('진짜 앱을 구우려면 서명 열쇠 비밀번호가 필요해요. DURE_ANDROID_KEYSTORE_PASS 환경 변수를 넣어 주세요(시험 앱은 --test).')
  }
  return { tools, keystore, alias: 'dure', pass: env.DURE_ANDROID_KEYSTORE_PASS }
}

/** 앱 판 파일(android/version.json) → { versionCode, versionName }. 판은 1 이상의 정수, 이름은 비지 않은 글이 아니면 던진다 */
export function readVersion(file) {
  let v
  try {
    v = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('앱 판 파일(android/version.json)을 읽지 못했어요. JSON 이어야 해요.')
  }
  if (!Number.isInteger(v?.versionCode) || v.versionCode < 1) throw new Error('android/version.json 의 versionCode 는 1 이상의 정수여야 해요.')
  if (typeof v.versionName !== 'string' || v.versionName === '') throw new Error('android/version.json 의 versionName 은 비지 않은 글이어야 해요.')
  return { versionCode: v.versionCode, versionName: v.versionName }
}

/** src/shared/androidApp.ts 의 글에서 패키지 이름·서명 지문을 읽는다 — 휴대폰 서버(assetlinks.json)와 같은 값을 쓰려고 */
export function androidConsts(ts) {
  const pick = (name) => {
    const m = new RegExp(`export const ${name} = '([^']+)'`).exec(ts)
    if (!m) throw new Error(`src/shared/androidApp.ts 에서 ${name} 를 찾지 못했어요.`)
    return m[1]
  }
  return {
    packageName: pick('ANDROID_PACKAGE'),
    testPackageName: pick('ANDROID_TEST_PACKAGE'),
    sha256: pick('ANDROID_CERT_SHA256'),
    testSha256: pick('ANDROID_TEST_CERT_SHA256'),
  }
}

/** apksigner verify --print-certs 의 글 → 첫 서명자 인증서의 SHA-256('AB:CD:…'), 없으면 null */
export function signerSha256(text) {
  const m = /Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})\b/.exec(text)
  return m ? m[1].toUpperCase().match(/../g).join(':') : null
}
