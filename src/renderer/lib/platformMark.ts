import type { Platform } from '../../engine/platform'

const KNOWN: readonly Platform[] = ['win32', 'darwin', 'linux']

/**
 * 운영체제를 html 에 단다 — CSS 가 mac 신호등 자리(위 띠 왼쪽 80px)를 비운다(base.css [data-platform='darwin']).
 * PC 진입점(main.tsx)이 React 를 띄우기 전에 preload 가 다리에 바로 실은 값(window.dure.platform)으로 부른다 — appInfo 를 기다리면 첫 장면에서
 * 신호등이 두레 표지를 가린다. 아는 값만(Windows 는 지금처럼 'win32'), 없거나 모르면 달지 않는다(Windows 규칙 그대로). 휴대폰 진입점은 부르지 않는다
 */
export function markPlatform(root: HTMLElement, platform: unknown): void {
  if (typeof platform === 'string' && (KNOWN as readonly string[]).includes(platform)) root.dataset.platform = platform
}
