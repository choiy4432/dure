import { memo, type MouseEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const WEB = /^https?:\/\//i
const PLUGINS = [remarkGfm]

interface HNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HNode[]
}

const CONTAINERS = new Set(['ul', 'ol', 'li', 'blockquote'])
const TEXT_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/** 흐르는 글의 커서 — 마지막 글 덩어리(문단·제목·목록 항목) 끝에 붙인다. 코드 상자는 그 안 마지막 줄 끝, 표 뒤면 맨 끝에 */
function rehypeCaret() {
  const caret = (): HNode => ({ type: 'element', tagName: 'span', properties: { className: ['caret'], ariaHidden: 'true' }, children: [] })
  const lastReal = (n: HNode) => [...(n.children ?? [])].reverse().find(c => !(c.type === 'text' && !(c as { value?: string }).value?.trim()))
  return (tree: HNode) => {
    let node = tree
    for (;;) {
      const last = lastReal(node)
      if (last?.type === 'element' && last.tagName && CONTAINERS.has(last.tagName)) node = last
      else if (last?.type === 'element' && last.tagName && TEXT_BLOCKS.has(last.tagName)) {
        last.children = [...(last.children ?? []), caret()]
        return
      } else if (last?.type === 'element' && last.tagName === 'pre') {
        // 쓰다 만 코드 상자 — 커서는 상자 안 마지막 줄 끝에(아래 새 문단이 아니다)
        const code = last.children?.find(c => c.type === 'element' && c.tagName === 'code')
        if (code) {
          // 코드 글은 끝 줄바꿈으로 끝난다 — 커서는 그 앞(마지막 줄 끝)에 둔다
          const kids = [...(code.children ?? [])]
          const tail = kids[kids.length - 1] as (HNode & { value?: string }) | undefined
          if (tail?.type === 'text' && tail.value?.endsWith('\n')) {
            kids.splice(kids.length - 1, 1, { ...tail, value: tail.value.slice(0, -1) } as HNode, caret(), { ...tail, value: '\n' } as HNode)
          } else kids.push(caret())
          code.children = kids
          return
        }
        break
      } else break
    }
    // li 안에 글이 바로 있는 경우(촘촘한 목록)는 li 끝, 그 밖(코드 상자·표·빈 글)은 맨 끝
    node.children = [...(node.children ?? []), caret()]
  }
}
const CARET_PLUGINS = [rehypeCaret]

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
 * `caret` 이면 마지막 글 끝에 깜빡이는 커서(흐르는 글).
 * 원시 HTML 은 요소로 그리지 않고 글자 그대로 둔다. 코드는 mono 글꼴(base.css 의 code).
 * 글·커서가 같으면 다시 읽지 않는다(memo) — 흐르는 글은 델타마다 줄이 다시 그려져도 한 장에 한 번만 읽힌다.
 */
export const Markdown = memo(function Markdown({ text, caret = false }: { text: string; caret?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS} rehypePlugins={caret ? CARET_PLUGINS : undefined} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
