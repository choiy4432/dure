import { ArrowUp, X } from 'lucide-react'
import { getStore, useDure } from '../state/store'
import { workingCount } from '../state/selectors'
import { UPDATE_TOAST as W } from '../lib/words'

/**
 * 새 버전 토스트 — 창 오른쪽 아래(상태 띠 위, 입력창을 가려도 됨).
 * 보이는 때: 있음·받는 중·준비됨, 그리고 받기를 누른 뒤의 실패(version 이 있는 오류). 자동 확인 실패는 조용히.
 */
export function UpdateToast() {
  const update = useDure(s => s.app.update)
  const hidden = useDure(s => s.app.toastHidden)
  const working = useDure(s => workingCount(s.agents))
  if (hidden) return null
  const hide = () => getStore().hideUpdateToast()
  const run = (fn: () => Promise<void>) => () => void fn().catch(() => {}) // 실패는 updater 가 'update' 사건으로 알린다

  let body
  switch (update.kind) {
    case 'available':
      body = (
        <>
          <div className="ut-t">{W.title}</div>
          <div className="ut-m">{W.versions(update.version, update.current)}</div>
          {update.highlights.length > 0 && (
            <ul className="ut-list">
              {update.highlights.slice(0, 3).map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          )}
          <div className="ut-acts">
            <button type="button" className="btn pri sm" onClick={run(() => window.dure.downloadUpdate())}>{W.update}</button>
            <button type="button" className="btn sec sm" onClick={hide}>{W.later}</button>
            <button type="button" className="ut-link" onClick={run(() => window.dure.openReleasePage())}>{W.all}</button>
          </div>
        </>
      )
      break
    case 'downloading':
      body = (
        <>
          <div className="ut-t">{W.downloading(update.percent)}</div>
          <div className="ut-m">{W.keepUsing}</div>
          <div className="ut-bar" aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, update.percent))}%` }} />
          </div>
        </>
      )
      break
    case 'ready':
      body = <Ready version={update.version} working={working} onHide={hide} />
      break
    case 'error': {
      if (update.version === null) return null
      if (update.message === W.installFailed) {
        body = (
          <>
            <div className="ut-t">{W.installFailed}</div>
            <div className="ut-acts">
              <button type="button" className="btn pri sm" onClick={run(() => window.dure.installUpdate())}>{W.restart}</button>
              <button type="button" className="btn sec sm" onClick={hide}>{W.later}</button>
            </div>
          </>
        )
      } else {
        body = (
          <>
            <div className="ut-t">{W.failed}</div>
            <div className="ut-acts">
              <button type="button" className="btn pri sm" onClick={run(() => window.dure.downloadUpdate())}>{W.retry}</button>
              <button type="button" className="btn sec sm" onClick={hide}>{W.later}</button>
            </div>
          </>
        )
      }
      break
    }
    default:
      return null
  }

  return (
    <aside className="ut" role="status">
      <span className="ut-ic" aria-hidden="true">
        <ArrowUp size={15} strokeWidth={2.25} />
      </span>
      <div className="ut-body">{body}</div>
      <button type="button" className="ut-x" aria-label={W.close} onClick={hide}>
        <X size={14} aria-hidden="true" />
      </button>
    </aside>
  )
}

function Ready({ version, working, onHide }: { version: string; working: number; onHide: () => void }) {
  return (
    <>
      <div className="ut-t">{W.ready}</div>
      <div className="ut-m">{W.readyBody(version)}</div>
      {working > 0 && <div className="ut-warn">{W.working(working)}</div>}
      <div className="ut-acts">
        <button type="button" className="btn pri sm" onClick={() => void window.dure.installUpdate().catch(() => {})}>{W.restart}</button>
        <button type="button" className="btn sec sm" onClick={onHide}>{W.onQuit}</button>
      </div>
    </>
  )
}
