import fs from 'node:fs'
import path from 'node:path'

export interface Log {
  write(line: string): void
}

/**
 * 설치본 로그 — `<dir>/dure.log` 에 `ISO시각 글` 한 줄씩 덧붙인다. maxBytes(기본 1 MiB)를 넘기면 dure.log.1…dure.log.<keep>(기본 3)로 돌리고
 * 가장 오래된 것은 버린다. 못 쓰면(폴더를 못 만듦·디스크 가득 등) 조용히 넘긴다 — 로그가 앱을 멈추게 하지 않는다.
 * 🔴 오류 글만 넘길 것 — 대화 글·토큰·쿠키는 쓰지 않는다.
 */
export function openLog(dir: string, o: { maxBytes?: number; keep?: number } = {}): Log {
  const maxBytes = o.maxBytes ?? 1024 * 1024
  const keep = o.keep ?? 3
  const file = path.join(dir, 'dure.log')
  const rotate = (): void => {
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`
      const to = `${file}.${i}`
      try {
        if (i === keep) fs.rmSync(to, { force: true })
        if (fs.existsSync(from)) fs.renameSync(from, to)
      } catch {
        // 못 돌리면 그대로 이어 쓴다
      }
    }
  }
  return {
    write(line: string): void {
      try {
        fs.mkdirSync(dir, { recursive: true })
        const text = `${new Date().toISOString()} ${line.replace(/\r?\n/g, ' ')}\n`
        let size = 0
        try {
          size = fs.statSync(file).size
        } catch {
          // 아직 없다
        }
        if (size > 0 && size + Buffer.byteLength(text) > maxBytes) rotate()
        fs.appendFileSync(file, text)
      } catch {
        // 조용히 넘긴다
      }
    },
  }
}

/**
 * 메인 프로세스의 잡히지 않은 오류 — 로그에 쓰고, 알림 상자도 띄운다(같은 글은 한 번만 · noDialog 면 안 띄움).
 * uncaughtException 핸들러가 Electron 기본 오류 창을 대신하므로 사용자가 알 수 있게 한다.
 */
export function makeFatalReporter(o: {
  log: (...args: unknown[]) => void
  showBox: (title: string, body: string) => void
  noDialog: boolean
}): (err: unknown) => void {
  const shown = new Set<string>()
  return (err) => {
    o.log('[두레] uncaughtException:', err)
    if (o.noDialog) return
    const msg = err instanceof Error ? err.message : String(err)
    if (shown.has(msg)) return
    shown.add(msg)
    try {
      o.showBox('두레에 문제가 생겼어요', `${msg}\n\n자세한 내용은 logs/dure.log 에 남겼어요.`)
    } catch {
      // 상자를 못 띄워도 앱을 더 망가뜨리지 않는다
    }
  }
}
