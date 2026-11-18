import { expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// 앱 아이콘 — scripts/icon/build.mjs 가 굽는다. 윈도우 작업표시줄·제목·바탕화면 크기가 다 들어 있어야 흐리게 늘린 그림이 안 쓰인다
test('resources/icon.ico 는 16~256 여덟 크기(PNG 칸)', () => {
  const b = fs.readFileSync(path.resolve('resources/icon.ico'))
  expect(b.readUInt16LE(2)).toBe(1)
  const n = b.readUInt16LE(4)
  const sizes = Array.from({ length: n }, (_, i) => b[6 + 16 * i] || 256)
  expect(sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 256])
  for (let i = 0; i < n; i++) {
    const off = b.readUInt32LE(6 + 16 * i + 12)
    expect(b.subarray(off, off + 8).toString('hex')).toBe('89504e470d0a1a0a')
  }
})

test('창은 그 아이콘을 쓴다', () => {
  const main = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8')
  expect(main).toContain("join(__dirname, '../../resources/icon.ico')")
  expect(main).toMatch(/icon: appIcon/)
})

/** PNG 를 RGBA 화소로 — 8비트 RGBA(색 형식 6)만. 새 의존성 없이 zlib 으로 푼다 */
function readPng(file: string): { width: number; height: number; colorType: number; rgba: Buffer } {
  const b = fs.readFileSync(path.resolve(file))
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  let at = 8
  let width = 0
  let height = 0
  let colorType = -1
  let depth = 0
  const idat: Buffer[] = []
  while (at < b.length) {
    const len = b.readUInt32BE(at)
    const type = b.subarray(at + 4, at + 8).toString('latin1')
    const data = b.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    at += 12 + len
  }
  if (colorType !== 6 || depth !== 8) return { width, height, colorType, rgba: Buffer.alloc(0) }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0
      const p = a + up - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - c)
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? up : c
      rgba[y * stride + x] = (row[x] + pred) & 0xff
    }
  }
  return { width, height, colorType, rgba }
}

// mac — 메뉴 막대(트레이)는 템플릿 그림: 이름이 …Template 로 끝나고 검정 + 알파만(macOS 가 다크·라이트에 맞춰 칠한다). @2x 는 레티나
test('resources/trayTemplate.png 16 · @2x 32 — 검정 + 알파(RGBA), 그린 화소가 있다', () => {
  for (const [file, size] of [['resources/trayTemplate.png', 16], ['resources/trayTemplate@2x.png', 32]] as const) {
    const png = readPng(file)
    expect([png.width, png.height, png.colorType], file).toEqual([size, size, 6])
    let drawn = 0
    for (let i = 0; i < png.rgba.length; i += 4) {
      if (png.rgba[i + 3] === 0) continue
      drawn++
      expect([png.rgba[i], png.rgba[i + 1], png.rgba[i + 2]], `${file} 화소 ${i / 4}`).toEqual([0, 0, 0])
    }
    expect(drawn, file).toBeGreaterThan(size) // 빈 그림이 아니다
    expect(drawn, file).toBeLessThan(size * size) // 바탕은 투명
  }
})

// mac 번들 아이콘 — electron-builder 가 1024 PNG 를 icns 로 바꾼다(256 이면 흐리거나 실패)
test('resources/icon-1024.png 는 1024×1024 RGBA', () => {
  const png = readPng('resources/icon-1024.png')
  expect([png.width, png.height, png.colorType]).toEqual([1024, 1024, 6])
})
