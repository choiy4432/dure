import { useState } from 'react'
import { FileText } from 'lucide-react'
import type { AgentId } from '../../engine/types'
import type { SentFile } from '../state/transcript'
import { opensAsDocument } from '../../shared/attachments'
import { errorMessage, formatBytes, splitName } from '../lib/words'
import { onPhone } from '../lib/phone'

/** 줄 끝에서도 지워지지 않는 빈칸(nbsp) */
const NBSP = String.fromCharCode(0xa0)

/**
 * 파일 이름 — 가운데 줄임(앞은 칸이 모자라면 말줄임, 확장자와 그 앞 몇 글자는 늘 보인다). 입력창 칩과 내 말 칩이 같이 쓴다.
 * 나눈 자리에 빈칸이 있었으면 앞 조각 끝에 nbsp 한 칸 — 보통 빈칸은 줄 끝이라 그려지지 않고, 말줄임이면 말줄임이 같이 가린다
 */
export function FileName({ name }: { name: string }) {
  const [head, tail] = splitName(name)
  const gap = tail !== '' && head.length + tail.length < name.length ? NBSP : ''
  return (
    <span className="af-n">
      <span className="af-h">{head + gap}</span>
      {tail && <span className="af-t">{tail}</span>}
    </span>
  )
}

/**
 * 내 말풍선의 첨부 파일 — 그림 썸네일 옆에 칩(이름 · 크기). 누르면 그 에이전트 첨부 폴더의 이 PC 사본을 연다(서버 방도 이 PC 사본).
 * 허용 목록(문서·그림·소리·영상·zip) 밖의 종류(.bat·.exe·프로젝트 파일 …·확장자 없음)는 main 이 열지 않고 탐색기에서 보인다 — 읽는 이름도 그 말로.
 * 못 열면(지워짐·연결된 프로그램 없음) 그 글을 칩 줄 아래에
 */
export function MeFiles({ agentId, files }: { agentId?: AgentId; files: SentFile[] }) {
  const [error, setError] = useState<string | null>(null)
  // 휴대폰 — 사본은 PC 에 있어 휴대폰에서 열 수 없다(openAttachment 는 PC 전용). 이름 · 크기만 보인다
  if (onPhone()) {
    return (
      <>
        {files.map((f, i) => (
          <span key={i} className="me-file" title={f.name}>
            <FileText className="i af-i" aria-hidden="true" />
            <span className="af-tx">
              <FileName name={f.name} />
              <span className="af-m">{formatBytes(f.bytes)}</span>
            </span>
          </span>
        ))}
      </>
    )
  }
  const open = async (f: SentFile) => {
    setError(null)
    if (!agentId) return
    try {
      await window.dure.openAttachment(agentId, f.file)
    } catch (e) {
      setError(`${f.name} — ${errorMessage(e)}`) // 칩이 여럿이어도 어느 파일인지
    }
  }
  return (
    <>
      {files.map((f, i) => {
        const size = formatBytes(f.bytes)
        const verb = opensAsDocument(f.file) ? '열기' : '폴더에서 보기'
        return (
          <button
            key={i}
            type="button"
            className="me-file"
            title={`${f.name} — ${verb}`}
            aria-label={`${f.name} ${verb} · ${size}`}
            disabled={!agentId}
            onClick={() => void open(f)}
          >
            <FileText className="i af-i" aria-hidden="true" />
            <span className="af-tx">
              <FileName name={f.name} />
              <span className="af-m">{size}</span>
            </span>
          </button>
        )
      })}
      {error && (
        <p className="me-ferr" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
