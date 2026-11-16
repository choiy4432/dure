import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 파워 모드 덮개는 테마와 상관없이 늘 어둡다 — .pw 가 tokens.css 다크 블록의 토큰을 빠짐없이 같은 값으로 다시 선언해야 하고
// (덮개 안 대화 패널이 쓰는 토큰이 하나라도 빠지면 밝은 값이 새어 든다), 그 밖의 pw- 규칙에는 색 값을 직접 쓰지 않는다.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = strip(fs.readFileSync(path.resolve('src/renderer/styles/tokens.css'), 'utf8'))
const power = strip(fs.readFileSync(path.resolve('src/renderer/power/power.css'), 'utf8'))
const varsOf = (block: string) => new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))
const dark = varsOf(tokens.slice(tokens.indexOf('@media (prefers-color-scheme: dark)')))
const pwBlocks = [...power.matchAll(/(?:^|\n)\.pw \{([^}]*)\}/g)].map(m => m[1])

describe('덮개 토큰', () => {
  it('pw_가_다시_선언한_토큰은_다크_값과_같다', () => {
    const redeclared = [...varsOf(pwBlocks.join('\n'))].filter(([k]) => !k.startsWith('--pw-'))
    expect(redeclared.length).toBeGreaterThan(10)
    for (const [k, v] of redeclared) expect({ k, v: dark.get(k) }).toEqual({ k, v })
  })

  it('pw_가_tokens.css_다크_블록의_토큰을_전부_다시_선언한다', () => {
    const pw = varsOf(pwBlocks.join('\n'))
    expect(dark.size).toBeGreaterThan(50)
    const missing = [...dark.keys()].filter(k => !pw.has(k))
    expect(missing).toEqual([])
    expect(pwBlocks.join('\n')).toMatch(/color-scheme:\s*dark/)
  })

  it('pw_규칙에_색_값을_직접_쓰지_않는다(.pw_블록의_이름_붙은_변수만)', () => {
    let rest = power
    for (const b of pwBlocks) rest = rest.replace(b, '')
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []).toEqual([])
  })

  it('둥근_모서리는_tokens.css_의_--radius-*_만_쓴다(앱의_base.css_처럼_—_0_은_예외)', () => {
    const radii = [...power.matchAll(/border-radius:\s*([^;}]+)/g)].map(m => m[1].trim())
    expect(radii.length).toBeGreaterThan(10)
    const known = new Set([...tokens.matchAll(/(--radius-[\w-]+)\s*:/g)].map(m => m[1]))
    for (const r of radii) {
      if (r === '0') continue
      const used = [...r.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1])
      expect({ r, tokenOnly: used.length > 0 && used.every(v => known.has(v)) && r.replace(/var\(--[\w-]+\)|calc\(|\)|[-+\s\d.px]/g, '') === '' }).toEqual({ r, tokenOnly: true })
    }
  })

  it('애니메이션은_차분_모드와_모션_줄이기_둘_다에서_꺼진다', () => {
    const names = [...power.matchAll(/@keyframes (pw-[\w-]+)/g)].map(m => m[1])
    expect(names.length).toBeGreaterThan(0)
    const media = power.slice(power.indexOf('@media (prefers-reduced-motion: reduce)'))
    for (const n of names) {
      const users = [...power.matchAll(/(\.pw-[\w-]+)\s*\{[^}]*animation:[^;}]*/g)]
        .filter(m => m[0].includes(n)).map(m => m[1])
      expect(users.length).toBeGreaterThan(0)
      for (const u of users) {
        expect(power).toMatch(new RegExp(`\\[data-calm\\][^{}]*${u.replace('.', '\\.')}\\b[^{]*\\{[^}]*animation: none`))
        expect(media).toContain(u)
      }
    }
  })
})
