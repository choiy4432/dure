// 휴대폰 아이콘·매니페스트 — 안드로이드 maskable(가운데 안전 영역) · 아이폰 홈 화면(불투명) · 다크에서도 맞는 색
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { MOBILE_ICONS } from '../scripts/build/mobileIcons'

const ROOT = path.join(__dirname, '..')
const ICONS = path.join(ROOT, 'resources/icon/mobile')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/public/manifest.webmanifest'), 'utf8')) as {
  background_color?: string
  theme_color?: string
  icons: { src: string; sizes: string; type: string; purpose: string }[]
}
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/mobile.html'), 'utf8')

/** 8비트 PNG(RGB·RGBA, 비월 없음 — 크로미움 캡처) → 화소. 거르기(filter) 0~4 를 되돌린다 */
function decodePng(buf: Buffer) {
  let off = 8
  let width = 0
  let height = 0
  let depth = 0
  let ctype = 0
  let interlace = 0
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      ctype = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  expect(depth).toBe(8)
  expect(interlace).toBe(0)
  const channels = ctype === 6 ? 4 : ctype === 2 ? 3 : 0
  expect(channels).toBeGreaterThan(0)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const px = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0
      let v = raw[y * (stride + 1) + 1 + x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[y * stride + x] = v & 255
    }
  }
  const at = (x: number, y: number) => {
    const i = y * stride + x * channels
    return { r: px[i], g: px[i + 1], b: px[i + 2], a: channels === 4 ? px[i + 3] : 255 }
  }
  return { width, height, at }
}
const png = (file: string) => decodePng(fs.readFileSync(path.join(ICONS, file)))
const luminance = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

describe('휴대폰 아이콘 · 매니페스트', () => {
  it('매니페스트 색 — 다크에서도 흰 화면이 번쩍이지 않게 어두운 중립색', () => {
    for (const c of [manifest.background_color, manifest.theme_color]) {
      if (c === undefined) continue
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(luminance(c)).toBeLessThan(0.05)
    }
    expect(manifest.background_color).toBeDefined()
  })

  it('maskable 512 — 매니페스트에 있고, 꽉 찬 불투명 판 · 마크는 가운데 안전 영역(반지름 40%) 안', () => {
    const m = manifest.icons.find((i) => i.purpose === 'maskable')!
    expect(m).toMatchObject({ src: '/icons/dure-maskable-512.png', sizes: '512x512', type: 'image/png' })
    // 투명 모서리 판(any)도 그대로
    expect(manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.src)).toEqual(['/icons/dure-192.png', '/icons/dure-512.png'])
    const p = png('dure-maskable-512.png')
    expect([p.width, p.height]).toEqual([512, 512])
    const half = p.width / 2
    for (let y = 0; y < p.height; y += 2) {
      for (let x = 0; x < p.width; x += 2) {
        const c = p.at(x, y)
        expect(c.a).toBe(255)
        // 안전 영역 밖은 판 색(파랑 + 옅은 윤기)뿐 — 흰 마크가 없다
        if (Math.hypot(x + 0.5 - half, y + 0.5 - half) > p.width * 0.4) expect(c.r).toBeLessThan(90)
      }
    }
    // 마크(흰색)가 실제로 그려졌다
    expect(p.at(half, half).r).toBeLessThan(90)
    let white = 0
    for (let x = 0; x < p.width; x++) if (p.at(x, Math.round(p.height * 0.73)).r > 200) white++
    expect(white).toBeGreaterThan(10)
  })

  it('아이폰 홈 화면(apple-touch-icon) — 180px · 투명한 곳 없음(모서리가 검게 보이지 않게)', () => {
    expect(html).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="\/icons\/dure-apple-180.png" \/>/)
    expect(html).not.toMatch(/apple-touch-icon"[^>]*dure-192/)
    const p = png('dure-apple-180.png')
    expect([p.width, p.height]).toEqual([180, 180])
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) expect(p.at(x, y).a).toBe(255)
    // 모서리도 판 색
    const corner = p.at(0, p.height - 1)
    expect(corner.b).toBeGreaterThan(200)
    expect(corner.r).toBeLessThan(90)
  })

  it('빌드가 싣는 아이콘 — 매니페스트·mobile.html·알림이 부르는 파일이 모두 있다', () => {
    const wanted = new Set([
      ...manifest.icons.map((i) => i.src),
      ...[...html.matchAll(/href="(\/icons\/[^"]+)"/g)].map((m) => m[1]),
      '/icons/dure-192.png',
      '/icons/dure-badge-96.png',
    ])
    for (const src of wanted) {
      const f = src.replace('/icons/', '')
      expect(MOBILE_ICONS as readonly string[]).toContain(f)
      expect(fs.existsSync(path.join(ICONS, f))).toBe(true)
    }
  })
})
