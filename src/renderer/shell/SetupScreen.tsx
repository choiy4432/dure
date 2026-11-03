import { useEffect, useId, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useDure } from '../state/store'
import { Presence } from '../lib/presence'
import { ExpandBox } from '../lib/ExpandBox'
import { SETUP } from '../lib/words'
import type { InstallStep, LoginStep } from '../../shared/appTypes'

/**
 * 준비 화면 — claude 가 없거나 로그인이 안 됐을 때 관계도 자리에 뜨는 단계 목록 카드(설치 → 로그인 → 둘러보기).
 * 단추는 api 만 부른다. 진행은 main 이 보내는 'setup' 사건이 바꾼다 — 눌린 단추는 다음 상태가 올 때까지만 막는다.
 */
export function SetupScreen() {
  const setup = useDure(s => s.app.setup)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => setBusy(null), [setup])

  if (setup.phase !== 'needs' && setup.phase !== 'relaunching') return null

  const call = (key: string, run: () => Promise<unknown>) => {
    setBusy(key)
    run().catch(() => setBusy(null))
  }

  if (setup.phase === 'relaunching') {
    return (
      <div className="empty setup-wrap">
        <section className="setup" aria-label={SETUP.kicker}>
          <p className="setup-k">{SETUP.kicker}</p>
          <ol className="setup-steps">
            <Step n={1} state="done" title={SETUP.installTitle} />
            <Step n={2} state="done" title={SETUP.loginTitle} />
            <Step n={3} state="cur" title={SETUP.tour}>
              <p className="setup-bd" role="status">{SETUP.relaunching}</p>
            </Step>
          </ol>
        </section>
      </div>
    )
  }

  const { install, login } = setup
  const loginOnly = install.state === 'done'
  const title = loginOnly ? SETUP.titleLogin : SETUP.titleBoth

  return (
    <div className="empty setup-wrap">
      <section className="setup" aria-labelledby="setup-h">
        <p className="setup-k">{SETUP.kicker}</p>
        <h2 className="setup-h" id="setup-h">{title}</h2>
        <ol className="setup-steps">
          <InstallRow install={install} busy={busy} call={call} />
          <LoginRow login={login} busy={busy} call={call} />
          <Step n={3} state="locked" title={SETUP.tour} tail={<span className="setup-mut">{SETUP.tourEta}</span>} />
        </ol>
      </section>
    </div>
  )
}

type Call = (key: string, run: () => Promise<unknown>) => void

function Step({ n, state, title, tail, children }: { n: number; state: 'cur' | 'done' | 'locked'; title: string; tail?: ReactNode; children?: ReactNode }) {
  return (
    <li className={`setup-s ${state}`}>
      <span className="setup-n" aria-hidden="true">{state === 'done' ? <Check size={13} strokeWidth={2.5} /> : n}</span>
      <span className="setup-t">
        {title}
        {tail && <> {tail}</>}
      </span>
      {children}
    </li>
  )
}

function InstallRow({ install, busy, call }: { install: InstallStep; busy: string | null; call: Call }) {
  if (install.state === 'done') {
    return <Step n={1} state="done" title={SETUP.installTitle} tail={install.version && <span className="setup-ver">{install.version}</span>} />
  }
  const running = install.state === 'running'
  const lines = install.state === 'running' || install.state === 'failed' ? install.lines : []
  return (
    <Step n={1} state="cur" title={SETUP.installTitle} tail={running && <span className="setup-side">{SETUP.eta}</span>}>
      <div className="setup-bd">
        {running ? (
          <div className="setup-bar" aria-hidden="true"><i /></div>
        ) : (
          <>
            {install.state === 'failed' ? (
              <>
                <p className="setup-err">{SETUP.installFailed}</p>
                <p className="setup-why">{install.message}</p>
              </>
            ) : (
              <p className="setup-p">{SETUP.installBody}</p>
            )}
          </>
        )}
        {lines.length > 0 && (
          <div className="setup-log" role="log" aria-label="설치 진행">
            {lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
        {!running && (
          <>
            <div className="setup-acts">
              <button type="button" className="btn pri" disabled={busy === 'install'} onClick={() => call('install', () => window.dure.installClaude())}>
                {install.state === 'failed' ? SETUP.retry : SETUP.install}
              </button>
              <button type="button" className="lk" onClick={() => void window.dure.openSetupGuide()}>
                {SETUP.manual}
              </button>
            </div>
            <Command />
          </>
        )}
      </div>
    </Step>
  )
}

function Command() {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <>
      <button type="button" className="lk setup-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
        {SETUP.showCommand}
        <ChevronDown className="i" size={14} aria-hidden="true" />
      </button>
      <Presence show={open}>
        <ExpandBox as="p" className="setup-cmd" id={id}>
          {SETUP.command}
        </ExpandBox>
      </Presence>
    </>
  )
}

function LoginRow({ login, busy, call }: { login: LoginStep; busy: string | null; call: Call }) {
  if (login.state === 'locked') return <Step n={2} state="locked" title={SETUP.loginTitle} />
  return (
    <Step n={2} state="cur" title={SETUP.loginTitle}>
      <div className="setup-bd">
        <p className="setup-p">{SETUP.loginBody}</p>
        {login.state === 'failed' && <p className="setup-err">{SETUP.loginFailed}</p>}
        <div className="setup-acts">
          {login.state === 'waiting' ? (
            <>
              <span className="setup-wait"><span className="setup-dot" aria-hidden="true" />{SETUP.waiting}</span>
              <button type="button" className="lk" disabled={busy === 'login'} onClick={() => call('login', () => window.dure.loginClaude())}>
                {SETUP.reopen}
              </button>
            </>
          ) : (
            <button type="button" className="btn pri" disabled={busy === 'login'} onClick={() => call('login', () => window.dure.loginClaude())}>
              {SETUP.login}
            </button>
          )}
        </div>
      </div>
    </Step>
  )
}
