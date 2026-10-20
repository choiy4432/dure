import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.resolve('src/renderer/styles/base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 선택자가 그 이름 그대로인 규칙의 본문을 모두 잇는다(묶음 선택자 'a, b { }' 안의 것도) — 없으면 '' */
function rule(selector: string): string {
  const bodies: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sels = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (sels.includes(selector)) bodies.push(m[2]);
  }
  return bodies.join(';');
}

// 접기·펼치기는 바깥 상자(.xp)의 높이만 움직인다(lib/expand). 펼친 내용 둘레의 간격이 상자 밖(부모의 flex gap · 카드 여백 클래스)에 있으면
// 상자가 생기거나 떨어지는 순간 그만큼 튄다 — 펼친 내용 쪽 간격은 상자 안에 둔다(2026-10-20, 받은 메시지 카드 10px · '/compact' 자세히 8px)
test("'/compact' 줄(.ci-sys)은 flex gap 을 쓰지 않는다 — 원문 상자 위 8px 은 상자 안(pre 의 margin)", () => {
  expect(rule('.ci-sys')).not.toBe('');
  expect(rule('.ci-sys')).not.toMatch(/(?:^|;)\s*gap\s*:/);
  expect(rule('.ci-sys .ci-local')).toMatch(/margin-top:\s*8px/);
});

test('받은 메시지 카드는 접힌 여백(위아래 8px)이 바탕 — 펼친 차이(위 4px · 아래 6px)는 접기·펼치기 상자 안', () => {
  expect(rule('.pin.fold')).toBe('');
  expect(rule('.pin.msg')).toMatch(/padding-block:\s*8px/);
  expect(rule('.pin-gap::before')).toMatch(/height:\s*4px/);
  expect(rule('.pin-open::after')).toMatch(/height:\s*6px/);
});

test('빈 화면 오류 원문(.empty-x)도 — 카드의 flex gap 4px 을 상자 쪽에서 되돌리고 상자 안 margin 으로', () => {
  expect(rule('.empty-card > .xp')).toMatch(/margin-top:\s*-4px/);
  expect(rule('.empty-x')).toMatch(/margin:\s*4px 0 0/);
});
