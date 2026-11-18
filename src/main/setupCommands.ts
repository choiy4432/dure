import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { posix } from 'node:path'
import { claudeEnv, CLAUDE_ENV_DROPPED } from '../engine/claudeEnv'
import { killTree as nodeKillTree } from '../engine/killTree'
import { spawnOpts, type Platform } from '../engine/platform'
import { shq } from '../engine/remote'
import { cmdArgs, startWaitLine } from './cmdLine'
import type { ClaudeCommand } from './claudeCommand'

// 준비 화면의 설치·로그인 명령 — 운영체제마다 무엇을 띄우는지는 순수 함수(installCommand·loginPlan)가, 띄우기는 얇은 층(spawnInstall·spawnLogin)이.
// index.ts 가 이것을 setupFlow 에 꽂는다. 🔴 claude 는 공식 설치 스크립트로만 — 바이너리를 넣어 배포하지 않는다

export type Command = { command: string; args: string[] }

/** 공식 설치 스크립트 — 이 길만 쓴다. mac 은 /bin/bash 절대 경로(curl 은 /usr/bin — Finder 의 빈약한 PATH 에도 있다) */
export function installCommand(p: Platform): Command {
  if (p === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; irm https://claude.ai/install.ps1 | iex',
      ],
    }
  }
  return { command: '/bin/bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] }
}

/** Test-only: DURE_SETUP_INSTALL (JSON argv 배열) — 설치 명령을 가짜로 바꾼다. index 가 주는 raw 는 설치본에선 걸러진 사본(appEnv) */
export function setupInstallCommand(p: Platform, raw: string | undefined): Command {
  if (!raw) return installCommand(p)
  const bad = new Error('DURE_SETUP_INSTALL 은 JSON 배열이어야 해요')
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    throw bad
  }
  if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === 'string')) throw bad
  return { command: list[0] as string, args: (list as string[]).slice(1) }
}

export type LoginPlan = Command & {
  /** spawn 옵션 — env 는 띄우는 층이 붙인다(claudeEnv) */
  options: Record<string, unknown>
  /** mac — 띄우기 전에 쓸 임시 실행 파일 */
  file?: { path: string; content: string; mode: number }
}

const LOGIN_ARGS = ['auth', 'login', '--claudeai']

/**
 * 로그인 — 새 창에서 `claude auth login --claudeai`(브라우저가 열린다. 코드를 붙여 넣는 경우도 그 창에서 된다).
 * win32: 새 콘솔 창 — `cmd.exe /d /v:off /s /c "start "" /wait <claude> auth login --claudeai"`(지금 그대로). start /wait 라 cmd 가 claude 를 기다리며 살아 있고
 *   claude 는 cmd 의 자식 — 나무째 끄면 콘솔 창까지 닫힌다. 줄은 cmdLine 이 만든다(경로에 & ^ % 가 있어도 cmd 가 나누거나 펼치지 않게).
 * darwin: 임시 `<tmpDir>/dure-login-<난수>.command`(0755)를 `open -a Terminal` 로 — Terminal 창에서 돈다. 경로는 POSIX 따옴표(shq).
 *   그 창의 환경은 두레의 것이 아니라(Terminal 의 셸) API 키 변수를 먼저 지운다 — claudeEnv 와 같은 약속(약관 경계선)
 */
