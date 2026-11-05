import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { EVENT_NAMES } from '../../shared/ipcContract'
import {
  PAIR_TTL_MS, PHONE_PORT_DEFAULT, pickPhoneChange,
  type PhonePairOffer, type PhoneSettingsChange, type PhoneState, type TailscaleState,
} from '../../shared/phoneTypes'
import { phoneDispatcher, type Dispatch } from '../dispatch'
import { createPairing, type Pairing } from './pairing'
import { createPhoneNotifier, type NotifierEngine } from './phoneNotifier'
import { startPhoneServer, type PhoneServer, type PhoneServerOptions } from './phoneServer'
import { openPhoneStore, publicDevice } from './phoneStore'
import { createPush, type Push } from './push'
import type { ServeOnResult, Tailscale } from './tailscale'

// 휴대폰 연결 묶기 — 켜기(Tailscale 확인 → 127.0.0.1 서버 → tailscale serve 길 → 절전 막기)·끄기·짝 맺기·기기 끊기·알림 판단·자동 켜기.
// 길은 두레가 연 것만 다룬다: 열기 전에 그 짝({httpsPort, localPort, dnsName})을 phone.json 에 적고, 끌 때·다음 시작 때 그 짝만 끈다(포트를 짐작해 지우지 않는다).
// 🔴 휴대폰엔 엔진 사건만 간다(앱 사건 'phone' 은 PC 창에만) · 짝 코드는 QR·주소에만(상태·로그엔 없음) · 진짜 tailscale·절전 막기·로그인 항목은 주입받는다(시험은 가짜)

/** tailnet https 포트 차례 — 443 이면 주소에 포트가 없다(알림에 붙는 사이트 주소가 짧다), 남이 쓰면 서버 기본 포트와 같은 번호 */
export const PHONE_HTTPS_PORTS: readonly number[] = Object.freeze([443, PHONE_PORT_DEFAULT])
/** 켜져 있는데 길이 안 열렸으면(Tailscale 이 아직 안 켜짐·로그인 전·https 꺼짐 …) 이만큼 뒤에 다시 해 본다 — 열리면 그만 */
export const PHONE_RETRY_MS = 30_000
/** 휴대폰이 올린 파일을 두는 폴더(<dataDir> 아래) — 시작·끄기·두레 끄기 때 비운다(올리기만 하고 안 보낸 것) */
export const PHONE_INBOX = 'phone-inbox'

