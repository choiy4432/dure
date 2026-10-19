import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.resolve('src/renderer/styles/base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// 대화 목록(.conv)은 세로 flex + 스크롤 칸이다. 제 스크롤을 가진 줄(로컬 명령 출력 pre 등)은 최소 높이가 0 이 되어
// 대화가 길어지면 두 줄 높이로 찌그러졌다(/compact 결과, 2026-10-20). 줄은 늘 제 높이 그대로, 스크롤은 .conv 가 한다.
test('대화 목록의 줄은 줄어들지 않는다(.conv > * 에 flex-shrink: 0)', () => {
  const rule = css.match(/\.conv\s*>\s*\*\s*\{([^}]*)\}/);
  expect(rule?.[1]).toMatch(/flex-shrink:\s*0/);
});
