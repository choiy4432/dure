import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 테마 교체 대비 — 색·반경은 tokens.css 의 변수로만(constraints: 컴포넌트 CSS 에 값을 직접 쓰지 않는다)
const css = fs.readFileSync(path.resolve('src/renderer/styles/base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('base.css 에 색 값을 직접 쓰지 않는다', () => {
  expect(css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([]);
});

test('base.css 의 border-radius 는 토큰 변수로(0 이나 토큰에서 빼는 calc 는 괜찮다)', () => {
  const literal = [...css.matchAll(/border-radius:\s*([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((v) => v !== '0' && !v.includes('var(--'));
  expect(literal).toEqual([]);
});
