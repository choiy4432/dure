import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { killTree } from '../../engine/killTree'
import type { TailscaleState } from '../../shared/phoneTypes'
import { jsonArgs } from '../claudeCommand'

// Tailscale 감싸기 — 사용자 PC 의 tailscale CLI 를 불러 상태를 보고, 두레 포트 하나만 `tailscale serve` 로 tailnet 안에 연다.
// 명령·칸 이름은 실측 그대로(probe28 — .superpowers/sdd/2026-11-04-dure-phone-remote/task-1-report.md).
// 🔴 `serve reset`·`funnel` 은 쓰지 않는다. 지우는 건 두레가 연 꼴(그 https 포트의 '/' 하나가 http://127.0.0.1:<두레 포트>)일 때만.
//    켜는 것도 그 https 포트가 비었거나 이미 두레 꼴일 때만(`serve --bg` 는 그 포트의 사용자 길을 덮어쓴다).
// 🔴 status 출력에서 BackendState·Self.DNSName·CertDomains 길이만 꺼낸다 — User·CurrentTailnet(로그인 이름·이메일이 든다)은 읽지 않는다.
//    CLI 의 출력은 결과·오류 글·로그에 옮기지 않는다(이 파일은 아무것도 로그에 쓰지 않는다). 셸 없이, 인자는 배열로, 창 없이.

/** status --json · serve status --json · serve off 를 기다리는 상한 */
export const TAILSCALE_STATUS_TIMEOUT_MS = 10_000
/** serve --bg 를 기다리는 상한 — Serve 가 꺼진 tailnet 이면 끝나지 않는다(켜기 링크를 찍고 기다림, 실측) */
export const TAILSCALE_SERVE_TIMEOUT_MS = 20_000
/** 끈 뒤 프로세스가 닫히길 이만큼까지 기다린다 */
const CLOSE_WAIT_MS = 5_000
/** stdout·stderr 각각 이만큼까지만 모은다(status --json 은 tailnet 의 기기 수만큼 길다) */
const OUTPUT_MAX = 8 * 1024 * 1024

const E = {
  missing: 'Tailscale 을 찾지 못했어요',
  timeout: 'Tailscale 이 답하지 않아요 — 잠시 뒤 다시 해 주세요',
  serveFailed: (code: number | null) => `Tailscale 로 휴대폰 길을 열지 못했어요(코드 ${code ?? '없음'})`,
  offFailed: (code: number | null) => `Tailscale 의 휴대폰 길을 닫지 못했어요(코드 ${code ?? '없음'})`,
  serveUnreadable: 'Tailscale 의 serve 설정을 읽지 못했어요',
  portBusy: '그 포트는 이미 다른 곳에 쓰이고 있어요',
  funnel: '이 포트가 인터넷에 공개(Funnel)돼 있어요 — Tailscale 에서 Funnel 을 꺼 주세요',
  badPort: '포트 번호가 틀렸어요',
}

export type TailscaleCommand = { command: string; args: string[] }

export type RunResult =
  /** 명령을 띄우지 못함(없음·권한 없음) */
  | { kind: 'missing' }
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string }
  /** 상한을 넘겨 나무째 끔 */
  | { kind: 'timeout'; stdout: string; stderr: string }
  /** until 이 참이라 나무째 끔 */
  | { kind: 'stopped'; stdout: string; stderr: string }

export type RunOptions = {
  timeoutMs: number
  /** 출력이 올 때마다 — 참이면 기다리지 않고 끈다 */
  until?: (stdout: string, stderr: string) => boolean
}

export type Runner = (command: string, args: string[], o: RunOptions) => Promise<RunResult>

