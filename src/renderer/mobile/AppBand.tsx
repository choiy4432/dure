/**
 * 두레 앱(안드로이드) 띠 — 시안 phone-a(파란 띠: 한 줄 글 + 단추). 방 목록 위(RoomList)와 짝 맺기 끝(PairScreen)이 같이 쓴다.
 * - 안드로이드 크롬(앱 밖) — SteerBand: '두레 앱으로 쓰면 알림에 주소가 안 붙어요.' [두레 앱으로 열기](intent — 앱이 없으면 크롬이 /dure.apk 를 받는다)
 *   [나중에](이번 세션만 접기). PC 가 내어 줄 앱이 없으면(androidApp null) 없다
 * - 앱 안 — AppBand 가 더 보인다: 알림 허락을 아직 안 물었으면(permission 'default') '알림을 켜야 휴대폰으로 알림이 와요' [켜기](알림 켜기 흐름 — 앱 이름으로 묻는다) ·
 *   PC 의 앱 판이 앱이 알린 판보다 크면 '앱 업데이트가 있어요' [받기](/dure.apk — 같은 열쇠라 덮어 깔린다. 드물어서 [나중에]는 없다)
 * 아이폰·PC 브라우저엔 아무것도 없다(/api/me 도 묻지 않는다)
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { PhoneAndroidApp } from '../../shared/phoneWire'
import { meInfo } from './phoneHttp'
import { appContext, needsUpdate, openInAppHref, setSteerLater, steerLater, type AppContext } from './androidApp'
import './mobile.css'

export const STEER_TEXT = '두레 앱으로 쓰면 알림에 주소가 안 붙어요.'
export const UPDATE_TEXT = '앱 업데이트가 있어요'
export const NOTIFY_TEXT = '알림을 켜야 휴대폰으로 알림이 와요'

/** 띠 하나 — 글 한 줄 + 단추 줄 */
function Band({ label, text, children }: { label: string; text: string; children: ReactNode }) {
  return (
    <section className="m-appband" aria-label={label}>
      <p className="m-appband-t">{text}</p>
      <div className="m-appband-act">{children}</div>
    </section>
  )
}

/** PC 가 내어 줄 앱(/api/me) — 한 번 받으면 다시 그려도 다시 묻지 않는다(방 목록으로 돌아올 때 띠가 깜빡이지 않게). 못 받으면 다음에 다시 */
let pcAppSeen: { app: PhoneAndroidApp | null } | null = null

/** wanted 일 때만 묻는다 — 아니면 늘 null */
function usePcApp(wanted: boolean): PhoneAndroidApp | null {
  const [pcApp, setPcApp] = useState<PhoneAndroidApp | null>(() => pcAppSeen?.app ?? null)
  useEffect(() => {
    if (!wanted) return
    if (pcAppSeen) {
      setPcApp(pcAppSeen.app)
      return
    }
    let live = true
    void meInfo().then(m => {
      if (!m) return
      pcAppSeen = { app: m.androidApp }
      if (live) setPcApp(m.androidApp)
    })
    return () => {
      live = false
    }
  }, [wanted])
  return wanted ? pcApp : null
}

/**
 * 안드로이드 크롬(앱 밖)에서 두레 앱으로 — later: [나중에](이번 세션 동안 접기)를 보일지(짝 맺기 끝은 아래에 알림 [나중에]가 있어 뺀다).
 * 이번 세션에 접었으면 어디서도 안 보인다
 */
export function SteerBand({ later = true, ctx: given }: { later?: boolean; ctx?: AppContext }) {
  const [ctx] = useState(() => given ?? appContext())
  const [folded, setFolded] = useState(steerLater)
  const pcApp = usePcApp(ctx.androidChrome && !ctx.inApp && !folded)
  if (!pcApp) return null
  return (
    <Band label="두레 앱으로 쓰기" text={STEER_TEXT}>
      <a className="btn pri m-appband-go" href={openInAppHref(location.origin, location.pathname + location.hash, pcApp.packageName)}>
        두레 앱으로 열기
      </a>
      {later && (
        <button
          type="button"
          className="btn m-appband-later"
          onClick={() => {
            setSteerLater()
            setFolded(true)
          }}
        >
          나중에
        </button>
      )}
    </Band>
  )
}

/** 앱 안 — PC 의 앱 판이 앱이 알린 판보다 크면 */
function UpdateBand({ appVersion }: { appVersion: number | null }) {
  const pcApp = usePcApp(true)
  if (!pcApp || !needsUpdate(pcApp.versionCode, appVersion)) return null
  return (
    <Band label="앱 업데이트" text={UPDATE_TEXT}>
      <a className="btn pri m-appband-go" href="/dure.apk" download>
        받기
      </a>
    </Band>
  )
}

const permissionNow = (): NotificationPermission | null => (typeof Notification === 'undefined' ? null : Notification.permission)

/**
 * 앱 안 — 알림 허락을 아직 안 물었으면(안드로이드 13 이상은 앱이 따로 묻는다). [켜기] = 알림 켜기 흐름(onEnable — 앱 이름으로 묻는다).
 * 허락·막음이 정해지면 숨는다 — 흐름이 끝난 뒤 · 다른 곳(⋯ 메뉴의 '휴대폰 알림 켜기')에서 켠 뒤(tick) · 휴대폰 설정에서 바꾸고 돌아왔을 때 다시 본다
 */
function NotifyBand({ onEnable, tick }: { onEnable: () => Promise<unknown>; tick: number }) {
  const [perm, setPerm] = useState(permissionNow)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setPerm(permissionNow())
  }, [tick])
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') setPerm(permissionNow())
    }
    document.addEventListener('visibilitychange', again)
    return () => document.removeEventListener('visibilitychange', again)
  }, [])
  if (perm !== 'default') return null
  // 켜는 동안은 글만 바뀐다(흐려지지 않는다 — '아직 못 누름'과 헷갈리지 않게, 짝 맺기 화면의 단추와 같다). 두 번 누르면 무시
  return (
    <Band label="휴대폰 알림" text={NOTIFY_TEXT}>
      <button
        type="button"
        className="btn pri m-appband-go"
        aria-busy={busy}
        onClick={() => {
          if (busy) return
          setBusy(true)
          void onEnable().finally(() => {
            setBusy(false)
            setPerm(permissionNow())
          })
        }}
      >
        {busy ? '켜는 중…' : '켜기'}
      </button>
    </Band>
  )
}

/**
 * 방 목록 위의 띠들 — 앱 밖이면 SteerBand, 앱 안이면 알림 켜기 띠 · 앱 업데이트 띠.
 * onEnablePush = 방 목록의 알림 켜기('휴대폰 알림 켜기'와 같은 것) · pushTick = 그 흐름이 끝날 때마다 바뀌는 수(알림 띠가 허락을 다시 본다)
 */
export function AppBand({ onEnablePush, pushTick }: { onEnablePush: () => Promise<unknown>; pushTick: number }) {
  const [ctx] = useState(appContext)
  if (!ctx.inApp) return <SteerBand ctx={ctx} />
  return (
    <>
      <NotifyBand onEnable={onEnablePush} tick={pushTick} />
      <UpdateBand appVersion={ctx.appVersion} />
    </>
  )
}
