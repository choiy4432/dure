import type { MouseEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const WEB = /^https?:\/\//i
const PLUGINS = [remarkGfm]

const COMPONENTS: Components = {
  // 링크는 앱 안에서 이동하지 않는다 — 새 창 요청으로 넘기면 main 이 기본 브라우저로 연다(http·https 만)
  a({ href, children }) {
    if (!href || !WEB.test(href)) return <span>{children}</span>
    const open = (e: MouseEvent) => {
      e.preventDefault()
      window.open(href, '_blank')
    }
    return (
      <a href={href} title={href} target="_blank" rel="noreferrer" onClick={open}>
        {children}
      </a>
    )
  },
  // 바깥 그림은 받지 않는다(CSP) — 설명 글만
  img({ alt }) {
    return alt ? <span>{alt}</span> : null
  },
}

/**
 * 마크다운 글(GFM) — Claude 답·받은 메시지 본문.
 * 원시 HTML 은 요소로 그리지 않고 글자 그대로 둔다. 코드는 mono 글꼴(base.css 의 code).
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
