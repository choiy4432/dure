// 엔진이 거절·취소·중단 때 Claude 에게 돌려주는 문구 — 엔진과 화면(대화 줄)이 같은 글자를 쓰도록 한 곳에 둔다.
export const DENY = {
  userDenied: '사용자가 거절했습니다.',
  requestCancelled: '요청이 취소되었습니다.',
  turnEnded: '차례가 끝났습니다.',
  userStopped: '사용자가 멈췄습니다.',
  claudeExited: 'Claude 가 종료되었습니다.',
  /** 서브에이전트가 두레 도구(send_message·list_agents·create_agent)를 불렀다 — 실행하지 않고 도구 오류로(spec §4.7) */
  subagentDureTool: '서브에이전트는 두레 도구를 쓸 수 없어요. 결과를 부모 에이전트에게 보고하면 부모가 전해요.',
  /** 사람이 새 에이전트 만들기 카드에서 [거절] — create_agent 의 결과(오류)로 */
  createAgentDenied: '사용자가 새 에이전트 만들기를 거절했어요.',
} as const

export const DENY_TEXTS: readonly string[] = Object.values(DENY)
