// 두레 안드로이드 앱(TWA 껍데기) 굽기: node scripts/android/build.mjs [--test]   (npm run android -- --test)
// DURE_ANDROID_TOOLS 폴더의 JDK·SDK·Gradle 로 android/ 를 굽는다 — Gradle·SDK 캐시도 그 폴더 안(홈 폴더를 건드리지 않는다).
// JUnit 을 먼저 돌리고(실패하면 멈춤), 서명한 APK 를 resources/android/dure.apk + dure.apk.json({ versionCode, versionName, packageName, sourceHash })으로 둔다.
// sourceHash = 구운 android/ 소스의 SHA-256(lib.mjs androidSourceHash) — 릴리스가 지금 소스와 맞춰 본다(껍데기를 바꾸고 다시 안 구우면 멈춤).
// APK 의 서명 지문이 src/shared/androidApp.ts(휴대폰 서버의 assetlinks.json)와 다르면 멈춘다 — 다르면 크롬이 앱으로 인정하지 않는다.
//   --test  시험 앱: 패키지 …dure.test · 이름 '두레 시험' · 도구 폴더의 시험 열쇠
//   (없음)  진짜 앱: 열쇠 DURE_ANDROID_KEYSTORE(기본 %USERPROFILE%\.dure-release\android-release.jks), 비밀번호는 DURE_ANDROID_KEYSTORE_PASS 로만
// 비밀번호는 명령줄에 싣지 않는다(Gradle 에 환경 변수로 넘긴다).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKUP_REMINDER, androidConsts, androidSourceHash, parseArgs, readVersion, requireEnv, signerSha256 } from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ANDROID = path.join(ROOT, 'android')
const OUT = path.join(ROOT, 'resources', 'android')
const APK_DIR = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release')
const GRADLE = 'gradle-8.14.3'
const BUILD_TOOLS = '36.0.0'

function fail(msg) {
  console.error(`중단: ${msg}`)
  process.exit(1)
}

let opts, env, version, consts, sourceHash
try {
  opts = parseArgs(process.argv.slice(2))
  env = requireEnv(process.env, opts.test)
  version = readVersion(path.join(ANDROID, 'version.json'))
  consts = androidConsts(readFileSync(path.join(ROOT, 'src', 'shared', 'androidApp.ts'), 'utf8'))
  // 굽기 전에 센다 — 구운 것(build/)·.gradle/·local.properties 는 셈에서 빠진다
  sourceHash = androidSourceHash(ANDROID)
} catch (e) {
  fail(e.message)
}
const packageName = opts.test ? consts.testPackageName : consts.packageName
const sha256 = opts.test ? consts.testSha256 : consts.sha256

const jdk = path.join(env.tools, 'jdk')
const sdk = path.join(env.tools, 'sdk')
const java = path.join(jdk, 'bin', 'java.exe')
const gradle = path.join(env.tools, GRADLE, 'bin', 'gradle.bat')
const apksigner = path.join(sdk, 'build-tools', BUILD_TOOLS, 'lib', 'apksigner.jar')
for (const [what, p] of [
  ['JDK', java],
  ['Android SDK(platform 36)', path.join(sdk, 'platforms', 'android-36')],
  [`build-tools ${BUILD_TOOLS}`, apksigner],
  [GRADLE, gradle],
]) {
  if (!existsSync(p)) fail(`도구 폴더에 ${what} 가 없어요(${path.relative(env.tools, p)}).`)
}
if (!existsSync(env.keystore)) {
  fail(opts.test ? '도구 폴더에 시험 서명 열쇠가 없어요(test-keys\\android-test.jks).' : '진짜 서명 열쇠 파일이 없어요. DURE_ANDROID_KEYSTORE 를 봐 주세요.')
}
// gradle.bat 은 cmd 로만 돈다 — 경로는 따옴표로 감싸지만 % 는 cmd 가 풀어 버린다
if (gradle.includes('%')) fail('도구 폴더 경로에 % 가 있으면 Gradle 을 부를 수 없어요.')

// SDK 자리(git 에 넣지 않음). properties 글이라 \ 와 : 를 이스케이프한다(Android Studio 와 같은 꼴)
const sdkDir = sdk.replaceAll('\\', '\\\\').replaceAll(':', '\\:')
writeFileSync(path.join(ANDROID, 'local.properties'), `# scripts/android/build.mjs 가 만든다(git 에 넣지 않음)\nsdk.dir=${sdkDir}\n`)

console.log(`굽는 중: ${packageName} v${version.versionName}(판 ${version.versionCode}) — JUnit 먼저`)
const gradleArgs = ['--no-daemon', '--console=plain', `-PdureTest=${opts.test}`, 'testReleaseUnitTest', 'assembleRelease']
const built = spawnSync(`"${gradle}" ${gradleArgs.join(' ')}`, {
  cwd: ANDROID,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    JAVA_HOME: jdk,
    ANDROID_HOME: sdk,
    GRADLE_USER_HOME: path.join(env.tools, '.gradle'),
    ANDROID_USER_HOME: path.join(env.tools, '.android'),
    DURE_SIGN_STORE: env.keystore,
    DURE_SIGN_ALIAS: env.alias,
    DURE_SIGN_PASS: env.pass,
  },
})
if (built.status !== 0) fail('Gradle 굽기 또는 JUnit 이 실패했어요(위 기록을 봐 주세요).')

// Gradle 이 남긴 output-metadata.json 으로 APK 를 찾고, 패키지·판이 바라던 것인지 본다
let meta
try {
  meta = JSON.parse(readFileSync(path.join(APK_DIR, 'output-metadata.json'), 'utf8'))
} catch {
  fail('구운 APK 의 정보(output-metadata.json)를 읽지 못했어요.')
}
const el = meta.elements?.[0]
if (meta.applicationId !== packageName) fail(`구운 APK 의 패키지(${meta.applicationId})가 ${packageName} 이 아니에요.`)
if (el?.versionCode !== version.versionCode || el?.versionName !== version.versionName) {
  fail('구운 APK 의 판이 android/version.json 과 달라요.')
}
const apk = path.join(APK_DIR, el.outputFile)

const verified = spawnSync(java, ['-jar', apksigner, 'verify', '--print-certs', apk], { encoding: 'utf8' })
if (verified.status !== 0) fail(`APK 서명 확인에 실패했어요.\n${verified.stderr}`)
const signer = signerSha256(verified.stdout)
if (signer !== sha256) fail(`APK 서명 지문(${signer})이 src/shared/androidApp.ts 의 지문과 달라요 — 크롬이 앱으로 인정하지 않아요.`)

mkdirSync(OUT, { recursive: true })
copyFileSync(apk, path.join(OUT, 'dure.apk'))
const info = { versionCode: version.versionCode, versionName: version.versionName, packageName, sourceHash }
writeFileSync(path.join(OUT, 'dure.apk.json'), `${JSON.stringify(info, null, 2)}\n`)
console.log(`다 됐어요: resources/android/dure.apk — ${packageName} v${version.versionName}(판 ${version.versionCode}) · 서명 지문 ${signer}`)
// 진짜 앱만 — 열쇠를 잃으면 앱을 다시는 업데이트할 수 없다(README '릴리스 올리기')
if (!opts.test) console.log(BACKUP_REMINDER)
