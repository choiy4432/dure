import type { StatsSnapshot } from '../stats'

const nf = (n: number) => n.toLocaleString('en-US')
const W = 1040
const H = 132

/** 숫자 띠 — 켠 뒤의 진짜 셈뿐(처리한 토큰은 정직한 값이 없어 싣지 않는다) */
export function StatsStrip({ s, subagents }: { s: StatsSnapshot; subagents: number }) {
  const max = Math.max(6, ...s.perSec)
  const bw = W / 60
  return (
    <footer className="pw-stats" aria-label="숫자">
      <div className="pw-tile">
        <span className="k">도구 호출</span>
        <span className="v" data-stat="tools">{nf(s.tools)}</span>
        <span className="d">+{s.toolsPerMin} /분</span>
      </div>
      <div className="pw-tile">
        <span className="k">읽은 파일</span>
        <span className="v" data-stat="files">{nf(s.files)}</span>
        <span className="d">고유 파일</span>
      </div>
      <div className="pw-tile">
        <span className="k">바꾼 줄</span>
        <span className="v"><span className="p" data-stat="added">+{nf(s.added)}</span></span>
        <span className="d r" data-stat="removed">−{nf(s.removed)}</span>
      </div>
      <div className="pw-tile">
        <span className="k">넘긴 일</span>
        <span className="v" data-stat="handoffs">{nf(s.handoffs)}</span>
        <span className="d">에이전트 사이</span>
      </div>
      <div className="pw-tile">
        <span className="k">서브에이전트</span>
        <span className="v">{subagents}</span>
        <span className="d">지금 도는 중</span>
      </div>
      <div className="pw-tile pw-spark">
        <span className="k">초당 도구 호출 · 지난 1분</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="초당 도구 호출 막대 그래프">
          {s.perSec.map((v, i) => {
            const h = Math.max(4, (v / max) * (H - 8))
            return <rect key={i} x={i * bw + 2} y={H - h} width={bw - 5} height={h} rx={3} data-last={i === s.perSec.length - 1 || undefined} />
          })}
        </svg>
      </div>
    </footer>
  )
}
