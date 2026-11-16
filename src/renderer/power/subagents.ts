/** 도는 서브에이전트가 없으면 지어낸 위성 4개(시안 값) */
const FAKE_SUBAGENTS = 4

/** 파워 모드 어디서나 같은 규칙 — 진짜 수가 0보다 크면 그대로, 아니면 4 */
export const shownSubagents = (view: { subagents: number }): number => (view.subagents > 0 ? view.subagents : FAKE_SUBAGENTS)
