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

// 다크 모드 — 라이트 :root 의 색 토큰은 어두운 세트(prefers-color-scheme: dark)에도 빠짐없이
const tokens = fs.readFileSync(path.resolve('src/renderer/styles/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** 블록 안의 --이름: 값 */
const varsOf = (block: string) => new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const darkStart = tokens.indexOf('@media (prefers-color-scheme: dark)');
const light = varsOf(tokens.slice(0, darkStart));
const dark = varsOf(tokens.slice(darkStart));
/** 테마와 상관없는 값 — 반경·글꼴·흐림 */
const SHARED = /^--(radius-|font$|mono$|overlay-blur$)/;

test('tokens.css 에 어두운 세트가 있고, 라이트의 색 토큰을 빠짐없이 다시 정한다', () => {
  expect(darkStart).toBeGreaterThan(0);
  const missing = [...light.keys()].filter((k) => !SHARED.test(k) && !dark.has(k));
  expect(missing).toEqual([]);
  const extra = [...dark.keys()].filter((k) => !light.has(k));
  expect(extra).toEqual([]);
});

test('창 바탕·창 단추 색(main 의 거울)은 tokens.css 의 --bg·--text-3 과 같다', async () => {
  const { WINDOW_COLORS } = await import('../src/main/windowTheme');
  expect(WINDOW_COLORS.light).toEqual({ bg: light.get('--bg'), symbol: light.get('--text-3') });
  expect(WINDOW_COLORS.dark).toEqual({ bg: dark.get('--bg'), symbol: dark.get('--text-3') });
});
