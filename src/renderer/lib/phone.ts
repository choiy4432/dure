// 휴대폰 화면(mobile.html)인가 — 화면 코드는 PC 창과 같고, 휴대폰에서 못 하는 일(폴더 고르기·탐색기·저장 창)만 이걸로 가린다.
// words.ts 가 이 파일을 쓰고 엔진 쪽 시험도 words.ts 를 읽는다 — window.dure 의 전역 타입(env.d.ts) 없이도 컴파일되게 globalThis 로 읽는다

type Upload = (file: File) => Promise<{ path: string; name: string; bytes: number }>

const current = (): unknown => (globalThis as { dure?: unknown }).dure

/**
 * 이 window.dure 가 휴대폰 것(WebSocket, src/renderer/mobile/wsApi)인가 — 휴대폰 것만 uploadFile 이 있다(휴대폰 파일엔 PC 경로가 없어 올린다).
 * PC 창의 preload 엔 없다
 */
export function onPhone(api: unknown = current()): boolean {
  return !!api && typeof (api as { uploadFile?: unknown }).uploadFile === 'function'
}

/** 휴대폰의 올리기 — 휴대폰 파일을 PC 의 받은 폴더에 올리고, 그 PC 경로를 sendUser 의 file part 로 쓴다. PC 창이면 null */
export function phoneUpload(): Upload | null {
  const api = current() as { uploadFile?: Upload } | undefined
  if (!api || !onPhone(api)) return null
  return file => api.uploadFile!(file)
}
