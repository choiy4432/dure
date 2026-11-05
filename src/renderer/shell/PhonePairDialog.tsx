import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { CircleCheck } from 'lucide-react'
import { PAIR_TTL_MS, type PhonePairOffer } from '../../shared/phoneTypes'
import { useDure } from '../state/store'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { Presence, useLeaving, useMotion } from '../lib/presence'
import { useNow } from '../lib/useNow'
import { errorMessage } from '../lib/words'

/** 짝 맺기 창 글 — 해요체 */
export const PAIR = {
  title: '휴대폰 짝 맺기',
  // 숫자는 QR 오른쪽에 있다(시안 글의 '아래'를 자리에 맞춤)
  desc: 'QR 을 휴대폰 카메라로 찍어 주세요. 홈 화면 앱(아이폰)에서는 오른쪽 숫자를 넣어요.',
  /** 휴대폰 쪽 준비 — 휴대폰도 같은 tailnet 에 있어야 주소가 열린다 */
  phoneSide: '휴대폰에서도 Tailscale 이 켜져 있어야 주소가 열려요',
  qr: '짝 맺기 QR',
  pin: '짝 맺기 숫자',
  left: (mss: string) => `${mss} 남음 · 한 번만 쓸 수 있어요`,
  preparing: '짝 맺기를 준비하는 중…',
  paired: '짝을 맺었어요',
  pairedBody: (name: string) => `이제 ‘${name}’ 에서 두레를 열 수 있어요`,
  closed: '짝 맺기가 닫혔어요 — 다시 해 주세요',
  closedBody: '시간이 지났거나 숫자가 여러 번 틀렸어요. 휴대폰에서 주소가 안 열렸다면 휴대폰의 Tailscale 을 먼저 켜 주세요',
  /** 휴대폰 연결이 꺼졌거나(트레이 등) 주소가 닫혔다 — 켜기 전엔 다시 맺을 수 없다 */
  off: '휴대폰 연결이 꺼져서 짝 맺기를 닫았어요',
  again: '다시 짝 맺기',
  cancel: '취소',
  close: '닫기',
} as const

/** 6자리 숫자를 세 자리씩 — '482 017' */
export const pinText = (pin: string) => (pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin)

/** 남은 시간 M:SS — 올림(막 받으면 5:00). 시각을 짝 맺기를 열 때 쟀으면 5분을 넘을 수 있어 5:00 에서 자른다 */
export function leftText(expiresAt: number, now: number): string {
  const s = Math.min(PAIR_TTL_MS / 1000, Math.max(0, Math.ceil((expiresAt - now) / 1000)))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 짝 맺기 창 — 열리면 phonePairStart 로 QR·6자리 숫자를 받고 남은 시간을 센다. [취소]·Esc·바깥 = phonePairCancel.
 * main 의 짝(state.pairing)이 사라지면(썼음·만료·틀림 상한) 결과로 바뀐다 — 새 기기가 생겼으면 '짝을 맺었어요', 아니면 '다시 짝 맺기'.
 * 사건이 늦어도 남은 시간이 다 되면 닫힌 것으로 본다. 휴대폰 연결이 꺼지면(주소가 닫힘) '꺼져서 닫았어요' — 다시 맺기는 켠 뒤에.
 * 닫는 중(나가는 움직임)엔 결과로 바꾸지 않는다 — 취소가 부른 pairing: null 이나 늦게 온 시작 답이 나가는 창을 바꾸지 않게.
 */
export function PhonePairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Presence show={open}>{createPortal(<Frame onClose={onClose} />, document.body)}</Presence>
}

type View =
  | { kind: 'loading' }
  | { kind: 'live'; offer: PhonePairOffer }
  | { kind: 'paired'; name: string }
  | { kind: 'closed' }
  | { kind: 'off' }
  | { kind: 'error'; message: string }

