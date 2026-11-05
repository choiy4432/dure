import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Circle, CircleAlert, ExternalLink, Smartphone } from 'lucide-react'
import type { PhoneDevice, PhoneSettingsChange, PhoneState } from '../../shared/phoneTypes'
import { useDure } from '../state/store'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { useMotion } from '../lib/presence'
import { useNow } from '../lib/useNow'
import { ago, errorMessage } from '../lib/words'
import { ConfirmDialog } from './ConfirmDialog'
import { PhonePairDialog } from './PhonePairDialog'

// 휴대폰으로 쓰기 — PC 쪽 화면(시안 C2 + D1, .superpowers/brainstorm/103256-1793850157/content/pc-phone-settings.html).
// 설정 창엔 '휴대폰' 한 줄(상태 + [열기]), 누르면 이 휴대폰 창이 설정 창 위에 뜬다(설정에서 바꾸던 값은 그대로 남는다).
// 위 띠 알약도 같은 창을 연다. 스위치는 저장 단추 없이 바로 setPhone — 상태는 main 의 'phone' 사건으로만 바뀐다(되묻지 않는다).

/** 화면 글 — 해요체 */
export const PHONE = {
  title: '휴대폰',
  switchName: '휴대폰으로 쓰기',
  on: '켜짐',
  off: '꺼짐',
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
  tip: 'Tailscale 대시보드에서 PC 이름을 dure 처럼 바꾸면 휴대폰 주소가 짧아져요',
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
  finished: '일을 마치면 휴대폰 알림',
  keepAwake: '켜 둔 동안 PC 절전 막기',
  lid: "노트북 덮개를 닫으면 PC 가 잠들어요 — Windows 전원 설정에서 '덮개를 닫을 때'를 '아무 것도 안 함'으로 바꿔 주세요",
  openAtLogin: 'Windows 를 켜면 두레도 켜기',
  openAtLoginOffered: 'PC 를 다시 켜도 휴대폰 연결이 이어지게 함께 켰어요',
  close: '닫기',
  noState: '휴대폰 연결 상태를 아직 받지 못했어요',
  // 상태 한 줄(설정 칸 · 위 띠 알약)
  status: (p: PhoneState) => (!p.settings.enabled ? '꺼짐' : routeOpen(p) ? `켜짐 · ${p.connected}대 접속 중` : '켜짐 · 아직 안 열렸어요'),
  pill: (n: number) => `휴대폰 · ${n}`,
  pillName: (p: PhoneState) => (routeOpen(p) ? `휴대폰 연결 켜짐 · ${p.connected}대 접속 중` : '휴대폰 연결 켜짐 · 아직 안 열렸어요'),
} as const

/** Tailscale 내려받기 — 기본 브라우저로 */
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

/** 휴대폰 연결을 처음 켤 때 'Windows 를 켜면 두레도 켜기'를 켬으로 제안했는가 — 이 PC 에 기억한다(한 번만 제안, 끈 것을 다시 덮지 않게) */
export const PHONE_LOGIN_OFFERED_KEY = 'dure.phoneLoginOffered'

