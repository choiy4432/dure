import { describe, it, expect, vi } from 'vitest'
import { prepareImage, type ImageDeps } from '../../src/renderer/lib/image'

const MB = 1024 * 1024
const WRONG = '이 형식은 붙일 수 없어요'
const TOO_BIG = '이미지가 너무 커요 — 더 작은 이미지를 붙여 주세요'

/** 크기만 있는 가짜 파일 — 내용은 0 바이트로 채운다 */
const blobOf = (bytes: number, type: string) => new Blob([new Uint8Array(bytes)], { type })

/**
 * 캔버스·이미지 읽기를 흉내 낸다 — jsdom 엔 캔버스가 없다.
 * encode 는 형식·품질에 따라 정해 둔 크기의 결과를 돌려준다.
 */
function fakeDeps(o: {
  width: number
  height: number
  sizes?: (type: string, quality: number | undefined) => number
}) {
  const close = vi.fn()
  const decode = vi.fn(async (_file: Blob) => ({ width: o.width, height: o.height, image: 'IMG', close }))
  const draw = vi.fn((_image: unknown, w: number, h: number, opaque: boolean) => ({ w, h, opaque }))
  const encode = vi.fn(async (_canvas: unknown, type: string, quality?: number) =>
    blobOf(o.sizes ? o.sizes(type, quality) : 1000, type),
  )
  const deps: ImageDeps = { decode, draw, encode }
  return { deps, decode, draw, encode, close }
}

describe('prepareImage — 형식', () => {
  it.each(['image/bmp', 'image/svg+xml', 'application/pdf', ''])('%s 는 거절 — 읽지도 않는다', async type => {
    const f = fakeDeps({ width: 10, height: 10 })
    expect(await prepareImage(blobOf(10, type), f.deps)).toEqual({ error: WRONG })
    expect(f.decode).not.toHaveBeenCalled()
  })

  it('읽지 못하는 이미지는 안내 — 원본을 보내지 않는다', async () => {
    const f = fakeDeps({ width: 10, height: 10 })
    f.decode.mockRejectedValueOnce(new Error('broken'))
    const r = await prepareImage(blobOf(10, 'image/png'), f.deps)
    expect(r).toEqual({ error: '이미지를 읽지 못했어요' })
  })
})

describe('prepareImage — 작은 이미지', () => {
  it('긴 변 1568 이하 · 5MB 아래면 원본 그대로(다시 그리지 않음), base64 는 실제 내용', async () => {
    const f = fakeDeps({ width: 1200, height: 800 })
    const file = new Blob([new Uint8Array([104, 105, 33])], { type: 'image/png' }) // 'hi!'
    const r = await prepareImage(file, f.deps)
    expect(r).toEqual({ mediaType: 'image/png', base64: 'aGkh', bytes: 3, blob: file })
    expect(f.draw).not.toHaveBeenCalled()
    expect(f.encode).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalled()
  })

  it.each(['image/jpeg', 'image/webp', 'image/gif'])('%s 도 받는다', async type => {
    const f = fakeDeps({ width: 100, height: 100 })
    const r = await prepareImage(blobOf(30, type), f.deps)
    expect(r).toMatchObject({ mediaType: type, bytes: 30 })
  })
})

describe('prepareImage — 큰 이미지(Review Focus 4)', () => {
  it('8000×4000 스크린샷은 긴 변 1568 로 줄인다 — 같은 형식으로', async () => {
    const f = fakeDeps({ width: 8000, height: 4000, sizes: () => 2 * MB })
    const r = await prepareImage(blobOf(20 * MB, 'image/png'), f.deps)
    expect(f.draw).toHaveBeenCalledWith('IMG', 1568, 784, false)
    expect(f.encode).toHaveBeenCalledTimes(1)
    expect(f.encode.mock.calls[0][1]).toBe('image/png')
    expect(r).toMatchObject({ mediaType: 'image/png', bytes: 2 * MB })
  })

  it('세로로 긴 이미지도 긴 변 기준', async () => {
    const f = fakeDeps({ width: 1000, height: 6272 })
    await prepareImage(blobOf(MB, 'image/webp'), f.deps)
    expect(f.draw).toHaveBeenCalledWith('IMG', 250, 1568, false)
  })

  it('줄인 GIF 는 PNG 로(캔버스는 GIF 를 못 만든다)', async () => {
    const f = fakeDeps({ width: 3000, height: 3000 })
    const r = await prepareImage(blobOf(MB, 'image/gif'), f.deps)
    expect(f.encode.mock.calls[0][1]).toBe('image/png')
    expect(r).toMatchObject({ mediaType: 'image/png' })
  })

  it('줄여도 5MB 가 넘으면 JPEG 0.85 로 다시 — 투명한 곳은 흰 바탕', async () => {
    const f = fakeDeps({
      width: 8000, height: 4000,
      sizes: (type, q) => (type === 'image/png' ? 9 * MB : q === 0.85 ? 3 * MB : 1 * MB),
    })
    const r = await prepareImage(blobOf(20 * MB, 'image/png'), f.deps)
    expect(f.encode.mock.calls.map(c => [c[1], c[2]])).toEqual([['image/png', undefined], ['image/jpeg', 0.85]])
    expect(f.draw).toHaveBeenLastCalledWith('IMG', 1568, 784, true)
    expect(r).toMatchObject({ mediaType: 'image/jpeg', bytes: 3 * MB })
  })

  it('0.85 로도 넘으면 0.7 로', async () => {
    const f = fakeDeps({
      width: 8000, height: 4000,
      sizes: (type, q) => (type === 'image/png' ? 9 * MB : q === 0.85 ? 6 * MB : 3.5 * MB),
    })
    const r = await prepareImage(blobOf(20 * MB, 'image/png'), f.deps)
    expect(f.encode.mock.calls.map(c => [c[1], c[2]])).toEqual([
      ['image/png', undefined], ['image/jpeg', 0.85], ['image/jpeg', 0.7],
    ])
    expect(r).toMatchObject({ mediaType: 'image/jpeg', bytes: 3.5 * MB })
  })

  it('5MB 는 보낼 글(base64) 기준 — 원본 4.5MB 는 base64 로 6MB 라 다시 줄인다', async () => {
    const f = fakeDeps({ width: 1200, height: 900, sizes: () => 2 * MB })
    const r = await prepareImage(blobOf(4.5 * MB, 'image/png'), f.deps)
    expect(f.draw).toHaveBeenCalledWith('IMG', 1200, 900, true) // 크기는 그대로, JPEG 로만
    expect(f.encode.mock.calls.map(c => [c[1], c[2]])).toEqual([['image/jpeg', 0.85]])
    expect(r).toMatchObject({ mediaType: 'image/jpeg', bytes: 2 * MB })
  })

  it('0.7 로도 넘으면 "이미지가 너무 커요" — 원본도 줄인 것도 보내지 않는다', async () => {
    const f = fakeDeps({ width: 8000, height: 8000, sizes: () => 6 * MB })
    const r = await prepareImage(blobOf(20 * MB, 'image/png'), f.deps)
    expect(r).toEqual({ error: TOO_BIG })
    expect(f.encode).toHaveBeenCalledTimes(3)
    expect(f.close).toHaveBeenCalled()
  })

  it('다시 그리기가 실패해도 원본을 보내지 않는다', async () => {
    const f = fakeDeps({ width: 8000, height: 4000 })
    f.encode.mockRejectedValue(new Error('no memory'))
    const r = await prepareImage(blobOf(20 * MB, 'image/png'), f.deps)
    expect(r).toEqual({ error: TOO_BIG })
  })
})
