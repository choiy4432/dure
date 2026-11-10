import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFatalReporter, openLog } from '../src/main/log'

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
