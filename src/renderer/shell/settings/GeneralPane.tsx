import { useId } from 'react'
import { SLEEP_CHOICES, type ThemePref } from '../../../engine/types'
import { useDure } from '../../state/store'
import { SLEEP_CHOICE_WORD, SLEEP_SETTING } from '../../lib/words'
import { Row, Section, useApply } from './parts'

/** 화면 테마 칸 — 누르는 차례대로 */
const THEMES: { key: ThemePref; label: string }[] = [
  { key: 'light', label: '라이트' },
  { key: 'dark', label: '다크' },
  { key: 'system', label: 'Windows 따라감' },
]

/** 일반 — 화면 테마 · 쉬는 에이전트 재우기. 누르는 즉시 바뀐다 */
export function GeneralPane() {
  const theme = useDure(s => s.theme ?? 'system')
  const sleep = useDure(s => s.sleepAfterMin)
  const apply = useApply()
  const id = useId()
  return (
    <>
      <Section title="화면">
        <Row name="테마" stacked nameId={`${id}-t`} error={apply.error('theme')}>
          {({ describedBy }) => (
          <div className="seg" role="radiogroup" aria-labelledby={`${id}-t`} aria-describedby={describedBy} aria-busy={apply.busy('theme') || undefined}>
            {THEMES.map(t => (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={theme === t.key}
                onClick={() => {
                  if (t.key !== theme) void apply.run('theme', () => window.dure.setTheme(t.key))
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          )}
        </Row>
      </Section>
      <Section title="쉬는 에이전트">
        <Row
          name={SLEEP_SETTING.label}
          desc="쉬는 동안 claude 를 내려 메모리를 비워요 · 말을 걸면 다시 깨요"
          stacked
          nameId={`${id}-s`}
          error={apply.error('sleep')}
        >
          {({ describedBy }) => (
          <div className="seg" role="radiogroup" aria-labelledby={`${id}-s`} aria-describedby={describedBy} aria-busy={apply.busy('sleep') || undefined}>
            {SLEEP_CHOICES.map(m => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={sleep === m}
                onClick={() => {
                  if (m !== sleep) void apply.run('sleep', () => window.dure.setSleepAfter(m))
                }}
              >
                {SLEEP_CHOICE_WORD[m]}
              </button>
            ))}
          </div>
          )}
        </Row>
      </Section>
    </>
  )
}
