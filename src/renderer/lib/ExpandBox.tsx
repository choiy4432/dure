import { useRef, type HTMLAttributes } from 'react'
import { useExpand } from './expand'

/** useExpand 를 건 상자 — Presence 안의 펼친 내용 뿌리에 쓴다 */
export function ExpandBox({ as: Tag, ...rest }: HTMLAttributes<HTMLElement> & { as: 'div' | 'pre' | 'p' }) {
  const ref = useRef<HTMLElement>(null)
  useExpand(ref)
  return <Tag {...rest} ref={ref as never} />
}
