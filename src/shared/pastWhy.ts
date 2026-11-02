// 이어 갈 수 없는 지난 대화의 이유 글 — 엔진(돌아가기·갈래 거절)과 화면(목록 셋째 줄·읽기 아래 줄)이 같은 글자를 쓰도록 한 곳에 둔다.

const DAY_MS = 24 * 60 * 60 * 1000
/** Claude 가 오래된 대화 기록을 지우는 기본 기한 — 두레는 지운 까닭을 모르니 이보다 오래된 대화만 '30일이 지나'라고 말한다 */
const CLEANUP_MS = 30 * DAY_MS

export const PAST_WHY_TEXT = {
  /** 세션을 모름(예전 경계) */
  old: '예전 대화라 읽기만 돼요',
  /** Claude 쪽 대화 파일이 없음 — 마지막 줄이 30일보다 오래됨 */
  expired: '30일이 지나 이어 갈 수 없어요',
  /** Claude 쪽 대화 파일이 없음 — 그 밖(까닭 모름) */
  gone: 'Claude 쪽 기록이 없어 이어 갈 수 없어요',
} as const

/** 이어 갈 수 없는 이유 글 — at = 그 대화의 마지막 줄 시각, now = 지금 */
export function pastWhyText(why: 'old' | 'gone', at: number, now: number): string {
  if (why === 'old') return PAST_WHY_TEXT.old
  return now - at > CLEANUP_MS ? PAST_WHY_TEXT.expired : PAST_WHY_TEXT.gone
}