function Frame({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()
  useMotion(backdrop, MOTION.backdrop)
  useMotion(ref, MOTION.dialog)

  const pairing = useDure(s => s.app.phone?.pairing ?? null)
  const devices = useDure(s => s.app.phone?.devices ?? [])
  /** 휴대폰 연결이 꺼졌거나 주소가 닫혔다 — main 이 짝도 닫았다 */
  const off = useDure(s => !s.app.phone?.settings.enabled || s.app.phone.url === null)
  const leaving = useLeaving()
  const now = useNow(1000)
  const [view, setView] = useState<View>({ kind: 'loading' })

  /** 짝 맺기를 연 때의 기기 — 새로 생긴 기기를 알아보려고 */
  const known = useRef(new Set<string>())
  /** 이번 짝을 main 의 상태에서 본 적이 있다 — 답이 사건보다 먼저 와도 '닫힘'으로 잘못 보지 않게 */
  const seen = useRef(false)
  /** 이번 짝이 아직 살아 있을 수 있다 — 닫을 때 취소해야 한다 */
  const live = useRef(false)
  const alive = useRef(true)
  const run = useRef(0)

  const start = async () => {
    const my = ++run.current
    known.current = new Set(devices.map(d => d.id))
    seen.current = false
    live.current = true
    setView({ kind: 'loading' })
    // 답을 기다리는 사이 취소(나가는 중)·꺼짐으로 끝났으면(live 가 내려감) 늦은 답은 버린다 — QR 이 다시 뜨지 않게
    const current = () => alive.current && my === run.current && live.current
    try {
      const offer = await window.dure.phonePairStart()
      if (current()) setView({ kind: 'live', offer })
    } catch (e) {
      if (!current()) return
      live.current = false
      setView({ kind: 'error', message: errorMessage(e) })
    }
  }

  useEffect(() => {
    alive.current = true
    void start()
    return () => {
      alive.current = false
      // 짝이 살아 있는 채 사라진다(위 창이 닫힘 등) — 남기지 않는다
      if (live.current) void window.dure.phonePairCancel().catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 나가다가 다시 열렸다(Presence 가 같은 창을 그 자리로 돌려준다) — 취소한 짝 대신 새 짝 맺기로
  const wasLeaving = useRef(false)
  useEffect(() => {
    if (leaving) {
      wasLeaving.current = true
      return
    }
    if (!wasLeaving.current) return
    wasLeaving.current = false
    void start()
  }, [leaving]) // eslint-disable-line react-hooks/exhaustive-deps

  // 짝이 끝났나 — 새 기기가 생겼거나, 본 적 있는 짝이 사라졌거나 바뀌었거나, 남은 시간이 다 됐다. 휴대폰 연결이 꺼지면 맺은 것 말고는 모두 '꺼져서 닫음'.
  // 닫는 중엔 보지 않는다(취소한 뒤 오는 pairing: null 로 '닫혔어요' 가 비쳐 창 높이가 튀지 않게)
  useEffect(() => {
    if (leaving) return
    if (off) {
      if (view.kind === 'paired' || view.kind === 'off') return
      live.current = false
      setView({ kind: 'off' })
      return
    }
    if (view.kind !== 'live' || !live.current) return
    const pin = view.offer.pin
    if (pairing?.pin === pin) seen.current = true
    const fresh = devices.find(d => !known.current.has(d.id))
    const gone = (seen.current && pairing?.pin !== pin) || now >= view.offer.expiresAt
    if (!fresh && !gone) return
    live.current = false
    setView(fresh ? { kind: 'paired', name: fresh.name } : { kind: 'closed' })
  }, [view, pairing, devices, now, off, leaving])

  /** 취소 · Esc · 바깥 — 살아 있는 짝이면 main 에도 닫게 한다 */
  const cancel = () => {
    if (live.current) {
      live.current = false
      void window.dure.phonePairCancel().catch(() => {})
    }
    onClose()
  }
  useDialogFocus(ref, cancel, box => box.querySelector<HTMLElement>('[data-first]'))

  const onBackdrop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) cancel()
  }

  const ended = view.kind === 'paired' || view.kind === 'closed' || view.kind === 'off' || view.kind === 'error'
  // 결과로 바뀌면 [취소] 가 사라진다 — 초점이 body 로 떨어지지 않게 결과의 첫 단추로
  useEffect(() => {
    if (ended) ref.current?.querySelector<HTMLElement>('[data-first]')?.focus()
  }, [ended, view.kind])

  return (
    <div ref={backdrop} className="dlg-bd" onPointerDown={onBackdrop}>
      <div
        ref={ref}
        className="dlg phn-pair-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ended ? undefined : descId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="dlg-t">
          {PAIR.title}
        </h2>
        {/* QR 안내는 짝이 살아 있는 동안만 — 끝나면 결과 글이 그 자리 */}
        {!ended && (
          <p className="dlg-d" id={descId}>
            {PAIR.desc}
          </p>
        )}

        {(view.kind === 'loading' || view.kind === 'live') && (
          <div className="phn-qrbox">
            {view.kind === 'live' ? (
              <img className="phn-qr" src={view.offer.qr} alt={PAIR.qr} width={156} height={156} />
            ) : (
              <div className="phn-qr wait" aria-hidden="true" />
            )}
            <div>
              {view.kind === 'live' ? (
                <>
                  <div className="phn-pin-l">{PAIR.pin}</div>
                  <div className="phn-pin">{pinText(view.offer.pin)}</div>
                  <div className="phn-left">{PAIR.left(leftText(view.offer.expiresAt, now))}</div>
                </>
              ) : (
                <div className="phn-left">{PAIR.preparing}</div>
              )}
            </div>
          </div>
        )}
        {view.kind === 'live' && <p className="phn-side">{PAIR.phoneSide}</p>}

        {/* 결과 자리 — 처음부터 빈 채로 붙어 있는 알림 자리(status)에 결과가 들어온다(새로 붙는 status 는 읽히지 않을 수 있다). 실패는 role=alert 가 따로 */}
        <div className="phn-say" role="status">
          {view.kind === 'paired' && (
            <div className="phn-result ok">
              <CircleCheck className="i" size={18} aria-hidden="true" />
              <div>
                <p className="phn-result-t">{PAIR.paired}</p>
                <p className="phn-result-d">{PAIR.pairedBody(view.name)}</p>
              </div>
            </div>
          )}
          {view.kind === 'closed' && (
            <div className="phn-result">
              <div>
                <p className="phn-result-t">{PAIR.closed}</p>
                <p className="phn-result-d">{PAIR.closedBody}</p>
              </div>
            </div>
          )}
          {view.kind === 'off' && (
            <div className="phn-result">
              <p className="phn-result-t">{PAIR.off}</p>
            </div>
          )}
        </div>
        {view.kind === 'error' && (
          <p className="dlg-err" role="alert">
            {view.message}
          </p>
        )}

        <div className="dlg-ab">
          {ended ? (
            <>
              {/* 다시 맺을 수 없으면(맺었음 · 꺼짐) [닫기] 하나가 주 단추 */}
              <button
                type="button"
                className={`btn ${view.kind === 'paired' || view.kind === 'off' ? 'pri' : 'sec'}`}
                data-first={view.kind === 'paired' || view.kind === 'off' || undefined}
                onClick={onClose}
              >
                {PAIR.close}
              </button>
              {view.kind !== 'paired' && view.kind !== 'off' && (
                <button type="button" className="btn pri" data-first onClick={() => void start()}>
                  {PAIR.again}
                </button>
              )}
            </>
          ) : (
            <button type="button" className="btn sec" data-first onClick={cancel}>
              {PAIR.cancel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
