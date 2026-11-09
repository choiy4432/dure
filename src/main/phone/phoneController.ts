import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { ANDROID_PACKAGE, ANDROID_TEST_PACKAGE } from '../../shared/androidApp'
import { EVENT_NAMES } from '../../shared/ipcContract'
import {
  PAIR_TTL_MS, PHONE_PORT_DEFAULT, pickPhoneChange,
  type PhonePairOffer, type PhoneSettingsChange, type PhoneState, type TailscaleState,
} from '../../shared/phoneTypes'
import { phoneDispatcher, type Dispatch } from '../dispatch'
import { assetStatements, readApk } from './androidApp'
import { createPairing, type Pairing } from './pairing'
import { createPhoneNotifier, type NotifierEngine } from './phoneNotifier'
import { startPhoneServer, type PhoneServer, type PhoneServerOptions } from './phoneServer'
import { openPhoneStore, publicDevice } from './phoneStore'
import { createPush, type Push } from './push'
import { offRecordedRoute, type ServeOnResult, type Tailscale } from './tailscale'

// 휴대폰 연결 묶기 — 켜기(Tailscale 확인 → 127.0.0.1 서버 → tailscale serve 길 → 절전 막기)·끄기·짝 맺기·기기 끊기·알림 판단·자동 켜기.
// 길은 두레가 연 것만 다룬다: 열기 전에 그 짝({httpsPort, localPort, dnsName})을 phone.json 에 적고, 끌 때·다음 시작 때 그 짝만 끈다(포트를 짐작해 지우지 않는다).
// 🔴 휴대폰엔 엔진 사건만 간다(앱 사건 'phone' 은 PC 창에만) · 짝 코드는 QR·주소에만(상태·로그엔 없음) · 진짜 tailscale·절전 막기·로그인 항목은 주입받는다(시험은 가짜)

/** tailnet https 포트 차례 — 443 이면 주소에 포트가 없다(알림에 붙는 사이트 주소가 짧다), 남이 쓰면 서버 기본 포트와 같은 번호 */
export const PHONE_HTTPS_PORTS: readonly number[] = Object.freeze([443, PHONE_PORT_DEFAULT])
/** 켜져 있는데 길이 안 열렸으면(Tailscale 이 아직 안 켜짐·로그인 전·https 꺼짐 …)·꺼졌는데 두레 길을 못 껐으면 이만큼 뒤에 다시 해 본다 — 열리면·정리되면 그만 */
export const PHONE_RETRY_MS = 30_000
/** 휴대폰이 올린 파일을 두는 폴더(<dataDir> 아래) — 시작·끄기·두레 끄기 때 비운다(올리기만 하고 안 보낸 것) */
export const PHONE_INBOX = 'phone-inbox'

const E = {
  notReady: '휴대폰 연결이 아직 열리지 않았어요',
  noHttpsPort: 'tailnet 의 https 포트 443·47615 가 모두 다른 곳에 쓰이고 있어요 — 하나를 비워 주세요',
  /** https 포트를 고르려고 serve 설정을 읽다 못 읽음 — '모두 쓰이고 있어요' 와 다른 까닭 */
  unreadable: 'Tailscale 상태를 읽지 못했어요 — 잠시 뒤 다시 확인해 주세요',
  /** 사용자가 그 https 포트에 Funnel(인터넷 공개)을 켰다 — 두레는 그 포트를 쓰지도 남기지도 않는다 */
  funnel: '이 포트가 인터넷에 공개(Funnel)돼 있어요 — Tailscale 에서 Funnel 을 꺼 주세요',
  stale: '두레가 전에 연 길을 정리하지 못했어요 — Tailscale 이 켜져 있는지 확인해 주세요',
  failed: '휴대폰 연결을 켜지 못했어요',
  /** 다시 연 주소가 앞서 연 주소와 다르다 — 짝 맺은 휴대폰은 예전 주소(그 주소의 쿠키)만 안다 */
  moved: '주소가 바뀌었어요 — 휴대폰을 다시 짝 맺어 주세요',
  /** 예전 PC 이름 아래 남은 두레 길 — 다른 serve 설정이 있어 지우지 않았다(serveOff 'left'). 그 이름으로는 이제 닿지 않는다 */
  left: '예전 PC 이름으로 연 두레 길은 Tailscale 의 다른 serve 설정이 있어 지우지 않고 남겨 뒀어요',
} as const

export type IdleState = 'active' | 'idle' | 'locked' | 'unknown'