/** 기본 Runner — 셸 없이 띄우고, 상한·until 이면 프로세스 나무를 끈다(Windows 는 자식이 부모보다 오래 산다). 던지지 않는다 */
export function runCommand(
  command: string,
  args: string[],
  o: RunOptions & { env?: NodeJS.ProcessEnv; kill?: (pid: number) => Promise<void> },
): Promise<RunResult> {
  const kill = o.kill ?? killTree
  return new Promise<RunResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: o.env })
    } catch {
      resolve({ kind: 'missing' })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let stopping: 'timeout' | 'stopped' | null = null
    const finish = (r: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const stop = (why: 'timeout' | 'stopped'): void => {
      if (stopping || settled) return
      stopping = why
      const done = (): void => finish({ kind: why, stdout, stderr })
      const pid = child.pid
      if (!pid) return done()
      // 끈 뒤 닫히길 기다린다 — 안 닫혀도 상한 뒤엔 돌려준다
      child.once('close', done)
      setTimeout(done, CLOSE_WAIT_MS).unref()
      // 나무째 끄기가 실패했으면(던짐·taskkill 이 조용히 실패) 그 프로세스라도 끈다
      Promise.resolve()
        .then(() => kill(pid))
        .catch(() => {})
        .then(() => {
          if (child.exitCode !== null || child.signalCode !== null) return
          try {
            child.kill()
          } catch {
            /* 이미 끝남 */
          }
        })
    }
    const timer = setTimeout(() => stop('timeout'), o.timeoutMs)
    const check = (): void => {
      if (!stopping && o.until?.(stdout, stderr)) stop('stopped')
    }
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < OUTPUT_MAX) stdout += d
      check()
    })
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < OUTPUT_MAX) stderr += d
      check()
    })
    child.on('error', () => {
      if (!stopping) finish({ kind: 'missing' })
    })
    child.on('close', (code) => {
      if (!stopping) finish({ kind: 'exit', code, stdout, stderr })
    })
  })
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * `status --json` 출력 → 상태. 꺼내는 칸은 BackendState · Self.DNSName(끝 '.' 떼기) · CertDomains 길이뿐.
 * 상태를 알 수 없는 출력(JSON 아님·BackendState 없음 — 서비스가 안 돎 등)이면 null.
 */
export function stateFromStatus(text: string): TailscaleState | null {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return null // 오류 글에 출력 조각이 들 수 있다 — 버린다
  }
  if (!isRecord(j) || typeof j.BackendState !== 'string') return null
  if (j.BackendState !== 'Running') return { kind: 'logged-out' } // NeedsLogin · Stopped · NeedsMachineAuth …
  const self = isRecord(j.Self) ? j.Self : null
  const dnsName = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '').toLowerCase() : ''
  if (!HOSTNAME.test(dnsName)) return { kind: 'logged-out' } // 주소를 만들 수 없다
  const certs = Array.isArray(j.CertDomains) ? j.CertDomains.length : 0
  if (certs === 0) return { kind: 'no-https', enableUrl: null }
  return { kind: 'ready', dnsName }
}

const ENABLE_URL = /https:\/\/login\.tailscale\.com\/f\/serve\?[A-Za-z0-9._~%=&+-]+/

/**
 * Serve 가 꺼진 tailnet 에서 `serve --bg` 가 찍는 켜기 링크(`https://login.tailscale.com/f/serve?node=…`).
 * 아직 도는 중(ended 아님)이면 링크 뒤에 글자가 더 와야(줄 바꿈 등) 끝까지 받은 것으로 친다.
 * stdout·stderr 는 따로 넣는다 — 둘을 이어 붙이면 그 사이 글자가 '링크 뒤 글자' 가 되어 덜 받은 링크를 끝으로 친다.
 */
export function enableUrlIn(text: string, ended: boolean): string | null {
  const m = ENABLE_URL.exec(text)
  if (!m) return null
  if (!ended && m.index + m[0].length >= text.length) return null
  return m[0]
}

/** `serve --bg` 의 결과 — 켜짐, 또는 tailnet 의 Serve 가 꺼져 있어 켜기 링크(화면이 그 링크를 열게 한다) */
export type ServeOnResult = { kind: 'on' } | Extract<TailscaleState, { kind: 'no-https' }>

/*
 * dnsName(이 기기 이름 — status() 의 ready.dnsName, Task 7 은 켤 때 적어 둔 이름)을 주면 두레 길은 그 이름의 길 하나뿐이다:
 * 그 https 포트의 Web 항목이 `<dnsName>:<https>` 하나뿐이어야 한다(기기 이름이 바뀌어 남은 예전 이름의 길·다른 이름의 길은 남의 것).
 * 안 주면 그 https 포트의 Web 항목이 모두 두레 꼴이면 두레 것.
 */
