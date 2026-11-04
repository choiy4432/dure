// 파일 첨부 — 화면(renderer)과 엔진(main)이 같이 쓰는 상한·문구. 렌더러가 먼저 막고, 엔진이 fs.stat 으로 다시 잰다(렌더러 값을 믿지 않는다)

/** 파일 하나 상한 — 100MB(정확히 100MB 는 보낸다) */
export const ATTACH_MAX_BYTES = 100 * 1024 * 1024;
/** 상한을 넘는 파일 */
export const ATTACH_TOO_BIG = '100MB 보다 큰 파일은 보낼 수 없어요';

/** PDF 하나를 문서 블록(base64)으로도 넘기는 크기 상한 — 원본 바이트(정확히 10MiB 는 넣는다). 넘으면 경로 줄만 */
export const PDF_INLINE_MAX_BYTES = 10 * 1024 * 1024;
/**
 * 한 메시지의 미디어 상한 — 그림 블록 + 문서 블록의 base64 글자 수 합(≈ 10MiB PDF 하나). 그림은 먼저 센다(이미 받은 것 — 빼지 않는다),
 * PDF 는 남은 자리에 드는 것만 앞에서부터 넣고(넣으면 넘는 PDF 는 경로 줄만, 뒤의 PDF 가 남은 자리에 들면 넣는다).
 * 근거(probe29): Claude CLI 는 요청마다 대화 전체의 그림·문서 base64 합이 24MiB 를 넘으면 오래된 것부터 오류 없이 빼서 14MiB 아래로
 * 맞춘다 — 한 메시지가 그 아래면 앞 차례의 것이 있어도 이번 것은 남는다
 */
export const MEDIA_INLINE_MAX_B64 = 13.5 * 1024 * 1024;
/**
 * 문서 블록으로 넘길 PDF 의 쪽수 상한 — 쪽수를 알 때만 넣는다(못 세면 경로 줄만 — pdfPageCount). 쪽당 ~1.1–1.6k 토큰(probe29) →
 * 100쪽 ≈ 155k 토큰, 그 뒤 모든 차례가 그만큼 읽는다. API 상한(이 모델 600쪽)을 넘으면 CLI 가 그 문서만 빼고 이어 간다(세션은 멀쩡)
 */
export const PDF_INLINE_MAX_PAGES = 100;
/** 보내기 실패의 머리 — 뒤에 ' — <이유 첫 줄>' */
export const ATTACH_FAILED = '파일을 보내지 못했어요';
/** 기록의 칩을 눌렀는데 그 에이전트 첨부 폴더에 그 사본이 없다(이름이 틀림·폴더 밖·지워짐) — openAttachment */
export const ATTACH_NOT_FOUND = '첨부 파일을 찾을 수 없어요';
/** 사본은 있는데 Windows 가 열지 못했다(연결된 프로그램 없음 등) — openAttachment */
export const ATTACH_OPEN_FAILED = '첨부 파일을 열지 못했어요';

/**
 * 기본 앱으로 열어도 되는 종류 — **허용 목록**(문서·그림·소리·영상·zip). 칩을 누르면 이것만 열고, 그 밖(프로그램·스크립트·바로 가기·
 * 프로젝트 파일·디스크 이미지·웹 페이지·svg·xml·확장자 없음 …)은 열지 않고 탐색기에서 그 파일을 보인다 — Claude 도 첨부 폴더를 읽고 쓸 수
 * 있고, 실행되는 종류는 다 꼽을 수 없다(연결은 PC 마다 다르다). 그래서 막을 것을 꼽지 않고 열 것만 꼽는다.
 * 빼 둔 것: svg·html(브라우저에서 스크립트가 돈다) · xml(엉뚱한 처리기에 연결되기도 한다) · 7z·rar(처리기가 PC 마다 다르다 — zip 은 탐색기가 연다)
 */
const DOCUMENT_EXT: ReadonlySet<string> = new Set([
  // 글·표·문서
  'pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'hwp', 'hwpx',
  // 그림
  'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'heif',
  // 소리·영상
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv',
  // 묶음 — 탐색기가 연다
  'zip',
]);

/** 기본 앱으로 열어도 되는 문서·그림 등인가 — 허용 목록(DOCUMENT_EXT)의 확장자일 때만 true. 그 밖·확장자 없음은 false(탐색기에서 보이기) */
export function opensAsDocument(fileName: string): boolean {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  return DOCUMENT_EXT.has(base.slice(dot + 1).toLowerCase());
}
