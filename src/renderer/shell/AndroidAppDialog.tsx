import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import { useDialogFocus } from '../lib/dialog'
import { MOTION } from '../lib/motion'
import { Presence, useMotion } from '../lib/presence'

/** 안드로이드 앱 받기 창 글 — 해요체 */
export const ANDROID = {
  title: '안드로이드 앱 받기',
  section: '안드로이드 앱',
  appName: '두레 앱',
  version: (name: string) => `v${name}`,
  rowDesc: '알림에 주소가 안 붙어요',
  get: '앱 받기',
  qr: '두레 앱 받기 QR',
  steps: [
    '휴대폰 카메라로 QR 을 찍어 앱을 받아요',
    "설치할 때 '출처를 알 수 없는 앱'을 허용하고, Play 프로텍트 경고가 뜨면 [그래도 설치]를 눌러요",
    '크롬의 두레 화면에서 [두레 앱으로 열기]를 눌러요',
  ],
  close: '닫기',
} as const

/** 앱 파일 주소 — 휴대폰 서버 주소와 같은 출처의 /dure.apk (주소를 못 읽으면 null) */
export function apkUrl(phoneUrl: string): string | null {
  try {
    return `${new URL(phoneUrl).origin}/dure.apk`
  } catch {
    return null
  }
}

/** 앱 받기 창 — 설정 창(휴대폰 탭) 위에 뜬다. 열린 동안 휴대폰 주소가 닫히면 부르는 쪽이 open 을 내린다 */
export function AndroidAppDialog({ open, url, onClose }: { open: boolean; url: string | null; onClose: () => void }) {
  return <Presence show={open}>{createPortal(<Frame url={url} onClose={onClose} />, document.body)}</Presence>
}

function Frame({ url, onClose }: { url: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useMotion(backdrop, MOTION.backdrop)
  useMotion(ref, MOTION.dialog)
  useDialogFocus(ref, onClose, box => box.querySelector<HTMLElement>('[data-first]'))

  const [qr, setQr] = useState<string | null>(null)
  const target = url === null ? null : apkUrl(url)
  useEffect(() => {
    if (target === null) return
    let stale = false
    // SVG 로 — 캔버스 없이 그려지고 어떤 크기에서도 선명하다. 흰 바탕을 넣어 어두운 테마에서도 읽힌다
    QRCode.toString(target, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
      .then(svg => {
        if (!stale) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [target])

  const onBackdrop = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div ref={backdrop} className="dlg-bd" onPointerDown={onBackdrop}>
      <div ref={ref} className="dlg phn-pair-dlg" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId} className="dlg-t">
          {ANDROID.title}
        </h2>
        <div className="phn-qrbox">
          {qr ? <img className="phn-qr" src={qr} alt={ANDROID.qr} width={156} height={156} /> : <div className="phn-qr wait" aria-hidden="true" />}
          <ol className="phn-apk-steps">
            {ANDROID.steps.map(t => (
              <li key={t}>{t}</li>
            ))}
          </ol>
        </div>
        <div className="dlg-ab">
          <button type="button" className="btn pri" data-first onClick={onClose}>
            {ANDROID.close}
          </button>
        </div>
      </div>
    </div>
  )
}
