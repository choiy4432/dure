import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { getStore } from '../../state/store'
import { errorMessage } from '../../lib/words'

/** 설정 탭 안의 묶음 — 작은 이름 줄 + 둥근 상자(줄들은 옅은 선으로 나뉜다) */
export function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="sx">
      <h3 className="sx-t">
        {title}
        {note && <span className="sx-note"> · {note}</span>}
      </h3>
      <div className="sx-box">{children}</div>
    </section>
  )
}

/**
 * 묶음 안의 한 줄 — 이름(+필요할 때만 짧은 설명)이 왼쪽, 조절은 오른쪽(children).
 * stacked 면 이름 아래 한 줄로 넓게(고르기). 오류는 그 줄 아래.
 * nameId 는 고르기 칸이 이름으로 이름을 붙일 때(aria-labelledby), labelFor 는 입력칸이 이름 글을 라벨로 쓸 때.
 */
export function Row({
  name,
  desc,
  children,
  stacked,
  error,
  nameId,
  labelFor,
}: {
  name: string
  desc?: ReactNode
  /** 함수로 주면 설명·오류 글을 가리키는 id 줄(describedBy)을 받아 조절에 aria-describedby 로 건다 */
  children?: ReactNode | ((p: { describedBy: string | undefined }) => ReactNode)
  stacked?: boolean
  error?: string | null
  nameId?: string
  labelFor?: string
}) {
  const uid = useId()
  const descId = desc ? `${uid}-d` : undefined
  const errId = error ? `${uid}-e` : undefined
  const describedBy = [descId, errId].filter(Boolean).join(' ') || undefined
  const label = labelFor ? (
    <label className="sx-n" id={nameId} htmlFor={labelFor}>
      {name}
    </label>
  ) : (
    <span className="sx-n" id={nameId}>
      {name}
    </span>
  )
  return (
    <div className="sx-rw" data-row>
      <div className={stacked ? 'sx-r col' : 'sx-r'}>
        <div className="sx-l">
          {label}
          {desc && (
            <span className="sx-s" id={descId}>
              {desc}
            </span>
          )}
        </div>
        {children && <div className="sx-c">{typeof children === 'function' ? children({ describedBy }) : children}</div>}
      </div>
      {error && (
        <p className="fe sx-e" id={errId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * 켜고 끄는 줄 — 줄 전체가 스위치다. 이름은 보이는 글(name) 그대로, 설명은 설명으로.
 * 보내는 중(busy)엔 흐리게, 잠기면(disabled) 눌러도 아무 일 없다. 켜짐 여부는 늘 저장된 값(checked)을 그린다.
 */
export function SwitchRow({
  name,
  desc,
  checked,
  busy,
  disabled,
  onToggle,
  error,
}: {
  name: string
  desc?: string
  checked: boolean
  busy?: boolean
  disabled?: boolean
  onToggle: () => void
  error?: string | null
}) {
  const id = useId()
  const describedBy = [desc ? `${id}-d` : null, error ? `${id}-e` : null].filter(Boolean).join(' ') || undefined
  return (
    <div className="sx-rw" data-row>
      <button
        type="button"
        className="sw sx-r sx-sw"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-n`}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled || busy) return
          onToggle()
        }}
      >
        <span className="sx-l">
          <span className="sx-n" id={`${id}-n`}>
            {name}
          </span>
          {desc && (
            <span className="sx-s" id={`${id}-d`}>
              {desc}
            </span>
          )}
        </span>
        <span className="tg" aria-hidden="true" />
      </button>
      {error && (
        <p className="fe sx-e" id={`${id}-e`} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * 누르는 즉시 적용 — 칸마다 key 를 두고, 보내는 중엔 같은 key 를 다시 보내지 않는다.
 * 실패하면 errorMessage(e) 를 그 key 에 남기고(화면 값은 저장된 값 그대로), 끝나면 상태를 다시 읽는다.
 */
export function useApply() {
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const inflight = useRef(new Set<string>())

  const run = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    if (inflight.current.has(key)) return
    inflight.current.add(key)
    setBusyKeys(new Set(inflight.current))
    setErrors(e => {
      if (!(key in e)) return e
      const { [key]: _gone, ...rest } = e
      return rest
    })
    try {
      await fn()
      await getStore().refresh()
    } catch (e) {
      setErrors(prev => ({ ...prev, [key]: errorMessage(e) }))
    } finally {
      inflight.current.delete(key)
      setBusyKeys(new Set(inflight.current))
    }
  }, [])

  return {
    busy: (key: string) => busyKeys.has(key),
    error: (key: string): string | null => errors[key] ?? null,
    run,
  }
}
