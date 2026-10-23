import { useId, useRef, useState } from 'react'
import type { ThemePref } from '../../engine/types'
import { getStore, useDure } from '../state/store'
import { errorMessage } from '../lib/words'
import { FormDialog } from './FormDialog'

/** 자동 전달 상한으로 적을 수 있는 수 */
const LIMIT_MIN = 1
const LIMIT_MAX = 20

/** 화면 테마 칸 — 누르는 차례대로 */
const THEMES: { key: ThemePref; label: string }[] = [
  { key: 'light', label: '라이트' },
  { key: 'dark', label: '다크' },
  { key: 'system', label: 'Windows 따라감' },
]

/** 적은 글이 1~20 의 정수면 그 수, 아니면 null */
function parseLimit(text: string): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n >= LIMIT_MIN && n <= LIMIT_MAX ? n : null
}

/**
 * 설정(위 띠 톱니) — 화면 테마 · 자동 전달 상한 · 묻지 않고 실행 허용 · 알림.
 * 화면 테마는 누르는 즉시 바꿔 뒤 화면으로 비교하게 한다 — 저장 없이 닫으면(취소·Esc·바깥) 열 때의 테마로 되돌린다.
 * 허용을 켜고 저장하면 설정 창을 닫은 뒤 onAskAllow 로 확인 창을 부른다(두 창을 겹쳐 띄우지 않는다).
 */
export function SettingsDialog({ onClose, onAskAllow }: { onClose: () => void; onAskAllow: () => void }) {
  const limit = useDure(s => s.autoChainLimit)
  const allowed = useDure(s => s.allowBypass)
  const notified = useDure(s => s.notify)
  const savedTheme = useDure(s => s.theme ?? 'system')
  /** 열 때의 테마 — 저장 없이 닫으면 여기로 */
  const startTheme = useRef(savedTheme)
  const [theme, setTheme] = useState(savedTheme)
  const [themeError, setThemeError] = useState<string | null>(null)
  const [allow, setAllow] = useState(allowed)
  const [asks, setAsks] = useState(notified.asks)
  const [finished, setFinished] = useState(notified.finished)
  const [value, setValue] = useState(() => String(limit))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()

  const n = parseLimit(value)
  const outOfRange = n === null && value.trim() !== ''

  const submit = async () => {
    if (n === null) return
    setBusy(true)
    setError(null)
    try {
      if (n !== limit) await window.dure.setAutoChainLimit(n)
      if (!allow && allowed) await window.dure.setAllowBypass(false) // 끄기는 바로
      // 바뀐 칸만 — 안 바뀐 칸을 다시 쓰면 그사이 다른 곳에서 바뀐 값을 덮는다
      const np: { asks?: boolean; finished?: boolean } = {}
      if (asks !== notified.asks) np.asks = asks
      if (finished !== notified.finished) np.finished = finished
      if (Object.keys(np).length > 0) await window.dure.setNotify(np)
      await getStore().refresh()
      onClose()
      if (allow && !allowed) onAskAllow() // 켜기는 확인 창을 거쳐서
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
      input.current?.focus()
    }
  }

  const pickTheme = async (t: ThemePref) => {
    if (t === theme) return
    setThemeError(null)
    try {
      await window.dure.setTheme(t)
      setTheme(t)
      await getStore().refresh()
    } catch (e) {
      setThemeError(errorMessage(e))
    }
  }

  /** 저장 없이 닫기 — 바꿔 본 테마는 되돌린다 */
  const cancel = () => {
    const back = startTheme.current
    if (theme !== back) {
      void window.dure.setTheme(back).then(
        () => getStore().refresh(),
        () => {}, // 못 되돌려도 닫기는 막지 않는다 — 다음에 열면 실제 값이 보인다
      )
    }
    onClose()
  }

  const described = [`${id}-d`, outOfRange && `${id}-r`, error && `${id}-e`].filter(Boolean).join(' ')

  return (
    <FormDialog
      title="설정"
      submitLabel="저장"
      canSubmit={
        n !== null && (n !== limit || allow !== allowed || asks !== notified.asks || finished !== notified.finished || theme !== startTheme.current)
      }
      busy={busy}
      onSubmit={() => void submit()}
      onClose={cancel}
    >
      <div className="fld">
        <span className="fld-l" id={`${id}-t`}>
          화면 테마
        </span>
        <div className="seg" role="radiogroup" aria-labelledby={`${id}-t`} aria-describedby={`${id}-td`}>
          {THEMES.map(t => (
            <button key={t.key} type="button" role="radio" aria-checked={theme === t.key} onClick={() => void pickTheme(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <p className="fld-d" id={`${id}-td`}>
          Windows 따라감은 Windows 가 어둡게 바뀌면 두레도 같이 바뀌어요
        </p>
        {themeError && <p className="fe">{themeError}</p>}
      </div>
      <div className="fld">
        <label className="fld-l" htmlFor={`${id}-n`}>
          자동 전달 상한
        </label>
        <p className="fld-d" id={`${id}-d`}>
          자동 켠 에이전트끼리 사람 확인 없이 이어서 주고받을 수 있는 횟수
        </p>
        <div className="fld-num">
          <input
            ref={input}
            id={`${id}-n`}
            className="inp"
            type="number"
            inputMode="numeric"
            min={LIMIT_MIN}
            max={LIMIT_MAX}
            step={1}
            value={value}
            onChange={e => {
              setValue(e.target.value)
              setError(null)
            }}
            aria-invalid={outOfRange || error ? true : undefined}
            aria-describedby={described}
          />
          <span className="fld-u">번</span>
        </div>
        {outOfRange && (
          <p className="fe" id={`${id}-r`}>
            {`${LIMIT_MIN}부터 ${LIMIT_MAX}까지 적을 수 있어요`}
          </p>
        )}
        {error && (
          <p className="fe" id={`${id}-e`}>
            {error}
          </p>
        )}
      </div>
      <div className="fld">
        <button
          type="button"
          className="sw"
          role="switch"
          aria-checked={allow}
          aria-describedby={`${id}-b`}
          onClick={() => setAllow(a => !a)}
        >
          <span>
            묻지 않고 실행 허용 <span className="sw-en">Bypass Permissions</span>
          </span>
          <span className="tg" aria-hidden="true" />
        </button>
        <p className="fld-d" id={`${id}-b`}>
          켜면 에이전트마다 승인 없이 실행하게 할 수 있어요
        </p>
      </div>
      <div className="fld">
        <button
          type="button"
          className="sw"
          role="switch"
          aria-checked={asks}
          aria-describedby={`${id}-na`}
          onClick={() => setAsks(a => !a)}
        >
          <span>Windows 알림</span>
          <span className="tg" aria-hidden="true" />
        </button>
        <p className="fld-d" id={`${id}-na`}>
          창이 가려져 있을 때 승인·질문을 알려 줘요
        </p>
      </div>
      <div className="fld">
        {/* Windows 알림이 꺼지면 이 알림도 못 보내니 잠근다 — 값은 그대로 둬서 다시 켜면 이어진다 */}
        <button
          type="button"
          className="sw"
          role="switch"
          aria-checked={finished}
          aria-disabled={asks ? undefined : true}
          aria-describedby={`${id}-nf`}
          onClick={() => {
            if (asks) setFinished(f => !f)
          }}
        >
          <span>일이 끝나도 알림</span>
          <span className="tg" aria-hidden="true" />
        </button>
        <p className="fld-d" id={`${id}-nf`}>
          창이 가려져 있을 때 일을 끝내면 알려 줘요
        </p>
      </div>
    </FormDialog>
  )
}
