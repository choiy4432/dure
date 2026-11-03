import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useDure } from '../state/store'
import { effectiveSetup } from '../state/selectors'
import { Presence } from '../lib/presence'
import { ExpandBox } from '../lib/ExpandBox'
import { SETUP } from '../lib/words'
import type { InstallStep, LoginStep } from '../../shared/appTypes'

/**
 * 준비 화면 — claude 가 없거나 로그인이 안 됐을 때 관계도 자리에 뜨는 단계 목록 카드(설치 → 로그인 → 둘러보기).
 * 단추는 api 만 부른다. 진행은 main 이 보내는 'setup' 사건이 바꾼다 — 눌린 단추는 다음 상태가 올 때까지만 막는다.
 */
export function SetupScreen() {
  const raw = useDure(s => ({ setup: s.app.setup, missing: s.claudeMissing, failed: s.app.setupLoadFailed }))
  const setup = effectiveSetup(raw.setup, raw.missing, raw.failed)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => setBusy(null), [setup])

  // 단계가 바뀌어 눌렀던 단추가 사라지면 초점이 body 로 떨어진다 — 새 현재 단계의 주 단추(없으면 제목)로 옮긴다. 처음 그릴 때와 다른 곳에 있는 초점은 건드리지 않는다
  const root = useRef<HTMLDivElement>(null)
  const prevKey = useRef<string | null>(null)
  const key = setup.phase === 'needs' ? `needs/${setup.install.state}/${setup.login.state}` : setup.phase
  useEffect(() => {
    const was = prevKey.current
    prevKey.current = key
    const el = root.current
    if (was === null || was === key || !el) return
    const active = document.activeElement
    if (active && active !== document.body && !el.contains(active)) return
    const cur = el.querySelector<HTMLElement>('.setup-s.cur')
    cur?.querySelector<HTMLElement>('[data-primary]')?.focus()
    if (!el.contains(document.activeElement)) cur?.querySelector<HTMLElement>('.setup-t')?.focus()
  }, [key])

  if (setup.phase !== 'needs' && setup.phase !== 'relaunching') return null

  const call = (key: string, run: () => Promise<unknown>) => {
    setBusy(key)
    run().catch(() => setBusy(null))
  }

  if (setup.phase === 'relaunching') {
    return (
      <div className="empty setup-wrap" ref={root}>
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
    <div className="empty setup-wrap" ref={root}>
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
      <span className="setup-t" tabIndex={-1}>
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
              <button type="button" className="btn pri" data-primary disabled={busy === 'install'} onClick={() => call('install', () => window.dure.installClaude())}>
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
              <button type="button" className="lk" data-primary disabled={busy === 'login'} onClick={() => call('login', () => window.dure.loginClaude())}>
                {SETUP.reopen}
              </button>
            </>
          ) : (
            <button type="button" className="btn pri" data-primary disabled={busy === 'login'} onClick={() => call('login', () => window.dure.loginClaude())}>
              {SETUP.login}
            </button>
          )}
        </div>
      </div>
    </Step>
  )
}
