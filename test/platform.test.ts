import { describe, expect, it } from 'vitest';
import { isPosix, spawnOpts } from '../src/engine/platform';

// 운영체제 이음매 — 오래 사는 자식을 띄울 때 옵션에 펼쳐 쓴다. win32 는 지금 쓰는 값 그대로
describe('platform', () => {
  it("spawnOpts('win32') 는 지금 쓰는 그대로 { windowsHide: true }", () => {
    expect(spawnOpts('win32')).toEqual({ windowsHide: true });
  });

  it("spawnOpts('darwin') 은 { detached: true } — 새 프로세스 그룹(리눅스도)", () => {
    expect(spawnOpts('darwin')).toEqual({ detached: true });
    expect(spawnOpts('linux')).toEqual({ detached: true });
  });

  it('isPosix — win32 만 아니다', () => {
    expect(isPosix('win32')).toBe(false);
    expect(isPosix('darwin')).toBe(true);
    expect(isPosix('linux')).toBe(true);
  });
});
