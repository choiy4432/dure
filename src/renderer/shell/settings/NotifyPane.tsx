import { useDure } from '../../state/store'
import { Section, SwitchRow, useApply } from './parts'

/** 알림 — Windows 알림 둘. '일이 끝나면'은 승인·질문 알림이 꺼지면 잠긴다(값은 그대로 — 다시 켜면 이어진다) */
export function NotifyPane() {
  const notify = useDure(s => s.notify)
  const apply = useApply()
  return (
    <Section title="Windows 알림" note="창이 가려져 있을 때">
      <SwitchRow
        name="승인·질문이 오면"
        checked={notify.asks}
        busy={apply.busy('asks')}
        error={apply.error('asks')}
        onToggle={() => void apply.run('asks', () => window.dure.setNotify({ asks: !notify.asks }))}
      />
      <SwitchRow
        name="일이 끝나면"
        checked={notify.finished}
        busy={apply.busy('finished')}
        disabled={!notify.asks}
        error={apply.error('finished')}
        onToggle={() => void apply.run('finished', () => window.dure.setNotify({ finished: !notify.finished }))}
      />
    </Section>
  )
}
