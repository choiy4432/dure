import { useId, useRef, useState } from 'react'
import { getStore, useDure } from '../state/store'
import { errorMessage } from '../lib/words'
import { FormDialog } from './FormDialog'

/** 자동 전달 상한으로 적을 수 있는 수 */
const LIMIT_MIN = 1
const LIMIT_MAX = 20

/** 적은 글이 1~20 의 정수면 그 수, 아니면 null */
function parseLimit(text: string): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n >= LIMIT_MIN && n <= LIMIT_MAX ? n : null
}

/** 설정(위 띠 톱니) — 지금은 자동 전달 상한 하나 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const limit = useDure(s => s.autoChainLimit)
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
      await window.dure.setAutoChainLimit(n)
      await getStore().refresh()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
      input.current?.focus()
    }
  }

  const described = [`${id}-d`, outOfRange && `${id}-r`, error && `${id}-e`].filter(Boolean).join(' ')

  return (
    <FormDialog
      title="설정"
      submitLabel="저장"
      canSubmit={n !== null && n !== limit}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
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
    </FormDialog>
  )
}