export interface PhoneControllerOptions {
  /** <userData> — phone.json·phone-inbox 가 여기 */
  dataDir: string
  /** 알림 판단·휴대폰에 보낼 사건 — 없으면(claude 없음) 둘 다 없다 */
  engine: NotifierEngine | null
  /** 창 IPC 와 같은 디스패처(createDispatcher) — 휴대폰은 phoneDispatcher 로 감싸 탄다 */
  dispatch: Dispatch
  /** 휴대폰 묶음 폴더(phoneStaticDir) */
  staticDir: string
  /** 안드로이드 앱 폴더(dure.apk · dure.apk.json) — 설치본은 resources/android, 개발은 resources/android(굽기 결과) */
  androidDir: string
  /** 시험 빌드(dure-…)·개발 실행 — 시험 패키지 앱과 그 확인 항목도 받는다. 진짜 빌드는 진짜 패키지만 */
  androidTest?: boolean
  tailscale: Pick<Tailscale, 'status' | 'serveOn' | 'serveOff' | 'httpsPortFree' | 'funnelOn'>
  /** 절전 막기 — 진짜는 powerSaveBlocker('prevent-app-suspension') */
  power: { start(): number; stop(id: number): void }
  /** 진짜는 powerMonitor.getSystemIdleState(120) — 'active' 면 PC 를 쓰는 중이라 휴대폰은 안 울린다(미뤘다가 자리를 비우면 보낸다) */
  idle: () => IdleState
  /** PC 를 떠났다는 신호 — 진짜는 powerMonitor 'lock-screen'. 오면 PC 를 쓰는 중이라 미룬 알림을 보낸다. 돌려준 함수로 푼다 */
  pcAway?: (fn: () => void) => () => void
  /** 시험만 — 미룬 알림의 다시 보기 타이머(기본 setInterval) */
  every?: (ms: number, fn: () => void) => () => void
  /** Windows 를 켜면 두레도 켜기 — 진짜는 설치본에서만 app.setLoginItemSettings, 개발 실행·시험은 가짜 */
  loginItem: { set(open: boolean): void }
  /** 앱 사건 'phone' — PC 창으로만 */
  emit: (s: PhoneState) => void
  /** e2e 만(DURE_PHONE_ALLOW_LOCAL=1) — 서버가 http://127.0.0.1:<포트> 도 받는다 */
  allowLocal?: boolean
  /** 시험 — 서버·푸시를 가짜로, 다시 해 보는 간격 */
  startServer?: (o: PhoneServerOptions) => Promise<PhoneServer>
  push?: Push
  retryMs?: number
  /** 기본 console.error — 고정된 글만 싣는다(경로·토큰·출력 없이) */
  log?: (...args: unknown[]) => void
}

export interface PhoneController {
  /** 시작 정리(inbox 비우기 · 남은 길 정리 · 켜져 있으면 다시 열기)가 끝나면 풀린다 — 거절하지 않는다 */
  ready: Promise<void>
  state(): PhoneState
  /**
   * 칸을 바로 저장하고 따른다 — 켜기는 길을 열어 보고(멈추면 켜 둔 채 까닭을 state 에), 끄기는 그 자리에서 문을 닫고(Host 거절·소켓 끊기·절전 풀기·짝 맺기 닫기)
   * 길은 줄을 서서 끈다(열고 있던 켜기는 멈춤)
   */
  set(p: PhoneSettingsChange): Promise<void>
  /**
   * Tailscale 을 다시 본다 — 켜져 있고 길이 안 열렸으면 다시 열어 본다(https 가 꺼졌고 링크를 아직 모르면 켜기 링크까지) · 꺼져 있는데 두레 길이 남았으면 다시 꺼 본다 ·
   * 길이 열려 있으면 PC 이름이 바뀌었나(→ 문을 닫고 지금 이름으로 다시 연다)·그 포트에 Funnel 이 켜졌나(→ 길·서버를 닫고 까닭)·
   * Funnel 때문에 비켜 와 있는데 그 포트가 이제 비었나(→ 문을 닫고 그 포트로 다시 연다) 본다
   */
  check(): Promise<TailscaleState>
  /** 새 짝 코드·6자리 숫자 — 앞의 것은 무효. 길이 열려 있어야 한다. 주소가 바뀌었다는 알림(notice)은 지운다 */
  pairStart(): Promise<PhonePairOffer>
  pairCancel(): void
  /** 설정의 휴대폰 탭이 주소가 바뀌었다는 알림(notice)을 받아 보였다 — 지운다 */
  noticeSeen(): void
  /** 기기 지우기 + 열린 소켓 닫기 — 같은 틱에 */
  unpair(id: string): void
  /** 두레를 끌 때 — 길 끄기·서버 닫기·절전 풀기·inbox 비우기. 켜짐 설정은 그대로(다음 시작 때 다시 연다). 여러 번 불러도 한 번 */
  dispose(): Promise<void>
}

