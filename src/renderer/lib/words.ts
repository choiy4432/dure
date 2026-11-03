// 화면 문구 도우미 — 조사(이/가 …)와 '방금 · N분 전' 같은 시각 말

import type { MessageState, SleepBlock, SshHostEntry, UsageWindow } from '../../engine/types'
import { hasBatchim } from '../../shared/josa'
import type { DisplayStatus, Phase } from '../state/selectors'

// 조사 규칙은 엔진도 쓴다(새 에이전트를 만든 결과 글) — 정본은 shared/josa, 화면은 여기서 그대로 가져다 쓴다
export { josa, type JosaPair } from '../../shared/josa'

/** 표시 상태 낱말 — 관계도 카드 바닥과 패널 머리 알약이 같은 말을 쓴다 */
export const STATUS_WORD: Record<DisplayStatus, string> = {
  working: '작업 중',
  awaiting: '내 승인 필요',
  idle: '쉬는 중',
  stopped: '쉬는 중',
  error: '멈춤',
}

/** 관계도 카드 한 줄 — 흐르는 글·단계가 없을 때 상태를 풀어 쓴 말(카드 바닥 낱말보다 한 걸음 자세하다) */
export const STATUS_LINE: Record<DisplayStatus, string> = {
  working: '작업 중…',
  awaiting: '내 승인 필요',
  idle: '쉬는 중',
  stopped: '쉬는 중',
  error: '오류로 멈췄어요',
}

/** 메시지 상태 — 관계도 엣지 알약·패널 메시지 꼬리표·엣지 목록이 같은 말을 쓴다. 내가 할 일이면 '내 …', 기계가 쥐고 있으면 그 사정 */
export const MESSAGE_WORD: Record<MessageState, string> = {
  delivered: '전달됨',
  pending: '내 확인 필요',
  held: '자동 멈춤',
  queued: '끝나면 전달',
  dismissed: '버림',
}

/** 잠든 에이전트(프로세스를 꺼 둔 것) — 바닥 줄·패널 알약 낱말과 달 위에 올렸을 때 설명 */
export const SLEEP_WORD = { asleep: '잠듦', waking: '깨우는 중' } as const
export const SLEEP_HINT = '지금은 꺼 두어 메모리를 쓰지 않아요 · 말을 걸면 몇 초 뒤 깨어나요'

/** 패널 … 메뉴의 '지금 재우기' · 방 메뉴의 '쉬는 에이전트 모두 재우기' */
export const SLEEP_NOW = '지금 재우기'
export const SLEEP_ROOM = '쉬는 에이전트 모두 재우기'

/** 지금 못 재우는 까닭 — 꺼진 '지금 재우기' 항목의 title */
export const SLEEP_BLOCK_WORD: Record<SleepBlock, string> = {
  working: '일하는 중이에요',
  asking: '답을 기다리고 있어요',
  'waiting-input': '기다리는 입력이 있어요',
  subagents: '서브에이전트가 일하는 중이에요',
  background: '뒤에서 명령이 돌고 있어요',
  unread: '보낸 말을 아직 읽는 중이에요',
}

/** 설정의 재우는 시간 칸 — 문구와 고르는 값의 이름 */
export const SLEEP_SETTING = {
  label: '쉬는 에이전트 재우기',
  desc: '이만큼 쉬면 claude 를 내려 메모리를 비워요. 말을 걸면 몇 초 뒤 그대로 이어서 깨어나요',
}
export const SLEEP_CHOICE_WORD: Record<number, string> = { 0: '끔', 15: '15분', 30: '30분', 60: '1시간', 180: '3시간' }

/** 방금 끝난 에이전트의 새 결과 표시 낱말 — 카드에서 쓰는 건 따로 붙인다 */
export const FRESH_WORD = '끝남 · 새 결과'

/** 질문(AskUserQuestion)이 떠 있는 카드의 링크 문구 */
export const QUESTION_LINK = '내 답 필요 · 패널에서 답하기'

/** 차례의 단계 — 대화 맨 아래 작업 중 줄과 관계도 카드 한 줄이 같은 말을 쓴다(생각 중·흐르는 글이 먼저) */
export const PHASE_WORD: Record<Phase, string> = {
  preparing: '준비하는 중…',
  requesting: 'Claude 답 받는 중…',
  compacting: '대화를 정리하는 중…',
}
/** 준비하는 중에 마우스를 올리면 — 이 동안은 Claude 가 아직 질문을 받지 않았다 */
export const PREPARING_HINT = '아직 Claude에게 질문을 보내기 전이에요'

/** 보낸 그림을 볼 수 없을 때 — 썸네일 풀이와 크게 보기가 같은 말을 쓴다 */
export const IMAGE_OLD = '저장하기 전에 보낸 그림이라 볼 수 없어요'
export const IMAGE_GONE = '그림을 찾을 수 없어요'

