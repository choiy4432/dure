import { describe, it, expect } from 'vitest'
import { stripWoffSources, woff2Only } from '../scripts/build/woff2Only'

describe('stripWoffSources', () => {
  it('woff 소스만 지운다', () => {
    expect(stripWoffSources("src: url(./a.woff2) format('woff2'), url(./a.woff) format('woff');")).toBe(
      "src: url(./a.woff2) format('woff2');",
    )
  })
  it('woff2 만 있으면 그대로', () => {
    const css = "src: url(./a.woff2) format('woff2');"
    expect(stripWoffSources(css)).toBe(css)
  })
})

describe('woff2Only plugin', () => {
  it('@fontsource CSS 만 바꾼다', () => {
    const p = woff2Only() as { enforce?: string; transform: (code: string, id: string) => unknown }
    expect(p.enforce).toBe('pre')
    const css = "src: url(./a.woff2) format('woff2'), url(./a.woff) format('woff');"
    expect(p.transform(css, '/x/node_modules/@fontsource/a/index.css')).toEqual({
      code: "src: url(./a.woff2) format('woff2');",
      map: null,
    })
    expect(p.transform(css, '/x/src/app.css')).toBeNull()
  })
})
