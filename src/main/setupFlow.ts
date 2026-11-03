import type { InstallStep, LoginStep, SetupState } from '../shared/appTypes'
import type { ClaudeCommand } from './claudeCommand'

export type SetupDeps = {
  /** 지금 쓸 claude — 매번 다시 찾는다(설치 직후 PATH 에 생길 수 있다) */
  claude(): ClaudeCommand | null
  loggedIn(c: ClaudeCommand): Promise<boolean>
  version(c: ClaudeCommand): Promise<string | null>
  spawnInstall(onLine: (l: string) => void): { done: Promise<{ code: number | null }>; kill(): Promise<void> }
  spawnLogin(c: ClaudeCommand): { kill(): void }
  relaunch(): void
  /** 엔진이 이미 만들어져 있나 — 없으면 로그인 뒤 두레를 다시 켠다 */
  hasEngine: boolean
  emit(s: SetupState): void
  pollMs?: number
  loginTimeoutMs?: number
  keepLines?: number
}

export type SetupFlow = {
  state(): SetupState
  check(): Promise<void>
  install(): Promise<void>
  login(): Promise<void>
  /** 도는 설치 프로세스 나무를 끄고(끝날 때까지 기다린다) 로그인 확인을 멈춘다 — 이 뒤로는 상태를 내지 않는다 */
  dispose(): Promise<void>
}

const NOT_FOUND = '설치가 끝났는데 claude 를 찾지 못했어요'
const LOGIN_TIMEOUT = '로그인을 확인하지 못했어요 — 다시 해 주세요'

export function createSetupFlow(d: SetupDeps): SetupFlow {
  const pollMs = d.pollMs ?? 2000
  const loginTimeoutMs = d.loginTimeoutMs ?? 600000
  const keepLines = d.keepLines ?? 6

  let state: SetupState = { phase: 'checking' }
  let installStep: InstallStep = { state: 'todo' }
  let installing: { kill(): Promise<void> } | null = null
  let loginProc: { kill(): void } | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let giveUp: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function set(s: SetupState): void {
    if (disposed) return
    state = s
    d.emit(s)
  }
  function needs(login: LoginStep): void {
    set({ phase: 'needs', install: installStep, login })
  }

  function stopLogin(): void {
    if (poll) clearInterval(poll)
    if (giveUp) clearTimeout(giveUp)
    poll = null
    giveUp = null
    loginProc?.kill()
    loginProc = null
  }

  /** 로그인 됨 — 엔진이 있으면 ready, 없으면 다시 켠다 */
  function finish(): void {
    if (d.hasEngine) {
      set({ phase: 'ready' })
    } else {
      set({ phase: 'relaunching' })
      d.relaunch()
    }
  }

  async function check(): Promise<void> {
    const c = d.claude()
    if (!c) {
      installStep = { state: 'todo' }
      needs({ state: 'locked' })
      return
    }
    if (await d.loggedIn(c)) {
      finish()
      return
    }
    installStep = { state: 'done', version: await d.version(c) }
    needs({ state: 'todo' })
  }

  async function install(): Promise<void> {
    if (installing || disposed) return
    const lines: string[] = []
    installStep = { state: 'running', lines: [] }
    needs({ state: 'locked' })
    let proc: ReturnType<SetupDeps['spawnInstall']>
    try {
      proc = d.spawnInstall((l) => {
        if (!l.trim()) return
        lines.push(l)
        if (lines.length > keepLines) lines.splice(0, lines.length - keepLines)
        installStep = { state: 'running', lines: [...lines] }
        needs({ state: 'locked' })
      })
    } catch (e) {
      installStep = { state: 'failed', message: e instanceof Error ? e.message : String(e), lines: [] }
      needs({ state: 'locked' })
      return
    }
    installing = proc
    let code: number | null = null
    let error: string | null = null
    try {
      code = (await proc.done).code
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    installing = null
    if (disposed) return
    const c = code === 0 ? d.claude() : null
    if (c) {
      installStep = { state: 'done', version: await d.version(c) }
      needs({ state: 'todo' })
      return
    }
    const message = code === 0 ? NOT_FOUND : error ?? lines[lines.length - 1] ?? NOT_FOUND
    installStep = { state: 'failed', message, lines: [...lines] }
    needs({ state: 'locked' })
  }

  async function login(): Promise<void> {
    if (disposed) return
    const c = d.claude()
    if (!c) return
    stopLogin()
    try {
      loginProc = d.spawnLogin(c)
    } catch (e) {
      needs({ state: 'failed', message: e instanceof Error ? e.message : String(e) })
      return
    }
    needs({ state: 'waiting' })
    let checking = false
    poll = setInterval(() => {
      if (checking) return
      checking = true
      void d
        .loggedIn(c)
        .catch(() => false)
        .then((ok) => {
          checking = false
          if (!ok || disposed || !poll) return
          stopLogin()
          finish()
        })
    }, pollMs)
    giveUp = setTimeout(() => {
      stopLogin()
      needs({ state: 'failed', message: LOGIN_TIMEOUT })
    }, loginTimeoutMs)
  }

  return {
    state: () => state,
    check,
    install,
    login,
    async dispose() {
      disposed = true
      const killing = installing?.kill()
      installing = null
      stopLogin()
      try {
        await killing
      } catch {
        /* 못 꺼도 끄는 길은 계속 */
      }
    },
  }
}