export interface Tailscale {
  /** 깔렸나 → 로그인됐나 → https(Serve) 가 켜졌나 → 준비됨. 던지지 않는다 */
  status(): Promise<TailscaleState>
  /**
   * `serve --bg --https=<httpsPort> http://127.0.0.1:<localPort>`. 먼저 serve 설정을 읽어, 그 https 포트가 비었거나
   * 이미 두레 길(→ 그 localPort)일 때만 켠다 — 남이 쓰면 '그 포트는 이미 다른 곳에 쓰이고 있어요'.
   * 그 포트가 Funnel(인터넷 공개)이면 두레 길이어도 켜지 않는다 — '이 포트가 인터넷에 공개(Funnel)돼 있어요 …'.
   * 설정을 못 읽거나 실패·시간 초과는 한국어 오류로 던진다
   */
  serveOn(httpsPort: number, localPort: number, dnsName?: string): Promise<ServeOnResult>
  /**
   * 그 https 포트가 두레 길(→ http://127.0.0.1:<localPort>)이면 `serve --https=<httpsPort> off` 하고 true(Funnel 이 켜져 있어도 끈다 — 공개된 길을 남기지 않게).
   * 없거나 남의 것이면 그대로 false. 설정을 못 읽거나 끄기 실패는 던진다
   */
  serveOff(httpsPort: number, localPort: number, dnsName?: string): Promise<boolean>
  /** serve 설정(앞쪽 세션 포함)에 그 https 포트가 없고 Funnel 도 아니다 — 설정을 못 읽으면 한국어 오류로 던진다('쓰이고 있음'과 다른 까닭) */
  httpsPortFree(httpsPort: number): Promise<boolean>
  /** serve 설정(앞쪽 세션 포함)의 AllowFunnel 에 그 https 포트가 공개(true)로 있다 — 읽지 못하면 false(모르면 열린 길을 닫지 않는다) */
  funnelOn(httpsPort: number): Promise<boolean>
  /** 비정상 종료로 남은 두레 길만 끈다(serveOff 와 같은 규칙) — 껐으면 true. 던지지 않는다 */
  cleanup(httpsPort: number, localPort: number, dnsName?: string): Promise<boolean>
}

/**
 * 적어 둔 두레 길(phone.json 의 serve — 켤 때 적은 {httpsPort, localPort, dnsName})을 끈다 — 껐으면 true, 이미 없거나 남의 것이면 false.
 * PC 이름을 Tailscale 에서 바꾸면 그 길이 지금 이름 아래로 옮겨질 수 있다 — 적어 둔 이름으로 두레 꼴이 아니면 status 의 지금 이름으로 한 번 더
 * (같은 https 포트 · 그 이름의 Web 항목 하나 · '/' 하나가 그 127.0.0.1 포트). 설정을 못 읽거나 끄기가 실패하면 던진다
 */
export async function offRecordedRoute(
  t: Pick<Tailscale, 'status' | 'serveOff'>,
  rec: { httpsPort: number; localPort: number; dnsName?: string },
): Promise<boolean> {
  if (await t.serveOff(rec.httpsPort, rec.localPort, rec.dnsName)) return true
  if (rec.dnsName === undefined) return false
  const now = await t.status()
  if (now.kind !== 'ready' || now.dnsName === rec.dnsName.toLowerCase()) return false
  return t.serveOff(rec.httpsPort, rec.localPort, now.dnsName)
}

function checkPort(p: number): void {
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(E.badPort)
}

/** serve 설정의 한 덩이(맨 위 또는 Foreground 의 세션 하나)에 그 포트가 쓰이나 */
function portUsedIn(conf: Record<string, unknown>, port: number): boolean {
  if (isRecord(conf.TCP) && String(port) in conf.TCP) return true
  return isRecord(conf.Web) && Object.keys(conf.Web).some((k) => k.endsWith(`:${port}`))
}

/** 앞쪽(foreground) `tailscale serve` 세션이 그 포트를 쥐고 있나 */
function foregroundUses(conf: Record<string, unknown>, port: number): boolean {
  const fg = isRecord(conf.Foreground) ? Object.values(conf.Foreground) : []
  return fg.some((s) => isRecord(s) && portUsedIn(s, port))
}

