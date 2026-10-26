import { expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

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
