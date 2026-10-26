// 두레 아이콘 굽기 — resources/icon/*.svg → resources/icon.png(256) · resources/icon.ico(16~256, PNG 칸)
// 작은 크기는 따로 그린 판을 쓴다: 16 = dure-16.svg · 20·24 = dure-24.svg · 32~48 = dure-48.svg · 64 이상 = dure.svg
// 쓰는 법: node scripts/icon/build.mjs   (Playwright 크로미움으로 그린다 — 다른 크로미움이면 CHROMIUM_PATH)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = path.join(ROOT, 'resources/icon')
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
const sourceFor = (s) => (s <= 16 ? 'dure-16.svg' : s <= 24 ? 'dure-24.svg' : s <= 48 ? 'dure-48.svg' : 'dure.svg')

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const page = await browser.newPage({ deviceScaleFactor: 1 })
const pngs = []
for (const size of SIZES) {
  const svg = fs.readFileSync(path.join(SRC, sourceFor(size)), 'utf8')
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`)
  pngs.push({ size, data: await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }) })
}
await browser.close()

// ICO — 머리 6바이트 + 칸마다 16바이트 + PNG 그대로(Vista 이후 모든 크기에 PNG 칸을 읽는다)
const head = Buffer.alloc(6)
head.writeUInt16LE(0, 0)
head.writeUInt16LE(1, 2)
head.writeUInt16LE(pngs.length, 4)
let offset = 6 + 16 * pngs.length
const dir = pngs.map(({ size, data }) => {
  const e = Buffer.alloc(16)
  e.writeUInt8(size >= 256 ? 0 : size, 0)
  e.writeUInt8(size >= 256 ? 0 : size, 1)
  e.writeUInt8(0, 2)
  e.writeUInt8(0, 3)
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(data.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += data.length
  return e
})
fs.writeFileSync(path.join(ROOT, 'resources/icon.ico'), Buffer.concat([head, ...dir, ...pngs.map((p) => p.data)]))
fs.writeFileSync(path.join(ROOT, 'resources/icon.png'), pngs.find((p) => p.size === 256).data)
console.log('icon.ico', pngs.map((p) => p.size).join(' · '), '/ icon.png 256')
