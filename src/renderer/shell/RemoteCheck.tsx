// 서버(SSH) 방 화면 조각 — 확인 줄(새 방 · 에이전트 추가) · 서버 알약
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Check, Server, TriangleAlert } from 'lucide-react'
import type { RemoteIssueKind } from '../../engine/types'
import { remoteIssueText } from '../../shared/remoteTexts'
import { errorMessage, REMOTE } from '../lib/words'

/** 서버 확인(checkRemote · checkRemoteFolder) 의 답 — 됨이면 value = 쓸 값(host · 서버가 펼친 폴더) */
export type RemoteAnswer = { ok: true; value: string; claudeVersion: string } | { ok: false; kind: RemoteIssueKind; detail: string | null }

/** 확인 줄 — target 은 무엇을 확인했나(그 사이 칸이 바뀌었으면 맞지 않는다) */
export type RemoteCheck =
  | { state: 'idle' }
  | { state: 'checking'; target: string }
  | { state: 'ok'; target: string; value: string; claudeVersion: string }
  | { state: 'bad'; target: string; text: string }

const IDLE: RemoteCheck = { state: 'idle' }

/**
 * 서버 확인 하나 — 시작할 때마다 앞의 확인은 지난 일이 된다(늦게 온 옛 답은 버린다).
 * 문제 글은 엔진 알림 줄·안내 띠와 같은 remoteIssueText(host 는 host(target)). 부르기가 던지면 그 글 그대로.
 */
export function useRemoteCheck(host: (target: string) => string, ask: (target: string) => Promise<RemoteAnswer>) {
  const [check, setCheck] = useState<RemoteCheck>(IDLE)
  // 지금 확인 — 타이머·키 처리가 그린 뒤의 값을 기다리지 않고 본다
  const now = useRef<RemoteCheck>(IDLE)
  const seq = useRef(0)
  const live = useRef({ host, ask })
  useLayoutEffect(() => {
    live.current = { host, ask }
  })

  const put = (next: RemoteCheck) => {
    now.current = next
    setCheck(next)
  }

  /** 지금 확인을 버린다(칸이 바뀌었다) */
  const reset = useCallback(() => {
    seq.current++
    if (now.current.state !== 'idle') put(IDLE)
  }, [])

  const start = useCallback((target: string) => {
    const n = ++seq.current
    put({ state: 'checking', target })
    const { host: hostOf, ask: run } = live.current
    Promise.resolve()
      .then(() => run(target))
      .then(
        r => {
          if (seq.current !== n) return
          put(r.ok ? { state: 'ok', target, value: r.value, claudeVersion: r.claudeVersion } : { state: 'bad', target, text: remoteIssueText(hostOf(target), r) })
        },
        e => {
          if (seq.current === n) put({ state: 'bad', target, text: errorMessage(e) })
        },
      )
  }, [])

  /** 이 글 그대로 이미 확인 중이거나 됐는가 — 같은 글로 또 묻지 않는다(실패했으면 다시 묻는다) */
  const settled = useCallback((target: string) => {
    const c = now.current
    return (c.state === 'checking' || c.state === 'ok') && c.target === target
  }, [])

  return { check, start, reset, settled }
}

/**
 * 확인 줄 — 확인 중·됨은 status(같은 줄의 글만 바뀐다), 문제는 새로 붙는 alert(경고 색).
 * 됨 글은 okText(새 방 '접속됨 · …' · 에이전트 추가 '폴더가 있어요 · …')
 */
export function RemoteCheckLine({ id, check, okText }: { id: string; check: RemoteCheck; okText: (version: string) => string }) {
  if (check.state === 'idle') return null
  if (check.state === 'bad') {
    return (
      <p key="bad" id={id} className="rchk bad" role="alert">
        <TriangleAlert className="i" aria-hidden="true" />
        <span>{check.text}</span>
      </p>
    )
  }
  return (
    <p key="live" id={id} className={`rchk${check.state === 'ok' ? ' ok' : ''}`} role="status">
      {check.state === 'ok' && <Check className="i" aria-hidden="true" />}
      <span>{check.state === 'ok' ? okText(check.claudeVersion) : REMOTE.checking}</span>
    </p>
  )
}

/** 서버 알약 — 서버 아이콘 + host(위 띠 방 이름 뒤 · 에이전트 추가의 폴더 라벨 옆) */
export function ServerTag({ host, title }: { host: string; title?: string }) {
  return (
    <span className="srv" title={title}>
      <Server className="i" aria-hidden="true" />
      {host}
    </span>
  )
}
