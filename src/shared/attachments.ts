// 파일 첨부 — 화면(renderer)과 엔진(main)이 같이 쓰는 상한·문구. 렌더러가 먼저 막고, 엔진이 fs.stat 으로 다시 잰다(렌더러 값을 믿지 않는다)

/** 파일 하나 상한 — 100MB(정확히 100MB 는 보낸다) */
export const ATTACH_MAX_BYTES = 100 * 1024 * 1024;
/** 상한을 넘는 파일 */
export const ATTACH_TOO_BIG = '100MB 보다 큰 파일은 보낼 수 없어요';
/** 보내기 실패의 머리 — 뒤에 ' — <이유 첫 줄>' */
export const ATTACH_FAILED = '파일을 보내지 못했어요';
/** 기록의 칩을 눌렀는데 그 에이전트 첨부 폴더에 그 사본이 없다(이름이 틀림·폴더 밖·지워짐) — openAttachment */
export const ATTACH_NOT_FOUND = '첨부 파일을 찾을 수 없어요';
/** 사본은 있는데 Windows 가 열지 못했다(연결된 프로그램 없음 등) — openAttachment */
export const ATTACH_OPEN_FAILED = '첨부 파일을 열지 못했어요';

/**
 * 기본 앱으로 열면 **실행되는** 종류(프로그램·스크립트·바로 가기·설치 파일·레지스트리 등 — Windows 첨부 파일 관리자의 위험 종류 바탕).
 * 칩을 누르면 이것들은 열지 않고 탐색기에서 그 파일을 보인다(Claude 도 첨부 폴더를 읽고 쓸 수 있다 — 누르기 한 번으로 돌지 않게)
 */
const RUNNABLE_EXT = new Set([
  'ade', 'adp', 'app', 'appref-ms', 'application', 'appx', 'appxbundle', 'asp', 'aspx', 'bas', 'bat', 'bgi', 'cer', 'chm', 'cmd', 'cnt', 'com',
  'cpl', 'crt', 'csh', 'der', 'diagcab', 'exe', 'fxp', 'gadget', 'grp', 'hlp', 'hpj', 'hta', 'htc', 'inf', 'ins', 'isp', 'its', 'jar', 'jnlp',
  'js', 'jse', 'ksh', 'library-ms', 'lnk', 'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mau', 'mav', 'maw', 'mcf', 'mda', 'mdb',
  'mde', 'mdt', 'mdw', 'mdz', 'msc', 'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml', 'msi', 'msix', 'msixbundle', 'msp', 'mst', 'msu',
  'ops', 'osd', 'pcd', 'pif', 'pl', 'plg', 'prf', 'prg', 'printerexport', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psd1', 'psdm1',
  'psm1', 'pssc', 'py', 'pyc', 'pyo', 'pyw', 'pyz', 'pyzw', 'reg', 'scf', 'scr', 'sct', 'search-ms', 'settingcontent-ms', 'shb', 'shs',
  'theme', 'url', 'vb', 'vbe', 'vbp', 'vbs', 'vhd', 'vhdx', 'vsmacros', 'vsw', 'webpnp', 'website', 'ws', 'wsc', 'wsf', 'wsh', 'xbap', 'xll', 'xnk',
]);

/** 기본 앱으로 열어도 되는 문서·그림인가 — 실행되는 종류이거나 확장자가 없으면 false(탐색기에서 보이기) */
export function opensAsDocument(fileName: string): boolean {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  return !RUNNABLE_EXT.has(base.slice(dot + 1).toLowerCase());
}
