import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Circle, CircleAlert, Copy, ExternalLink, Smartphone } from 'lucide-react'
import type { PhoneDevice, PhoneSettingsChange, PhoneState } from '../../shared/phoneTypes'
import { useDure } from '../state/store'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { useMotion } from '../lib/presence'
import { useNow } from '../lib/useNow'
import { ago, errorMessage } from '../lib/words'
import { ConfirmDialog } from './ConfirmDialog'
import { PhonePairDialog } from './PhonePairDialog'
import { AndroidAppDialog, ANDROID } from './AndroidAppDialog'

// 휴대폰으로 쓰기 — PC 쪽 화면(시안 C2 + D1, .superpowers/brainstorm/103256-1793850157/content/pc-phone-settings.html).
// 설정 창엔 '휴대폰' 한 줄(상태 + [열기]), 누르면 이 휴대폰 창이 설정 창 위에 뜬다(설정에서 바꾸던 값은 그대로 남는다).
// 위 띠 알약도 같은 창을 연다. 스위치는 저장 단추 없이 바로 setPhone — 상태는 main 의 'phone' 사건으로만 바뀐다(되묻지 않는다).

/** 화면 글 — 해요체 */
export const PHONE = {
  title: '휴대폰',
  switchName: '휴대폰으로 쓰기',
  on: '켜짐',
  off: '꺼짐',
  /** 머리 스위치의 이름 — 보이는 글(켜짐/꺼짐)을 이름에 담는다(WCAG 2.5.3 Label in Name) */
  switchLabel: (on: boolean) => `휴대폰으로 쓰기 — ${on ? '켜짐' : '꺼짐'}`,
  desc: '밖에서 휴대폰으로 에이전트 일을 보고 승인해요. 내 Tailscale 기기에서만 열려요.',
  rowDesc: '밖에서 휴대폰으로 에이전트 일을 보고 승인해요',
  open: '열기',
  openName: '휴대폰 열기',
  // Tailscale 확인 단계
  checking: 'Tailscale 을 확인하는 중…',
  checkTodo: 'Tailscale 확인',
  installed: 'Tailscale 이 깔려 있어요',
  install: 'Tailscale 을 깔고 켜 주세요',
  installHint: '이미 깔았다면 Tailscale 이 켜져 있는지 확인해 주세요',
  download: '내려받기',
  loggedIn: '로그인돼 있어요',
  login: 'Tailscale 에 로그인해 주세요',
  loginHint: '작업 표시줄의 Tailscale 아이콘을 눌러 로그인해요',
  loginTodo: '로그인',
  opened: '휴대폰 주소가 열렸어요',
  serve: 'Tailscale 에서 Serve 를 한 번 켜야 해요',
  serveHint: '한 번만 켜면 돼요 — 켠 뒤 다시 확인을 눌러 주세요',
  serveGo: '켜러 가기',
  openTodo: '휴대폰 주소 열기',
  openWhenOn: '켜면 휴대폰 주소가 열려요',
  opening: '휴대폰 주소를 여는 중…',
  openFailed: '휴대폰 주소를 열지 못했어요',
  recheck: '다시 확인',
  rechecking: '확인하는 중…',
  tip: 'Tailscale 대시보드에서 PC 이름을 dure 처럼 바꾸면 주소가 짧아져요 — 바꾸기 전에 휴대폰 연결을 끄고, 바꾼 뒤 다시 켜 주세요',
  copyUrl: '주소 복사',
  copied: '복사했어요',
  copyFailed: '복사하지 못했어요',
  // 기기
  devices: '짝 맺은 휴대폰',
  noDevices: '아직 짝 맺은 휴대폰이 없어요',
  online: '지금 접속 중',
  lastSeen: (when: string) => `마지막 접속 ${when}`,
  neverSeen: '아직 접속한 적 없어요',
  unpair: '끊기',
  unpairName: (name: string) => `${name} 끊기`,
  unpairTitle: (name: string) => `‘${name}’ 연결을 끊을까요?`,
  unpairBody: '이 휴대폰에서는 더 이상 두레를 열 수 없어요. 다시 쓰려면 짝을 새로 맺어야 해요.',
  pair: '휴대폰 짝 맺기',
  pairWait: '휴대폰 주소가 열리면 짝을 맺을 수 있어요',
  // 알림 · 전원
  power: '알림 · 전원',
  asks: '승인·질문이 오면 휴대폰 알림',
  finished: '답이 오면 휴대폰 알림',
  keepAwake: '켜 둔 동안 PC 절전 막기',
  lid: "노트북 덮개를 닫으면 PC 가 잠들어요 — Windows 전원 설정에서 '덮개를 닫을 때'를 '아무 것도 안 함'으로 바꿔 주세요",
  openAtLogin: 'Windows 를 켜면 두레도 켜기',
  openAtLoginOffered: 'PC 를 다시 켜도 휴대폰 연결이 이어지게 함께 켰어요',
  close: '닫기',
  noState: '휴대폰 연결 상태를 아직 받지 못했어요',
  // 상태 한 줄(설정 칸 · 위 띠 알약)
  status: (p: PhoneState) => (!p.settings.enabled ? '꺼짐' : routeOpen(p) ? `켜짐 · ${p.connected}대 접속 중` : '켜짐 · 아직 안 열렸어요'),
  /** 위 띠 알약의 보이는 글 = 이름 */
  pill: (n: number) => `휴대폰 · ${n}`,
  /** 위 띠 알약의 긴 말 — 설명(aria-describedby)·툴팁 */
  pillDesc: (p: PhoneState) => (routeOpen(p) ? `휴대폰 연결 켜짐 · ${p.connected}대 접속 중` : '휴대폰 연결 켜짐 · 아직 안 열렸어요'),
} as const