export function loginPlan(p: Platform, claude: ClaudeCommand, tmpDir: string, rand: () => string = () => randomBytes(8).toString('hex')): LoginPlan {
  const args = [...claude.argsPrefix, ...LOGIN_ARGS]
  if (p === 'win32') {
    return {
      command: 'cmd.exe',
      args: cmdArgs(startWaitLine(claude.command, args)),
      options: { windowsHide: true, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' },
    }
  }
  const path = posix.join(tmpDir, `dure-login-${rand()}.command`)
  const content = `#!/bin/bash\nunset ${CLAUDE_ENV_DROPPED.join(' ')}\nexec ${[claude.command, ...claude.argsPrefix].map(shq).join(' ')} ${LOGIN_ARGS.join(' ')}\n`
  return { command: '/usr/bin/open', args: ['-a', 'Terminal', path], options: { stdio: 'ignore' }, file: { path, content, mode: 0o755 } }
}

type Spawn = typeof nodeSpawn
type KillTree = typeof nodeKillTree

/** 설치 스크립트를 돌리고 출력(stdout·stderr)을 줄로 쪼개 넘긴다 — kill 은 나무째(PowerShell 이 받아 돌리는 claude install · bash 의 curl 은 자식이다) */
export function spawnInstall(
  cmd: Command,
  onLine: (l: string) => void,
  d: { platform: Platform; env?: NodeJS.ProcessEnv; spawn?: Spawn; killTree?: KillTree },
): { done: Promise<{ code: number | null }>; kill(): Promise<void> } {
  const spawn = d.spawn ?? nodeSpawn
  const killTree = d.killTree ?? nodeKillTree
  const child = spawn(cmd.command, cmd.args, { ...spawnOpts(d.platform), stdio: ['ignore', 'pipe', 'pipe'], env: claudeEnv(d.env ?? process.env) })
  const feed = (stream: NodeJS.ReadableStream | null): void => {
    let rest = ''
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk: string) => {
      rest += chunk
      const parts = rest.split(/\r\n|\n|\r/)
      rest = parts.pop() ?? ''
      for (const l of parts) onLine(l)
    })
    stream?.on('end', () => {
      if (rest) onLine(rest)
    })
  }
  feed(child.stdout)
  feed(child.stderr)
  const done = new Promise<{ code: number | null }>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code }))
  })
  return { done, kill: () => (child.pid ? killTree(child.pid, { platform: d.platform }) : Promise.resolve()) }
}

export type LoginDeps = {
  platform: Platform
  /** 임시 폴더(os.tmpdir) — mac 의 .command 자리 */
  tmpDir: string
  env?: NodeJS.ProcessEnv
  /** 시험용 — 띄우기·끄기·파일 쓰기/지우기·난수 */
  spawn?: Spawn
  killTree?: KillTree
  write?: (path: string, content: string, mode: number) => void
  remove?: (path: string) => void
  rand?: () => string
}

/** 새 파일로만 쓴다(wx — 같은 이름이 이미 있으면, 링크라도 던진다) */
const writeNew = (path: string, content: string, mode: number): void => writeFileSync(path, content, { mode, flag: 'wx' })
const removeFile = (path: string): void => rmSync(path, { force: true })

/**
 * 로그인 창을 연다 — kill 은 흐름이 끝날 때(로그인됨·상한·다시 열기·두레 끄기 — setupFlow 의 stopLogin) 부른다.
 * win32: 그 창의 cmd 를 나무째 끄고 끝날 때까지 기다린다. 이미 끝난 cmd 는 끄지 않는다 — 그 pid 를 다른 프로세스가 물려받았을 수 있다.
 * darwin: .command 를 지운다. 🔴 Terminal 창은 두레가 닫지 못한다(open 은 곧 끝나고 창은 Terminal 의 것) — 흐름만 멈춘다.
 * 못 쓰거나 못 띄우면 던진다(setupFlow 가 로그인 실패로 보인다) — 쓴 파일은 지우고
 */
export function spawnLogin(c: ClaudeCommand, d: LoginDeps): { kill(): Promise<void> } {
  const spawn = d.spawn ?? nodeSpawn
  const plan = loginPlan(d.platform, c, d.tmpDir, d.rand)
  const env = claudeEnv(d.env ?? process.env)
  if (plan.file) {
    const { path, content, mode } = plan.file
    const remove = d.remove ?? removeFile
    ;(d.write ?? writeNew)(path, content, mode)
    let removed = false
    const cleanup = (): void => {
      if (removed) return
      removed = true
      try {
        remove(path)
      } catch {
        /* 이미 없음 — 임시 폴더라 OS 도 치운다 */
      }
    }
    try {
      const child = spawn(plan.command, plan.args, { ...plan.options, env })
      child.on('error', () => {}) // open 을 못 띄움 — 흐름은 상한까지 auth status 를 본다(Windows 와 같다)
    } catch (e) {
      cleanup()
      throw e
    }
    return { kill: async () => cleanup() }
  }
  const killTree = d.killTree ?? nodeKillTree
  const child = spawn(plan.command, plan.args, { ...plan.options, env })
  let alive = true
  const gone = (): void => {
    alive = false
  }
  child.on('exit', gone)
  child.on('error', gone)
  child.unref()
  return { kill: () => (alive && child.pid ? killTree(child.pid, { platform: d.platform }) : Promise.resolve()) }
}
