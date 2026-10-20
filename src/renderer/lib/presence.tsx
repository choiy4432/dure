import {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type HTMLAttributes,
  type Key,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { animate, utils } from 'animejs'
import { reducedMotion, type MotionSpec, type MotionStep } from './motion'

// 열고 닫히는 것의 움직임 — 생길 때 들어오고, 사라질 때 나가는 움직임이 끝날 때까지 남는다.
// Presence 가 '언제 지우나'를 쥐고, 안쪽의 useMotion(MotionDiv)이 '어떻게 움직이나'를 쥔다.
// 처음 그릴 때 이미 있던 것은 움직이지 않는다(바뀔 때만 움직인다). 움직임 줄이기면 지금처럼 바로 나타나고 바로 사라진다.

/** 나가는 움직임이 끝났다는 알림을 기다리는 여유 — 엔진이 멈춰(창이 가려짐) 알림이 안 와도 가장 긴 나가기 + 이만큼 뒤엔 지운다 */
const EXIT_GRACE_MS = 200

export interface PresenceApi {
  /** 둘러싼 Presence 가 나가는 중인가 */
  leaving: boolean
  /** 지금 붙는 자식이 들어와야 하는가 — Presence 가 처음 그릴 때 이미 있던 자식이면 아니다 */
  entering(): boolean
  /** 나가는 움직임을 가진 자식이 붙었다 — 떼는 함수를 준다 */
  register(id: string, ms: number): () => void
  /** 그 자식의 나가는 움직임이 끝났다 */
  done(id: string): void
}

const PresenceCtx = createContext<PresenceApi | null>(null)

/** 둘러싼 Presence 의 장부 — 나가는 움직임을 직접 가진 훅(useExpand)이 쓴다. Presence 밖이면 null */
export function usePresenceApi(): PresenceApi | null {
  return useContext(PresenceCtx)
}

/** 둘러싼 Presence 가 나가는 중인가 — 닫히는 순간 할 일(초점 돌려주기 등)을 움직임이 끝나기 전에 할 때 쓴다 */
export function useLeaving(): boolean {
  return useContext(PresenceCtx)?.leaving ?? false
}

function PresenceCore({
  show,
  children,
  appear = false,
  onGone,
}: {
  show: boolean
  children?: ReactNode
  /** 처음 그릴 때 이미 있는 자식도 들어오게 — PresenceList 가 새 key 에 준다 */
  appear?: boolean
  /** 다 사라졌다(나가기가 끝났거나 바로 지웠다) — PresenceList 가 그 key 를 뺀다 */
  onGone?: () => void
}) {
  const exits = useRef(new Map<string, number>()) // 나가는 움직임을 가진 자식 → 그 시간(ms)
  const finished = useRef(new Set<string>())
  const committed = useRef(false)
  const appearFirst = useRef(appear)
  const leavingNow = useRef(false)
  const last = useRef<ReactNode>(null)
  const gone = useRef(onGone)
  gone.current = onGone

  // show 가 바뀌는 렌더에서 바로 정한다 — 나갈 수 없으면(움직임 줄이기 · 나가는 움직임을 가진 자식 없음) 같은 렌더에서 지운다
  const [prevShow, setPrevShow] = useState(show)
  const [leaving, setLeaving] = useState(false)
  if (show !== prevShow) {
    setPrevShow(show)
    setLeaving(!show && exits.current.size > 0 && !reducedMotion())
  }
  if (show) last.current = children

  const finish = useCallback(() => setLeaving(false), [])
  const check = useCallback(() => {
    if (!leavingNow.current) return
    for (const id of exits.current.keys()) if (!finished.current.has(id)) return
    finish()
  }, [finish])

  const base = useMemo(
    () => ({
      entering: () => appearFirst.current || committed.current,
      register: (id: string, ms: number) => {
        exits.current.set(id, ms)
        return () => {
          exits.current.delete(id)
          check()
        }
      },
      done: (id: string) => {
        finished.current.add(id)
        check()
      },
    }),
    [check],
  )
  const api = useMemo<PresenceApi>(() => ({ ...base, leaving }), [base, leaving])

  useLayoutEffect(() => {
    committed.current = true
  }, [])

  // 나가는 동안 — 모든 자식이 끝났다고 알리거나, 가장 긴 나가기 + 여유가 지나면 지운다
  useLayoutEffect(() => {
    if (!leaving) return
    leavingNow.current = true
    const timer = setTimeout(finish, Math.max(0, ...exits.current.values()) + EXIT_GRACE_MS)
    check()
    return () => {
      clearTimeout(timer)
      leavingNow.current = false
      finished.current.clear()
    }
  }, [leaving, finish, check])

  const empty = !show && !leaving
  useLayoutEffect(() => {
    if (!empty) return
    last.current = null
    gone.current?.()
  }, [empty])

  return <PresenceCtx.Provider value={api}>{show ? children : leaving ? last.current : null}</PresenceCtx.Provider>
}

/**
 * 열고 닫히는 것 하나를 감싼다 — show 가 false 가 되면 마지막으로 그린 children 을 남겨 둔 채(useLeaving() 참)
 * 안쪽 움직임이 다 끝나거나 가장 긴 나가기 + 200ms 가 지나면 지운다. 다시 보이면 같은 노드가 그 자리에서 돌아온다.
 */
export function Presence(props: { show: boolean; children?: ReactNode }): ReactNode {
  return <PresenceCore show={props.show}>{props.children}</PresenceCore>
}

interface Entry {
  key: Key
  el: ReactElement
  show: boolean
  appear: boolean
}

/** 지난번에 그린 것(prev)에 이번 자식(next)을 맞춘다 — 빠진 key 는 원래 자리(앞 이웃 바로 뒤)에 나가는 것으로 남긴다 */
function merge(prev: Entry[], next: ReactElement[], appear: boolean): Entry[] {
  const was = new Map(prev.map(e => [e.key, e]))
  const out: Entry[] = next.map((el, i) => {
    const key: Key = el.key ?? `#${i}` // key 없는 자식(쓰지 말 것)도 서로 겹치지는 않게 — 자리 번호
    return { key, el, show: true, appear: was.get(key)?.appear ?? appear }
  })
  const now = new Set(out.map(e => e.key))
  prev.forEach((p, i) => {
    if (now.has(p.key)) return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex(e => e.key === prev[j].key)
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, { ...p, show: false })
  })
  return out
}