/** Tailscale 내려받기 — 기본 브라우저로 */
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

/** 휴대폰 연결을 처음 켤 때 'Windows 를 켜면 두레도 켜기'를 켬으로 제안했는가 — 이 PC 에 기억한다(한 번만 제안, 끈 것을 다시 덮지 않게) */
export const PHONE_LOGIN_OFFERED_KEY = 'dure.phoneLoginOffered'

/** 휴대폰 주소가 열려 있고 까닭(문제)이 없다 — 초록 점 */
export function routeOpen(p: PhoneState): boolean {
  return p.url !== null && p.problem === null
}

/** 상태 점 — 꺼짐 회색(s) · 켰는데 아직 안 열렸거나 까닭이 있음 앰버(a) · 열림 초록(g) */
function dotOf(p: PhoneState): 's' | 'a' | 'g' {
  return !p.settings.enabled ? 's' : routeOpen(p) ? 'g' : 'a'
}

/** 기본 브라우저로 — 새 창 요청을 main 이 받아 연다(http·https 만, 창 안에서는 옮겨 가지 않는다) */
function openOutside(url: string) {
  window.open(url, '_blank')
}

function loginOffered(): boolean {
  try {
    return localStorage.getItem(PHONE_LOGIN_OFFERED_KEY) === '1'
  } catch {
    return false
  }
}
function markLoginOffered() {
  try {
    localStorage.setItem(PHONE_LOGIN_OFFERED_KEY, '1')
  } catch {
    // 못 적으면 다음에 한 번 더 제안할 뿐
  }
}

/** 설정 창의 '휴대폰' 칸 — 상태 알약 + [열기]. 휴대폰 상태를 못 받았으면(옛 api) 칸을 숨긴다 */
export function PhoneField({ onOpen }: { onOpen: () => void }) {
  const p = useDure(s => s.app.phone)
  const id = useId()
  if (!p) return null
  const on = p.settings.enabled
  const ok = routeOpen(p)
  return (
    <div className="fld">
      <span className="fld-l">{PHONE.title}</span>
      <div className="fld-row phn-row">
        <span className={`phn-stat${on && ok ? ' on' : ''}`} id={`${id}-s`}>
          <span className={`dot ${dotOf(p)}`} aria-hidden="true" />
          {PHONE.status(p)}
        </span>
        <button type="button" className="btn sec sm" aria-label={PHONE.openName} aria-describedby={`${id}-s ${id}-d`} onClick={onOpen}>
          {PHONE.open}
        </button>
      </div>
      <p className="fld-d" id={`${id}-d`}>
        {PHONE.rowDesc}
      </p>
    </div>
  )
}

