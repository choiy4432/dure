import { useEffect, useRef } from 'react'
import { createTimeline, svg } from 'animejs'
import { reducedMotion } from '../lib/motion'

/** 슈퍼타원 타일 — 아이콘(resources/icon/dure.svg)과 같은 모양 */
function squircle(cx: number, cy: number, r: number, n = 5, steps = 96): string {
  const pts: string[] = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    pts.push(`${(cx + r * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(2)} ${(cy + r * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(2)}`)
  }
  return `M${pts.join('L')}Z`
}
const TILE = squircle(128, 128, 112)
/** D 의 둥근 길(위 → 아래)과 줄기(아래 → 위) */
const BOWL = 'M84 68 H116 C160 68 188 98 188 128 C188 158 160 188 116 188 H84'
const STEM = 'M84 188 V68'

/**
 * 두레를 여는 중 — 처음 상태를 받기 전까지 창 가운데에 움직이는 아이콘(D 넘김).
 * 점이 위 고리에서 둥근 길을 따라 아래로 → 아래가 받고 → 줄기를 타고 위로 → 위가 받고, 지나온 길이 가라앉고 다시.
 * 빨리 열리면 보이지 않게 250ms 뒤에 나타난다(base.css .spl). 움직임 줄이기면 멈춘 아이콘.
 */
export function Splash() {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 움직임 줄이기 — 지나온 길을 다 그린 멈춘 D
    if (reducedMotion()) {
      el.querySelectorAll('.spl-trail').forEach(p => p.setAttribute('stroke-dasharray', '100 100'))
      return
    }
    const $ = (s: string) => el.querySelector(s) as SVGElement
    const ease = 'outCubic'
    const tl = createTimeline({ loop: true, loopDelay: 700 })
      .add([$('.spl-bowl-trail'), $('.spl-stem-trail')], { opacity: 1, duration: 1 }, 0)
      .add($('.spl-dot'), { opacity: [{ to: 1, duration: 120 }], ...svg.createMotionPath($('.spl-bowl') as SVGPathElement), duration: 1000, ease }, 0)
      .add($('.spl-bowl-trail'), { strokeDasharray: ['0 100', '100 100'], duration: 1000, ease }, 0)
      .add($('.spl-dot'), { opacity: 0, duration: 120 }, 980)
      .add($('.spl-bot-ring'), { r: [23, 46], opacity: [0.8, 0], duration: 650, ease: 'outQuad' }, 980)
      .add($('.spl-dot'), { opacity: [{ to: 1, duration: 120 }], ...svg.createMotionPath($('.spl-stem') as SVGPathElement), duration: 700, ease }, 1350)
      .add($('.spl-stem-trail'), { strokeDasharray: ['0 100', '100 100'], duration: 700, ease }, 1350)
      .add($('.spl-dot'), { opacity: 0, duration: 120 }, 2030)
      .add($('.spl-top-ring'), { r: [26, 48], opacity: [0.8, 0], duration: 650, ease: 'outQuad' }, 2030)
      .add($('.spl-top-fill'), { opacity: [0, 1, 0], duration: 700, ease: 'outQuad' }, 2030)
      .add([$('.spl-bowl-trail'), $('.spl-stem-trail')], { opacity: [1, 0], duration: 350 }, 2650)
    return () => {
      tl.revert()
    }
  }, [])

  return (
    <div className="spl" role="status" aria-label="두레를 여는 중">
      <svg ref={ref} viewBox="0 0 256 256" aria-hidden="true">
        <path className="spl-tile" d={TILE} />
        <path className="spl-stem spl-track" d={STEM} />
        <path className="spl-bowl spl-track" d={BOWL} />
        <path className="spl-bowl-trail spl-trail" d={BOWL} pathLength={100} strokeDasharray="0 100" />
        <path className="spl-stem-trail spl-trail" d={STEM} pathLength={100} strokeDasharray="0 100" />
        <circle className="spl-top" cx={84} cy={68} r={20} />
        <circle className="spl-top-fill" cx={84} cy={68} r={20} opacity={0} />
        <circle className="spl-top-ring spl-ring" cx={84} cy={68} r={26} opacity={0} />
        <circle className="spl-bot" cx={84} cy={188} r={23} />
        <circle className="spl-bot-ring spl-ring" cx={84} cy={188} r={23} opacity={0} />
        <circle className="spl-dot" cx={0} cy={0} r={13} opacity={0} />
      </svg>
    </div>
  )
}
