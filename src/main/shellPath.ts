import { spawn as nodeSpawn } from 'node:child_process'
import { posix } from 'node:path'
import { killTree } from '../engine/killTree'
import { spawnOpts, type Platform } from '../engine/platform'

// mac — Finder·Dock 으로 켠 앱은 셸 프로필을 읽지 않아 PATH 가 launchd 기본(/usr/bin:/bin:/usr/sbin:/sbin)뿐이다. 그러면 claude(Homebrew·npm 설치)와
// 에이전트의 Bash 도구가 쓸 brew·node 를 못 찾는다. 켤 때 한 번 로그인 셸에서 PATH 를 찍게 해 들여온다(fix-path 와 같은 꼴).
// 🔴 PATH 하나만 들인다 — 다른 변수(ANTHROPIC_API_KEY 등)는 셸이 무엇을 찍어도 들이지 않는다(약관 경계선). 상한 3초, 실패하면 그대로

/** 로그인 셸을 기다리는 상한 — 넘으면 셸을 그룹째 끄고 들여오지 않는다(창이 이보다 오래 기다리지 않는다) */
export const SHELL_PATH_TIMEOUT_MS = 3000
const START = '__DURE_PATH_START__'
const END = '__DURE_PATH_END__'
/** $SHELL 이 없거나 절대 경로가 아니면 — mac 의 기본 셸 */
const DEFAULT_SHELL = '/bin/zsh'
/** 셸 출력은 끝쪽 이만큼만 둔다(시끄러운 프로필 — 표식은 맨 끝에 찍힌다) */
const OUTPUT_KEEP = 1024 * 1024

/** 셸을 띄워 stdout 을 돌려준다 — 상한이면 끄고 거절 */
export type ShellRun = (shell: string, args: string[], timeoutMs: number) => Promise<string>

/**
 * 로그인·대화형 셸(-ilc — .zprofile 의 brew shellenv 와 .zshrc 의 export 둘 다)에 PATH 를 표식으로 감싸 찍게 한다 — 프로필이 앞뒤에 무엇을 찍어도 가려낸다.
 * fish 의 $PATH 는 목록이라 string join 으로 ':' 를 잇는다(fish 3 의 "$PATH" 도 ':' 지만 옛 fish 는 빈칸 — 둘 다 같게). string 이 없는 아주 옛 fish 면 표식이 안 나와 null
 */
function shellArgs(shell: string): string[] {
  const printf = `printf "${START}%s${END}"`
  return ['-ilc', posix.basename(shell) === 'fish' ? `${printf} (string join : $PATH)` : `${printf} "$PATH"`]
}

/** 시작 표식 뒤에 끝 표식까지 왔나 — parseShellPath 가 읽는 자리(처음 시작 표식 · 그 뒤 처음 끝 표식)와 같다 */
function hasMarkers(out: string): boolean {
  const s = out.indexOf(START)
  return s >= 0 && out.indexOf(END, s + START.length) >= 0
}

/** 표식 사이의 PATH 만 — 표식이 없거나 비었거나 줄바꿈·NUL 이 들었으면 null. 절대 경로가 아닌 칸(빈 칸·'.'·펼치지 못한 '$PATH')은 버린다 */
export function parseShellPath(stdout: string): string | null {
  const s = stdout.indexOf(START)
  if (s < 0) return null
  const from = s + START.length
  const e = stdout.indexOf(END, from)
  if (e < 0) return null
  const raw = stdout.slice(from, e)
  if (/[\0\r\n]/.test(raw)) return null
  const dirs = raw.split(':').filter((d) => d.startsWith('/'))
  return dirs.length > 0 ? dirs.join(':') : null
}

/** 셸 것을 앞에, 지금 것을 뒤에 — 같은 칸은 처음 것만, 빈 칸은 뺀다. 구분자 ':' */
export function mergePath(current: string | undefined, fromShell: string | null): string {
  const out: string[] = []
  for (const d of [...(fromShell ?? '').split(':'), ...(current ?? '').split(':')]) {
    if (d && !out.includes(d)) out.push(d)
  }
  return out.join(':')
}

/** 로그인 셸의 PATH — darwin 이 아니면 셸을 띄우지 않고 null. 실패·시간 초과(SHELL_PATH_TIMEOUT_MS)·표식 없음이면 null. 던지지 않는다 */
export async function importShellPath(o: { platform: Platform; env: NodeJS.ProcessEnv; run: ShellRun }): Promise<string | null> {
  if (o.platform !== 'darwin') return null
  const shell = o.env.SHELL?.startsWith('/') ? o.env.SHELL : DEFAULT_SHELL
  let timer: NodeJS.Timeout | undefined
  try {
    // run 이 상한을 못 지켜도(끝나지 않는 약속) 여기서 끊는다
    const capped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('시간 초과')), SHELL_PATH_TIMEOUT_MS)
    })
    return parseShellPath(await Promise.race([o.run(shell, shellArgs(shell), SHELL_PATH_TIMEOUT_MS), capped]))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 들여온 PATH 를 env 에 — 🔴 바꾸는 열쇠는 PATH 하나뿐. 들여온 것이 없으면(null) 그대로 */
export function applyShellPath(env: NodeJS.ProcessEnv, fromShell: string | null): void {
  if (fromShell === null) return
  env.PATH = mergePath(env.PATH, fromShell)
}

/**
 * 기본 run — 셸 없이 그 셸을 띄운다(mac 만 쓴다 — 새 프로세스 그룹·제어 터미널 없음이라 프로필이 터미널을 붙잡지 못한다). 입력은 없음(/dev/null),
 * stderr 는 버린다. 끝 표식까지 오면 곧 그때까지의 stdout — 닫히길 기다리지 않는다(프로필이 띄운 뒷일이 stdout 을 쥐고 있으면 close 가 상한까지
 * 안 와 켤 때마다 3초를 기다리고 아무것도 못 들인다). 그때 셸을 그룹째 끄고(그 뒷일까지) 더 듣지 않는다. 표식 없이 닫히면 그때까지의 stdout
 * (끝 코드는 보지 않는다 — 표식이 말한다), 못 띄우면(ENOENT 등) 거절, 상한이면 셸을 그룹째 끄고 거절. spawn·kill 은 시험용
 */
export function shellRunner(d: { spawn?: typeof nodeSpawn; kill?: (pid: number) => Promise<void>; env?: NodeJS.ProcessEnv } = {}): ShellRun {
  const spawn = d.spawn ?? nodeSpawn
  const kill = d.kill ?? ((pid: number) => killTree(pid, { platform: 'darwin' }))
  return (shell, args, timeoutMs) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(shell, args, { ...spawnOpts('darwin'), stdio: ['ignore', 'pipe', 'ignore'], env: d.env ?? process.env })
      let out = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      /** 셸을 그룹째 — 셸이 이미 끝났어도 뒷일이 남았으면 그 그룹은 살아 있다(그룹이 없으면 killTree 가 곧 돌아온다) */
      const killShell = (): void => {
        if (child.pid) void kill(child.pid).catch(() => {})
      }
      const timer = setTimeout(() => {
        finish(() => reject(new Error('시간 초과')))
        killShell()
      }, timeoutMs)
      const onData = (s: string): void => {
        out = (out + s).slice(-OUTPUT_KEEP)
        if (settled || !hasMarkers(out)) return
        child.stdout?.off('data', onData)
        child.stdout?.destroy()
        finish(() => resolve(out))
        killShell()
      }
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', onData)
      child.on('error', (e) => finish(() => reject(e)))
      child.on('close', () => finish(() => resolve(out)))
    })
}
