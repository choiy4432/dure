/**
 * 두레 마크 — 판 없이 D 만(resources/icon/dure-mark.svg 와 같은 모양, 앱 안 로고).
 * 위 빈 고리(보낸 쪽) → 둥근 길 → 아래 찬 점(받는 쪽), 줄기는 옅게 닫는다. 색은 currentColor — base.css .brand 가 --brand 로 칠한다(다크는 한 단 밝게).
 */
export function BrandMark() {
  return (
    <svg className="brand" viewBox="0 0 24 24" role="img" aria-label="두레">
      <path d="M6 7.1 V16.5" stroke="currentColor" strokeOpacity={0.35} strokeWidth={2.2} strokeLinecap="round" />
      <path
        d="M8.3 4.5 H11 C16.5 4.5 20 7.9 20 12 C20 16.1 16.5 19.5 11 19.5 H9"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={6} cy={4.5} r={2.3} fill="none" stroke="currentColor" strokeWidth={1.8} />
      <circle cx={6} cy={19.5} r={3} fill="currentColor" />
    </svg>
  )
}
