// 휴대폰 진입점(mobile.html) — PC 의 휴대폰 서버가 내어 준다. 짝을 맺었으면 WebSocket 으로 만든 window.dure 를 끼우고 PC 와 같은 스토어를 쓴다.
// 🔴 useAttention 을 붙이지 않는다(작업 표시줄·Windows 알림은 PC 몫, 휴대폰 알림은 PC main 이 웹 푸시로)
import '@fontsource/noto-sans-kr/400.css'
import '@fontsource/noto-sans-kr/500.css'
import '@fontsource/noto-sans-kr/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '../styles/tokens.css'
import '../styles/base.css'
import './pair.css'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import { Splash } from '../shell/Splash'
import { getStore } from '../state/store'
import { followClockBack } from '../lib/animeClock'
import { PHONE_PATHS } from '../../shared/phoneWire'
import { createWsApi } from './wsApi'
import { onPhoneConn } from './connection'
import { PairScreen } from './PairScreen'
import { MobileApp } from './MobileApp'
import { detectPairEnv } from './pairEnv'
import { checkMe, copyText, pairWith, subscribePush } from './phoneHttp'

/** QR 의 짝 코드(#pair=) — 읽자마자 주소에서 지운다(방문 기록·화면 공유에 남지 않게). #agent= 같은 다른 조각은 그대로 */
function takePairCode(): string | null {
  const code = new URLSearchParams(location.hash.slice(1)).get('pair')
  if (code === null) return null
  history.replaceState(null, '', location.pathname + location.search)
  return code.trim() || null
}

/** 알림 서비스 워커 — 짝 맺기 전에도 등록해 둔다(알림 켜기가 바로 구독하게). 알림을 누르면 열린 창이 그 대화로(#agent=) */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return
  navigator.serviceWorker.register('/sw.js').catch(() => {})
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { type?: unknown; url?: unknown } | null
    if (!m || m.type !== 'dure:open' || typeof m.url !== 'string') return
    let u: URL
    try {
      u = new URL(m.url, location.origin)
    } catch {
      return
    }
    if (u.origin !== location.origin) return
    // 같은 조각이면 hashchange 가 안 생긴다 — 화면이 그 대화로 다시 가게 직접 알린다
    if (location.hash === u.hash) window.dispatchEvent(new HashChangeEvent('hashchange'))
    else location.hash = u.hash
  })
}

const root = createRoot(document.getElementById('root')!)
const show = (node: ReactNode) =>
  root.render(
    <StrictMode>
      <LucideProvider size={16} strokeWidth={1.75}>
        {node}
      </LucideProvider>
    </StrictMode>,
  )

const pairCode = takePairCode()
registerServiceWorker()
void boot()

async function boot(): Promise<void> {
  show(<Splash />)
  // 끊겼거나 PC 가 꺼져 있으면(모름) 일단 잇는다 — 못 열 때마다 다시 짝 여부를 본다(wsApi)
  if ((await checkMe()) === 'unpaired') return showPair()
  startApp()
}

async function showPair(): Promise<void> {
  const env = await detectPairEnv()
  const link = `${location.origin}/mobile.html${pairCode ? `#pair=${encodeURIComponent(pairCode)}` : ''}`
  show(
    <PairScreen
      code={pairCode}
      env={env}
      link={link}
      pair={(secret, name) => pairWith(secret, name)}
      enablePush={() => subscribePush()}
      copy={copyText}
      onDone={startApp}
    />,
  )
}

let started = false
function startApp(): void {
  if (started) return
  started = true
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // 첫 getStore() 전에 끼운다 — 스토어는 처음 부를 때의 window.dure 로 만들어진다
  window.dure = createWsApi({
    url: `${scheme}//${location.host}${PHONE_PATHS.ws}`,
    onConn: onPhoneConn,
    // PC 에서 끊었다 — 처음부터(짝 맺기 화면). 쓰던 글은 버려진다(사용자가 PC 에서 고른 일)
    onUnpaired: () => location.reload(),
  })
  followClockBack()
  setInterval(() => getStore().followClock(), 1000)
  show(<Splash />)
  // 처음 상태를 못 받았어도(PC 가 꺼짐·끊김) 화면은 띄운다 — 끊김 띠와 안내가 보이고, 이어지면 스냅샷부터 다시 받는다(onPhoneConn → resync)
  getStore()
    .init()
    .catch(() => {})
    .finally(() => show(<MobileApp />))
}
