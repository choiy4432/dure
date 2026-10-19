// 엔진이 거절·취소·중단 때 Claude 에게 돌려주는 문구 — 엔진과 화면(대화 줄)이 같은 글자를 쓰도록 한 곳에 둔다.
export const DENY = {
  userDenied: '사용자가 거절했습니다.',
  requestCancelled: '요청이 취소되었습니다.',
  turnEnded: '차례가 끝났습니다.',
  userStopped: '사용자가 멈췄습니다.',
  claudeExited: 'Claude 가 종료되었습니다.',
} as const

export const DENY_TEXTS: readonly string[] = Object.values(DENY)
