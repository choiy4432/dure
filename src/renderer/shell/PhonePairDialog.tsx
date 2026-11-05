import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { CircleCheck } from 'lucide-react'
import { PAIR_TTL_MS, type PhonePairOffer } from '../../shared/phoneTypes'
import { useDure } from '../state/store'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { Presence, useMotion } from '../lib/presence'
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
 * main 의 짝(state.pairing)이 사라지면(썼음·만료·틀림 상한·연결 끔) 결과로 바뀐다 — 새 기기가 생겼으면 '짝을 맺었어요', 아니면 '다시 짝 맺기'.
 * 사건이 늦어도 남은 시간이 다 되면 닫힌 것으로 본다.
 */
export function PhonePairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Presence show={open}>{createPortal(<Frame onClose={onClose} />, document.body)}</Presence>
}

type View =
  | { kind: 'loading' }
  | { kind: 'live'; offer: PhonePairOffer }
  | { kind: 'paired'; name: string }
  | { kind: 'closed' }
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
    try {
      const offer = await window.dure.phonePairStart()
      if (alive.current && my === run.current) setView({ kind: 'live', offer })
    } catch (e) {
      live.current = false
      if (alive.current && my === run.current) setView({ kind: 'error', message: errorMessage(e) })
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

  // 짝이 끝났나 — 새 기기가 생겼거나, 본 적 있는 짝이 사라졌거나 바뀌었거나, 남은 시간이 다 됐다
  useEffect(() => {
    if (view.kind !== 'live') return
    const pin = view.offer.pin
    if (pairing?.pin === pin) seen.current = true
    const fresh = devices.find(d => !known.current.has(d.id))
    const gone = (seen.current && pairing?.pin !== pin) || now >= view.offer.expiresAt
    if (!fresh && !gone) return
    live.current = false
    setView(fresh ? { kind: 'paired', name: fresh.name } : { kind: 'closed' })
  }, [view, pairing, devices, now])

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

  const ended = view.kind === 'paired' || view.kind === 'closed' || view.kind === 'error'
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
                <div className="phn-left" role="status">
                  {PAIR.preparing}
                </div>
              )}
            </div>
          </div>
        )}
        {view.kind === 'live' && <p className="phn-side">{PAIR.phoneSide}</p>}

        {view.kind === 'paired' && (
          <div className="phn-result ok" role="status">
            <CircleCheck className="i" size={18} aria-hidden="true" />
            <div>
              <p className="phn-result-t">{PAIR.paired}</p>
              <p className="phn-result-d">{PAIR.pairedBody(view.name)}</p>
            </div>
          </div>
        )}
        {view.kind === 'closed' && (
          <div className="phn-result" role="status">
            <div>
              <p className="phn-result-t">{PAIR.closed}</p>
              <p className="phn-result-d">{PAIR.closedBody}</p>
            </div>
          </div>
        )}
        {view.kind === 'error' && (
          <p className="dlg-err" role="alert">
            {view.message}
          </p>
        )}

        <div className="dlg-ab">
          {ended ? (
            <>
              <button type="button" className={`btn ${view.kind === 'paired' ? 'pri' : 'sec'}`} data-first={view.kind === 'paired' || undefined} onClick={onClose}>
                {PAIR.close}
              </button>
              {view.kind !== 'paired' && (
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