/**
 * 위 띠 알약(시안 D1) — 휴대폰 연결이 켜져 있을 때만, 설정 톱니 왼쪽. 초록 점 = 주소가 열림, 앰버 = 아직 안 열렸거나 까닭, 숫자 = 접속 중인 기기.
 * 이름은 보이는 글('휴대폰 · N') 그대로, 긴 말은 설명·툴팁으로
 */
export function PhonePill({ onOpen }: { onOpen: () => void }) {
  const p = useDure(s => s.app.phone)
  const id = useId()
  if (!p?.settings.enabled) return null
  const desc = PHONE.pillDesc(p)
  return (
    <>
      <span id={id} hidden>
        {desc}
      </span>
      <button type="button" className="phn-top" title={desc} aria-describedby={id} onClick={onOpen}>
        <span className={`dot ${dotOf(p)}`} aria-hidden="true" />
        <Smartphone className="i" size={14} aria-hidden="true" />
        {PHONE.pill(p.connected)}
      </button>
    </>
  )
}

/** 휴대폰 창 — 설정 창(또는 위 띠 알약) 위에 뜬다 */
export function PhoneDialog({ onClose }: { onClose: () => void }) {
  return createPortal(<Frame onClose={onClose} />, document.body)
}

type SwitchKey = 'enabled' | 'keepAwake' | 'openAtLogin' | 'asks' | 'finished'

