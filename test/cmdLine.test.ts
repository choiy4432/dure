import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argvQuote, cmdArg, cmdArgs, cmdEscape, startWaitLine } from '../src/main/cmdLine'

describe('cmdLine — 글자 규칙', () => {
  it('argvQuote — 큰따옴표로 싸고 " 앞 \\ 는 두 배 + \\", 끝의 \\ 는 두 배', () => {
    expect(argvQuote('a b')).toBe('"a b"')
    expect(argvQuote('x"y')).toBe('"x\\"y"')
    expect(argvQuote('x\\"y')).toBe('"x\\\\\\"y"')
    expect(argvQuote('C:\\dir\\')).toBe('"C:\\dir\\\\"')
    expect(argvQuote('C:\\a\\b')).toBe('"C:\\a\\b"') // 가운데 \ 는 그대로
    expect(argvQuote('')).toBe('""')
  })

  it('cmdEscape — 특수 글자마다 ^ (따옴표 포함)', () => {
    expect(cmdEscape('"a&b"')).toBe('^"a^&b^"')
    expect(cmdEscape('%PATH%')).toBe('^%PATH^%')
    expect(cmdEscape('^!()<>|')).toBe('^^^!^(^)^<^>^|')
    expect(cmdEscape('abc')).toBe('abc')
  })

  it('startWaitLine — 제목 "" · /wait · 명령과 인자는 cmdArg', () => {
    expect(startWaitLine('C:\\a & b\\claude.exe', ['auth', 'login'])).toBe(
      `start "" /wait ${cmdArg('C:\\a & b\\claude.exe')} ${cmdArg('auth')} ${cmdArg('login')}`,
    )
    expect(startWaitLine('x.exe', [], { sameWindow: true })).toBe(`start "" /b /wait ${cmdArg('x.exe')}`)
    expect(cmdArgs('L')).toEqual(['/d', '/v:off', '/s', '/c', '"L"'])
  })
})

// 진짜 cmd.exe + start 로 — 새 창 없이(/b) 같은 줄 규칙을 지나 인자가 그대로 닿는지. 경로에 & ^ % ! ( ) 공백
describe.skipIf(process.platform !== 'win32')('cmdLine — 진짜 cmd.exe 를 지나도 그대로', () => {
  it('start /b /wait — 명령 경로와 인자의 & ^ % ! ( ) 공백 · 따옴표 · 끝 \\ · 빈 글', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dure-cmd-'))
    try {
      const odd = join(dir, 'a & b ^ c %PATH% (d) !e! f')
      mkdirSync(odd)
      // 이름이 claude.exe 인 node — 같은 볼륨이면 하드 링크, 아니면 복사
      const exe = join(odd, 'claude.exe')
      try {
        linkSync(process.execPath, exe)
      } catch {
        copyFileSync(process.execPath, exe)
      }
      const script = join(odd, 'argv.mjs')
      writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
      const args = ['auth', 'login', '--claudeai', '%PATH%', '%%', 'a&b|c', 'x"y', 'end\\', '^caret', '!bang!', '(paren)', 'two words', '']
      const r = spawnSync('cmd.exe', cmdArgs(startWaitLine(exe, [script, ...args], { sameWindow: true })), {
        windowsHide: true,
        windowsVerbatimArguments: true,
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual(args)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
