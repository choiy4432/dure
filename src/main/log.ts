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
