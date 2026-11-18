/**
 * 운영체제 이음매 — 갈래는 이 값으로만 가른다. process.platform 은 모듈마다 deps 기본값 한 곳에서만 읽고(main 은 index.ts 한 곳),
 * 순수 함수는 인자로 받는다 — 시험은 인자로 mac 길을 Windows 에서도 돌린다. 화면(렌더러)도 이 타입을 쓴다(AppInfo.platform) — node 의존 없음
 */
export type Platform = 'win32' | 'darwin' | 'linux';

/** POSIX(mac·리눅스) — 프로세스 그룹으로 띄우고 그룹째 끈다 */
export const isPosix = (p: Platform): boolean => p !== 'win32';

/**
 * 오래 사는 자식(두레가 나중에 끄는 것)을 띄울 때 옵션에 펼쳐 쓴다 — `spawn(cmd, args, { ...spawnOpts(p), stdio, env })`.
 * win32: 지금 쓰는 그대로 `{ windowsHide: true }` — 끄기는 taskkill /T 가 나무째.
 * POSIX: `{ detached: true }` — 새 세션·프로세스 그룹의 리더(pgid = 자식 pid)라 killTree 가 -pid 로 손자(MCP 서버·Bash 명령·curl)까지 끈다.
 *   unref 하지 않는다 — 두레가 끌 때까지 붙어 있다
 */
export function spawnOpts(p: Platform): { windowsHide: true } | { detached: true } {
  return p === 'win32' ? { windowsHide: true } : { detached: true };
}
