// 채움에 쓰는 가짜 세계 — 파일·명령·말·에이전트. 진짜 데이터가 아니다.
import type { PowerAgent } from './events'

export const FAKE_ROOM = '주문 서비스 개편'

export const AGENT_COLORS: string[] = ['#60A5FA', '#34D399', '#FBBF24', '#C4B5FD', '#67E8F9']

const FAKE_AGENT_DEFS: Array<[string, string, string]> = [
  ['lead', '총괄', '조율'],
  ['impl', '구현', '코드 작성'],
  ['test', '테스트', '검증'],
  ['rev', '검토', '코드 리뷰'],
  ['doc', '문서', '정리'],
]

export function fakeAgents(): PowerAgent[] {
  return FAKE_AGENT_DEFS.map(([id, name, role], i) => ({
    id,
    name,
    role,
    color: AGENT_COLORS[i % AGENT_COLORS.length],
    real: false,
  }))
}

export const FILES = [
  'src/order/checkout.ts', 'src/order/refund.ts', 'src/payment/gateway.ts', 'src/payment/retry.ts',
  'src/coupon/apply.ts', 'src/coupon/stack.ts', 'src/api/routes/orders.ts', 'test/order/checkout.test.ts',
  'test/payment/gateway.test.ts', 'src/lib/money.ts', 'db/migrations/0042_coupon_index.sql', 'docs/api/orders.md',
  'src/inventory/reserve.ts', 'src/payment/webhook.ts', 'src/order/cart.ts', 'test/coupon/apply.test.ts',
]
export const BASH = [
  'npm test -- checkout', 'npx tsc --noEmit', 'git diff --stat', 'npm run lint',
  'node scripts/seed.mjs', 'npm run bench -- refund',
]
export const GREP = ['"applyCoupon"', '"idempotencyKey"', '"refunded"', 'TODO\\(payment\\)', '"reserveStock"']
export const GLOB = ['src/**/*.ts', 'test/**/*.test.ts', 'src/payment/*']
export const WEB = ['결제 재시도 멱등 키', 'postgres 인덱스 잠금 없이 만들기', '쿠폰 중복 적용 경쟁 상태']
export const TASKS = ['결제 흐름 조사', '느린 쿼리 찾기', '테스트 빈틈 찾기']
export const HAND = [
  '테스트 다시 돌려 주세요', '실패 3건 원인 정리했어요', '리뷰 의견 4개 보냈어요', 'checkout 수정 끝, 확인 부탁해요',
  'API 문서 고쳐 주세요', '재시도 로직 검토해 주세요', '마이그레이션 순서 확인 필요', '타입 오류 2곳 고쳤어요',
  '부하 측정 결과 공유해요', '쿠폰 경계값 케이스 추가했어요',
]

/** 도구 고르기 가중치(시안 그대로): Read 3 · Edit 2 · 나머지 1. */
export const TOOL_MIX = ['Read', 'Read', 'Read', 'Edit', 'Edit', 'Bash', 'Grep', 'Glob', 'Write', 'WebSearch', 'Task']

export const TARGETS: Record<string, string[]> = {
  Read: FILES, Edit: FILES, Write: FILES, Bash: BASH, Grep: GREP, Glob: GLOB, WebSearch: WEB, Task: TASKS,
}
