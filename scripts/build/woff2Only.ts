import type { Plugin } from 'vite'

/** @fontsource CSS 의 `, url(…woff) format('woff')` 소스를 지운다 — woff2 만 쓴다. */
export function stripWoffSources(css: string): string {
  return css.replace(/,\s*url\([^)]*?\.woff\)\s*format\(['"]woff['"]\)/g, '')
}

export function woff2Only(): Plugin {
  return {
    name: 'dure:woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@fontsource') || !id.split('?')[0].endsWith('.css')) return null
      return { code: stripWoffSources(code), map: null }
    },
  }
}
