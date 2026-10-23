import { useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { AgentView } from '../../shared/ipcContract'
import { getStore } from '../state/store'
import { errorMessage } from '../lib/words'

type Step = 0 | 1 | 2

const NAMES = ['끔', '자동', '묻지 않음'] as const
const TITLES = [
  '받은 메시지는 내가 시키고, 권한도 물어요',
  '받은 메시지는 바로 시작하고, 권한은 물어요',
  '바로 시작하고, 권한도 안 물어요',
] as const
const LOCKED = 'Claude 설정이 전부 허용이라 이미 묻지 않아요'
/** 묻지 않음을 켠 채 계획 모드 — 계획을 승인하면 다시 묻지 않는다(그동안 실제 모드는 plan 이라 bypass 가 아니다) */
const PLAN_PAUSED = '계획을 세우는 동안은 묻고, 계획을 승인하면 다시 묻지 않아요'

/**
 * 보이는 단계 — 저장값이 아니라 화면 상태에서. 두 스위치를 따로 켜 둔 옛 상태(auto 꺼짐 + 묻지 않음 켜짐)도 2.
 * 계획 모드 동안엔 실제 모드가 plan 이라 bypass 가 아니지만 묻지 않음을 켜 둔 에이전트는 2 — 승인하면 엔진이 bypass 로 되돌리니,
 * 여기서 내리면 setBypass(false) 로 그 켜짐을 거둬야 한다(자동으로만 보이면 끔으로 옮겨도 승인 뒤 묻지 않고 실행한다)
 */
export function levelOf(agent: AgentView): Step {
  if (!agent.bypassBySettings && (agent.bypass || agent.bypassPending)) return 2
  if (agent.planMode && agent.bypassOn) return 2
  return agent.auto ? 1 : 0
}

interface Props {
  agent: AgentView
  /** 오류 줄(ph-msg) — null 이면 지운다 */
  onError: (message: string | null) => void
}

/** 패널 머리의 맡기는 정도 — 끔 · 자동 · 묻지 않음 세 칸 스위치(role=slider) */
export function LevelSwitch({ agent, onError }: Props) {
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const lockId = useId()
  const locked = agent.bypassBySettings
  const now = levelOf(agent)
  const max: Step = locked ? 1 : 2
  const paused = now === 2 && agent.planMode && !agent.bypass

  // 옮기기 — 응답을 기다리는 동안 두 번 누르기는 막는다. 묻지 않음이 걸린 옮기기만 흐리게 보인다
  const move = async (target: number) => {
    const to = Math.max(0, Math.min(max, target)) as Step
    if (saving.current || to === now) return
    const viaBypass = to === 2 || now === 2
    saving.current = true
    if (viaBypass) setBusy(true)
    onError(null)
    try {
      if (to === 2) {
        if (!agent.auto) await window.dure.updateAgent(agent.id, { auto: true })
        await window.dure.setBypass(agent.id, true)
      } else if (now === 2) {
        // bypassPending 이면 이 false 가 미뤄 둔 켜기를 거둔다
        await window.dure.setBypass(agent.id, false)
        if (to === 0 || !agent.auto) await window.dure.updateAgent(agent.id, { auto: to === 1 })
      } else {
        await window.dure.updateAgent(agent.id, { auto: to === 1 })
      }
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      // 절반만 적용됐어도 화면은 실제 값을 따른다 — 새로고침 실패는 옮기기 오류가 아니다
      try {
        await getStore().refresh()
      } catch {
        /* 다음 갱신이 바로잡는다 */
      }
      saving.current = false
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let to: number
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        to = now - 1
        break
      case 'ArrowRight':
      case 'ArrowUp':
        to = now + 1
        break
      case 'Home':
        to = 0
        break
      case 'End':
        to = max
        break
      default:
        return
    }
    e.preventDefault()
    void move(to)
  }

  // 누른 순간 트랙 자리를 재어 3등분한 칸으로
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (!(r.width > 0)) return
    const zone = Math.floor(((e.clientX - r.left) / r.width) * 3)
    if (locked && zone >= 2) return // 잠김이면 묻지 않음 칸은 무시 — 끝 칸으로 끌어내리지 않는다
    void move(zone)
  }

  return (
    <div className={`sw lvl s${now}`}>
      <span className="lvl-n" aria-hidden="true">
        {NAMES[now]}
      </span>
      <div
        className="lvl-tr"
        role="slider"
        tabIndex={0}
        aria-label="맡기는 정도"
        aria-valuemin={0}
        aria-valuemax={2}
        aria-valuenow={now}
        aria-valuetext={NAMES[now]}
        aria-busy={busy || agent.bypassPending || undefined}
        aria-describedby={locked ? lockId : undefined}
        title={locked ? LOCKED : paused ? PLAN_PAUSED : TITLES[now]}
        onKeyDown={onKey}
        onClick={onClick}
      >
        <i className="lvl-t" aria-hidden="true" />
        <i className="lvl-t" aria-hidden="true" />
        <i className="lvl-t" aria-hidden="true" />
        <i className="lvl-k" aria-hidden="true" />
      </div>
      {locked && (
        <span id={lockId} className="lvl-hid">
          {LOCKED}
        </span>
      )}
    </div>
  )
}
