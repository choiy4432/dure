import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 휴대폰 css(mobile.css — 휴대폰 묶음에만 실린다)의 규칙 — jsdom 은 배치를 셈하지 않아 규칙 글로 본다(진짜 모습은 캡처로)
const read = (p: string) => fs.readFileSync(path.join(__dirname, '../src/renderer', p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const mobile = read('mobile/mobile.css')
const base = read('styles/base.css')

/** 고른 꼴(selector)이 든 규칙들의 선언을 합친다 — 여러 꼴을 쉼표로 묶은 규칙도 */
function decls(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map(s => s.trim().replace(/\s+/g, ' '))
    if (!sels.includes(selector)) continue
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':')
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim()
    }
  }
  return out
}
const px = (v: string | undefined) => Number(/^(-?[\d.]+)px$/.exec(v ?? '')?.[1] ?? NaN)

describe('mobile.css', () => {
  it('설정 판의 모델 목록은 칩 오른쪽 끝에 맞춰 왼쪽으로 펼친다 — 화면 밖으로 나가지 않게(너비도 화면 안)', () => {
    const d = decls(mobile, '.m-set .pop')
    expect(d.left).toBe('auto')
    expect(d.right).toBe('0')
    expect(d['max-width']).toMatch(/100vw/)
    expect(d['transform-origin']).toMatch(/top right/)
  })

  it('PC 와 같이 쓰는 작은 단추도 누르는 칸은 44px 이상 — 메시지 ⋯ · 첨부 빼기 · 경고 닫기(보이는 크기는 그대로)', () => {
    const cases: [string, string][] = [
      ['.ib.xs', '.m-agent .ib.xs::before'],
      ['.ib.xs', '.m-inbox .ib.xs::before'],
      ['.att-x', '.m-agent .att-x::before'],
      ['.band-x', '.m-agent .band-x::before'],
    ]
    for (const [part, hit] of cases) {
      const size = px(decls(base, part).width)
      const d = decls(mobile, hit)
      expect(d.content, hit).toBe("''")
      expect(d.position, hit).toBe('absolute')
      const inset = px(d.inset)
      expect(size + 2 * -inset, hit).toBeGreaterThanOrEqual(44)
    }
    expect(decls(mobile, '.m-agent .ib.xs').position).toBe('relative')
    expect(decls(mobile, '.m-agent .band-x').position).toBe('relative')
  })

  it('한국어 어절 줄바꿈(keep-all)은 body 에 — 판·대화상자는 .m-app 밖(body 바로 아래)에 그려진다', () => {
    const d = decls(mobile, 'body')
    expect(d['word-break']).toBe('keep-all')
    expect(d['overflow-wrap']).toBe('anywhere')
  })
})