/** 휴대폰 주소가 열려 있고 까닭(문제)이 없다 — 초록 점 */
export function routeOpen(p: PhoneState): boolean {
  return p.url !== null && p.problem === null
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
          {on && <span className={`dot ${ok ? 'g' : 's'}`} aria-hidden="true" />}
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

/** 위 띠 알약(시안 D1) — 휴대폰 연결이 켜져 있을 때만, 설정 톱니 왼쪽. 초록 점 = 주소가 열림, 숫자 = 접속 중인 기기 */
export function PhonePill({ onOpen }: { onOpen: () => void }) {
  const p = useDure(s => s.app.phone)
  if (!p?.settings.enabled) return null
  const ok = routeOpen(p)
  const name = PHONE.pillName(p)
  return (
    <button type="button" className="phn-top" title={name} aria-label={name} onClick={onOpen}>
      <span className={`dot ${ok ? 'g' : 's'}`} aria-hidden="true" />
      <Smartphone className="i" size={14} aria-hidden="true" />
      {PHONE.pill(p.connected)}
    </button>
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
  // 처음 초점은 창 자체 — 켜기 스위치에 두면 Space·Enter 한 번에 연결이 꺼질 수 있다. Tab 이 첫 단추부터 돈다
  useDialogFocus(ref, onClose, () => null)

  /** 보낸 뒤 사건을 기다리는 스위치 — 그동안 바라는 쪽으로 보이고 다시 누를 수 없다 */
  const [pending, setPending] = useState<Partial<Record<SwitchKey, boolean>>>({})
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [unpairing, setUnpairing] = useState<PhoneDevice | null>(null)
  /** 처음 켤 때 자동 켜기를 함께 켰다 — 말없이 바뀌지 않게 그 스위치 아래에 한 줄 */
  const [loginOfferedNow, setLoginOfferedNow] = useState(false)
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

  // 꺼진 채 시작하면 main 은 Tailscale 을 부르지 않는다 — 처음 열 때 아직 모르면 한 번 본다
  const askedFirst = useRef(false)
  useEffect(() => {
    if (askedFirst.current || !p || p.tailscale !== null) return
    askedFirst.current = true
    void recheck()
  }, [p]) // eslint-disable-line react-hooks/exhaustive-deps

  // 바깥(브라우저·Tailscale)에 다녀와 창으로 돌아오면 — 아직 안 됐으면 다시 본다([다시 확인]을 누르지 않아도)
  const latest = useRef({ p, checking, recheck })
  latest.current = { p, checking, recheck }
  useEffect(() => {
    const onFocus = () => {
      const { p: now, checking: busy, recheck: again } = latest.current
      if (!now || busy) return
      const stuck = now.tailscale?.kind !== 'ready' || (now.settings.enabled && now.url === null)
      if (stuck) void again()
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

  /** 스위치 하나 — 바뀐 칸만 바로 보낸다. 실패하면 되돌아가고(사건이 없으니 그대로) 까닭을 보인다 */
  const flip = async (k: SwitchKey) => {
    if (pending[k] !== undefined) return
    const to = !shown(k)
    const change: PhoneSettingsChange =
      k === 'asks' ? { notify: { asks: to } } : k === 'finished' ? { notify: { finished: to } } : { [k]: to }
    const also: Partial<Record<SwitchKey, boolean>> = {}
    // 처음 켤 때는 'Windows 를 켜면 두레도 켜기'도 켬으로(업데이트로 PC 가 다시 켜져도 이어지게) — 한 번만 제안한다
    const offer = k === 'enabled' && to && !s.openAtLogin && !loginOffered()
    if (offer) {
      change.openAtLogin = true
      also.openAtLogin = true
    }
    setError(null)
    setPending(cur => ({ ...cur, [k]: to, ...also }))
    try {
      await window.dure.setPhone(change)
      if (k === 'enabled' && to) markLoginOffered()
      if (offer && alive.current) setLoginOfferedNow(true)
    } catch (e) {
      if (alive.current) setError(errorMessage(e))
    } finally {
      if (alive.current)
        setPending(cur => {
          const next = { ...cur }
          delete next[k]
          for (const a of Object.keys(also) as SwitchKey[]) delete next[a]
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
              aria-label={PHONE.switchName}
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

          <Checklist p={p} enabled={enabled} checking={checking} onRecheck={() => void recheck()} />

          <h3 className="phn-sub">{PHONE.devices}</h3>
          <Devices p={p} onUnpair={setUnpairing} />
          <div className="phn-pair">
            <button type="button" className="btn pri" disabled={p.url === null} onClick={() => setPairOpen(true)}>
              {PHONE.pair}
            </button>
            {p.url === null && <span className="fld-note">{PHONE.pairWait}</span>}
          </div>

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

function Checklist({ p, enabled, checking, onRecheck }: { p: PhoneState; enabled: boolean; checking: boolean; onRecheck: () => void }) {
  const steps = stepsOf(p, enabled, checking)
  const ready = p.tailscale?.kind === 'ready'
  // 다시 확인 — 아직 안 됐거나(Tailscale 을 깔고·로그인하고·Serve 를 켠 뒤) 켰는데 주소가 안 열렸을 때
  const canRecheck = !ready || (enabled && p.url === null)
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
      {p.url !== null && <div className="phn-url">{p.url}</div>}
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
