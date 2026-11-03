// release.mjs 의 순수 부분 — 시험할 수 있게 따로 둔다.

// 노트 검사. 문제 없으면 null, 있으면 한국어 사유.
export function notesProblem(text) {
  if (!text.trimStart().startsWith('- ')) return '노트는 맨 앞이 "- " 목록이어야 해요.'
  if (text.includes('@')) return '노트에 "@" 가 있어요. 누군가에게 알림이 가니 빼 주세요.'
  if (/C:\\Users\\|\/Users\//i.test(text)) return '노트에 로컬 사용자 경로가 있어요. 빼 주세요.'
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
