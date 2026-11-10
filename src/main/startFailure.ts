import { formatLogArgs, redactHome } from './log'

/** 시작 실패 상자·로그에 보일 글 — 홈 경로는 ~ 로 가리고, Error 가 아닌 값도 읽히게 한다 */
export function startFailureMessage(err: unknown, home: string): string {
  return redactHome(err instanceof Error ? err.message : formatLogArgs([err]), home)
}
