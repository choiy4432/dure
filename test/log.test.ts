import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatLogArgs, makeFatalReporter, openLog, redactHome } from '../src/main/log'

test('makeFatalReporter: 로그는 늘 쓰고, 같은 글은 상자 한 번만', () => {
  const log = vi.fn()
  const showBox = vi.fn()
  const r = makeFatalReporter({ log, showBox, noDialog: false })
  r(new Error('boom'))
  r(new Error('boom'))
  r(new Error('other'))
  expect(log).toHaveBeenCalledTimes(3)
  expect(showBox).toHaveBeenCalledTimes(2)
  expect(showBox.mock.calls[0][0]).toBe('두레에 문제가 생겼어요')
  expect(showBox.mock.calls[0][1]).toContain('boom')
  expect(showBox.mock.calls[0][1]).toContain('dure.log')
})

test('makeFatalReporter: noDialog 면 상자 없음', () => {
  const log = vi.fn()
  const showBox = vi.fn()
  makeFatalReporter({ log, showBox, noDialog: true })('x')
  expect(log).toHaveBeenCalledTimes(1)
  expect(showBox).not.toHaveBeenCalled()
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-log-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

test('한 줄 쓰기: ISO 시각 + 글', () => {
  const log = openLog(path.join(dir, 'logs'))
  log.write('안녕\n둘째 줄')
  const text = fs.readFileSync(path.join(dir, 'logs', 'dure.log'), 'utf8')
  expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z 안녕 둘째 줄\n$/)
})

test('maxBytes 를 넘기면 .1 .2 .3 으로 돌리고 4번째는 버린다', () => {
  const log = openLog(dir, { maxBytes: 60, keep: 3 })
  for (let i = 1; i <= 6; i++) log.write(`줄${i}-` + 'x'.repeat(20))
  const files = fs.readdirSync(dir).sort()
  expect(files).toEqual(['dure.log', 'dure.log.1', 'dure.log.2', 'dure.log.3'])
  const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('')
  expect(all).toContain('줄6-')
  expect(all).not.toContain('줄1-') // 가장 오래된 것은 버려졌다
  expect(fs.readFileSync(path.join(dir, 'dure.log'), 'utf8')).toContain('줄6-')
})

test('폴더를 못 만들면 던지지 않는다', () => {
  const blocker = path.join(dir, 'file')
  fs.writeFileSync(blocker, 'x')
  const log = openLog(path.join(blocker, 'logs')) // 파일 아래라 mkdir 이 실패한다
  expect(() => log.write('아무 일 없음')).not.toThrow()
})

// ── 홈 경로 가리기 — 가짜 홈만 쓴다 ──
const HOME = 'C:\\Users\\tester'

test('logRedactsHome: Windows 홈 · 대소문자 다름 · 슬래시 → ~ , 홈이 아닌 경로는 그대로', () => {
  expect(redactHome('ENOENT C:\\Users\\tester\\AppData\\x.json', HOME)).toBe('ENOENT ~\\AppData\\x.json')
  expect(redactHome('c:\\users\\TESTER\\a', HOME)).toBe('~\\a')
  expect(redactHome('C:/Users/tester/a/b', HOME)).toBe('~/a/b')
  expect(redactHome('두 곳 C:\\Users\\tester\\a 와 C:/Users/Tester/b', HOME)).toBe('두 곳 ~\\a 와 ~/b')
  expect(redactHome('C:\\Users\\tester2\\a', HOME)).toBe('C:\\Users\\tester2\\a') // 다른 이름은 건드리지 않는다
  expect(redactHome('D:\\work\\a', HOME)).toBe('D:\\work\\a')
  expect(redactHome('아무 경로 없음', HOME)).toBe('아무 경로 없음')
  expect(redactHome('x C:\\Users\\tester', HOME)).toBe('x ~') // 홈 자체
  expect(redactHome('C:\\Users\\tester\\a', '')).toBe('C:\\Users\\tester\\a') // 홈을 모르면 그대로
})

test('logRedactsHome: 정규식 글자가 든 홈도 글자 그대로 찾는다', () => {
  expect(redactHome('C:\\Users\\a.b+c\\x', 'C:\\Users\\a.b+c')).toBe('~\\x')
  expect(redactHome('C:\\Users\\aXb+c\\x', 'C:\\Users\\a.b+c')).toBe('C:\\Users\\aXb+c\\x')
})

test('logRedactsHome: 로그 줄과 알림 상자 글에 쓰이고, 객체 이유는 inspect 글', () => {
  const err = redactHome(formatLogArgs(['[두레] 실패:', new Error('열 수 없음 C:\\Users\\tester\\x')]), HOME)
  expect(err).toContain('열 수 없음 ~\\x')
  expect(err).not.toContain('tester')
  const obj = redactHome(formatLogArgs(['[두레] unhandledRejection:', { path: 'C:\\Users\\tester\\y', deep: { a: { b: { c: { d: 1 } } } } }]), HOME)
  expect(obj).not.toContain('[object Object]')
  expect(obj).toContain("path: '~\\\\y'")
  expect(obj).toContain('[Object]') // depth 3 을 넘는 곳은 줄인다

  const showBox = vi.fn()
  makeFatalReporter({ log: vi.fn(), showBox, noDialog: false, home: HOME })(new Error('열 수 없음 c:/users/Tester/x'))
  expect(showBox.mock.calls[0][1]).toContain('열 수 없음 ~/x')
  expect(showBox.mock.calls[0][1]).not.toMatch(/tester/i)
  showBox.mockClear()
  makeFatalReporter({ log: vi.fn(), showBox, noDialog: false, home: HOME })({ where: 'C:\\Users\\tester\\z' })
  expect(showBox.mock.calls[0][1]).not.toContain('tester')
  expect(showBox.mock.calls[0][1]).not.toContain('[object Object]')
})

test('logRedactsHome: openLog 는 홈이 주어지면 쓰는 모든 줄에서 가린다', () => {
  const log = openLog(dir, { home: HOME })
  log.write('실패 C:\\Users\\tester\\AppData')
  const text = fs.readFileSync(path.join(dir, 'dure.log'), 'utf8')
  expect(text).toContain('실패 ~\\AppData')
  expect(text).not.toContain('tester')
})
