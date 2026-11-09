import { useEffect, useId, useState } from 'react'
import { getStore, useDure } from '../../state/store'
import { ConfirmDialog } from '../ConfirmDialog'
import { Row, Section, SwitchRow, useApply } from './parts'

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

/**
 * 에이전트 — 자동 전달 상한 · 묻지 않고 실행 허용.
 * 상한은 칸을 벗어나거나 Enter 일 때 바뀐다(1~20 밖·빈칸은 까닭만 보이고 안 보낸다 — 이 판을 떠나면 칸은 저장된 값).
 * 묻지 않고 실행은 켜기만 확인 창을 거친다 — 설정 창 위에 겹쳐 뜨는 동안 onCoveredChange(true).
 */
export function AgentsPane({ onCoveredChange }: { onCoveredChange: (covered: boolean) => void }) {
  const limit = useDure(s => s.autoChainLimit)
  const allowed = useDure(s => s.allowBypass)
  const apply = useApply()
  const id = useId()
  const [value, setValue] = useState(() => String(limit))
  const [ask, setAsk] = useState(false)

  useEffect(() => {
    onCoveredChange(ask)
    return () => onCoveredChange(false)
  }, [ask, onCoveredChange])

  const n = parseLimit(value)
  const invalid = n === null

  const commit = async () => {
    if (n === null || n === limit) return
    await apply.run('limit', () => window.dure.setAutoChainLimit(n))
    // 못 바꿨으면 칸도 저장된 값으로
    setValue(String(getStore().getState().autoChainLimit))
  }

  return (
    <>
      <Section title="맡기는 정도">
        <Row
          name="자동 전달 상한"
          desc="사람 확인 없이 이어서 주고받는 횟수"
          labelFor={`${id}-n`}
          error={invalid ? `${LIMIT_MIN}부터 ${LIMIT_MAX}까지 적을 수 있어요` : apply.error('limit')}
        >
          <div className="fld-num">
            <input
              id={`${id}-n`}
              className="inp"
              type="number"
              inputMode="numeric"
              min={LIMIT_MIN}
              max={LIMIT_MAX}
              step={1}
              value={value}
              onChange={e => setValue(e.target.value)}
              onBlur={() => void commit()}
              onKeyDown={e => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                void commit()
              }}
              aria-invalid={invalid ? true : undefined}
            />
            <span className="fld-u">번</span>
          </div>
        </Row>
        <SwitchRow
          name="묻지 않고 실행 허용"
          desc="켜면 에이전트마다 승인 없이 실행하게 할 수 있어요"
          checked={allowed}
          busy={apply.busy('bypass')}
          error={apply.error('bypass')}
          onToggle={() => {
            if (allowed) void apply.run('bypass', () => window.dure.setAllowBypass(false)) // 끄기는 바로
            else setAsk(true) // 켜기는 확인 창을 거쳐서
          }}
        />
      </Section>
      <ConfirmDialog
        open={ask}
        title="묻지 않고 실행을 허용할까요?"
        body="허용하면 에이전트마다 '묻지 않음'을 켤 수 있어요. 켠 에이전트는 파일 수정·명령 실행을 묻지 않고 바로 해요. 믿을 수 있는 폴더에서만 켜 주세요."
        confirmLabel="허용"
        onConfirm={async () => {
          await window.dure.setAllowBypass(true)
          await getStore().refresh()
          setAsk(false)
        }}
        onCancel={() => setAsk(false)}
      />
    </>
  )
}
