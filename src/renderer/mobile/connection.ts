// 휴대폰 ↔ PC 연결 상태 — 진입점이 createWsApi 의 onConn 으로 채우고, 화면(위쪽 '다시 잇는 중…' 띠)이 useConn 으로 읽는다
import { useSyncExternalStore } from 'react'
import { getStore } from '../state/store'
import type { PhoneConnState } from './wsApi'

/** connecting = 처음 잇는 중(아직 한 번도 안 열림) */
export type PhoneConn = 'connecting' | PhoneConnState

let conn: PhoneConn = 'connecting'
const listeners = new Set<() => void>()

export function getConn(): PhoneConn {
  return conn
}

function setConn(next: PhoneConn): void {
  if (next === conn) return
  conn = next
  listeners.forEach(fn => fn())
}

export function useConn(): PhoneConn {
  return useSyncExternalStore(
    fn => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    getConn,
  )
}

/**
 * createWsApi 의 onConn — 상태를 적고, 다시 이어지면(again) 그사이 놓친 사건을 메운다: 스냅샷부터 다시 받고 열린 대화의 기록도 다시 받는다
 * (store.resync). 쓰던 글(drafts)은 화면 쪽 상태라 그대로 남는다
 */
export function onPhoneConn(s: PhoneConnState, again: boolean): void {
  setConn(s)
  if (s === 'open' && again) getStore().resync().catch(() => {})
}
