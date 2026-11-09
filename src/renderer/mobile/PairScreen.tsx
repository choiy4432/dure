/**
 * 휴대폰 짝 맺기 — 시안 B2(.superpowers/brainstorm/103256-1793850157/content/mobile-pair-v2.html): 위에 큰 제목, 할 일 단추는 엄지가 닿는 맨 아래.
 * 길: 앱 안 브라우저 → '크롬(아이폰은 사파리)으로 열어 주세요' · 아이폰 사파리 → '홈 화면에 추가' 안내 · QR 로 열었으면(#pair=) 이름 붙여 짝 맺기 ·
 * 아니면(홈 화면 앱 등) PC 에 뜬 6자리 넣기 → 짝을 맺으면 알림 켜기(삼성이면 팝업 설정 안내를 접어 둠 — 켜고 나면 펼쳐 보인다).
 * 짝을 맺은 화면엔 안드로이드 크롬에서만 '두레 앱으로 쓰기' 띠(방 목록과 같은 SteerBand — PC 가 앱을 내어 줄 때).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { Bell, Check, ChevronDown, Copy, Ellipsis, EllipsisVertical, Info, LoaderCircle, Share, type LucideIcon } from 'lucide-react'
import { BrandMark } from '../shell/BrandMark'
import { PHONE_NAME_MAX } from '../../shared/phoneTypes'
import type { PairEnv } from './pairEnv'
import type { PairOutcome, PushOutcome } from './phoneHttp'
import { SteerBand } from './AppBand'

export type { PairOutcome, PushOutcome }

export const PIN_LENGTH = 6
export const PIN_WRONG = '숫자가 맞지 않아요 — 다시 넣어 주세요'
export const PIN_EXPIRED = '시간이 지났어요 — PC 에서 [휴대폰 짝 맺기]를 다시 눌러 주세요'
export const QR_USED = 'QR 코드가 지났거나 이미 썼어요 — PC 에 뜬 숫자 6자리를 넣어 주세요'
export const PUSH_DENIED = '알림이 막혀 있어요 — 휴대폰 설정에서 이 사이트의 알림을 허용해 주세요'
export const PUSH_FAILED = '알림을 켜지 못했어요 — 다시 해 주세요'

type Stage = 'inapp' | 'ios-add' | 'confirm' | 'pin' | 'paired'
/** 오류 줄 — warn 은 사용자 탓이 아닌 안내(지난 QR 코드) */
type Notice = { text: string; tone: 'danger' | 'warn' }

export interface PairScreenProps {
  /** 주소의 #pair= 짝 코드(QR) — 없으면 null */
  code: string | null
  env: PairEnv
  /** 앱 안 브라우저에서 복사할 이 주소(짝 코드 포함 — 크롬·사파리에서 열면 바로 짝 맺기) */
  link: string
  pair: (secret: string, name: string) => Promise<PairOutcome>
  /** 알림 켜기 — 누른 그 자리에서 부른다(허락 묻기는 사용자 손짓이 있어야) */
  enablePush: () => Promise<PushOutcome>
  copy: (text: string) => Promise<boolean>
  /** 짝을 맺었고 알림도 정했다(또는 알림을 못 받는 브라우저) — 두레로 */
  onDone: () => void
}

function firstStage(code: string | null, env: PairEnv): Stage {
  if (env.inApp) return 'inapp'
  if (env.ios && !env.standalone) return 'ios-add'
  return code ? 'confirm' : 'pin'
}