/** 새 대화 확인 — 에이전트 메뉴의 '새 대화'와 입력창의 /clear 가 같은 말을 쓴다 */
export const RENEW_CONFIRM = {
  title: '지금까지 대화를 접고 새로 시작할까요?',
  confirmLabel: '새로 시작',
  body: "지금 대화는 '지난 대화'에서 다시 볼 수 있어요.",
} as const

/** 갈래 창 — 지난 대화에서 새 에이전트로 이어 가기 */
export const FORK_DIALOG = {
  title: '새 에이전트로 이어 가기',
  folderNote: '원래 에이전트와 같은 폴더예요',
} as const

/** 서버(SSH) 방 — 새 방 스위치·서버 칸·확인 줄·에이전트 추가의 서버 폴더(설계 4.1·4.2 문구 표). 문제 글은 shared/remoteTexts */
export const REMOTE = {
  where: '어디서 일하나요',
  local: '이 PC',
  server: '서버(SSH)',
  serverLabel: '서버',
  /** 서버 목록 단추 — 아직 고르지 않았을 때 */
  pick: '골라 주세요',
  typed: '직접 입력…',
  typedExample: '사용자@주소',
  /** 직접 입력칸의 읽는 이름 */
  typedLabel: '서버 주소',
  noSsh: '윈도우 OpenSSH 를 찾지 못했어요',
  checking: '확인하는 중…',
  connected: (version: string) => `접속됨 · claude ${version}`,
  folderOk: (version: string) => `폴더가 있어요 · claude ${version}`,
  folderExample: '/home/<사용자>/projects/web',
  check: '확인',
} as const

/** 준비 화면(claude 설치·로그인) 문구 */
export const SETUP = {
  kicker: '두레를 쓰기 전에',
  titleBoth: '준비가 두 가지 필요해요',
  titleLogin: '준비가 하나 남았어요',
  installTitle: 'Claude Code 설치',
  installBody: '두레는 이 PC 의 Claude Code 로 에이전트를 움직여요. 단추를 누르면 Anthropic 공식 설치 스크립트(install.ps1)를 대신 실행해요. 관리자 권한 없이 1~2분.',
  install: '설치',
  manual: '직접 설치할게요',
  showCommand: '실행하는 명령 보기',
  command: 'irm https://claude.ai/install.ps1 | iex',
  eta: '1~2분',
  installFailed: '설치하지 못했어요',
  retry: '다시 시도',
  loginTitle: 'Claude 계정 로그인',
  loginBody: '단추를 누르면 브라우저가 열려요. 쓰고 있는 Claude 구독 계정으로 로그인하고 돌아오면 이어져요.',
  login: '로그인',
  waiting: '브라우저에서 마치면 저절로 넘어가요',
  reopen: '다시 열기',
  loginFailed: '로그인을 확인하지 못했어요 — 다시 해 주세요',
  tour: '둘러보기',
  tourEta: '· 1분',
  relaunching: '두레를 다시 켜요…',
} as const

/** 상태 띠 오른쪽 — 켤 때 claude 최신으로 바꾸는 동안만 */
export const CLAUDE_UPDATING = 'claude 최신으로 바꾸는 중…'

/** ~/.ssh/config 한 줄의 흐린 주소 — user@hostName(없는 칸은 뺀다). 덧붙일 게 없으면 null */
export function sshAddress(e: SshHostEntry): string | null {
  const name = e.hostName ?? e.host
  const addr = e.user ? `${e.user}@${name}` : name
  return addr === e.host ? null : addr
}

/** 서버 방 표시 한 줄 — '<host> · <user>@<hostName>', 목록에 없거나 덧붙일 게 없으면 host 만 */
export function serverLine(host: string, hosts: readonly SshHostEntry[] | null): string {
  const e = hosts?.find(h => h.host === host)
  const addr = e ? sshAddress(e) : null
  return addr ? `${host} · ${addr}` : host
}

/** 지난 대화 탭 — 탭 이름 · 지금 배지 · 날짜 줄 꼬리 · 읽기 띠 · 아래 줄 안내·단추 · 긴 대화의 앞 줄 */
export const PAST = {
  tab: '지난 대화',
  current: '지금',
  turns: (n: number) => `${n}차례`,
  readOnly: '읽기만',
  /** 글·그림 없는 첫 말 — 제목이 빈 대화 */
  untitled: '(내용 없음)',
  back: '목록으로',
  note: '돌아가도 지금 대화는 지난 대화에 남아요.',
  fork: '새 에이전트로 이어 가기',
  resume: '이 대화로 돌아가기',
  more: '앞 줄 모두 보기',
} as const

