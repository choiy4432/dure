import { useContext, useId } from 'react'
import { SLEEP_CHOICES, type ThemePref } from '../../../engine/types'
import { getStore, useDure } from '../../state/store'
import { SLEEP_CHOICE_WORD, SLEEP_SETTING } from '../../lib/words'
import { Row, Section, SettingsCloseContext, SwitchRow, useApply } from './parts'

/** 화면 테마 칸 — 누르는 차례대로 */
const THEMES: { key: ThemePref; label: string }[] = [
  { key: 'light', label: '라이트' },
  { key: 'dark', label: '다크' },
  { key: 'system', label: 'Windows 따라감' },
]

/** 파워 모드 화면 칸 */
const SCREENS = [
  { label: '관제실', terminal: false },
  { label: '터미널 벽', terminal: true },
]

/** 일반 — 화면 테마 · 쉬는 에이전트 재우기. 누르는 즉시 바뀐다 */
export function GeneralPane() {
  const theme = useDure(s => s.theme ?? 'system')
  const sleep = useDure(s => s.sleepAfterMin)
  const apply = useApply()
  const id = useId()
  const closeSettings = useContext(SettingsCloseContext)
  const powerOn = useDure(s => s.power.on)
  const terminal = useDure(s => s.app.prefs?.powerTerminal ?? false)
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
      <Section title="파워 모드">
        <SwitchRow
          name="파워 모드"
          desc="켜 둔 동안엔 화면이 꺼지거나 잠기지 않아요. Esc 를 길게 누르면 나가요."
          checked={powerOn}
          busy={apply.busy('power')}
          error={apply.error('power')}
          onToggle={() =>
            void apply.run('power', async () => {
              const on = !powerOn
              await getStore().setPower(on)
              if (on) closeSettings()
            })
          }
        />
        <Row name="화면" stacked nameId={`${id}-p`} error={apply.error('screen')}>
          {({ describedBy }) => (
            <div className="seg" role="radiogroup" aria-labelledby={`${id}-p`} aria-describedby={describedBy} aria-busy={apply.busy('screen') || undefined}>
              {SCREENS.map(c => (
                <button
                  key={c.label}
                  type="button"
                  role="radio"
                  aria-checked={terminal === c.terminal}
                  onClick={() => {
                    if (c.terminal !== terminal) void apply.run('screen', () => getStore().setPrefs({ powerTerminal: c.terminal }))
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </Row>
      </Section>
    </>
  )
}