const E = {
  notReady: '휴대폰 연결이 아직 열리지 않았어요',
  noHttpsPort: 'tailnet 의 https 포트 443·47615 가 모두 다른 곳에 쓰이고 있어요 — 하나를 비워 주세요',
  stale: '두레가 전에 연 길을 정리하지 못했어요 — Tailscale 이 켜져 있는지 확인해 주세요',
  failed: '휴대폰 연결을 켜지 못했어요',
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
  tailscale: Pick<Tailscale, 'status' | 'serveOn' | 'serveOff' | 'httpsPortFree'>
  /** 절전 막기 — 진짜는 powerSaveBlocker('prevent-app-suspension') */
  power: { start(): number; stop(id: number): void }
  /** 진짜는 powerMonitor.getSystemIdleState(120) — 'active' 면 PC 를 쓰는 중이라 휴대폰은 안 울린다 */
  idle: () => IdleState
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
  /** 칸을 저장하고 따른다 — 켜기는 길을 열어 보고(멈추면 켜 둔 채 까닭을 state 에), 끄기는 길·서버·절전 막기를 거둔다 */
  set(p: PhoneSettingsChange): Promise<void>
  /** Tailscale 을 다시 본다 — 켜져 있고 길이 안 열렸으면 다시 열어 본다(https 가 꺼졌으면 켜기 링크까지) */
  check(): Promise<TailscaleState>
  /** 새 짝 코드·6자리 숫자 — 앞의 것은 무효. 길이 열려 있어야 한다 */
  pairStart(): Promise<PhonePairOffer>
  pairCancel(): void
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

/** 오류 글 — tailscale.ts·phoneServer 가 던지는 한국어 글은 그대로, 그 밖(영어 시스템 글·경로가 들 수 있음)은 fallback */
function koreanOr(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : ''
  return /[가-힣]/.test(m) ? m : fallback
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

  let tailscale: TailscaleState | null = null
  let server: PhoneServer | null = null
  /** 길이 열려 있다 — host = 서버가 받는 Host(443 이면 포트 없이), url = 휴대폰 주소 */
  let open: { host: string; url: string } | null = null
  let problem: string | null = null
  let pair: { pin: string; expiresAt: number } | null = null
  let pairTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let blocker: number | null = null
  let disposed = false
  let disposing: Promise<void> | null = null
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
    return {
      settings: f.settings,
      devices: f.devices.map(publicDevice),
      connected: server ? new Set(server.clients().map((c) => c.deviceId)).size : 0,
      tailscale,
      url: open?.url ?? null,
      pairing: pair ? { ...pair } : null,
      problem,
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
      inboxDir,
      vapidKey: () => push.publicKey(),
      onSubscribe: (id, sub) => {
        push.subscribe(id, sub) // 그 사이 끊긴 기기면 아무것도 안 한다
        publish()
      },
      onClients: () => publish(),
      allowLocal: o.allowLocal === true,
    })
    if (disposed) {
      await s.close()
      throw new Error(E.failed)
    }
    server = s
    if (s.port !== settings().port) store.write({ settings: { port: s.port } }) // 쓰이던 포트를 비켜 연 실제 포트 — 다음에도 여기부터
    return s
  }

  /** 서버를 닫고 절전 막기를 푼다(길은 따로 — routeOff) */
  const closeServer = async () => {
    const s = server
    server = null
    open = null
    if (s) await s.close().catch(() => {})
    syncPower()
  }

  /**
   * phone.json 에 적어 둔 두레 길만 끈다(serveOff — 그 짝이 두레 꼴일 때만 끄고, 없거나 남의 것이면 그대로).
   * 껐거나 이미 없으면 기록을 지우고 true · 끄지 못하면(설정 못 읽음·끄기 실패) 기록을 남기고 false — 다음에 다시
   */
  const routeOff = async (): Promise<boolean> => {
    const rec = store.read().serve
    if (!rec) return true
    try {
      await o.tailscale.serveOff(rec.httpsPort, rec.localPort, rec.dnsName)
      store.write({ serve: null })
      return true
    } catch {
      return false
    }
  }

  /** 지난번 포트 → 443 → 47615 중 비어 있는 첫 포트 — 주소가 바뀌면 휴대폰의 홈 화면 앱·알림 구독이 끊긴다 */
  const pickHttpsPort = async (): Promise<number | null> => {
    const last = store.read().httpsPort
    for (const p of new Set([...(last === undefined ? [] : [last]), ...PHONE_HTTPS_PORTS])) {
      if (await o.tailscale.httpsPortFree(p)) return p
    }
    return null
  }

  /**
   * 길 열기 — Tailscale 이 ready 일 때만(wantLink 면 https 가 꺼진 tailnet 에서도 켜기 링크를 받으러 한 번 열어 본다).
   * 멈추면 켜짐은 그대로 두고 까닭은 tailscale·problem 에
   */
  const bringUp = async (wantLink: boolean): Promise<void> => {
    if (open || disposed) return
    problem = null
    const ts = await o.tailscale.status()
    tailscale = ts
    publish()
    if (disposed || ts.kind === 'missing' || ts.kind === 'logged-out') return
    if (ts.kind === 'no-https' && (ts.enableUrl !== null || !wantLink)) return
    const dnsName = ts.kind === 'ready' ? ts.dnsName : undefined
    // 전에 연 길이 남아 있으면 먼저 그 짝만 — 못 끄면 새 길을 열지 않는다(기록을 덮어 그 길을 잃지 않게)
    if (!(await routeOff())) {
      problem = E.stale
      return
    }
    let s: PhoneServer
    try {
      s = await ensureServer()
    } catch (e) {
      problem = koreanOr(e, E.failed)
      return
    }
    if (disposed) return
    const httpsPort = await pickHttpsPort()
    if (httpsPort === null) {
      problem = E.noHttpsPort
      await closeServer()
      return
    }
    // 열기 전에 적는다 — serveOn 이 시간 상한으로 던져도·두레가 그 사이 꺼져도 그 짝만 정리할 수 있게
    store.write({ serve: { httpsPort, localPort: s.port, ...(dnsName ? { dnsName } : {}) } })
    let r: ServeOnResult
    try {
      r = await o.tailscale.serveOn(httpsPort, s.port, dnsName)
    } catch (e) {
      problem = koreanOr(e, E.failed)
      await routeOff()
      await closeServer()
      return
    }
    if (r.kind === 'no-https') {
      tailscale = r
      await routeOff()
      await closeServer()
      return
    }
    if (dnsName === undefined) {
      // https 가 꺼졌다더니 길이 열렸다 — 이름을 모르니 닫고 상태부터 다시(이번엔 링크를 받으러 열지 않는다)
      await routeOff()
      await closeServer()
      return bringUp(false)
    }
    if (disposed) return // dispose 가 적어 둔 짝을 끈다
    store.write({ httpsPort })
    const host = httpsPort === 443 ? dnsName : `${dnsName}:${httpsPort}`
    open = { host, url: `https://${host}/mobile.html` }
    syncPower()
  }

  /** 한 번 열어 보기 — 무엇이 던져도 까닭으로 남기고, 켜져 있는데 못 열었으면 잠시 뒤 다시 */
  const attempt = async (wantLink: boolean): Promise<void> => {
    try {
      await bringUp(wantLink)
    } catch (e) {
      problem = koreanOr(e, E.failed)
      await closeServer()
    }
    if (open) clearRetry()
    else scheduleRetry()
    publish()
  }

  const scheduleRetry = () => {
    if (retryTimer || disposed || open) return
    let on = false
    try {
      on = settings().enabled
    } catch {
      on = false
    }
    if (!on) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void serial(async () => {
        if (!disposed && !open && settings().enabled) await attempt(false)
      }).catch(() => {})
    }, retryMs)
    retryTimer.unref?.()
  }

  /** 끄기 — 새 요청은 바로 거절 → 길 끄기 → 서버 닫기 → 절전 풀기 → inbox 비우기 */
  const bringDown = async () => {
    clearRetry()
    clearPairing()
    open = null
    await routeOff()
    await closeServer()
    await emptyInbox()
    problem = null
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
    })
    : null

  // 시작 — 올리기만 하고 안 보낸 파일 비우기 → 켜져 있으면 다시 열기(적어 둔 길은 그 안에서 먼저 정리), 꺼져 있으면 적어 둔 길만 정리.
  // 꺼져 있고 기록이 없으면 tailscale 을 부르지 않는다
  const ready = serial(async () => {
    await emptyInbox()
    if (disposed) return
    if (settings().enabled) await attempt(false)
    else await routeOff()
    publish()
  }).catch(() => {
    log('[두레] 휴대폰 연결을 시작하지 못했어요')
  })

  return {
    ready,

    state,

    set(p) {
      return serial(async () => {
        if (disposed) return
        const change = pickPhoneChange(p)
        const before = settings()
        store.write({ settings: change })
        const after = settings()
        if (after.openAtLogin !== before.openAtLogin) safely('자동 켜기', () => o.loginItem.set(after.openAtLogin))
        if (before.enabled && !after.enabled) await bringDown()
        else if (after.enabled && !open && change.enabled === true) await attempt(true)
        syncPower()
        publish()
      })
    },

    check() {
      return serial(async () => {
        if (!disposed) {
          if (settings().enabled && !open) await attempt(true)
          else {
            tailscale = await o.tailscale.status()
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
      open = null // 새 요청은 바로 거절
      syncPower()
      const now = server
      server = null
      const closingNow = now ? now.close().catch(() => {}) : Promise.resolve()
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
