import { getStore, useDure } from '../../state/store'
import { workingCount } from '../../state/selectors'
import { SETTINGS_UPDATE as W, updateErrorWhy } from '../../lib/words'
import { Row, Section, SwitchRow, useApply } from './parts'

/** 업데이트 단추는 따로 바로 — 못 해도 결과 줄(사건)이 말해 준다 */
const act = (call: () => Promise<unknown>) => () => void call().catch(() => {})

/** 두레 — 업데이트(판 · 확인 · 받기·다시 켜기 줄) · 켤 때 claude 최신으로 · 처음 쓰는 안내 */
export function AboutPane({ onReplayTour }: { onReplayTour: () => void }) {
  const info = useDure(s => s.app.info)
  const update = useDure(s => s.app.update)
  const working = useDure(s => workingCount(s.agents))
  const auto = useDure(s => s.app.prefs?.claudeAutoUpdate ?? true)
  const apply = useApply()

  // 오류 셋 — 설치 실패(받아 둔 것을 다시 켜며 설치) · 받기 실패(version 있음, 토스트와 같은 글) · 확인 실패(version 없음)
  const installFailed = update.kind === 'error' && update.message === W.installFailed
  const downloadFailed = update.kind === 'error' && !installFailed && update.version !== null

  const status =
    update.kind === 'idle' ? undefined : (
      <span role="status" className="sx-st">
        <span className={update.kind === 'error' ? 'upd-t bad' : 'upd-t'}>
          {update.kind === 'dev' && W.dev}
          {update.kind === 'checking' && W.checking}
          {update.kind === 'none' && W.none}
          {update.kind === 'available' && W.available(update.version)}
          {update.kind === 'downloading' && W.downloading(update.percent)}
          {update.kind === 'ready' && W.ready}
          {update.kind === 'error' &&
            (installFailed ? W.installFailed : downloadFailed ? W.downloadFailed : W.failed(updateErrorWhy(update.message)))}
        </span>
        {/* 다시 켜면 일하는 에이전트가 멈춘다 — 토스트와 같은 노란 줄 */}
        {update.kind === 'ready' && working > 0 && <span className="upd-warn">{W.working(working)}</span>}
      </span>
    )

  return (
    <>
      <Section title="업데이트">
        <Row name={info ? W.version(info.version) : '두레'} desc={status}>
          <div className="sx-btns">
            {update.kind !== 'dev' && (
              // 다 받아 둔 뒤(ready)엔 확인할 게 없다 — 다시 확인해도 준비 상태를 바꾸지 않는다(updater)
              <button
                type="button"
                className="btn sec sm"
                disabled={update.kind === 'checking' || update.kind === 'downloading' || update.kind === 'ready'}
                onClick={act(() => window.dure.checkUpdate())}
              >
                {W.check}
              </button>
            )}
            {update.kind === 'available' && (
              <button type="button" className="btn pri sm" onClick={act(() => window.dure.downloadUpdate())}>
                {W.update}
              </button>
            )}
            {downloadFailed && (
              <button type="button" className="btn pri sm" onClick={act(() => window.dure.downloadUpdate())}>
                {W.retry}
              </button>
            )}
            {(update.kind === 'ready' || installFailed) && (
              <button type="button" className="btn pri sm" onClick={act(() => window.dure.installUpdate())}>
                {W.restart}
              </button>
            )}
          </div>
        </Row>
      </Section>
      <Section title="두레">
        <SwitchRow
          name={W.claudeAuto}
          desc="이 PC 와 서버의 claude 를 바꿔요"
          checked={auto}
          busy={apply.busy('auto')}
          error={apply.error('auto')}
          onToggle={() => void apply.run('auto', () => getStore().setPrefs({ claudeAutoUpdate: !auto }))}
        />
        <Row name="처음 쓰는 안내">
          <button type="button" className="btn sec sm" onClick={onReplayTour}>
            다시 보기
          </button>
        </Row>
      </Section>
    </>
  )
}
