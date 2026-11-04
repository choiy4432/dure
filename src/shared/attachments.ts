// 파일 첨부 — 화면(renderer)과 엔진(main)이 같이 쓰는 상한·문구. 렌더러가 먼저 막고, 엔진이 fs.stat 으로 다시 잰다(렌더러 값을 믿지 않는다)

/** 파일 하나 상한 — 100MB(정확히 100MB 는 보낸다) */
export const ATTACH_MAX_BYTES = 100 * 1024 * 1024;
/** 상한을 넘는 파일 */
export const ATTACH_TOO_BIG = '100MB 보다 큰 파일은 보낼 수 없어요';
/** 보내기 실패의 머리 — 뒤에 ' — <이유 첫 줄>' */
export const ATTACH_FAILED = '파일을 보내지 못했어요';
