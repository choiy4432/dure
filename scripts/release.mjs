// 릴리스 올리기: node scripts/release.mjs --notes <파일> [--dry-run]
// 설치 파일 셋(.exe · .blockmap · latest.yml)만 올린다. dist/ 전체는 올리지 않는다(builder-debug.yml 에 로컬 경로가 있다).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const ni = args.indexOf('--notes')
const notes = ni >= 0 ? args[ni + 1] : undefined

function fail(msg) {
  console.error(`중단: ${msg}`)
  process.exit(1)
}
const run = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8' }).trim()
const shell = process.platform === 'win32'

if (!notes) fail('노트 파일을 알려 주세요. 예: npm run release -- --notes notes.md')
if (!existsSync(notes)) fail(`노트 파일이 없어요: ${notes}`)
const text = readFileSync(notes, 'utf8')
if (!text.trimStart().startsWith('- ')) fail('노트는 맨 앞이 "- " 목록이어야 해요.')
if (text.includes('@')) fail('노트에 "@" 가 있어요. 누군가에게 알림이 가니 빼 주세요.')
if (/C:\\Users\\|\/Users\//i.test(text)) fail('노트에 로컬 사용자 경로가 있어요. 빼 주세요.')

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const tag = `v${version}`

if (run('git', ['status', '--porcelain'])) fail('git 작업 폴더가 깨끗하지 않아요. 먼저 커밋해 주세요.')
if (run('git', ['tag', '--list', tag])) fail(`태그 ${tag} 가 이미 있어요(로컬). package.json 버전을 올려 주세요.`)
if (run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) fail(`태그 ${tag} 가 이미 origin 에 있어요.`)
if (spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', shell }).status !== 0) {
  fail('gh 를 못 찾았거나 로그인이 안 돼 있어요. `gh auth login` 을 먼저 해 주세요.')
}

const files = [`dist/Dure-Setup-${version}.exe`, `dist/Dure-Setup-${version}.exe.blockmap`, 'dist/latest.yml']
const build = ['npm', 'run', 'dist']
const release = ['gh', 'release', 'create', tag, ...files, '--title', `두레 ${version}`, '--notes-file', notes]

if (dry) {
  console.log('[dry-run] 올리지 않고 할 일만 보여 드려요.')
  console.log('1.', build.join(' '))
  console.log('2.', release.map((s) => (/\s/.test(s) ? `"${s}"` : s)).join(' '))
  process.exit(0)
}

const sh = (cmd) => {
  const [c, ...a] = cmd
  if (spawnSync(c, a, { stdio: 'inherit', shell }).status !== 0) fail(`실패: ${cmd.join(' ')}`)
}
sh(build)
for (const f of files) if (!existsSync(f)) fail(`빌드 결과가 없어요: ${f}`)
sh(release)