/** 이어 갈 수 없는 이유 글(목록 셋째 줄 · 읽기 아래 줄) — 엔진이 거절하는 글과 같다(gone 은 30일이 넘은 대화만 '30일이 지나') */
export { pastWhyText } from '../../shared/pastWhy'

/** 돌아가기를 막는 까닭 — 읽기 아래 줄(엔진이 거절하는 글과 같다) */
export const RESUME_BLOCK_WORD: Record<'working' | 'asking' | 'held', string> = {
  working: '일이 끝나면 돌아갈 수 있어요',
  asking: '기다리는 카드를 먼저 처리해 주세요',
  held: '붙잡아 둔 입력을 먼저 처리해 주세요',
}

/** 아바타 글자 — 이름의 첫 글자(영문은 대문자) */
export function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}

const FAMILY_NAME = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' } as const
const FAMILY_DESC: Record<string, string> = {
  opus: '어려운 일에 가장 똑똑한 모델',
  sonnet: '빠르고 균형 잡힌 모델',
  haiku: '가장 빠르고 가벼운 모델',
  fable: '가장 어렵고 오래 걸리는 일에 맞는 모델',
}
const MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/

/** 모델 id → 'Opus 5.5' · 'Haiku 4.5' · 'Opus 5 (긴 대화)'. id 가 아니면 null */
export function modelVersionName(id: string): string | null {
  const m = MODEL_ID.exec(id)
  if (!m) return null
  const family = FAMILY_NAME[m[1] as keyof typeof FAMILY_NAME]
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (긴 대화)' : ''}`
}

/** 관계도 카드의 모델 이름 — 지금 풀린 모델 > 고른 모델(버전 id 면 버전, 별명이면 계열) > 기본 모델 */
export function nodeModelLabel(model: string | null, modelNow: string | null): string {
  const now = modelNow ? modelVersionName(modelNow) : null
  if (now) return now
  if (model) return modelVersionName(model) ?? modelText(model).name
  return '기본 모델'
}

// 'Opus 5.5' 처럼 띄어 쓴 숫자 낱말이 있는 이름만 버전 이름으로 본다('Opus (1M context)' 는 아니다)
const HAS_VERSION = /(?:^|\s)\d+(?:\.\d+)?(?:\s|$)/

/**
 * 모델 이름·설명 — Claude 가 주는 설명은 영어라 값(value)으로 한국어를 고른다.
 * 이름은 모델 id(resolvedModel) 에서 뽑은 버전 이름 > 버전이 든 Claude 이름 > 계열 이름 > Claude 이름·값.
 * describe 전에도 쓴다 — 패널 머리의 모델 칩은 agent.model 만으로 이름을 정한다.
 */
export function modelText(value: string, displayName?: string, resolvedModel?: string): { name: string; description: string | null } {
  const versioned = modelVersionName(resolvedModel ?? value)
  if (value === 'default') {
    return { name: '기본 (추천)', description: versioned ? `${versioned} · 평소 쓰기 좋은 모델` : '평소 쓰기 좋은 모델' }
  }
  const family = /^(?:claude-)?(opus|sonnet|haiku|fable)/.exec(value)?.[1] ?? /^claude-(opus|sonnet|haiku|fable)/.exec(resolvedModel ?? '')?.[1]
  const description = family ? FAMILY_DESC[family] : null
  if (versioned) return { name: versioned, description }
  if (displayName && HAS_VERSION.test(displayName)) return { name: displayName, description }
  if (family) {
    const long = value.includes('[1m]') ? ' (긴 대화)' : ''
    return { name: `${FAMILY_NAME[family as keyof typeof FAMILY_NAME]}${long}`, description }
  }
  return { name: displayName || value, description }
}

/** 엔진 오류를 화면에 그대로 — 엔진의 한국어 문구만 온다(스택은 오지 않는다) */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 엔진의 이름 겹침 문구 — store.ts addAgent·updateAgent 가 던진다 */
const NAME_TAKEN = /^이미 있는 이름입니다: (.+)$/

/**
 * 입력 칸 아래에 보일 오류 — 엔진 문구 중 해요체가 아니고 다음 할 일이 없는 것만 바꿔 쓴다.
 * 이름 겹침 '이미 있는 이름입니다: 기획' → '‘기획’이라는 에이전트가 이미 있어요. 다른 이름을 써 주세요.'
 * 그 밖은 그대로(어느 칸의 오류인지는 원문으로 가린다).
 */
