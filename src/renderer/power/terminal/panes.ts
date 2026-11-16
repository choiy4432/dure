// 터미널 벽 창별 줄 만들기 — 순수. 같은 씨앗이면 같은 줄, 시각·Date·Math.random 을 쓰지 않는다(시간은 부르는 쪽이 흘린다).
import { mulberry32, oneLine, type ScreenEvent } from '../events'
import { BASH, FILES, GLOB, GREP, HAND, TASKS, TOOL_MIX, WEB } from '../fakeWorld'
import { CODE, FAILS, HUNKS, PROCS, REVIEW, SAY, SUB_DEFS, SUB_DONE, SUB_NEXT, TEST_FILES } from './data'

export type Color = 'ok' | 'er' | 'am' | 'bl' | 'dim' | 'vi' | 'cy' | 'add' | 'del' | 'gn'
export type Part = { t: string; c?: Color; b?: boolean }
/** key: 같은 key 의 줄은 새로 붙지 않고 그 자리를 바꾼다 · end: 그 key 의 줄을 지운다 · hd: 표 머리 바탕 */
export type Line = { parts: Part[]; key?: string; end?: boolean; hd?: boolean }
export type SubRow = { name: string; task: string; files: number; sec: number; pct: number }
export type Typing = { file: string; line: number; text: string; done: boolean; lineDone: boolean; idle: boolean }

const line = (...parts: Part[]): Line => ({ parts })
const p = (t: string, c?: Color, b?: boolean): Part => ({ t, c, b })
const blank = (): Line => ({ parts: [] })
const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const nf = (n: number) => Math.round(n).toLocaleString('ko-KR')
export const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const KW = /^(import|from|export|function|const|let|return|if|for|of|continue|async|await|type|as|new|throw)$/
const TOKEN = /('[^']*')|\b([A-Za-z_]+)\b|\b(\d+)\b/g