function Frame({ onClose }: { onClose: () => void }) {
  const p = useDure(s => s.app.phone)
  const ref = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()
  useMotion(backdrop, MOTION.backdrop)
  useMotion(ref, MOTION.dialog)
  // 처음 초점은 창 자체 — 켜기 스위치에 두면 Space·Enter 한 번에 연결이 꺼질 수 있다. Tab 이 첫 단추부터 돈다.
  // 위 띠 알약에서 열었는데 그사이 껐으면 알약이 없다 — 닫을 때 초점은 그 옆 설정 톱니로
  useDialogFocus(ref, onClose, () => null, () => document.querySelector<HTMLElement>('[data-tour="settings-gear"]'))

  /** 보낸 뒤 사건을 기다리는 스위치 — 그동안 바라는 쪽으로 보인다(켜기 스위치 말고는 다시 누를 수 없다) */
  const [pending, setPending] = useState<Partial<Record<SwitchKey, boolean>>>({})
  /** 스위치마다 보낸 차례 — 앞서 보낸 것이 늦게 끝나도 뒤에 보낸 것의 기다림 표시를 지우거나 그 실패를 띄우지 않게 */
  const sent = useRef<Partial<Record<SwitchKey, number>>>({})
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [appOpen, setAppOpen] = useState(false)
  const [unpairing, setUnpairing] = useState<PhoneDevice | null>(null)
  /** 처음 켤 때 자동 켜기를 함께 켰다 — 말없이 바뀌지 않게 그 스위치 아래에 한 줄 */
  const [loginOfferedNow, setLoginOfferedNow] = useState(false)
  /**
   * 주소가 바뀌었다는 알림 — main 의 notice 를 받으면 이 창이 열린 동안 주소 칸에 보이고, main 엔 봤다고 알린다(main 은 지운다 — 다음에 열면 없다).
   * 짝 맺기를 열면 할 일을 했으니 지운다
   */
  const [notice, setNotice] = useState<string | null>(null)
  const mainNotice = p?.notice ?? null
  useEffect(() => {
    if (mainNotice === null) return
    setNotice(mainNotice)
    void window.dure.phoneNoticeSeen().catch(() => {})
  }, [mainNotice])
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const recheck = async () => {
    setChecking(true)
    setError(null)
    try {
      await window.dure.phoneCheck() // 결과는 'phone' 사건으로 온다
    } catch (e) {
      if (alive.current) setError(errorMessage(e))
    } finally {
      if (alive.current) setChecking(false)
    }
  }

  // 처음 열 때 한 번 본다 — 꺼진 채 시작하면 main 은 Tailscale 을 부르지 않아 아직 모를 때 · 주소가 열려 있을 때(창이 닫힌 사이 PC 이름을 바꿨을 수 있다 —
  // 바뀌었으면 main 이 지금 이름으로 다시 연다)
  const askedFirst = useRef(false)
  useEffect(() => {
    if (askedFirst.current || !p || (p.tailscale !== null && !addressOpen(p))) return
    askedFirst.current = true
    void recheck()
  }, [p]) // eslint-disable-line react-hooks/exhaustive-deps

  // 바깥(브라우저·Tailscale 대시보드)에 다녀와 창으로 돌아오면 — 아직 안 됐거나 까닭이 남았거나 주소가 열려 있으면(이름을 바꿨을 수 있다) 다시 본다
  // ([다시 확인]을 누르지 않아도)
  const latest = useRef({ p, checking, recheck })
  latest.current = { p, checking, recheck }
  useEffect(() => {
    const onFocus = () => {
      const { p: now, checking: busy, recheck: again } = latest.current
      if (!now || busy) return
      if (stuck(now) || addressOpen(now)) void again()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const onBackdrop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  if (!p) {
    return (
      <div ref={backdrop} className="dlg-bd" onPointerDown={onBackdrop}>
        <div ref={ref} className="dlg dlg-form phn-dlg" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
          <h2 id={titleId} className="dlg-t">
            {PHONE.title}
          </h2>
          <p className="dlg-d">{PHONE.noState}</p>
          <div className="dlg-ab">
            <button type="button" className="btn sec" onClick={onClose}>
              {PHONE.close}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const s = p.settings
  const actual: Record<SwitchKey, boolean> = {
    enabled: s.enabled,
    keepAwake: s.keepAwake,
    openAtLogin: s.openAtLogin,
    asks: s.notify.asks,
    finished: s.notify.finished,
  }
  const shown = (k: SwitchKey) => pending[k] ?? actual[k]

  /**
   * 스위치 하나 — 바뀐 칸만 바로 보낸다. 실패하면 되돌아가고(사건이 없으니 그대로) 까닭을 보인다.
   * 휴대폰 연결 켜기는 오래 걸린다(Tailscale 확인·길 열기 10~30초) — 그동안에도 다시 눌러 끌 수 있다(main 은 끄기를 바로 적고 켜기를 멈춘다).
   * 다른 스위치는 보낸 것이 끝날 때까지 한 번만
   */
  const flip = async (k: SwitchKey) => {
    if (pending[k] !== undefined && k !== 'enabled') return
    const to = !shown(k)
    const change: PhoneSettingsChange =
      k === 'asks' ? { notify: { asks: to } } : k === 'finished' ? { notify: { finished: to } } : { [k]: to }
    const also: Partial<Record<SwitchKey, boolean>> = {}
    // 처음 켤 때는 'Windows 를 켜면 두레도 켜기'도 켬으로(업데이트로 PC 가 다시 켜져도 이어지게) — 한 번만 제안한다
    const offer = k === 'enabled' && to && !shown('openAtLogin') && !loginOffered()
    if (offer) {
      change.openAtLogin = true
      also.openAtLogin = true
    }
    const keys = [k, ...(Object.keys(also) as SwitchKey[])]
    const mine: Partial<Record<SwitchKey, number>> = {}
    for (const key of keys) mine[key] = sent.current[key] = (sent.current[key] ?? 0) + 1
    /** 이 칸에 뒤에 보낸 것이 없다 */
    const last = (key: SwitchKey) => sent.current[key] === mine[key]
    setError(null)
    setPending(cur => ({ ...cur, [k]: to, ...also }))
    try {
      await window.dure.setPhone(change)
      if (k === 'enabled' && to) markLoginOffered()
      if (offer && alive.current) setLoginOfferedNow(true)
    } catch (e) {
      // 켜는 중에 껐으면 앞의 켜기 실패는 지난 일 — 띄우지 않는다
      if (alive.current && last(k)) setError(errorMessage(e))
    } finally {
      if (alive.current)
        setPending(cur => {
          const next = { ...cur }
          for (const key of keys) if (last(key)) delete next[key]
          return next
        })
    }
  }

  const sw = (k: SwitchKey, label: string, describedBy?: string) => (
    <button
      type="button"
      className="sw"
      role="switch"
      aria-checked={shown(k)}
      aria-busy={pending[k] !== undefined || undefined}
      aria-describedby={describedBy}
      onClick={() => void flip(k)}
    >
      <span>{label}</span>
      <span className="tg" aria-hidden="true" />
    </button>
  )

  const enabled = shown('enabled')
  const lidId = `${titleId}-lid`

  return (
    <>
      <div ref={backdrop} className="dlg-bd" onPointerDown={onBackdrop}>
        <div
          ref={ref}
          className="dlg dlg-form phn-dlg"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          tabIndex={-1}
        >
          <div className="phn-head">
            <h2 id={titleId} className="dlg-t">
              <Smartphone className="i" size={16} aria-hidden="true" />
              {PHONE.title}
            </h2>
            <button
              type="button"
              className="sw phn-master"
              role="switch"
              aria-checked={enabled}
              aria-busy={pending.enabled !== undefined || undefined}
              aria-label={PHONE.switchLabel(enabled)}
              onClick={() => void flip('enabled')}
            >
              <span>{enabled ? PHONE.on : PHONE.off}</span>
              <span className="tg" aria-hidden="true" />
            </button>
          </div>
          <p className="dlg-d" id={descId}>
            {PHONE.desc}
          </p>
          {error && (
            <p className="dlg-err" role="alert">
              {error}
            </p>
          )}

          <Checklist p={p} enabled={enabled} checking={checking} notice={notice} onRecheck={() => void recheck()} />

          <h3 className="phn-sub">{PHONE.devices}</h3>
          <Devices p={p} onUnpair={setUnpairing} />
          <div className="phn-pair">
            <button
              type="button"
              className="btn pri"
              data-pair
              disabled={p.url === null}
              onClick={() => {
                setNotice(null)
                setPairOpen(true)
              }}
            >
              {PHONE.pair}
            </button>
            {p.url === null && <span className="fld-note">{PHONE.pairWait}</span>}
          </div>

          {p.androidApp !== null && p.url !== null && (
            <>
              <h3 className="phn-sub">{ANDROID.section}</h3>
              <div className="phn-app">
                <div className="phn-dev-nm">
                  <b>
                    {ANDROID.appName} <span className="phn-app-v">{ANDROID.version(p.androidApp.versionName)}</span>
                  </b>
                  <span>{ANDROID.rowDesc}</span>
                </div>
                <button type="button" className="btn pri sm" onClick={() => setAppOpen(true)}>
                  {ANDROID.get}
                </button>
              </div>
            </>
          )}

          <h3 className="phn-sub">{PHONE.power}</h3>
          <div className="fld phn-sws">
            {sw('asks', PHONE.asks)}
            {sw('finished', PHONE.finished)}
            {sw('keepAwake', PHONE.keepAwake, lidId)}
            <p className="fld-d" id={lidId}>
              {PHONE.lid}
            </p>
            {sw('openAtLogin', PHONE.openAtLogin, loginOfferedNow && shown('openAtLogin') ? `${titleId}-login` : undefined)}
            {loginOfferedNow && shown('openAtLogin') && (
              <p className="fld-d" id={`${titleId}-login`}>
                {PHONE.openAtLoginOffered}
              </p>
            )}
          </div>

          <div className="dlg-ab">
            <button type="button" className="btn sec" onClick={onClose}>
              {PHONE.close}
            </button>
          </div>
        </div>
      </div>
      {/* 이 창 위에 겹쳐 뜨는 창 — 키는 맨 위 것만 받는다(useDialogFocus) */}
      <PhonePairDialog open={pairOpen} onClose={() => setPairOpen(false)} />
      <AndroidAppDialog open={appOpen && p.androidApp !== null && p.url !== null} url={p.url} onClose={() => setAppOpen(false)} />
      <ConfirmDialog
        open={unpairing !== null}
        title={unpairing ? PHONE.unpairTitle(unpairing.name) : ''}
        body={PHONE.unpairBody}
        confirmLabel={PHONE.unpair}
        danger
        onConfirm={async () => {
          if (!unpairing) return
          await window.dure.phoneUnpair(unpairing.id)
          setUnpairing(null)
        }}
        onCancel={() => setUnpairing(null)}
        // 끊으면 그 줄([끊기])이 없어진다 — [휴대폰 짝 맺기]로(막혀 있으면 휴대폰 창으로)
        returnFocus={() => ref.current?.querySelector<HTMLElement>('[data-pair]')}
      />
    </>
  )
}

type StepState = 'ok' | 'need' | 'todo'
type Step = { state: StepState; text: string; hint?: string; action?: ReactNode }

/** Tailscale 확인 단계 — 깔림 → 로그인 → 휴대폰 주소. 막힌 단계에서 할 일(내려받기·켜러 가기), 그 뒤 단계는 흐리게 */
function stepsOf(p: PhoneState, enabled: boolean, checking: boolean): Step[] {
  const ts = p.tailscale
  const link = (label: string, url: string) => (
    <button type="button" className="phn-link" onClick={() => openOutside(url)}>
      <ExternalLink className="i" size={13} aria-hidden="true" />
      {label}
    </button>
  )
  const todo = (text: string): Step => ({ state: 'todo', text })
  if (ts === null) return [todo(checking ? PHONE.checking : PHONE.checkTodo), todo(PHONE.loginTodo), todo(PHONE.openTodo)]
  if (ts.kind === 'missing')
    return [
      { state: 'need', text: PHONE.install, hint: PHONE.installHint, action: link(PHONE.download, TAILSCALE_DOWNLOAD_URL) },
      todo(PHONE.loginTodo),
      todo(PHONE.openTodo),
    ]
  const installed: Step = { state: 'ok', text: PHONE.installed }
  if (ts.kind === 'logged-out') return [installed, { state: 'need', text: PHONE.login, hint: PHONE.loginHint }, todo(PHONE.openTodo)]
  const loggedIn: Step = { state: 'ok', text: PHONE.loggedIn }
  if (ts.kind === 'no-https')
    return [
      installed,
      loggedIn,
      { state: 'need', text: PHONE.serve, hint: PHONE.serveHint, action: ts.enableUrl ? link(PHONE.serveGo, ts.enableUrl) : undefined },
    ]
  // ready — 주소는 켜야 열린다
  const route: Step =
    p.url !== null ? { state: 'ok', text: PHONE.opened }
      : !enabled ? todo(PHONE.openWhenOn)
      : p.problem !== null ? { state: 'need', text: PHONE.openFailed }
      : todo(PHONE.opening)
  return [installed, loggedIn, route]
}

const STEP_ICON: Record<StepState, typeof Check> = { ok: Check, need: CircleAlert, todo: Circle }

/**
 * 아직 다 안 됐다 — [다시 확인]을 보이고, 창으로 돌아오면 저절로 다시 본다.
 * Tailscale 이 준비 전이거나(깔고·로그인하고·Serve 를 켠 뒤) · 까닭이 남았거나(꺼진 채 전에 연 길을 못 정리함 등) · 켰는데 주소가 안 열렸을 때
 */
function stuck(p: PhoneState, enabled = p.settings.enabled): boolean {
  return p.tailscale?.kind !== 'ready' || p.problem !== null || (enabled && p.url === null)
}

/** 켜져 있고 휴대폰 주소가 열려 있다 — 창으로 돌아오면 다시 본다(Tailscale 대시보드에서 PC 이름을 바꿨으면 그 주소는 끊긴다) */
function addressOpen(p: PhoneState): boolean {
  return p.settings.enabled && p.url !== null
}

function Checklist({ p, enabled, checking, notice, onRecheck }: {
  p: PhoneState
  enabled: boolean
  checking: boolean
  /** 주소가 바뀌었다는 알림 — 주소 바로 위에 */
  notice: string | null
  onRecheck: () => void
}) {
  const steps = stepsOf(p, enabled, checking)
  const canRecheck = stuck(p, enabled)
  return (
    <div className="phn-panel" aria-live="polite">
      <ul className="phn-steps">
        {steps.map(st => {
          const Icon = STEP_ICON[st.state]
          return (
            <li key={st.text} className="phn-step" data-step={st.state}>
              <Icon className="i" size={16} aria-hidden="true" />
              <div className="phn-step-b">
                <div className="phn-step-l">
                  <span className="phn-step-t">{st.text}</span>
                  {st.action}
                </div>
                {st.hint && <span className="phn-step-h">{st.hint}</span>}
              </div>
            </li>
          )
        })}
      </ul>
      {p.problem && <p className="phn-problem">{p.problem}</p>}
      {notice && <p className="phn-problem">{notice}</p>}
      {p.url !== null && <UrlRow url={p.url} />}
      {/* 주소가 보일 때만 — 그 주소를 짧게 하는 법 */}
      {p.url !== null && <p className="phn-tip">{PHONE.tip}</p>}
      {canRecheck && (
        <button type="button" className="btn sec sm phn-recheck" disabled={checking} onClick={onRecheck}>
          {checking ? PHONE.rechecking : PHONE.recheck}
        </button>
      )}
    </div>
  )
}

/** '복사했어요'·'복사하지 못했어요' 를 보이는 시간 */
const COPIED_MS = 1500

/** 휴대폰 주소 한 줄 — 주소(mono, 끌어 고를 수 있음) + [주소 복사]. 결과는 그 옆 글로(늘 붙어 있는 status 라 읽힌다) */
function UrlRow({ url }: { url: string }) {
  const [said, setSaid] = useState<'' | 'done' | 'fail'>('')
  useEffect(() => {
    if (!said) return
    const t = setTimeout(() => setSaid(''), COPIED_MS)
    return () => clearTimeout(t)
  }, [said])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setSaid('done')
    } catch {
      setSaid('fail') // 창이 초점을 잃었을 때 등 — 주소를 끌어 골라 복사할 수 있다
    }
  }
  return (
    <div className="phn-url">
      <span className="phn-url-t">{url}</span>
      <span className={`phn-copied${said === 'fail' ? ' bad' : ''}`} role="status">
        {said === 'done' ? PHONE.copied : said === 'fail' ? PHONE.copyFailed : ''}
      </span>
      <button type="button" className="ib phn-copy" title={PHONE.copyUrl} aria-label={PHONE.copyUrl} onClick={() => void copy()}>
        {said === 'done' ? <Check className="i" size={14} aria-hidden="true" /> : <Copy className="i" size={14} aria-hidden="true" />}
      </button>
    </div>
  )
}

function Devices({ p, onUnpair }: { p: PhoneState; onUnpair: (d: PhoneDevice) => void }) {
  const now = useNow()
  if (p.devices.length === 0) return <p className="phn-empty">{PHONE.noDevices}</p>
  const online = new Set(p.online)
  return (
    <ul className="phn-devs">
      {p.devices.map(d => {
        const on = online.has(d.id)
        return (
          <li key={d.id} className="phn-dev">
            <span className={`dot ${on ? 'g' : 's'}`} aria-hidden="true" />
            <div className="phn-dev-nm">
              <b>{d.name}</b>
              <span>{on ? PHONE.online : d.lastSeen !== null ? PHONE.lastSeen(ago(d.lastSeen, now)) : PHONE.neverSeen}</span>
            </div>
            <button type="button" className="btn sec sm" aria-label={PHONE.unpairName(d.name)} onClick={() => onUnpair(d)}>
              {PHONE.unpair}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
