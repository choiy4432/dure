// 릴리스 올리기: node scripts/release.mjs --notes <파일> [--dry-run]
// 설치 파일 셋(.exe · .blockmap · latest.yml)만 올린다. dist/ 전체는 올리지 않는다(builder-debug.yml 에 로컬 경로가 있다).
// gh 는 셸 없이 부른다 — 제목의 공백, 노트 경로의 공백·&·% 가 쪼개지거나 해석되지 않게.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { androidProblem, notesProblem, releaseArgs, releaseFiles, show } from './releaseLib.mjs'
import { androidSourceHash } from './android/lib.mjs'

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const ni = args.indexOf('--notes')
const notes = ni >= 0 ? args[ni + 1] : undefined

function fail(msg) {
  console.error(`중단: ${msg}`)
  process.exit(1)
}
const run = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

if (!notes) fail('노트 파일을 알려 주세요. 예: npm run release -- --notes notes.md')
if (!existsSync(notes)) fail(`노트 파일이 없어요: ${notes}`)
const problem = notesProblem(readFileSync(notes, 'utf8'))
if (problem) fail(problem)

// 릴리스 커밋이 원격에 있어야 한다 — gh 는 원격 기본 브랜치에 태그를 단다.
try {
  run('git', ['fetch', '--quiet', 'origin'])
} catch {
  fail('origin 에서 최신 상태를 가져오지 못했어요. 네트워크를 확인해 주세요.')
}
let branch = ''
try {
  branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
} catch {}
if (branch !== 'main') fail(`main 브랜치에서만 올릴 수 있어요(지금: ${branch || '알 수 없음'}).`)
let ahead = -1
try {
  ahead = Number(run('git', ['rev-list', '--count', '@{u}..HEAD']))
} catch {
  fail('main 에 원격(upstream)이 연결돼 있지 않아요.')
}
if (ahead !== 0) fail(`아직 push 하지 않은 커밋이 ${ahead}개 있어요. 먼저 git push 해 주세요.`)

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const tag = `v${version}`

if (run('git', ['status', '--porcelain'])) fail('git 작업 폴더가 깨끗하지 않아요. 먼저 커밋해 주세요.')
if (run('git', ['tag', '--list', tag])) fail(`태그 ${tag} 가 이미 있어요(로컬). package.json 버전을 올려 주세요.`)
if (run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) fail(`태그 ${tag} 가 이미 origin 에 있어요.`)
if (spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status !== 0) {
  fail('gh 를 못 찾았거나 로그인이 안 돼 있어요. `gh auth login` 을 먼저 해 주세요.')
}

// 안드로이드 앱 — resources/android/dure.apk(.json)이 android/version.json 과 같은 판 · 진짜 패키지 · 지금 android/ 소스로 구운 것이어야 한다
// (설치 파일에 실린다 — dist·업로드 전에 멈춘다)
let apkInfo = null
try {
  apkInfo = JSON.parse(readFileSync('resources/android/dure.apk.json', 'utf8'))
  if (!existsSync('resources/android/dure.apk')) apkInfo = null
} catch {}
const androidVersion = JSON.parse(readFileSync('android/version.json', 'utf8'))
const androidIssue = androidProblem({ apkInfo, version: androidVersion, sourceHash: androidSourceHash('android') })
if (androidIssue) fail(androidIssue)

const files = releaseFiles(version)
const ghArgs = releaseArgs(version, notes)

if (dry) {
  console.log('[dry-run] 올리지 않고 할 일만 보여 드려요.')
  console.log('1.', 'npm run dist')
  console.log('2.', show('gh', ghArgs))
  process.exit(0)
}

// npm 은 Windows 에서 npm.cmd 라 셸이 필요하다. 사용자 입력 인자가 없는 고정 명령이다.
if (spawnSync('npm run dist', { stdio: 'inherit', shell: true }).status !== 0) fail('실패: npm run dist')
for (const f of files) if (!existsSync(f)) fail(`빌드 결과가 없어요: ${f}`)
if (spawnSync('gh', ghArgs, { stdio: 'inherit' }).status !== 0) fail('실패: gh release create')