/**
 * 자식을 한 줄로 편다 — 배열 안의 것도 제 key 그대로.
 * Children.toArray 는 key 앞에 묶음 자리를 붙여(.1:$id · .$id) 같은 key 가 다른 묶음으로 옮기면(받은 목록 → 최근 전달된 자리)
 * 새 자식으로 본다 — 옛것은 나가고 같은 것이 하나 더 들어왔다.
 */
function keyed(children: ReactNode): ReactElement[] {
  const out: ReactElement[] = []
  Children.forEach(children, child => {
    if (isValidElement(child)) out.push(child)
  })
  return out
}

/**
 * key 가 있는 자식 목록 — 빠진 key 는 제자리에 남아 나가고, 새 key 는 들어온다. 처음 그릴 때의 key 는 들어오지 않는다.
 * 자식은 모두 key 가 있어야 하고, 묶음(배열)이 달라도 key 가 겹치면 안 된다 — key 하나가 자식 하나다.
 */
export function PresenceList(props: { children: ReactNode }): ReactNode {
  const committed = useRef<Entry[]>([])
  const mounted = useRef(false)
  const gone = useRef(new Set<Key>()) // 다 나간 key — 다음 렌더에서 뺀다
  const [, redraw] = useReducer((n: number) => n + 1, 0)

  const next = keyed(props.children)
  const entries = merge(committed.current, next, mounted.current).filter(e => e.show || !gone.current.has(e.key))

  useLayoutEffect(() => {
    committed.current = entries
    mounted.current = true
    // 나가는 것으로 남아 있는 동안만 기억한다 — 빠졌거나 다시 보이면 잊는다(다음에 또 빠지면 다시 나가게)
    const leavingKeys = new Set(entries.filter(e => !e.show).map(e => e.key))
    for (const k of gone.current) if (!leavingKeys.has(k)) gone.current.delete(k)
  })

  const drop = useCallback((key: Key) => {
    gone.current.add(key)
    redraw()
  }, [])

  return entries.map(e => (
    <PresenceCore key={e.key} show={e.show} appear={e.appear} onGone={() => drop(e.key)}>
      {e.el}
    </PresenceCore>
  ))
}

type MotionTarget = HTMLElement | SVGElement
type Props = Record<string, number | { from: number; to: number }>

/** 쉬는 자리 — 들어오면 여기로 오고, 나가다 돌아올 때도 여기로 */
const REST = { opacity: 1, y: 0, scale: 1 } as const
const FIELDS = ['opacity', 'y', 'scale'] as const
// SVG 요소에선 'y' 가 속성(attribute)으로 잡힐 수 있어 transform 이름을 쓴다
const PROP = { opacity: 'opacity', y: 'translateY', scale: 'scale' } as const

const enterProps = (s: MotionStep): Props => {
  const p: Props = {}
  for (const f of FIELDS) if (s[f] !== undefined) p[PROP[f]] = { from: s[f], to: REST[f] }
  return p
}
const exitProps = (s: MotionStep): Props => {
  const p: Props = {}
  for (const f of FIELDS) if (s[f] !== undefined) p[PROP[f]] = s[f]
  return p
}
const restProps = (s: MotionStep): Props => {
  const p: Props = {}
  for (const f of FIELDS) if (s[f] !== undefined) p[PROP[f]] = REST[f]
  return p
}

