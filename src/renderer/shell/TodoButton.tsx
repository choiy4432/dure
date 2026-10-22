import { useMemo } from 'react'
import { getStore, useDure } from '../state/store'
import { todoCounts } from '../state/attention'

/**
 * 위 띠의 '할 일 N' — 방 고르기 바로 오른쪽. 누르면 고른 에이전트를 풀어 오른쪽 패널을 '돌아오는 길'(받은함)로 돌린다.
 * 점은 하나만: 승인·질문(asks)이 있으면 앰버, 메시지·묶음뿐이면 빨강 — 내가 눌러야 막힌 일이 더 급하다.
 * 목록이 보이는 동안(고른 에이전트가 없을 때)은 눌린 모양이라 지금 어디에 있는지 알 수 있다.
 */
export function TodoButton() {
  const v = useDure(s => ({ agents: s.agents, requests: s.requests, messages: s.messages, selected: s.selectedAgentId }))
  const t = useMemo(() => todoCounts(v), [v.agents, v.requests, v.messages]) // eslint-disable-line react-hooks/exhaustive-deps
  const none = t.total === 0
  return (
    <button
      type="button"
      className={`todo${none ? ' muted' : ''}`}
      aria-pressed={v.selected === null}
      // 점 색의 뜻을 화면 읽기 프로그램에도 — 보이는 글은 '할 일 N' 그대로
      aria-label={none ? undefined : `할 일 ${t.total}개 · ${t.asksTotal > 0 ? '내 승인 필요 있음' : '받은 메시지만'}`}
      onClick={() => getStore().selectAgent(null)}
    >
      {!none && <span className={`dot ${t.asksTotal > 0 ? 'a' : 'r'}`} aria-hidden="true" />}
      {none ? '할 일' : `할 일 ${t.total}`}
    </button>
  )
}
