// 화면 문구 도우미 — 조사(이/가 …)와 '방금 · N분 전' 같은 시각 말

import type { DisplayStatus } from '../state/selectors'

/** 표시 상태 낱말 — 관계도 카드 바닥과 패널 머리 알약이 같은 말을 쓴다 */
export const STATUS_WORD: Record<DisplayStatus, string> = {
  working: '작업 중',
  awaiting: '승인 기다림',
  idle: '대기',
  stopped: '대기',
  error: '멈춤',
}

/** 아바타 글자 — 이름의 첫 글자(영문은 대문자) */
export function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}

/** 엔진 오류를 화면에 그대로 — 엔진의 한국어 문구만 온다(스택은 오지 않는다) */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export type JosaPair = '이/가' | '을/를' | '은/는' | '과/와'

// 숫자를 읽은 소리에 받침이 있는가 — 영 일 이 삼 사 오 육 칠 팔 구
const DIGIT_BATCHIM = [true, true, false, true, false, false, true, true, true, false]

function hasBatchim(word: string): boolean | null {
  const last = word.trimEnd().slice(-1)
  if (last === '') return null
  const code = last.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0
  if (last >= '0' && last <= '9') return DIGIT_BATCHIM[Number(last)]
  return null
}

/** 낱말 뒤에 붙일 조사 — 받침이 있으면 앞 것, 없으면 뒤 것, 알 수 없으면 '이(가)' 처럼 둘 다 */
export function josa(word: string, pair: JosaPair): string {
  const [withB, withoutB] = pair.split('/')
  const b = hasBatchim(word)
  if (b === null) return `${withB}(${withoutB})`
  return b ? withB : withoutB
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 지난 시각 — 방금 · N분 전 · N시간 전 · N일 전 */
export function ago(at: number, now: number): string {
  const d = now - at
  if (d < MIN) return '방금'
  if (d < HOUR) return `${Math.floor(d / MIN)}분 전`
  if (d < DAY) return `${Math.floor(d / HOUR)}시간 전`
  return `${Math.floor(d / DAY)}일 전`
}

/** 이어진 시간 — 방금 시작 · N분째 · N시간째 */
export function lasting(since: number, now: number): string {
  const d = now - since
  if (d < MIN) return '방금 시작'
  if (d < HOUR) return `${Math.floor(d / MIN)}분째`
  return `${Math.floor(d / HOUR)}시간째`
}