/** 쉬는 자리에 닿았다 — y 0 · scale 1 의 transform 은 지운다(남으면 안쪽 position: fixed 목록의 기준이 이 요소로 바뀐다) */
function settle(el: MotionTarget, s: MotionStep) {
  if (s.y !== undefined || s.scale !== undefined) el.style.removeProperty('transform')
}

/** 요소 하나를 쉬는 자리로 들어오게 한다(useMotion 과 같은 값) — 끝나면 transform 을 지운다. 움직임 줄이기는 부르는 쪽이 거른다 */
export function playEnter(el: MotionTarget, step: MotionStep): void {
  animate(el, { ...enterProps(step), duration: step.ms, ease: step.ease, onComplete: () => settle(el, step) })
}

/** 나가는 동안은 누를 수도 초점이 갈 수도 없다 — 그 아래·옆을 누르면 바로 먹힌다 */
export function setInert(el: MotionTarget, on: boolean) {
  if (el instanceof HTMLElement) {
    el.inert = on
    el.toggleAttribute('inert', on)
  }
  el.style.pointerEvents = on ? 'none' : ''
}

/**
 * 요소 하나의 들어오기·나가기. 같은 속성의 새 움직임은 anime 기본(composition: 'replace')으로 지금 값에서 이어 간다.
 * - 들어오기: 둘러싼 Presence 가 처음 그릴 때 이미 있던 요소가 아닐 때(Presence 밖이면 늘). opts.appear 가 있으면 그 값을 따른다.
 * - 나가기: 둘러싼 Presence 가 나가는 중일 때 — inert · pointer-events: none 을 걸고 spec.exit 로 움직인 뒤 Presence 에 알린다.
 *   나가다가 다시 보이면 풀고 지금 자리에서 쉬는 자리(opacity 1 · y 0 · scale 1)로 돌아간다.
 * - origin 은 transform-origin(예: 'top right').
 * 움직이는 동안 요소의 transform·opacity 는 이 훅이 쓴다 — CSS transform 이 걸린 요소라면 그 안쪽 감싸개에 건다.
 */
export function useMotion(
  ref: RefObject<MotionTarget | null>,
  spec: MotionSpec,
  opts: { origin?: string; appear?: boolean } = {},
): void {
  const ctx = useContext(PresenceCtx)
  const id = useId()
  const leaving = ctx?.leaving ?? false
  const live = useRef({ spec, ctx, appear: opts.appear })
  live.current = { spec, ctx, appear: opts.appear }
  const enters = useRef<boolean | null>(null) // 붙을 때 한 번 정한다(StrictMode 의 두 번째 붙기에도 같은 답)
  const exiting = useRef(false)
  const { origin } = opts

  useLayoutEffect(() => {
    const el = ref.current
    if (el && origin) el.style.transformOrigin = origin
  }, [ref, origin])

  // 붙을 때 — 들어오고, 나가는 움직임이 있으면 Presence 에 알린다
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { spec, ctx, appear } = live.current
    if (enters.current === null) enters.current = appear ?? (ctx ? ctx.entering() : true)
    if (enters.current && !reducedMotion()) {
      playEnter(el, spec.enter)
    }
    const unregister = ctx && spec.exit ? ctx.register(id, spec.exit.ms) : undefined
    return () => {
      unregister?.()
      utils.remove(el)
    }
  }, [ref, id])

  // 둘러싼 Presence 가 나가기 시작하거나 다시 보일 때
  useLayoutEffect(() => {
    const el = ref.current
    const { spec, ctx } = live.current
    if (!ctx || !spec.exit) return
    if (leaving) {
      exiting.current = true
      if (!el || reducedMotion()) {
        ctx.done(id)
        return
      }
      setInert(el, true)
      let current = true
      const step = spec.exit
      animate(el, {
        ...exitProps(step),
        duration: step.ms,
        ease: step.ease,
        onComplete: () => {
          if (current) ctx.done(id)
        },
      })
      return () => {
        current = false
      }
    }
    if (!exiting.current) return
    exiting.current = false
    if (!el) return
    setInert(el, false)
    const back = spec.enter
    if (reducedMotion()) {
      utils.remove(el)
      utils.set(el, restProps(spec.exit))
      settle(el, spec.exit)
      return
    }
    animate(el, { ...restProps(spec.exit), duration: back.ms, ease: back.ease, onComplete: () => settle(el, spec.exit!) })
  }, [leaving, ref, id])
}

/** useMotion 을 건 div — 떠 있는 목록·대화상자·카드의 뿌리에 쓴다 */
export const MotionDiv = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { motion: MotionSpec; origin?: string }>(
  function MotionDiv({ motion, origin, ...rest }, ref) {
    const inner = useRef<HTMLDivElement | null>(null)
    useMotion(inner, motion, { origin })
    const setRef = useCallback(
      (el: HTMLDivElement | null) => {
        inner.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) ref.current = el
      },
      [ref],
    )
    return <div {...rest} ref={setRef} />
  },
)