/**
 * 그 포트가 Funnel(인터넷 공개)인가 — AllowFunnel["<이름>:<포트>"] 가 true(맨 위 또는 앞쪽 세션). 이름은 가리지 않는다(어느 이름이든 그 포트로 들어온다).
 * 🔴 두레는 `funnel` 을 쓰지 않는다 — 사용자가 켰을 때 그 포트를 쓰지 않으려고 읽기만 한다
 */
function funnelIn(conf: Record<string, unknown>, port: number): boolean {
  const on = (c: Record<string, unknown>) =>
    isRecord(c.AllowFunnel) && Object.entries(c.AllowFunnel).some(([k, v]) => v === true && k.endsWith(`:${port}`))
  const fg = isRecord(conf.Foreground) ? Object.values(conf.Foreground) : []
  return on(conf) || fg.some((s) => isRecord(s) && on(s))
}

/**
 * 두레가 연 꼴인가 — TCP[<https>] = { HTTPS: true } 이고, 그 포트의 Web 항목이 '/' 하나뿐이며 http://127.0.0.1:<local> 로 간다.
 * dnsName 을 주면 그 포트의 Web 항목이 `<dnsName>:<https>` 하나뿐이어야 한다(대소문자는 가리지 않음)
 */
function oursIn(conf: Record<string, unknown>, httpsPort: number, localPort: number, dnsName?: string): boolean {
  const tcp = isRecord(conf.TCP) ? conf.TCP[String(httpsPort)] : undefined
  if (!isRecord(tcp) || tcp.HTTPS !== true) return false
  const webs = isRecord(conf.Web) ? Object.entries(conf.Web).filter(([k]) => k.endsWith(`:${httpsPort}`)) : []
  if (webs.length === 0) return false
  if (dnsName !== undefined && (webs.length !== 1 || webs[0][0].toLowerCase() !== `${dnsName.toLowerCase()}:${httpsPort}`)) return false
  const target = `http://127.0.0.1:${localPort}`
  return webs.every(([, w]) => {
    const handlers = isRecord(w) && isRecord(w.Handlers) ? w.Handlers : null
    if (!handlers || Object.keys(handlers).length !== 1) return false
    const root = handlers['/']
    return isRecord(root) && root.Proxy === target
  })
}