export function PairScreen(p: PairScreenProps) {
  const [stage, setStage] = useState<Stage>(() => firstStage(p.code, p.env))
  const [name, setName] = useState(p.env.defaultName)
  const [pin, setPin] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  /** 알림을 켰다(삼성) — 팝업 설정을 펼쳐 보이고 '두레 열기' 하나만 */
  const [pushOn, setPushOn] = useState(false)
  /** 알림을 막아 두었다 — 다시 눌러도 바로 막히니 '알림 없이 계속' 으로 */
  const [denied, setDenied] = useState(false)
  const inflight = useRef(false) // 숫자 자동 보내기와 Enter 가 겹치지 않게
  const titleRef = useRef<HTMLHeadingElement>(null)
  const pinRef = useRef<HTMLInputElement>(null)
  const noticeId = useId()

  // 단계가 바뀌면 — 숫자 넣기는 그 칸으로, 그 밖은 제목으로(읽어 주는 프로그램이 새 화면을 읽게)
  useEffect(() => {
    if (stage === 'pin') pinRef.current?.focus()
    else titleRef.current?.focus()
  }, [stage, pushOn])

  const go = (s: Stage, n: Notice | null = null) => {
    setStage(s)
    setNotice(n)
  }

  const submit = async (secret: string) => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setNotice(null)
    const r = await p.pair(secret, name.trim() || p.env.defaultName)
    inflight.current = false
    setBusy(false)
    if (r.ok) {
      if (p.env.push) go('paired')
      else p.onDone()
      return
    }
    // QR 코드가 안 맞음 — 이미 썼거나 PC 가 새로 띄웠다(사용자 탓 아님). PC 창의 6자리로 이어 간다
    if (stage === 'confirm' && (r.kind === 'wrong' || r.kind === 'expired')) {
      go('pin', { text: r.kind === 'wrong' ? QR_USED : PIN_EXPIRED, tone: 'warn' })
      return
    }
    setNotice({ text: r.kind === 'wrong' ? PIN_WRONG : r.kind === 'expired' ? PIN_EXPIRED : r.error, tone: 'danger' })
    if (stage !== 'pin') return
    // 다시 넣기 쉽게 — 틀림·지남은 칸을 비우고, 막힘·끊김은 그대로 둬 단추로 다시
    if (r.kind === 'wrong' || r.kind === 'expired') setPin('')
    pinRef.current?.focus()
  }

  const turnOnPush = async () => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setNotice(null)
    const r = await p.enablePush()
    inflight.current = false
    setBusy(false)
    if (r === 'on' && p.env.samsung) setPushOn(true)
    else if (r === 'on' || r === 'unsupported') p.onDone()
    else {
      if (r === 'denied') setDenied(true)
      setNotice({ text: r === 'denied' ? PUSH_DENIED : PUSH_FAILED, tone: 'danger' })
    }
  }

  const title = (text: ReactNode) => (
    <h1 className="pr-title" ref={titleRef} tabIndex={-1}>
      {text}
    </h1>
  )
  const alert = notice && (
    <p className={`pr-err${notice.tone === 'warn' ? ' warn' : ''}`} role="alert" id={noticeId}>
      {notice.text}
    </p>
  )

  if (stage === 'inapp') return <InApp env={p.env} link={p.link} copy={p.copy} title={title} />

  if (stage === 'ios-add') {
    return (
      <Screen
        head={<>
          {title(<>아이폰은 <br />홈 화면에 추가해 주세요</>)}
          <p className="pr-hint">알림은 홈 화면에 추가한 두레에서만 받을 수 있어요.</p>
        </>}
        foot={<button type="button" className="pr-btn pr-link" onClick={() => go(p.code ? 'confirm' : 'pin')}>알림 없이 사파리에서 쓰기</button>}
      >
        <Steps items={[
          <><Glyph icon={Share} label="공유" /> 공유 단추를 눌러요 — 화면 아래나 <Glyph icon={Ellipsis} label="더 보기" /> 메뉴에 있어요</>,
          <>'홈 화면에 추가'를 골라요</>,
          <>홈 화면의 두레를 열고, PC 에 뜬 숫자 6자리를 넣어요</>,
        ]} />
      </Screen>
    )
  }

  if (stage === 'paired' && pushOn) {
    return (
      <Screen
        head={<>
          <span className="pr-ok"><Bell size={22} strokeWidth={2} aria-hidden /></span>
          {title('알림을 켰어요')}
          <p className="pr-hint">알림이 화면 위에 바로 뜨게 하려면 아래 설정을 한 번 해 주세요.</p>
        </>}
        foot={<button type="button" className="pr-btn pr-pri" onClick={p.onDone}>두레 열기</button>}
      >
        <SteerBand later={false} />
        <SamsungFold defaultOpen />
      </Screen>
    )
  }

  if (stage === 'paired') {
    return (
      <Screen
        head={<>
          <span className="pr-ok"><Check size={22} strokeWidth={2.25} aria-hidden /></span>
          {title('짝을 맺었어요')}
          <p className="pr-hint">에이전트가 승인을 기다리면 알려 드릴까요? PC 를 쓰고 있을 땐 울리지 않아요.</p>
        </>}
        foot={denied ? (
          <button type="button" className="pr-btn pr-pri" onClick={p.onDone}>알림 없이 계속</button>
        ) : <>
          <BusyButton busy={busy} label="알림 켜기" busyLabel="알림 켜는 중…" icon={Bell} onClick={turnOnPush} />
          <button type="button" className="pr-btn pr-link" onClick={p.onDone} disabled={busy}>나중에</button>
        </>}
      >
        {/* 안드로이드 크롬이고 PC 가 앱을 내어 주면 — 두레 앱으로(설계 §5.4-3). 아래에 알림 [나중에]가 있어 띠의 [나중에]는 뺀다 */}
        <SteerBand later={false} />
        {p.env.samsung && <SamsungFold />}
        {alert}
      </Screen>
    )
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (stage === 'confirm' && p.code) void submit(p.code)
    else if (stage === 'pin' && pin.length === PIN_LENGTH) void submit(pin)
  }
  const pairButton = (
    <BusyButton busy={busy} label="짝 맺기" busyLabel="짝 맺는 중…" submit disabled={stage === 'pin' && pin.length !== PIN_LENGTH} />
  )

  if (stage === 'confirm') {
    return (
      <Screen
        form={onSubmit}
        head={<>
          <span className="pr-mark"><BrandMark /></span>
          {title(<>이 휴대폰을 <br />두레와 짝 맺을까요?</>)}
          <p className="pr-hint">짝을 맺으면 밖에서도 이 휴대폰으로 에이전트 일을 보고 승인할 수 있어요.</p>
        </>}
        foot={pairButton}
      >
        <NameField value={name} onChange={setName} errorId={notice ? noticeId : undefined} />
        {alert}
      </Screen>
    )
  }

  // 숫자 넣기 — 6자리가 차면 바로 보낸다(아이폰 숫자 자판엔 '이동' 키가 없고, 맨 아래 단추를 자판이 가린다)
  return (
    <Screen
      form={onSubmit}
      head={<>
        {title(<>PC 에 뜬 <br />숫자 6자리를 넣어 주세요</>)}
        <p className="pr-hint">PC 두레 → 설정 → 휴대폰 → 휴대폰 짝 맺기</p>
      </>}
      foot={pairButton}
    >
      <PinBoxes
        ref={pinRef}
        value={pin}
        invalid={notice?.tone === 'danger'}
        describedBy={notice ? noticeId : undefined}
        onChange={v => {
          setPin(v)
          if (notice) setNotice(null)
          if (v.length === PIN_LENGTH && v !== pin) void submit(v)
        }}
      />
      {alert}
    </Screen>
  )
}

