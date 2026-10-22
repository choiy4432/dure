// 조사(이/가 …) 규칙 — 화면 문구(renderer/lib/words.ts 가 다시 내보낸다)와 엔진이 Claude 에게 돌려주는 글이 같은 규칙을 쓴다

export type JosaPair = '이/가' | '을/를' | '은/는' | '과/와'

// 숫자를 읽은 소리에 받침이 있는가 — 영 일 이 삼 사 오 육 칠 팔 구
const DIGIT_BATCHIM = [true, true, false, true, false, false, true, true, true, false]

/** 낱말 끝 글자에 받침이 있는가 — 한글·숫자만 알고, 그 밖(영문·기호·빈 글)은 null */
export function hasBatchim(word: string): boolean | null {
  const last = word.trimEnd().slice(-1)
  if (last === '') return null
  const code = last.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0
  if (last >= '0' && last <= '9') return DIGIT_BATCHIM[Number(last)]
  return null
}

/** 낱말 뒤에 붙일 조사 — 받침이 있으면 앞 것, 없으면 뒤 것, 알 수 없으면 '이(가)' 처럼 둘 다 */
export function josa(word: string, pair: JosaPair): string {
  const [withB, withoutB] = pair.split('/')
  const b = hasBatchim(word)
  if (b === null) return `${withB}(${withoutB})`
  return b ? withB : withoutB
}
