// 붙여 넣은 이미지 준비 — Claude 에 보낼 수 있는 크기로 줄인다(Review Focus 4).
// 원본이 너무 크면 줄인 것만 보낸다. 못 줄이면 안내 문구 — 원본은 절대 그대로 보내지 않는다.

/** 붙일 수 있는 형식 — 파일 고르기의 accept 에도 쓴다 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** 긴 변 상한(px) — 이보다 크면 Claude 쪽에서도 줄인다 */
const MAX_EDGE = 1568
/** 한 장 상한 — 보낼 글(base64) 기준 5MB */
const MAX_SENT = 5 * 1024 * 1024
/** 줄여도 크면 JPEG 로 이 품질 순서대로 다시 */
const JPEG_QUALITIES = [0.85, 0.7] as const

export const IMAGE_WRONG_TYPE = '이 형식은 붙일 수 없어요'
export const IMAGE_TOO_BIG = '이미지가 너무 커요 — 더 작은 이미지를 붙여 주세요'
export const IMAGE_UNREADABLE = '이미지를 읽지 못했어요'

export type PreparedImage = { mediaType: string; base64: string; bytes: number }

/** 이미지 읽기·그리기·저장 — 테스트는 바꿔 끼운다(jsdom 엔 캔버스가 없다) */
export interface ImageDeps {
  decode(file: Blob): Promise<{ width: number; height: number; image: unknown; close?: () => void }>
  /** w×h 캔버스에 그린다 — opaque 면 투명한 곳을 흰 바탕으로(JPEG 는 투명을 못 담는다) */
  draw(image: unknown, w: number, h: number, opaque: boolean): unknown
  encode(canvas: unknown, type: string, quality?: number): Promise<Blob>
}

const defaultDeps: ImageDeps = {
  async decode(file) {
    const bmp = await createImageBitmap(file)
    return { width: bmp.width, height: bmp.height, image: bmp, close: () => bmp.close() }
  },
  draw(image, w, h, opaque) {
    const canvas = new OffscreenCanvas(w, h)
    const g = canvas.getContext('2d')
    if (!g) throw new Error('canvas')
    if (opaque) {
      // 그림 내용의 바탕(화면 테마 색 아님) — JPEG 로 바꿀 때 투명한 곳이 검게 되지 않게
      g.fillStyle = 'white'
      g.fillRect(0, 0, w, h)
    }
    g.imageSmoothingQuality = 'high'
    g.drawImage(image as CanvasImageSource, 0, 0, w, h)
    return canvas
  },
  encode(canvas, type, quality) {
    return (canvas as OffscreenCanvas).convertToBlob({ type, quality })
  },
}

/** n 바이트를 base64 로 쓰면 몇 글자인가 */
const sentSize = (bytes: number) => 4 * Math.ceil(bytes / 3)
const fits = (blob: Blob) => sentSize(blob.size) <= MAX_SENT

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export async function prepareImage(
  file: Blob,
  deps: Partial<ImageDeps> = {},
): Promise<PreparedImage | { error: string }> {
  const d = { ...defaultDeps, ...deps }
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return { error: IMAGE_WRONG_TYPE }

  let decoded: Awaited<ReturnType<ImageDeps['decode']>>
  try {
    decoded = await d.decode(file)
  } catch {
    return { error: IMAGE_UNREADABLE }
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height))
    const w = Math.max(1, Math.round(decoded.width * scale))
    const h = Math.max(1, Math.round(decoded.height * scale))

    let blob = file
    let type = file.type
    if (scale < 1) {
      // 캔버스는 GIF 를 만들지 못한다 — 줄인 GIF 는 PNG 로
      type = type === 'image/gif' ? 'image/png' : type
      blob = await d.encode(d.draw(decoded.image, w, h, false), type)
    }
    if (!fits(blob)) {
      const flat = d.draw(decoded.image, w, h, true)
      for (const q of JPEG_QUALITIES) {
        type = 'image/jpeg'
        blob = await d.encode(flat, type, q)
        if (fits(blob)) break
      }
    }
    if (!fits(blob)) return { error: IMAGE_TOO_BIG }
    return { mediaType: type, base64: await toBase64(blob), bytes: blob.size }
  } catch {
    // 다시 그리기가 실패(메모리 등) — 원본으로 물러서지 않는다
    return { error: IMAGE_TOO_BIG }
  } finally {
    decoded.close?.()
  }
}