/** 겉틀 — 위(제목·설명) · 가운데(칸·안내, 길면 스크롤) · 맨 아래 고정 단추. 늘 main 영역 하나 · form 이면 그 안에서 Enter 로 보낸다 */
function Screen({ head, children, foot, form }: { head: ReactNode; children?: ReactNode; foot: ReactNode; form?: (e: FormEvent) => void }) {
  const body = (
    <>
      <div className="pr-body">
        <div className="pr-head">{head}</div>
        {children && <div className="pr-mid">{children}</div>}
      </div>
      <div className="pr-foot">{foot}</div>
    </>
  )
  return (
    <main className="pr">
      {form ? (
        <form className="pr-form" onSubmit={form} noValidate>
          {body}
        </form>
      ) : body}
    </main>
  )
}

/** 할 일 단추 — 기다리는 동안 글이 바뀌고 도는 표시가 붙는다(흐려지지 않는다: '아직 못 누름'과 헷갈리지 않게). 읽어 주는 프로그램엔 status 로 */
function BusyButton({ busy, label, busyLabel, icon: Icon, onClick, submit, disabled }: {
  busy: boolean
  label: string
  busyLabel: string
  icon?: LucideIcon
  onClick?: () => void
  submit?: boolean
  disabled?: boolean
}) {
  return (
    <>
      <button type={submit ? 'submit' : 'button'} className="pr-btn pr-pri" onClick={onClick} disabled={busy || disabled} aria-busy={busy}>
        {busy ? <LoaderCircle className="pr-spin" size={18} aria-hidden /> : Icon && <Icon size={18} aria-hidden />}
        {busy ? busyLabel : label}
      </button>
      <span className="pr-sr" role="status">{busy ? busyLabel : ''}</span>
    </>
  )
}

/** 글 안의 단추 그림(공유·더 보기) — 읽어 주는 프로그램엔 label 로 */
function Glyph({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="pr-glyph" role="img" aria-label={`${label} 단추`}>
      <Icon size={16} strokeWidth={2} aria-hidden />
    </span>
  )
}

function Steps({ items }: { items: ReactNode[] }) {
  // list-style 을 지우면 사파리(VoiceOver)가 목록으로 읽지 않는다 — role 로 되살린다
  return (
    <ol className="pr-steps" role="list">
      {items.map((it, i) => (
        <li key={i}>
          <span className="pr-n" aria-hidden>{i + 1}</span>
          <span>{it}</span>
        </li>
      ))}
    </ol>
  )
}

/** errorId — 오류 줄이 떠 있으면 그 id(읽어 주는 프로그램이 칸과 함께 읽는다) */
function NameField({ value, onChange, errorId }: { value: string; onChange: (v: string) => void; errorId?: string }) {
  const id = useId()
  return (
    <div className="pr-field">
      <label htmlFor={id}>휴대폰 이름</label>
      <input
        id={id}
        className="pr-input"
        type="text"
        value={value}
        maxLength={PHONE_NAME_MAX}
        autoComplete="off"
        enterKeyHint="go"
        onChange={e => onChange(e.target.value)}
        aria-describedby={errorId ? `${id}-n ${errorId}` : `${id}-n`}
      />
      <p className="pr-note" id={`${id}-n`}>PC 의 짝 맺은 휴대폰 목록에 이 이름으로 보여요</p>
    </div>
  )
}

