import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'

/** '복사했어요' 를 보이는 시간 */
const COPIED_MS = 1500

/**
 * 복사 단추 — 누르면 글을 클립보드에, 1.5초 동안 체크와 '복사했어요'. text 가 함수면 누르는 순간 읽는다(코드 상자의 지금 글).
 * 클립보드를 못 쓰면(창이 포커스를 잃었을 때 등) 아무 일도 없다 — 다시 누르면 된다
 */
export function CopyButton({ text, label = '복사', className }: { text: string | (() => string); label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(t)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text)
      setCopied(true)
    } catch {
      // 못 썼다 — 그대로
    }
  }
  const name = copied ? '복사했어요' : label
  return (
    <button type="button" className={className ? `ib ${className}` : 'ib'} title={name} aria-label={name} onClick={copy}>
      {copied ? <Check className="i" size={14} aria-hidden="true" /> : <Copy className="i" size={14} aria-hidden="true" />}
    </button>
  )
}
