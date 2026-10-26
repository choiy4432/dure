import { memo, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Check, Copy } from 'lucide-react'
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

/** 글로 읽는 코드 상자 — 언어가 없거나 마크다운·글이면 옆으로 밀지 않고 줄을 바꿔 아래로(릴리스 노트·메시지 초안 같은 것) */
const PROSE = new Set(['md', 'markdown', 'text', 'txt', 'plaintext', 'plain'])

/** 코드 상자의 언어 — 안쪽 code 의 class 'language-xx' */
function langOf(node: HNode | undefined): string | null {
  const code = node?.children?.find(c => c.type === 'element' && c.tagName === 'code')
  const cls = code?.properties?.className
  const hit = Array.isArray(cls) ? cls.find((c): c is string => typeof c === 'string' && c.startsWith('language-')) : undefined
  return hit ? hit.slice('language-'.length).toLowerCase() : null
}

/** 코드 상자 — 오른쪽 위 복사 단추(누르면 1.5초 동안 체크). 글 상자는 줄바꿈, 코드는 옆으로 밀기 */
function CodeBlock({ node, children }: { node?: HNode; children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const lang = langOf(node)
  const wrap = !lang || PROSE.has(lang)
  const copy = async () => {
    // 코드 글은 끝 줄바꿈으로 끝난다 — 붙여 넣을 때 빈 줄이 하나 더 생기지 않게 뺀다
    const text = (pre.current?.textContent ?? '').replace(/\n$/, '')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // 클립보드를 못 쓰면(창이 포커스를 잃었을 때 등) 아무 일도 없다 — 다시 누르면 된다
    }
  }
  return (
    <div className="md-code">
      <pre ref={pre} className={wrap ? 'wrap' : undefined}>
        {children}
      </pre>
      <button type="button" className="ib md-copy" title={copied ? '복사했어요' : '복사'} aria-label={copied ? '복사했어요' : '복사'} onClick={copy}>
        {copied ? <Check className="i" size={14} aria-hidden="true" /> : <Copy className="i" size={14} aria-hidden="true" />}
      </button>
    </div>
  )
}

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
  pre({ node, children }) {
    return <CodeBlock node={node as HNode | undefined}>{children}</CodeBlock>
  },
}

/**
 * 마크다운 글(GFM) — Claude 답·받은 메시지 본문.
 * `caret` 이면 마지막 글 끝에 깜빡이는 커서(흐르는 글).
 * 원시 HTML 은 요소로 그리지 않고 글자 그대로 둔다. 코드는 mono 글꼴(base.css 의 code), 코드 상자엔 복사 단추(CodeBlock).
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
