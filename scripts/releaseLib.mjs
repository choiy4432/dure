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
export const ANDROID_STALE = '앱 껍데기를 바꾼 뒤 다시 굽지 않았어요 — npm run android'
// sourceHash = 지금 android/ 소스의 SHA-256(scripts/android/lib.mjs androidSourceHash). 구운 APK 옆 dure.apk.json 의 sourceHash 와 달라야(없어도 — 예전에 구운 것) 멈춘다
export function androidProblem({ apkInfo, version, sourceHash }) {
  if (!apkInfo) return '안드로이드 앱 파일(resources/android/dure.apk)이 없어요. npm run android 로 먼저 구워 주세요.'
  if (apkInfo.packageName !== ANDROID_REAL_PACKAGE) {
    return '안드로이드 앱의 패키지가 진짜가 아니에요(시험용으로 구운 것일 수 있어요). npm run android 로 다시 구워 주세요.'
  }
  if (apkInfo.versionCode !== version.versionCode || apkInfo.versionName !== version.versionName) {
    return `안드로이드 앱 판(${apkInfo.versionName}, ${apkInfo.versionCode})이 android/version.json(${version.versionName}, ${version.versionCode})과 달라요. npm run android 로 다시 구워 주세요.`
  }
  if (typeof apkInfo.sourceHash !== 'string' || apkInfo.sourceHash !== sourceHash) return ANDROID_STALE
  return null
}

export function releaseFiles(version) {
  return [`dist/Dure-Setup-${version}.exe`, `dist/Dure-Setup-${version}.exe.blockmap`, 'dist/latest.yml']
}

// gh 에 넘길 argv. 초안(--draft)으로 올린다 — 초안은 electron-updater 에 안 보여서, 사람이 Publish 를 누를 때까지 사용자에게 안 나간다. 셸 없이 그대로 spawn 하므로 제목·경로가 한 칸씩 유지된다.
export function releaseArgs(version, notesFile) {
  return ['release', 'create', `v${version}`, ...releaseFiles(version), '--title', `두레 ${version}`, '--notes-file', notesFile, '--draft']
}

// 사람이 읽는 한 줄(실행하는 것과 같은 argv 를 따옴표로 감싸 보여 준다).
export function show(cmd, argv) {
  return [cmd, ...argv].map((s) => (/[\s"&%^|<>]/.test(s) ? JSON.stringify(s) : s)).join(' ')
}

export const DRAFT_HINT = 'GitHub 에서 초안을 확인하고 [Publish release] 를 누르면 자동 업데이트가 나가요'

// 올리는 순서: typecheck → 시험 → 빌드 → 올리기. shell 이 true 인 것은 npm(Windows 에서 npm.cmd)이고 인자가 고정이다.
export function releasePlan(version, notesFile) {
  return [
    { name: 'typecheck', cmd: 'npm run typecheck', args: [], shell: true },
    { name: 'test', cmd: 'npm test', args: [], shell: true },
    { name: 'dist', cmd: 'npm run dist', args: [], shell: true },
    { name: 'upload', cmd: 'gh', args: releaseArgs(version, notesFile), shell: false },
  ]
}

// 단계를 차례로 돌린다. exec(step) 이 0 이 아닌 값을 돌려주면 거기서 멈추고 한국어 사유를, 다 되면 null.
export function runPlan(plan, exec) {
  for (const step of plan) {
    if (exec(step) !== 0) return `실패: ${step.cmd}${step.name === 'upload' ? ' release create' : ''} (${step.name})`
  }
  return null
}