export function createTailscale(o: { command: string; args: string[]; run?: Runner }): Tailscale {
  const run: Runner = o.run ?? ((command, args, ro) => runCommand(command, args, ro))
  const cli = (args: string[], ro: RunOptions): Promise<RunResult> => run(o.command, [...o.args, ...args], ro)

  /** `serve status --json` — 못 읽으면 한국어 오류로 던진다(CLI 출력은 옮기지 않음) */
  const readServeConfig = async (): Promise<Record<string, unknown>> => {
    const r = await cli(['serve', 'status', '--json'], { timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS })
    if (r.kind === 'missing') throw new Error(E.missing)
    if (r.kind !== 'exit') throw new Error(E.timeout)
    if (r.code !== 0) throw new Error(E.serveUnreadable)
    let j: unknown
    try {
      j = JSON.parse(r.stdout)
    } catch {
      throw new Error(E.serveUnreadable)
    }
    if (!isRecord(j)) throw new Error(E.serveUnreadable)
    return j
  }
  /** `serve status --json` — 못 읽으면 null */
  const serveConfig = (): Promise<Record<string, unknown> | null> => readServeConfig().catch(() => null)

  /** 두레 길이면 끈다 — 껐으면 true, 없거나 남의 것이면 false. 설정을 못 읽거나 끄기가 실패하면 던진다 */
  const offIfOurs = async (httpsPort: number, localPort: number, dnsName?: string): Promise<boolean> => {
    checkPort(httpsPort)
    checkPort(localPort)
    const conf = await readServeConfig()
    if (!oursIn(conf, httpsPort, localPort, dnsName)) return false
    const r = await cli(['serve', `--https=${httpsPort}`, 'off'], { timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS })
    if (r.kind === 'missing') throw new Error(E.missing)
    if (r.kind !== 'exit') throw new Error(E.timeout)
    if (r.code !== 0) throw new Error(E.offFailed(r.code))
    return true
  }

  return {
    async status() {
      const r = await cli(['status', '--json'], { timeoutMs: TAILSCALE_STATUS_TIMEOUT_MS })
      if (r.kind !== 'exit') return { kind: 'missing' }
      // 로그인 안 됐어도 JSON 은 나온다 — 코드보다 출력을 본다. 알 수 없는 출력(서비스가 안 돎 등) = 쓸 수 없음
      return stateFromStatus(r.stdout) ?? { kind: 'missing' }
    },

    async serveOn(httpsPort, localPort, dnsName) {
      checkPort(httpsPort)
      checkPort(localPort)
      // `serve --bg` 는 그 포트의 사용자 길을 덮어쓴다 — 비었거나 이미 두레 길일 때만(앞쪽 세션이 쥐었으면 안 됨).
      // 공개(Funnel)된 포트는 두레 길이어도 안 된다 — 두레가 인터넷에 열린다
      const conf = await readServeConfig()
      if (funnelIn(conf, httpsPort)) throw new Error(E.funnel)
      const free = !portUsedIn(conf, httpsPort) || oursIn(conf, httpsPort, localPort, dnsName)
      if (!free || foregroundUses(conf, httpsPort)) throw new Error(E.portBusy)
      const r = await cli(['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`], {
        timeoutMs: TAILSCALE_SERVE_TIMEOUT_MS,
        until: (stdout, stderr) => (enableUrlIn(stdout, false) ?? enableUrlIn(stderr, false)) !== null,
      })
      if (r.kind === 'missing') throw new Error(E.missing)
      const enableUrl = enableUrlIn(r.stdout, true) ?? enableUrlIn(r.stderr, true)
      if (enableUrl) return { kind: 'no-https', enableUrl }
      if (r.kind !== 'exit') throw new Error(E.timeout)
      if (r.code !== 0) throw new Error(E.serveFailed(r.code))
      return { kind: 'on' }
    },

    serveOff(httpsPort, localPort, dnsName) {
      return offIfOurs(httpsPort, localPort, dnsName)
    },

    async httpsPortFree(httpsPort) {
      checkPort(httpsPort)
      const conf = await readServeConfig()
      return !portUsedIn(conf, httpsPort) && !foregroundUses(conf, httpsPort) && !funnelIn(conf, httpsPort)
    },

    async funnelOn(httpsPort) {
      checkPort(httpsPort)
      const conf = await serveConfig()
      return conf ? funnelIn(conf, httpsPort) : false
    },

    async cleanup(httpsPort, localPort, dnsName) {
      try {
        return await offIfOurs(httpsPort, localPort, dnsName)
      } catch {
        return false
      }
    },
  }
}

/** 손잡이를 찾을 때 Windows 환경 변수는 대소문자를 가리지 않는다(Path·PATH) */
function envGet(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

/** 완전한 드라이브 경로(`C:\…`)인가 — 상대(`.`·`bin`)·루트 상대(`\x`, 지금 드라이브)·드라이브 상대(`C:x`)·UNC 는 아님 */
const fullDrivePath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p)

/**
 * tailscale CLI — DURE_TAILSCALE_COMMAND (+ DURE_TAILSCALE_ARGS, JSON 배열)로 시험·개발은 가짜.
 * 아니면 %ProgramFiles%\Tailscale\tailscale.exe 먼저(관리자만 쓰는 폴더 · 실측: PATH 에 없을 수 있다) → 없으면 PATH 의 tailscale.exe
 * (완전한 드라이브 경로 폴더만). 둘 다 없으면 ProgramFiles 쪽 경로를 돌려준다 — 있는지는 status() 가 본다
 */
export function resolveTailscaleCommand(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean = existsSync,
): TailscaleCommand {
  const override = env.DURE_TAILSCALE_COMMAND
  if (override) return { command: override, args: jsonArgs(env.DURE_TAILSCALE_ARGS, 'DURE_TAILSCALE_ARGS') }
  const pf = envGet(env, 'ProgramFiles')?.trim()
  const installed = join(pf && fullDrivePath(pf) ? pf : 'C:\\Program Files', 'Tailscale', 'tailscale.exe')
  if (exists(installed)) return { command: installed, args: [] }
  for (const raw of (envGet(env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    // 상대·루트 상대·드라이브 상대는 지금 폴더·드라이브에 따라 심어 둔 exe 를 부를 수 있다 — 건너뜀
    if (!fullDrivePath(dir)) continue
    const p = join(dir, 'tailscale.exe')
    if (exists(p)) return { command: p, args: [] }
  }
  return { command: installed, args: [] }
}