export function fieldError(message: string): string {
  const taken = NAME_TAKEN.exec(message)
  if (!taken) return message
  const name = taken[1]
  const b = hasBatchim(name)
  const ra = b === null ? '(이)라는' : b ? '이라는' : '라는'
  return `‘${name}’${ra} 에이전트가 이미 있어요. 다른 이름을 써 주세요.`
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 지난 시각 — 방금 · N분 전 · N시간 전 · N일 전 */
export function ago(at: number, now: number): string {
  const d = now - at
  if (d < MIN) return '방금'
  if (d < HOUR) return `${Math.floor(d / MIN)}분 전`
  if (d < DAY) return `${Math.floor(d / HOUR)}시간 전`
  return `${Math.floor(d / DAY)}일 전`
}

/**
 * 아는 명령 출력의 한국어 한 줄 — Claude 가 주는 출력은 영어라, 아는 것만 바꿔 보이고 원문은 접어 둔다.
 * /compact 는 'Compacted' 뒤에 훅 메시지(내 PC 경로 포함)가 붙어 온다. 모르는 출력은 null(원문 그대로).
 */
export function localSummary(text: string): string | null {
  if (/^Compacted\b/.test(text)) return '대화를 요약해서 줄였어요'
  return null
}

/** 글의 첫 줄 — 마크다운 머리표·강조 기호는 걷는다(접힌 전달 메시지 · 서브에이전트 지도의 차례 머리·실패 줄) */
export function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim() !== '') ?? ''
  return line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[`*]/g, '').trim()
}

/** 지난 시간(초까지) — 대화 맨 아래 '작업 중…' 줄이 1초마다 센다: N초 · N분 N초 · N분 · N시간 N분 */
export function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}분` : `${m}분 ${s % 60}초`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}

/** 이어진 시간 — 방금 시작 · N분째 · N시간째 */
export function lasting(since: number, now: number): string {
  const d = now - since
  if (d < MIN) return '방금 시작'
  if (d < HOUR) return `${Math.floor(d / MIN)}분째`
  return `${Math.floor(d / HOUR)}시간째`
}

/** 위 띠 막대 라벨 — 5시간 · 1주 · 모델 이름 */
export function usageBarLabel(w: UsageWindow): string {
  if (w.key === 'session') return '5시간'
  if (w.key === 'week') return '1주'
  return w.label
}

/** 펼침 줄 라벨 — 5시간 · 1주 · 모든 모델 · 1주 · Fable 전용 */
export function usageRowLabel(w: UsageWindow): string {
  if (w.key === 'session') return '5시간'
  if (w.key === 'week') return '1주 · 모든 모델'
  return `1주 · ${w.label} 전용`
}

const two = (n: number) => String(n).padStart(2, '0')

/** 초기화 시각 — 곧 · M분 뒤 · H시간 M분 뒤 · 하루 넘으면 M월 D일(요일) HH:mm */
export function resetText(resetsAt: number, now: number): string {
  const d = resetsAt - now
  if (d < MIN) return '곧 초기화'
  if (d < HOUR) return `${Math.floor(d / MIN)}분 뒤 초기화`
  if (d < DAY) {
    const h = Math.floor(d / HOUR)
    const m = Math.floor((d % HOUR) / MIN)
    return m === 0 ? `${h}시간 뒤 초기화` : `${h}시간 ${m}분 뒤 초기화`
  }
  const t = new Date(resetsAt)
  return `${t.getMonth() + 1}월 ${t.getDate()}일(${'일월화수목금토'[t.getDay()]}) ${two(t.getHours())}:${two(t.getMinutes())} 초기화`
}

/** 토큰 수 — 1만 아래 '3,400' · 10만 아래 '1.2만'·'5만' · 그 위 '34만'·'100만' */
export function tokensText(n: number): string {
  if (n < 10_000) return n.toLocaleString('ko-KR')
  const man = n / 10_000
  if (man < 10) return `${Number(man.toFixed(1))}만`
  return `${Math.round(man)}만`
}

/** 업데이트 토스트 */
export const UPDATE_TOAST = {
  title: '새 버전이 나왔어요',
  versions: (next: string, now: string) => `두레 ${next} · 지금 ${now}`,
  update: '업데이트',
  later: '나중에',
  all: '모두 보기',
  close: '닫기',
  downloading: (p: number) => `받고 있어요 · ${p}%`,
  keepUsing: '받는 동안 계속 써도 돼요',
  ready: '업데이트 준비됐어요',
  readyBody: (v: string) => `다시 켜면 새 버전(${v})으로 바뀌어요`,
  working: (n: number) => `일하는 에이전트 ${n}명이 멈춰요 — 다시 켜진 뒤 말을 걸면 이어서 해요`,
  restart: '지금 다시 켜기',
  onQuit: '끌 때 할게요',
  failed: '받지 못했어요',
  installFailed: '업데이트를 설치하지 못했어요',
  retry: '다시 시도',
} as const
