// 휴대폰 화면(mobile.html)인가 — 화면 코드는 PC 창과 같고, 휴대폰에서 못 하는 일(폴더 고르기·탐색기·저장 창)만 이걸로 가린다.
// words.ts 가 이 파일을 쓰고 엔진 쪽 시험도 words.ts 를 읽는다 — window.dure 의 전역 타입(env.d.ts) 없이도 컴파일되게 globalThis 로 읽는다

type Upload = (file: File, signal?: AbortSignal) => Promise<{ path: string; name: string; bytes: number }>

/**
 * 휴대폰 표시 — 휴대폰의 window.dure(src/renderer/mobile/wsApi 의 createWsApi)만 이 칸이 true 다.
 * 메서드 이름(uploadFile 등)으로 가리지 않는다 — PC 의 preload 에 같은 이름이 생겨도 PC 가 휴대폰으로 보이지 않게.
 * Symbol.for — 시험이 모듈을 다시 불러도(vi.resetModules) 같은 표시
 */
export const PHONE_MARK: unique symbol = Symbol.for('dure.phone')

const current = (): unknown => (globalThis as { dure?: unknown }).dure

/** 이 api 를 휴대폰 것으로 표시한다 — createWsApi 와 휴대폰 화면 시험의 가짜만 부른다 */
export function markPhone<T extends object>(api: T): T {
  Object.defineProperty(api, PHONE_MARK, { value: true, enumerable: false })
  return api
}

/** 이 window.dure 가 휴대폰 것(WebSocket)인가 — 표시(PHONE_MARK)로만 안다. PC 창의 preload 엔 없다 */
export function onPhone(api: unknown = current()): boolean {
  return !!api && typeof api === 'object' && (api as { [PHONE_MARK]?: unknown })[PHONE_MARK] === true
}

/** 휴대폰의 올리기 — 휴대폰 파일을 PC 의 받은 폴더에 올리고, 그 PC 경로를 sendUser 의 file part 로 쓴다. signal 로 끊는다. PC 창이면 null */
export function phoneUpload(): Upload | null {
  const api = current() as { uploadFile?: Upload } | undefined
  if (!api || !onPhone(api) || typeof api.uploadFile !== 'function') return null
  return (file, signal) => api.uploadFile!(file, signal)
}