/** 한 줄 코드를 낱말 색으로 나눈다 — 주석은 통째로 dim, 문자열 초록, 예약어 보라, 숫자 노랑 */
export function highlight(text: string): Part[] {
  if (/^\s*\/\//.test(text)) return [p(text, 'dim')]
  const out: Part[] = []
  let at = 0
  for (const m of text.matchAll(TOKEN)) {
    const [all, str, word, num] = m
    const color: Color | undefined = str ? 'gn' : word && KW.test(word) ? 'vi' : num ? 'am' : undefined
    if (!color) continue
    if (m.index! > at) out.push(p(text.slice(at, m.index)))
    out.push(p(all, color))
    at = m.index! + all.length
  }
  if (at < text.length) out.push(p(text.slice(at)))
  return out
}

export type PaneNames = {
  /** 대표 말고 다른 에이전트의 이름 — 채움 넘김의 받는 이 */
  others?: string[]
  /** 진짜 넘김 사건의 id → 이름 */
  nameOf?: (id: string) => string
}

export function createPanes(seed: number, names: PaneNames = {}) {
  const others = names.others?.length ? names.others : ['구현', '테스트', '검토', '문서']
  const nameOf = names.nameOf ?? ((id: string) => id)
  const mk = (n: number) => {
    const rnd = mulberry32(seed + n * 7919)
    const R = (a: number, b: number) => a + rnd() * (b - a)
    const RI = (a: number, b: number) => Math.floor(R(a, b + 1))
    const P = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
    return { R, RI, P }
  }

  // ── 1 대표 에이전트 대화
  const a = mk(1)
  const think = { on: false, left: 0, sec: 0 }
  let actLeft = 5
  const endThink = (): Line[] => {
    if (!think.on) return []
    think.on = false
    return [{ parts: [], key: 'think', end: true }]
  }
  const result = (t: string): string =>
    ({
      Read: `${a.RI(40, 420)}줄 읽음`,
      Edit: `+${a.RI(1, 24)} −${a.RI(0, 12)}줄 바꿈`,
      Bash: a.P(['통과 · 오류 0', '종료 코드 0', '86개 파일 검사 · 문제 없음']),
      Grep: `${a.RI(2, 19)}곳에서 찾음`,
      Glob: `파일 ${a.RI(8, 120)}개`,
      Write: '새 파일 만듦',
      WebSearch: `결과 ${a.RI(6, 10)}개`,
      Task: '서브에이전트 시작',
    } as Record<string, string>)[t] ?? '끝'
  const toolLines = (tool: string, target: string): Line[] => [
    line(p('●', 'ok'), p(' '), p(tool, undefined, true), p('(', 'dim'), p(oneLine(target, 140)), p(')', 'dim')),
    line(p('  ⎿  ' + result(tool), 'dim')),
  ]
  const sendLines = (arrow: string, who: string, text: string): Line[] => [
    line(p('●', 'bl'), p(' '), p('send_message', undefined, true), p(`(${arrow} ${who})`, 'dim')),
    line(p(`  ⎿  "${oneLine(text, 140)}"`, 'dim')),
  ]
  const fillerTarget = (tool: string) =>
    a.P(({ Read: FILES, Edit: FILES, Write: FILES, Bash: BASH, Grep: GREP, Glob: GLOB, WebSearch: WEB, Task: TASKS } as Record<string, string[]>)[tool])

  function agent(ev: ScreenEvent | null, self?: string): Line[] {
    if (ev) {
      const drop = endThink()
      actLeft = Math.max(actLeft, 1)
      if (ev.kind === 'tool') return [...drop, ...toolLines(ev.tool, ev.target)]
      return [...drop, ...(ev.from === self || self === undefined ? sendLines('→', nameOf(ev.to), ev.text) : sendLines('←', nameOf(ev.from), ev.text))]
    }
    if (think.on || actLeft <= 0) {
      if (!think.on) {
        think.on = true
        think.sec = a.RI(2, 9)
        think.left = 5
      }
      think.sec++
      const out: Line[] = [{ parts: [p(`${a.P([...'✻✶✷✸✹✺'])} 생각 중…`, 'am'), p(' '), p(`(${think.sec}s · ↓ ${(think.sec * 0.31).toFixed(1)}k 토큰)`, 'dim')], key: 'think' }]
      if (--think.left <= 0) {
        out.push(...endThink())
        actLeft = a.RI(2, 5)
      }
      return out
    }
    const r = a.R(0, 1)
    let out: Line[]
    if (r < 0.6) {
      const tool = a.P(TOOL_MIX)
      out = toolLines(tool, fillerTarget(tool))
    } else if (r < 0.8) out = sendLines('→', a.P(others), a.P(HAND))
    else out = [blank(), line(p('  ' + a.P(SAY))), blank()]
    if (--actLeft <= 0) {
      actLeft = 0
      think.left = 0
    }
    return out
  }

  // ── 2 테스트
  const t = mk(2)
  const tst = { i: 0, pass: 0, fail: 0 }
  function tests(): Line[] {
    const out: Line[] = []
    if (tst.i === 0) out.push(line(p(' '), p('RERUN', 'cy'), p(` src/${t.P(TEST_FILES)}.ts `), p(`x${t.RI(1, 4)}`, 'dim')), blank())
    if (tst.i < TEST_FILES.length) {
      const f = TEST_FILES[tst.i++]
      const n = t.RI(4, 48)
      if (t.R(0, 1) < 0.08) {
        tst.fail++
        out.push(
          line(p(' '), p('✗', 'er'), p(` test/${f}.test.ts `), p(`(${n} | 1 실패)`, 'dim'), p(' '), p(`${t.RI(300, 1900)}ms`, 'am')),
          line(p(`   → ${t.P(FAILS)}`, 'er')),
          line(p(`   ❯ src/${f}.ts:${t.RI(20, 240)}:${t.RI(3, 40)}`, 'dim')),
        )
      } else {
        tst.pass += n
        out.push(line(p(' '), p('✓', 'ok'), p(` test/${f}.test.ts `), p(`(${n})  ${t.RI(40, 900)}ms`, 'dim')))
      }
      return out
    }
    out.push(
      blank(),
      line(p(' Test Files', 'dim'), p('  '), ...(tst.fail ? [p(`${tst.fail} failed`, 'er'), p(' | ', 'dim')] : []), p(`${TEST_FILES.length - tst.fail} passed`, 'ok'), p(` (${TEST_FILES.length})`, 'dim')),
      line(p('      Tests', 'dim'), p('  '), p(`${nf(tst.pass + 960)} passed`, 'ok')),
      line(p('   Duration', 'dim'), p(`  ${t.R(9, 16).toFixed(2)}s`)),
      blank(),
    )
    tst.i = tst.pass = tst.fail = 0
    return out
  }

  // ── 3 diff
  const d = mk(3)
  const dq: Line[] = []
  function diff(): Line[] {
    if (!dq.length) {
      const [f, h, lines] = d.P(HUNKS)
      dq.push(line(p(`diff --git a/${f} b/${f}`, undefined, true)), line(p(`--- a/${f}`, 'dim')), line(p(`+++ b/${f}`, 'dim')), line(p(h, 'cy')))
      for (const l of lines) dq.push(line(p(l, l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'dim')))
      if (d.R(0, 1) < 0.6) dq.push(blank(), line(p(d.P(REVIEW), d.R(0, 1) < 0.3 ? 'ok' : 'am')))
      dq.push(blank())
    }
    return [dq.shift()!]
  }

  // ── 4 코드 치기
  const c = mk(4)
  const typ = { ci: 0, li: 0, ch: 0, pause: 0 }
  function typing(): Typing {
    if (typ.pause > 0) {
      typ.pause--
      return { file: CODE[typ.ci][0], line: typ.li + 1, text: '', done: false, lineDone: false, idle: true }
    }
    const [file, lines] = CODE[typ.ci]
    const src = lines[typ.li]
    const n = typ.li + 1
    typ.ch = Math.min(src.length, typ.ch + c.RI(1, 3))
    const text = src.slice(0, typ.ch)
    const lineDone = typ.ch >= src.length
    let done = false
    if (lineDone) {
      typ.li++
      typ.ch = 0
      if (c.R(0, 1) < 0.15) typ.pause = c.RI(6, 18)
      if (typ.li >= lines.length) {
        done = true
        typ.ci = (typ.ci + 1) % CODE.length
        typ.li = 0
        typ.pause = 40
      }
    }
    return { file, line: n, text, done, lineDone, idle: false }
  }

  // ── 5 서브에이전트
  const s = mk(5)
  const rows: SubRow[] = SUB_DEFS.map(def => ({ ...def, files: s.RI(5, 40), sec: s.RI(20, 200), pct: s.RI(5, 70) }))
  /** 한 걸음: 일이 올라가고, 끝난 것은 한 줄 남긴다 */
  function subsLog(): Line[] {
    const r = s.P(rows)
    r.files += s.RI(0, 3)
    r.pct = Math.min(100, r.pct + s.RI(1, 6))
    for (const x of rows) x.sec++
    if (r.pct >= 100) {
      const out = line(p('✓', 'ok'), p(` ${r.name} 끝 `), p('—', 'dim'), p(' ' + s.P(SUB_DONE)))
      r.task = s.P(SUB_NEXT)
      r.pct = r.files = r.sec = 0
      return [out]
    }
    return s.R(0, 1) < 0.18 ? [line(p(`  ${r.name} ▸ Read ${s.P(FILES)}`, 'dim'))] : []
  }
  const bar = (pct: number, w: number): Part[] => {
    const n = Math.round((pct / 100) * w)
    return [p('█'.repeat(n), 'bl'), p('░'.repeat(w - n), 'dim')]
  }
  /** 위 고정 블록 — 서브에이전트마다 두 줄(이름·일 / 막대). spin 은 돌아가는 글자의 걸음 수 */
  function subs(n = SUB_DEFS.length, spin = 0): { rows: SubRow[]; lines: Line[] } {
    const shown = rows.slice(0, Math.max(0, Math.min(n, rows.length)))
    const lines: Line[] = []
    shown.forEach((r, i) => {
      lines.push(line(p(SPIN[(spin + i * 3) % SPIN.length], 'bl'), p(' '), p(r.name, undefined, true), p(' '), p('·', 'dim'), p(` ${r.task} `), p(`— 파일 ${r.files}개 · ${r.sec}s`, 'dim')))
      lines.push(line(p('  '), ...bar(r.pct, 30), p(` ${r.pct}%`, 'dim')))
    })
    return { rows: shown.map(r => ({ ...r })), lines }
  }

  // ── 6 시스템
  const y = mk(6)
  const cpu = Array.from({ length: 8 }, () => y.R(40, 90))
  let mem = 11.8
  /** barW: CPU 막대 칸 수(시안 10). 창이 좁으면 줄인다 */
  function system(barW = 10): Line[] {
    for (let i = 0; i < 8; i++) cpu[i] = Math.max(12, Math.min(99, cpu[i] + y.R(-14, 14)))
    mem = Math.max(9, Math.min(14.5, mem + y.R(-0.3, 0.3)))
    const cb = (v: number): Part[] => {
      const n = Math.round((v / 100) * barW)
      const col: Color = v > 85 ? 'er' : v > 65 ? 'am' : 'ok'
      return [p('[', 'dim'), p('|'.repeat(n), col), p(' '.repeat(barW - n)), p(`${v.toFixed(1).padStart(5)}%]`, 'dim')]
    }
    const out: Line[] = []
    for (let i = 0; i < 4; i++) out.push(line(p(String(i).padStart(3), 'bl'), p(' '), ...cb(cpu[i]), p('  '), p(String(i + 4).padStart(2), 'bl'), p(' '), ...cb(cpu[i + 4])))
    const mn = Math.round((mem / 32) * (barW * 2 + 2))
    out.push(line(p('Mem', 'bl'), p(' '), p('[', 'dim'), p('|'.repeat(mn), 'ok'), p(' '.repeat(barW * 2 + 2 - mn)), p(`${mem.toFixed(1)}G/32.0G]`, 'dim')))
    out.push(line(p(`  작업 412개 · 스레드 ${nf(y.RI(3200, 3400))} · 가동 3일 04:12`, 'dim')), blank())
    out.push({ parts: [p('  PID  CPU%  MEM%   시간+    명령', 'ok')], hd: true })
    PROCS.map((pr, i) => ({ pr, cp: i < 5 ? y.R(8, 42) : y.R(1, 20), pid: 4412 + i * 37 }))
      .sort((m, n) => n.cp - m.cp)
      .forEach(({ pr, cp, pid }) =>
        out.push(line(p(` ${String(pid).padStart(5)} ${cp.toFixed(1).padStart(5)} ${y.R(0.4, 4.8).toFixed(1).padStart(5)}  ${y.RI(0, 3)}:${pad(y.RI(0, 59))}:${pad(y.RI(0, 59))}  `), p(pr[0], pr[0] === 'claude' ? 'vi' : undefined), p(' '), p(pr[1], 'dim'))),
      )
    return out
  }

  return { agent, tests, diff, typing, subs, subsLog, system }
}

/** 코드 한 줄을 다 쳤을 때 앞에 붙는 줄 번호 */
export const lineNo = (n: number): Part => p(String(n).padStart(3) + '  ', 'dim')
/** 한 파일을 다 치고 저장했을 때 남기는 줄 */
export const savedLines = (file: string): Line[] => [blank(), line(p('✓ 저장함', 'ok'), p(` · ${file} · tsc 통과`, 'dim')), blank()]
export const waitingLine = (): Line => line(p('승인을 기다리는 중…', 'am'))
