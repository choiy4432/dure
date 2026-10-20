import { useRef, type HTMLAttributes } from 'react'
import { useExpand } from './expand'

type Props = HTMLAttributes<HTMLElement> & {
  /** 안쪽 요소(꾸밈이 있는 .act-out · pre.ci-local · .empty-x) — 없으면 children 이 바깥 상자 바로 안에 든다 */
  as?: 'div' | 'pre' | 'p'
  /** 바깥 상자에 더 붙일 클래스 */
  outer?: string
}

/**
 * useExpand 를 건 바깥 상자(.xp, display: flow-root) — 높이만 움직이고, 꾸민 요소는 그 안에 그대로 든다.
 * 안쪽 여백·테두리·바깥 여백이 움직이는 동안 따로 튀지 않는다.
 */
export function ExpandBox({ as: Tag, outer, children, ...rest }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useExpand(ref)
  return (
    <div ref={ref} className={outer ? `xp ${outer}` : 'xp'}>
      {Tag ? <Tag {...rest}>{children}</Tag> : children}
    </div>
  )
}
