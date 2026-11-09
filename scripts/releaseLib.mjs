// release.mjs 의 순수 부분 — 시험할 수 있게 따로 둔다.

// 노트 검사. 문제 없으면 null, 있으면 한국어 사유.
export function notesProblem(text) {
  if (!text.trimStart().startsWith('- ')) return '노트는 맨 앞이 "- " 목록이어야 해요.'
  if (text.includes('@')) return '노트에 "@" 가 있어요. 누군가에게 알림이 가니 빼 주세요.'
  if (/C:\\Users\\|\/Users\//i.test(text)) return '노트에 로컬 사용자 경로가 있어요. 빼 주세요.'
  return null
}

// 안드로이드 앱 검사. 문제 없으면 null, 있으면 한국어 사유.
// 진짜 패키지 이름은 src/shared/androidApp.ts 의 ANDROID_PACKAGE 와 같아야 한다(release.test.ts 가 맞춰 본다)
export const ANDROID_REAL_PACKAGE = 'io.github.choiy4432.dure'
export function androidProblem({ apkInfo, version }) {
  if (!apkInfo) return '안드로이드 앱 파일(resources/android/dure.apk)이 없어요. npm run android 로 먼저 구워 주세요.'
  if (apkInfo.packageName !== ANDROID_REAL_PACKAGE) {
    return '안드로이드 앱의 패키지가 진짜가 아니에요(시험용으로 구운 것일 수 있어요). npm run android 로 다시 구워 주세요.'
  }
  if (apkInfo.versionCode !== version.versionCode || apkInfo.versionName !== version.versionName) {
    return `안드로이드 앱 판(${apkInfo.versionName}, ${apkInfo.versionCode})이 android/version.json(${version.versionName}, ${version.versionCode})과 달라요. npm run android 로 다시 구워 주세요.`
  }
  return null
}

export function releaseFiles(version) {
  return [`dist/Dure-Setup-${version}.exe`, `dist/Dure-Setup-${version}.exe.blockmap`, 'dist/latest.yml']
}

// gh 에 넘길 argv. 셸 없이 그대로 spawn 하므로 제목·경로가 한 칸씩 유지된다.
export function releaseArgs(version, notesFile) {
  return ['release', 'create', `v${version}`, ...releaseFiles(version), '--title', `두레 ${version}`, '--notes-file', notesFile]
}

// 사람이 읽는 한 줄(실행하는 것과 같은 argv 를 따옴표로 감싸 보여 준다).
export function show(cmd, argv) {
  return [cmd, ...argv].map((s) => (/[\s"&%^|<>]/.test(s) ? JSON.stringify(s) : s)).join(' ')
}