/** 6칸(PC 처럼 3 + 3) — 입력은 한 칸(숫자 자판 · 자동 채우기), 칸 그림은 그 값을 나눠 보인다 */
function PinBoxes({ value, onChange, invalid, describedBy, ref }: {
  value: string
  onChange: (v: string) => void
  invalid: boolean
  describedBy?: string
  ref: Ref<HTMLInputElement>
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div className={`pr-pin${focused ? ' focus' : ''}${invalid ? ' bad' : ''}`}>
      <input
        ref={ref}
        className="pr-pin-in"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        enterKeyHint="go"
        aria-label="숫자 6자리"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        value={value}
        onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <span key={i} className={`pr-box${focused && i === Math.min(value.length, PIN_LENGTH - 1) ? ' on' : ''}`} aria-hidden>
          {value[i] ?? ''}
        </span>
      ))}
    </div>
  )
}

/** 삼성 팝업 설정 — 접은 줄(사용자 말 그대로). 삼성은 웹 앱 알림을 처음엔 팝업으로 띄우지 않는다(실측) */
function SamsungFold({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className="pr-fold-wrap">
      <button type="button" className="pr-fold" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
        <Info className="pr-fold-i" size={18} aria-hidden />
        <span className="pr-fold-t">삼성 팝업 설정</span>
        <ChevronDown className="pr-fold-c" size={18} aria-hidden />
      </button>
      {open && (
        <div className="pr-fold-body" id={id}>
          <p className="pr-fold-lead">알림을 켠 뒤, 알림이 화면 위에 바로 뜨게 하려면</p>
          <ol className="pr-fold-steps">
            <li>휴대폰 <b>설정 → 알림 → 고급 설정</b></li>
            <li><b>앱별 알림 카테고리 관리</b> 켜기</li>
            <li><b>두레</b> → 알림 카테고리 → <b>팝업으로 표시</b> 켜기</li>
          </ol>
        </div>
      )}
    </div>
  )
}

/** 앱 안 브라우저(카카오톡 등) — 알림도 짝(쿠키)도 그 앱 안에만 남는다. 크롬·사파리로 열게 한다 */
function InApp({ env, link, copy, title }: { env: PairEnv; link: string; copy: (t: string) => Promise<boolean>; title: (t: ReactNode) => ReactNode }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const onCopy = async () => {
    const ok = await copy(link)
    setCopied(ok ? 'done' : 'failed')
    if (timer.current) clearTimeout(timer.current)
    if (ok) timer.current = setTimeout(() => setCopied('idle'), 3000)
  }
  return (
    <Screen
      head={<>
        {title(env.ios ? '사파리로 열어 주세요' : '크롬으로 열어 주세요')}
        <p className="pr-hint">{env.inApp?.name ?? '이 앱'} 안에서는 알림을 받을 수 없어요.</p>
      </>}
      foot={<>
        <button type="button" className="pr-btn pr-sec" onClick={onCopy}>
          {copied === 'done' ? <Check size={18} aria-hidden /> : <Copy size={18} aria-hidden />}
          {copied === 'done' ? '복사했어요' : '주소 복사'}
        </button>
        {/* 누른 단추의 글이 바뀌어도 VoiceOver 는 다시 읽지 않는다 */}
        <span className="pr-sr" role="status">{copied === 'done' ? '주소를 복사했어요' : ''}</span>
      </>}
    >
      <Steps items={env.ios
        ? [<><Glyph icon={Ellipsis} label="더 보기" /> 메뉴 또는 <Glyph icon={Share} label="공유" /> 공유 단추를 눌러 'Safari로 열기'를 골라요</>, <>안 되면 아래 [주소 복사]를 눌러 사파리에 붙여 넣어요</>]
        : [<><Glyph icon={EllipsisVertical} label="더 보기" /> 또는 <Glyph icon={Ellipsis} label="더 보기" /> 메뉴를 눌러 '다른 브라우저로 열기'를 골라요</>, <>안 되면 아래 [주소 복사]를 눌러 크롬에 붙여 넣어요</>]}
      />
      {copied === 'failed' && (
        <div className="pr-field">
          <p className="pr-note" id="pr-addr-n">복사하지 못했어요 — 아래 주소를 길게 눌러 복사해 주세요</p>
          <input
            className="pr-input pr-addr"
            type="text"
            readOnly
            value={link}
            aria-label="두레 주소"
            aria-describedby="pr-addr-n"
            onFocus={e => e.currentTarget.select()}
          />
        </div>
      )}
    </Screen>
  )
}