/** 휴대폰 묶음 폴더 — electron-vite 의 렌더러 출력(out/renderer). 설치본은 app.asar 대신 app.asar.unpacked(electron-builder asarUnpack) 안 — 서버가 진짜 파일로 읽게 */
export function phoneStaticDir(mainDir: string, packaged: boolean): string {
  const dir = path.join(mainDir, '..', 'renderer')
  return packaged ? dir.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked') : dir
}

/**
 * 오류 글 — tailscale.ts·phoneServer 가 던지는 한국어 글은 그대로, 그 밖은 fallback.
 * 시스템 오류(code·syscall·path 가 있음 — fs·net)는 한국어가 들어도 fallback: 한국어 Windows 사용자 이름이 경로에 들 수 있다
 */
function koreanOr(e: unknown, fallback: string): string {
  if (!(e instanceof Error) || 'code' in e || 'syscall' in e || 'path' in e) return fallback
  return /[가-힣]/.test(e.message) ? e.message : fallback
}

export function createPhoneController(o: PhoneControllerOptions): PhoneController {
  const store = openPhoneStore(o.dataDir)
  const inboxDir = path.join(o.dataDir, PHONE_INBOX)
  const pairing = createPairing(store)
  const push = o.push ?? createPush(store)
  const startServer = o.startServer ?? startPhoneServer
  const log = o.log ?? console.error
  const retryMs = o.retryMs ?? PHONE_RETRY_MS
  const phoneDispatch = phoneDispatcher(o.dispatch, { inboxDir })

  /** 내어 줄 안드로이드 앱 — 진짜 패키지만(시험 빌드면 시험 패키지도). 파일이 없거나 꼴·패키지가 틀리면 null */
  const androidApk = () => {
    const a = readApk(o.androidDir)
    if (!a) return null
    const ok = a.info.packageName === ANDROID_PACKAGE || (o.androidTest === true && a.info.packageName === ANDROID_TEST_PACKAGE)
    return ok ? a : null
  }

  let tailscale: TailscaleState | null = null
  let server: PhoneServer | null = null
  /** 길이 열려 있다 — host = 서버가 받는 Host(443 이면 포트 없이), url = 휴대폰 주소, dnsName·httpsPort = 연 짝(이름이 바뀌었나·Funnel 을 볼 때) */
  let open: { host: string; url: string; dnsName: string; httpsPort: number } | null = null
  let problem: string | null = null
  /** 주소가 바뀌었다는 알림(E.moved) — 휴대폰 탭이 보거나·짝을 다시 맺거나·끌 때까지 */
  let notice: string | null = null
  /** 이 실행에서 마지막으로 연 주소의 Host — 다시 열 때 주소가 바뀌었나 본다(처음엔 모른다 — 그땐 phone.json 의 httpsPort 와 포트만 견준다) */
  let lastHost: string | null = null
  let pair: { pin: string; expiresAt: number } | null = null
  let pairTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let blocker: number | null = null
  let disposed = false
  let disposing: Promise<void> | null = null
  /** 끄기 요청 수 — 켜기는 시작 때 값을 쥐고, 기다림마다 뒤에 바뀌었으면(그 사이 끄기) 멈춘다 */
  let stops = 0
  let lastSent = ''

  const settings = () => store.read().settings
  const safely = (what: string, f: () => void) => {
    try {
      f()
    } catch {
      log(`[두레] 휴대폰 연결 — ${what}에 실패했어요`)
    }
  }

  /** 켜기·끄기·확인이 겹치지 않게 차례로 — 앞의 것이 실패해도 다음 것은 돈다 */
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f)
    chain = run.catch(() => {})
    return run
  }

  const state = (): PhoneState => {
    const f = store.read()
    const apkNow = androidApk()
    const online = server ? [...new Set(server.clients().map((c) => c.deviceId))].sort() : []
    return {
      settings: f.settings,
      devices: f.devices.map(publicDevice),
      online,
      connected: online.length,
      tailscale,
      url: open?.url ?? null,
      pairing: pair ? { ...pair } : null,
      problem,
      notice,
      androidApp: apkNow ? { versionCode: apkNow.info.versionCode, versionName: apkNow.info.versionName } : null,
    }
  }
  /** 바뀌었으면 'phone' 사건 — 같은 상태는 다시 보내지 않는다 */
  const publish = () => {
    if (disposed) return
    let s: PhoneState
    try {
      s = state()
    } catch {
      return // phone.json 을 잠깐 못 읽음 — 다음 바뀜이 보낸다
    }
    const key = JSON.stringify(s)
    if (key === lastSent) return
    lastSent = key
    safely('상태 알리기', () => o.emit(s))
  }

  /** 길이 열린 동안 + keepAwake 면 절전 막기, 아니면 풀기 */
  const syncPower = () => {
    let want = false
    try {
      want = !disposed && open !== null && settings().keepAwake
    } catch {
      want = false
    }
    if (want && blocker === null) safely('절전 막기', () => (blocker = o.power.start()))
    else if (!want && blocker !== null) {
      const id = blocker
      blocker = null
      safely('절전 풀기', () => o.power.stop(id))
    }
  }

  const emptyInbox = () =>
    fs.promises.rm(inboxDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
      log('[두레] 휴대폰에서 받은 파일을 비우지 못했어요')
    })

  const clearPairing = () => {
    pairing.cancel()
    pair = null
    if (pairTimer) clearTimeout(pairTimer)
    pairTimer = null
  }
  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }

  /** 짝 맺기 — 맞으면 기기가 생기고, 틀림 상한이면 짝이 닫힌다. 어느 쪽이든 PC 화면이 알게 */
  const redeem: Pairing['redeem'] = (secret, name, from) => {
    const r = pairing.redeem(secret, name, from)
    if (pair && !pairing.open()) {
      pair = null
      if (pairTimer) clearTimeout(pairTimer)
      pairTimer = null
    }
    publish()
    return r
  }

  /** 휴대폰에 보낼 사건 — 엔진 사건(EVENT_NAMES)만. 앱 사건은 여기 없다 */
  const engineEvents = (forward: (name: string, payload: unknown) => void): (() => void) => {
    const engine = o.engine
    if (!engine) return () => {}
    const fns = EVENT_NAMES.map((name) => {
      const fn = (payload: unknown) => forward(name, payload)
      engine.on(name, fn)
      return [name, fn] as const
    })
    return () => {
      for (const [name, fn] of fns) engine.off(name, fn)
    }
  }

  const ensureServer = async (): Promise<PhoneServer> => {
    if (server) return server
    const s = await startServer({
      port: settings().port,
      allowedHost: () => open?.host ?? null, // 길이 열리기 전·끈 뒤엔 모두 거절
      pairing: { redeem, verify: (t) => pairing.verify(t), touch: (id) => pairing.touch(id) },
      dispatch: phoneDispatch,
      subscribe: engineEvents,
      staticDir: o.staticDir,
      android: () => {
        const a = androidApk()
        return {
          statements: assetStatements({ includeTest: o.androidTest === true }),
          apk: a ? { path: a.path, versionCode: a.info.versionCode, packageName: a.info.packageName } : null,
        }
      },
      inboxDir,
      vapidKey: () => push.publicKey(),
      onSubscribe: (id, sub) => {
        push.subscribe(id, sub) // 그 사이 끊긴 기기면 아무것도 안 한다
        publish()
      },
      onClients: () => publish(),
      // 화면을 보던 휴대폰이 떠났다(다른 앱·화면 끔·끊김) — 그 휴대폰이라 미룬 알림을 보낸다
      onVisible: (id, visible) => {
        if (!visible) notifier?.deviceHidden(id)
      },
      allowLocal: o.allowLocal === true,
    })
    if (disposed) {
      await s.close()
      throw new Error(E.failed)
    }
    server = s
    // 쓰이던 포트를 비켜 연 실제 포트 — 다음에도 여기부터(못 적어도 이번 켜기는 그대로)
    if (s.port !== settings().port) safely('포트 적기', () => store.write({ settings: { port: s.port } }))
    return s
  }

  /** 닫히는 중인 서버들 — closeServer 가 다 닫히길 기다린다(inbox 를 비우기 전에 올리기가 끝나게) */
  let closing: Promise<unknown> = Promise.resolve()
  /**
   * 문을 그 자리에서 닫는다 — 새 요청은 거절(Host), 서버를 닫기 시작해 열린 소켓을 바로 끊고, 절전 막기를 푼다(길은 따로 — routeOff).
   * 끄기·dispose·Funnel 이 같은 틱에 부른다 — 줄 선 일(serve 끄기 등)을 기다리지 않게
   */
  const shutServer = () => {
    open = null
    const s = server
    server = null
    if (s) closing = Promise.all([closing, s.close().catch(() => {})])
    syncPower()
  }
  /** 서버를 닫고 절전 막기를 푼다 — 다 닫힐 때까지 기다린다 */
  const closeServer = async () => {
    shutServer()
    await closing
  }

  /**
   * phone.json 에 적어 둔 두레 길만 끈다(offRecordedRoute — 그 짝이 두레 꼴일 때만 끄고, 없거나 남의 것이면 그대로.
   * PC 이름이 바뀌어 그 길이 지금 이름 아래로 옮겨졌으면 지금 이름으로).
   * 껐거나 이미 없으면 기록을 지우고 true · 끄지 못하면(설정 못 읽음·끄기 실패) 기록을 남기고 false — 다음에 다시.
   * 예전 PC 이름 아래의 길을 다른 serve 설정 때문에 남겨 뒀으면('left') 기록은 지우고(더 할 수 있는 게 없다 — 그 이름으로는 닿지 않는다) PC 화면에 알린다
   */
  const routeOff = async (): Promise<boolean> => {
    const rec = store.read().serve
    if (!rec) return true
    try {
      const r = await offRecordedRoute(o.tailscale, rec)
      store.write({ serve: null })
      if (r === 'left') notice = E.left
      return true
    } catch {
      return false
    }
  }

  /**
   * Funnel 때문에 비켜 간 포트 → 지난번 포트 → 443 → 47615 중 비어 있는 첫 포트(Funnel 이 켜진 포트는 빈 포트가 아니다) — 주소가 바뀌면 휴대폰의 홈 화면 앱·알림 구독이 끊긴다.
   * funnel = 그 앞에서 Funnel 때문에 건너뛴 첫 포트(공개가 풀리면 돌아갈 곳 — 남이 써서 건너뛴 포트는 아니다).
   * 없으면 까닭: 그중 Funnel 이 켜진 포트가 있으면 E.funnel, 아니면 E.noHttpsPort · serve 설정을 못 읽으면 E.unreadable
   */
  const pickHttpsPort = async (): Promise<{ port: number; funnel: number | undefined } | string> => {
    const f = store.read()
    const ports = [...new Set([...(f.funnelPort === undefined ? [] : [f.funnelPort]), ...(f.httpsPort === undefined ? [] : [f.httpsPort]), ...PHONE_HTTPS_PORTS])]
    let funnel: number | undefined
    for (const p of ports) {
      let free: boolean
      try {
        free = await o.tailscale.httpsPortFree(p)
      } catch {
        return E.unreadable
      }
      if (free) return { port: p, funnel }
      if (funnel === undefined && (await o.tailscale.funnelOn(p).catch(() => false))) funnel = p
    }
    return funnel !== undefined ? E.funnel : E.noHttpsPort
  }

  /**
   * status 의 no-https 엔 켜기 링크가 없다(링크는 serveOn 이 받는다) — 앞서 받은 링크가 있으면 그대로 둔다.
   * 그 사이 다른 상태(로그아웃 등)를 거쳤으면 잊는다(다른 기기일 수 있다)
   */
  const keepLink = (ts: TailscaleState): TailscaleState =>
    ts.kind === 'no-https' && ts.enableUrl === null && tailscale?.kind === 'no-https' && tailscale.enableUrl !== null ? tailscale : ts

  /**
   * 길 열기 — Tailscale 이 ready 일 때만(wantLink 면 https 가 꺼진 tailnet 에서 켜기 링크를 아직 모를 때 받으러 한 번 열어 본다).
   * 돌려주는 것 = 까닭(problem) — 멈추면 켜짐은 그대로 두고 까닭은 tailscale·이 값에.
   * 기다림마다 뒤에 끄기·dispose 가 왔는지(my ≠ stops) 보고, 왔으면 그때까지 연 것(서버·길)을 거두고 그만둔다 — 절전은 막지 않는다
   */
  const bringUp = async (wantLink: boolean, my: number): Promise<string | null> => {
    const halted = () => disposed || stops !== my
    const quit = async (route: boolean) => {
      if (route) await routeOff() // 못 끄면 기록이 남는다 — 뒤의 끄기·dispose 가 다시
      await closeServer()
      return null
    }
    if (open || halted()) return null
    const ts = keepLink(await o.tailscale.status())
    tailscale = ts
    if (halted() || ts.kind === 'missing' || ts.kind === 'logged-out') return null
    if (ts.kind === 'no-https' && (ts.enableUrl !== null || !wantLink)) return null
    const dnsName = ts.kind === 'ready' ? ts.dnsName : undefined
    // 전에 연 길이 남아 있으면 먼저 그 짝만 — 못 끄면 새 길을 열지 않는다(기록을 덮어 그 길을 잃지 않게)
    const cleared = await routeOff()
    if (halted()) return null
    if (!cleared) return E.stale
    let s: PhoneServer
    try {
      s = await ensureServer()
    } catch (e) {
      return koreanOr(e, E.failed)
    }
    if (halted()) return quit(false)
    const picked = await pickHttpsPort()
    if (halted()) return quit(false)
    if (typeof picked === 'string') {
      await closeServer()
      return picked
    }
    const httpsPort = picked.port
    // 열기 전에 적는다 — serveOn 이 시간 상한으로 던져도·두레가 그 사이 꺼져도 그 짝만 정리할 수 있게. 못 적으면 열지 않는다
    try {
      store.write({ serve: { httpsPort, localPort: s.port, ...(dnsName ? { dnsName } : {}) } })
    } catch (e) {
      await closeServer()
      return koreanOr(e, E.failed)
    }
    let r: ServeOnResult
    try {
      r = await o.tailscale.serveOn(httpsPort, s.port, dnsName)
    } catch (e) {
      await quit(true)
      return koreanOr(e, E.failed)
    }
    if (halted()) return quit(true)
    if (r.kind === 'no-https') {
      tailscale = r
      return quit(true)
    }
    if (dnsName === undefined) {
      // https 가 꺼졌다더니 길이 열렸다 — 이름을 모르니 닫고 상태부터 다시(이번엔 링크를 받으러 열지 않는다)
      await quit(true)
      return bringUp(false, my)
    }
    const host = httpsPort === 443 ? dnsName : `${dnsName}:${httpsPort}`
    // 앞서 연 주소와 다르면(이 실행에서 연 Host — 처음이면 phone.json 의 httpsPort·dnsName: 두레가 꺼진 사이·다시 켜기 전에 PC 이름을 바꿨을 수 있다)
    // 짝 맺은 휴대폰에 알릴 것 — 예전 주소의 쿠키만 안다
    let paired = false
    let known: string | null = lastHost
    try {
      const f = store.read()
      paired = f.devices.length > 0
      const name = f.dnsName ?? dnsName
      if (known === null && f.httpsPort !== undefined) known = f.httpsPort === 443 ? name : `${name}:${f.httpsPort}`
    } catch {
      // 못 읽음 — 알리지 않는다
    }
    lastHost = host
    // 예전 이름의 길을 남겨 뒀다는 알림이 이번 열기에서 나왔으면 둘 다 — 다시 짝 맺기가 먼저
    if (known !== null && known !== host && paired) notice = notice === E.left ? `${E.moved}. ${E.left}` : E.moved
    // 다음 켜기의 첫 포트 · Funnel 때문에 비켜 갔으면 그 포트(아니면 지움) — 못 적어도 이번 길은 그대로
    safely('https 포트 적기', () => store.write({ httpsPort, funnelPort: picked.funnel ?? null, dnsName }))
    open = { host, url: `https://${host}/mobile.html`, dnsName, httpsPort }
    syncPower()
    return null
  }

  /**
   * 한 번 열어 보기 — 까닭은 끝날 때 한 번 정하고 한 번 알린다(다시 해 볼 때마다 null 로 깜박이지 않게).
   * 무엇이 던져도 까닭으로 남기고, 켜져 있는데 못 열었으면 잠시 뒤 다시. 그 사이 끄기·dispose 가 왔으면 뒤는 그쪽이 맡는다
   */
  const attempt = async (wantLink: boolean, my = stops): Promise<void> => {
    let reason: string | null
    try {
      reason = await bringUp(wantLink, my)
    } catch (e) {
      reason = koreanOr(e, E.failed)
      await closeServer()
    }
    if (disposed || stops !== my) return
    problem = reason
    if (open) clearRetry()
    else scheduleRetry()
    publish()
  }

  /** 꺼진 채 남은 두레 길 정리 — 못 끄면 까닭을 남기고 잠시 뒤 다시(기록이 없어질 때까지) */
  const tidy = async (): Promise<void> => {
    const ok = await routeOff()
    problem = ok ? null : E.stale
    if (!ok) scheduleRetry()
    publish()
  }

  /** 잠시 뒤 다시 — 켜져 있는데 길이 안 열렸거나, 꺼져 있는데 두레 길 기록이 남았을 때(정리되면 그만) */
  const scheduleRetry = () => {
    if (retryTimer || disposed || open) return
    let need = false
    try {
      const f = store.read()
      need = f.settings.enabled || f.serve !== undefined
    } catch {
      need = false
    }
    if (!need) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void serial(async () => {
        if (disposed || open) return
        if (settings().enabled) await attempt(false)
        else await tidy()
      }).catch(() => {})
    }, retryMs)
    retryTimer.unref?.()
  }

  /**
   * 끄기(줄 선 쪽) — 문은 set 이 이미 닫았다(shutServer) · 길 끄기 → 서버가 다 닫히길 기다림 → inbox 비우기.
   * 길을 못 끄면 까닭을 남기고 잠시 뒤 다시
   */
  const bringDown = async () => {
    clearRetry()
    clearPairing()
    shutServer()
    const ok = await routeOff()
    await closeServer()
    await emptyInbox()
    problem = ok ? null : E.stale
    if (!ok) scheduleRetry()
  }

  /**
   * 다른 주소로 다시 열기 — 문부터 닫는다: 짝 맺기(예전 주소의 QR)를 닫고, 서버를 닫아(새 요청 거절 · 붙어 있던 휴대폰 소켓 끊김 · 절전 풀림)
   * PC 화면에서 예전 주소를 거둔 뒤(알림), 서버가 다 닫히면 예전 짝을 끄고 같은 포트의 새 서버로 다시 연다(attempt — 연 뒤에 새 주소를 알린다)
   */
  const reopen = async (my: number): Promise<void> => {
    clearPairing()
    shutServer()
    publish()
    await closing
    await attempt(true, my)
  }

  /**
   * 길이 열린 채 확인 — PC 이름이 바뀌었으면(Tailscale 대시보드) 휴대폰이 아는 주소는 더 못 쓴다: 지금 이름으로 다시 연다(reopen).
   * 그 포트에 Funnel 이 켜졌으면 길·서버를 닫고 까닭 — 잠시 뒤 다시 해 보기는 공개 아닌 포트로.
   * Funnel 때문에 비켜 와 있는데(funnelPort) 그 포트가 비었고 공개도 아니면 그리로 다시 연다(reopen — 47615 에 머물지 않게).
   * 그 사이 끄기·dispose 가 왔으면(my ≠ stops) 아무것도 하지 않는다
   */
  const recheckOpen = async (my: number): Promise<void> => {
    const was = open
    const ts = keepLink(await o.tailscale.status())
    if (disposed || stops !== my || !was || open !== was) return
    tailscale = ts
    if (ts.kind === 'ready' && ts.dnsName !== was.dnsName) return reopen(my)
    const funnel = await o.tailscale.funnelOn(was.httpsPort).catch(() => false)
    if (disposed || stops !== my || open !== was) return
    if (funnel) {
      // 서버부터 닫는다 — 길을 못 꺼도(기록이 남아 다시 해 보기가 정리) 공개된 길 끝엔 두레가 없다
      clearPairing()
      shutServer()
      await routeOff()
      await closeServer()
      if (disposed || stops !== my) return
      problem = E.funnel
      scheduleRetry()
      publish()
      return
    }
    // Funnel 때문에 비켜 와 있으면 — 그 포트가 비었고 공개도 아니면(httpsPortFree) 돌아간다. 못 읽으면 그대로
    let back: number | undefined
    try {
      back = store.read().funnelPort
    } catch {
      back = undefined
    }
    if (back !== undefined && back !== was.httpsPort && (await o.tailscale.httpsPortFree(back).catch(() => false))) {
      if (disposed || stops !== my || open !== was) return
      return reopen(my)
    }
    publish()
  }

  const notifier = o.engine
    ? createPhoneNotifier({
      engine: o.engine,
      settings,
      devices: () => store.read().devices.map(publicDevice),
      isPcInUse: () => o.idle() === 'active',
      isVisible: (id) => server?.clients().some((c) => c.deviceId === id && c.visible) ?? false,
      push,
      log,
      pcAway: o.pcAway,
      every: o.every,
    })
    : null

  // 시작 — 올리기만 하고 안 보낸 파일 비우기 → 켜져 있으면 다시 열기(적어 둔 길은 그 안에서 먼저 정리), 꺼져 있으면 적어 둔 길만 정리
  // (못 지우면 까닭을 남기고 잠시 뒤 다시). 꺼져 있고 기록이 없으면 tailscale 을 부르지 않는다.
  // 켜짐은 만들 때 본 값으로 — 그 뒤 set 이 바로 적은 켜기·끄기는 set 이 맡는다(두 번 열어 보지 않게).
  // 🟡 두레가 둘 떠 있으면(설치본과 개발 실행 — phone.json 이 따로) A 의 남은 기록이 B 가 지금 연 길과 같은 짝일 때 B 의 길을 끌 수 있다 — 드물어서 받아들인다
  let startOn = false
  try {
    startOn = settings().enabled
  } catch {
    startOn = false // 못 읽음 — 아래에서 다시 읽다 던지면 로그
  }
  const startStops = stops
  const ready = serial(async () => {
    await emptyInbox()
    if (disposed) return
    if (startOn && settings().enabled) await attempt(false, startStops)
    else await tidy()
    publish()
  }).catch(() => {
    log('[두레] 휴대폰 연결을 시작하지 못했어요')
  })

  return {
    ready,

    state,

    set(p) {
      if (disposed) return Promise.resolve()
      // 칸은 바로 적는다 — 끄기는 기다리는 켜기(status·serveOn …) 뒤에 줄 서지 않고 바로 적히며, 그 켜기는 다음 기다림 뒤에 보고 멈춘다
      let change: PhoneSettingsChange
      let off: boolean
      try {
        change = pickPhoneChange(p)
        const before = settings()
        store.write({ settings: change })
        const after = settings()
        if (after.openAtLogin !== before.openAtLogin) safely('자동 켜기', () => o.loginItem.set(after.openAtLogin))
        off = before.enabled && !after.enabled
      } catch (e) {
        return Promise.reject(e)
      }
      if (off) {
        stops++
        clearRetry()
        // 문은 그 자리에서 — 줄 선 일(앞의 켜기·확인이 Tailscale 을 기다리는 중일 수 있다)을 기다리지 않고 새 요청을 거절하고 열린 소켓을 끊는다.
        // 주소가 없으니 주소가 바뀌었다는 알림도 지운다(다시 켜서 또 바뀌면 다시)
        clearPairing()
        shutServer()
        notice = null
        publish()
      }
      const my = stops
      return serial(async () => {
        if (disposed) return
        if (off) await bringDown()
        else if (change.enabled === true && stops === my && settings().enabled && !open) await attempt(true, my)
        syncPower()
        publish()
      })
    },

    check() {
      return serial(async () => {
        if (!disposed) {
          if (settings().enabled && !open) await attempt(true)
          else if (settings().enabled) await recheckOpen(stops)
          else {
            tailscale = keepLink(await o.tailscale.status())
            // 꺼진 채 두레 길 기록이 남았으면 기다리지 않고 다시 꺼 본다(Tailscale 을 켠 뒤의 '확인')
            if (!settings().enabled && store.read().serve) await tidy()
            publish()
          }
        }
        return tailscale ?? { kind: 'missing' as const }
      })
    },

    async pairStart() {
      if (disposed || !open) throw new Error(E.notReady)
      const link = open.url
      const p = pairing.start()
      if (pairTimer) clearTimeout(pairTimer)
      pair = { pin: p.pin, expiresAt: p.expiresAt }
      notice = null // 다시 짝을 맺는다 — 주소가 바뀌었다는 알림은 할 일을 했다
      pairTimer = setTimeout(() => {
        pairTimer = null
        pairing.cancel()
        pair = null
        publish()
      }, PAIR_TTL_MS)
      pairTimer.unref?.()
      publish()
      const url = `${link}#pair=${p.code}`
      const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 320 })
      return { qr, pin: p.pin, url, expiresAt: p.expiresAt }
    },

    pairCancel() {
      clearPairing()
      publish()
    },

    noticeSeen() {
      if (notice === null) return
      notice = null
      publish()
    },

    unpair(id) {
      pairing.unpair(id)
      server?.kick(id) // 같은 틱에 — 열린 소켓이 그 사이 무엇도 못 하게
      publish()
    },

    dispose() {
      if (disposing) return disposing
      disposed = true
      clearRetry()
      clearPairing()
      if (notifier) safely('알림 끄기', () => notifier.dispose())
      shutServer() // 새 요청은 바로 거절 · 열린 소켓은 바로 끊는다
      const closingNow = closing
      disposing = serial(async () => {
        await Promise.all([routeOff(), closeServer(), closingNow])
        await emptyInbox()
      }).catch(() => {
        log('[두레] 휴대폰 연결을 다 정리하지 못했어요')
      })
      return disposing
    },
  }
}
