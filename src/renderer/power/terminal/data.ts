// 터미널 벽 전용 가짜 자료 — diff 조각 · 칠 코드 · 시험 파일 · 서브에이전트 일 · 프로세스. 진짜 데이터가 아니다.
// 파일·명령·말은 fakeWorld 것을 그대로 쓴다.

export const SAY = [
  '쿠폰 금액이 주문 금액보다 크면 0원에서 멈추게 해야 해요.',
  '재시도는 멱등 키가 있을 때만 하도록 바꿀게요.',
  '환불 쪽 실패 3건은 원인이 같아요 — 반올림 순서.',
  '검토 의견대로 금액 계산을 lib/money 로 모았어요.',
  '인덱스를 먼저 만들고 컬럼을 채우는 순서가 안전해요.',
  '남은 일: 문서 갱신, 부하 측정 한 번 더.',
]

export const TEST_FILES = [
  'order/checkout', 'order/refund', 'order/cart', 'payment/gateway', 'payment/retry', 'payment/webhook', 'coupon/apply',
  'coupon/stack', 'inventory/reserve', 'inventory/release', 'api/orders', 'api/auth', 'lib/money', 'lib/dates', 'db/migrate',
]
export const FAILS = ['expected 1200 to be 1000', '쿠폰 두 장 겹침 — 예상 1장', '5000ms 시간 초과', "expected undefined to be 'REFUNDED'"]

/** [파일, 머리, 줄들] — 줄의 첫 글자가 + 면 더한 줄, - 면 뺀 줄, 그 밖엔 그대로인 줄 */
export const HUNKS: Array<[string, string, string[]]> = [
  ['src/coupon/apply.ts', '@@ -112,9 +112,14 @@ export function applyCoupon(', [
    ' export function applyCoupon(order: Order, coupon: Coupon): Money {', '-  const discount = order.total * coupon.rate', '-  return order.total - discount',
    '+  const discount = Math.min(order.total, round(order.total * coupon.rate))', '+  if (coupon.expiresAt && coupon.expiresAt < now()) {', "+    throw new CouponError('EXPIRED', coupon.id)", '+  }', '+  return clampZero(order.total - discount)', ' }']],
  ['src/payment/retry.ts', '@@ -40,6 +40,12 @@ async function charge(', [
    ' async function charge(req: ChargeRequest) {', "-  return gateway.post('/charge', req)", '+  const key = req.idempotencyKey ?? hash(req.orderId, req.amount)',
    "+  return retry(() => gateway.post('/charge', req, { key }), {", '+    attempts: 3,', '+    backoff: (n) => 200 * 2 ** n,', '+    retryOn: isTransient,', '+  })', ' }']],
  ['src/order/refund.ts', '@@ -77,8 +77,15 @@ export async function refund(', [
    ' export async function refund(orderId: string, amount: Money) {', '   const order = await repo.find(orderId)', "-  if (amount > order.paid) throw new Error('too much')",
    '+  if (amount > order.paid - order.refunded) {', "+    throw new RefundError('OVER_REFUND', { orderId, amount })", '+  }', '+  await repo.tx(async (tx) => {',
    '+    await tx.refunds.insert({ orderId, amount, at: now() })', '+    await tx.orders.addRefunded(orderId, amount)', '+  })', ' }']],
  ['db/migrations/0042_coupon_index.sql', '@@ -1,3 +1,4 @@', [
    '-CREATE INDEX coupon_code_idx ON coupons (code);', '+CREATE INDEX CONCURRENTLY IF NOT EXISTS coupon_code_idx', '+  ON coupons (code) WHERE deleted_at IS NULL;']],
]
export const REVIEW = [
  '▲ 검토: 반올림은 lib/money 의 round() 로 맞춰 주세요', '▲ 검토: 재시도 3회면 충분해요 — 실패 로그 한 줄만 더',
  '✓ 검토: 트랜잭션으로 묶은 것 좋아요', '▲ 검토: CONCURRENTLY 는 트랜잭션 밖에서 돌려야 해요',
]

/** [파일, 줄들] — 한 줄씩 쳐 넣는다 */
export const CODE: Array<[string, string[]]> = [
  ['src/coupon/stack.ts', [
    "import { Money, round, clampZero } from '../lib/money'", "import type { Coupon, Order } from '../types'", '',
    '// 여러 장을 겹칠 때: 비율 할인 먼저, 금액 할인은 나중에', 'export function stackCoupons(order: Order, coupons: Coupon[]): Money {',
    "  const rate = coupons.filter((c) => c.kind === 'rate')", "  const flat = coupons.filter((c) => c.kind === 'flat')", '  let total = order.total', '',
    '  for (const c of rate.slice(0, 1)) {', '    total = total - round(total * c.rate)', '  }', '  for (const c of flat) {', '    if (c.minOrder && order.total < c.minOrder) continue', '    total = total - c.amount', '  }',
    '  return clampZero(total)', '}']],
  ['src/inventory/reserve.ts', [
    "import { db } from '../db'", '', 'const HOLD_MS = 10 * 60 * 1000', '', 'export async function reserveStock(sku: string, qty: number, orderId: string) {',
    '  return db.tx(async (tx) => {', '    const row = await tx.stock.lock(sku)', '    if (row.available < qty) {', "      return { ok: false, reason: 'OUT_OF_STOCK' as const }", '    }',
    '    await tx.stock.update(sku, { available: row.available - qty })', '    await tx.holds.insert({ sku, qty, orderId, until: Date.now() + HOLD_MS })', '    return { ok: true }', '  })', '}']],
]

export const SUB_DEFS: Array<{ name: string; task: string }> = [
  { name: '탐색 1', task: '결제 흐름 따라가기' }, { name: '탐색 2', task: '느린 쿼리 찾기' },
  { name: '점검', task: '테스트 빈틈 찾기' }, { name: '조사', task: '멱등 키 사례 찾기' },
]
export const SUB_NEXT = ['환불 경로 정리', '쿠폰 겹침 사례 모으기', '웹훅 순서 확인', '재고 잠금 시간 재기', '오류 문구 모으기', 'API 응답 크기 재기']
export const SUB_DONE = [
  '결제 흐름 6단계 정리 → 총괄에게 넘김', '느린 쿼리 2개 찾음 (180ms, 420ms) → 구현에게 넘김',
  '빠진 테스트 5개 목록 → 테스트에게 넘김', '사례 4개 요약 → 검토에게 넘김',
]

/** [프로그램, 뒷말] */
export const PROCS: Array<[string, string]> = [
  ['claude', '총괄'], ['claude', '구현'], ['claude', '테스트'], ['claude', '검토'], ['claude', '문서'],
  ['node', 'vitest'], ['node', 'tsc --watch'], ['esbuild', ''], ['postgres', ''],
]
