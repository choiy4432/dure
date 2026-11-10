import fs from 'node:fs'
import path from 'node:path'
import type { Engine } from '../engine'
import {
  APP_METHODS, BEFORE_START, CLAUDE_MISSING_ERROR, METHODS,
  type AgentView, type DureApi, type InvokeResult, type Snapshot,
} from '../shared/ipcContract'
import { ATTACH_FAILED, ATTACH_NOT_FOUND, ATTACH_OPEN_FAILED, IMAGE_TYPES, opensAsDocument } from '../shared/attachments'
import { PHONE_DENIED, PHONE_FOLDER_BAD, phoneAllows, phoneFolderOk } from '../shared/phoneAccess'
import { pickPhoneChange } from '../shared/phoneTypes'
import { REALPATH_FATAL } from '../engine/attachmentStore'
import { SLEEP_DEFAULT_MIN, type AgentPatch, type Decision, type ThemePref, type UserPart } from '../engine/types'
import { pickPrefs } from './appPrefs'

// IPC(창)와 휴대폰 서버가 같이 타는 디스패처 — 메서드 이름 + 인자 → 앱 쪽·엔진·창 쪽 일. 누가 불렀는지(창 프레임·휴대폰 기기)는
// 부르는 쪽이 먼저 가린다: IPC 는 isAppPage(registerIpc), 휴대폰은 phoneDispatcher(허용 목록)

type AppMethod = (typeof APP_METHODS)[number]
/** 엔진 없이 도는 앱 쪽 일 — APP_METHODS 전부(main 이 준비 흐름·claude 최신으로·두레 업데이트·휴대폰 연결로 채운다) */
export type AppHost = Pick<DureApi, AppMethod>

/** 디스패처가 쓰는 main 쪽 일 — IpcDeps 는 이것에 창 쪽 칸(사건 잇기·화면 주소 가리기)을 더한 것 */
export interface DispatchDeps {
  /** 앱 쪽 메서드가 가는 곳 — 엔진이 없어도·엔진 시작 전에도 */
  app: AppHost
  /** 엔진 시작이 끝나면 풀린다 — BEFORE_START 밖의 엔진 메서드는 이걸 기다린 뒤 엔진에 닿는다 */
  engineReady: Promise<void>
  pickFolder(): Promise<string | null>
  openFolder(path: string): Promise<void>
  /** 기본 앱으로 파일 열기(shell.openPath) — 못 열면 던진다. 엔진이 첨부 폴더 안으로 푼 경로만 온다(openAttachment) */
  openPath(path: string): Promise<void>
  /** 탐색기에서 그 파일을 골라 보인다(shell.showItemInFolder) — 허용 목록 밖 종류의 첨부는 열지 않고 이것으로 */
  showInFolder(path: string): void
  /** 기본 앱으로 주소 열기(VS Code 원격 창) — 못 열면 던진다 */
  openExternal(url: string): Promise<void>
  /** 저장 창으로 글을 저장 — 저장한 경로, 취소면 null. 이름은 이미 다듬어 온다(saveName) */
  saveText(fileName: string, text: string): Promise<string | null>
  /** 작업표시줄 배지 — count 가 0 이면 지운다. 엔진을 거치지 않는 창 쪽 일이라 deps 로 받는다 */
  setTaskbar(count: number, png: string | null): Promise<void>
  /** 초점이 없는 창의 작업표시줄 단추를 깜박인다 */
  flashWindow(): Promise<void>
  /** 창을 앞으로(최소화면 되살리고 초점) */
  focusWindow(): Promise<void>
  /** 화면 테마를 창에 — Windows 에 알릴 테마(nativeTheme.themeSource)를 바꾼다 */
  applyTheme(t: ThemePref): void
}

/** 메서드 이름 + 인자 → 결과 봉투. 던지지 않는다(오류는 { ok:false, error: 문구 } — 스택 없이) */
export type Dispatch = (method: string, args: unknown[]) => Promise<InvokeResult>

export const NOT_ALLOWED = '허용되지 않은 요청이에요'
const FOLDER_NOT_ALLOWED = '등록된 에이전트의 폴더만 열 수 있어요'
const VSCODE_MISSING = 'VS Code 를 찾지 못했어요'
const REMOTE_BAD = '서버 방 인자가 올바르지 않아요'
const SAVE_BAD = '저장할 이름과 글이 필요해요'

/**
 * 저장 창의 처음 이름 — renderer 가 준 이름에서 경로를 떼고(마지막 / · \ 뒤만) Windows 가 못 쓰는 글자를 _ 로, 끝은 .md.
 * 비면 '대화.md'. 사람이 저장 창에서 고르는 이름이라 처음 값만 다듬는다
 */
export function saveName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim()
  const stem = base.replace(/\.md$/i, '').replace(/^[.\s]+/, '')
  return `${stem || '대화'}.md`
}

const CONV_BAD = '지난 대화를 부를 수 없어요'
const PARTS_BAD = '보낼 내용이 올바르지 않아요'
const FILE_PART_BAD = `${ATTACH_FAILED} — 첨부 정보가 올바르지 않아요`
const AGENT_BAD = '에이전트 정보가 올바르지 않아요'
const HISTORY_BAD = '대화 기록을 부를 수 없어요'
const SEARCH_BAD = '찾기 요청이 올바르지 않아요'
const PHONE_DEVICE_BAD = '끊을 기기를 알 수 없어요'
const MODEL_BAD = '모델 이름이 올바르지 않아요'
const ROOM_NAME_BAD = '방 이름을 바꿀 수 없어요'
const DECISION_BAD = '답을 보낼 수 없어요 — 답 꼴이 올바르지 않아요'
/** 모델 이름 상한 — 화면의 목록·직접 입력 모두 이보다 짧다 */
const MODEL_MAX = 200

/** 칸이 꼭 이 이름들뿐인 보통 객체인가(목록·null 아님) — 부르는 쪽이 꾸민 칸을 엔진에 넘기지 않게 */
function hasOnlyKeys(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const own = Object.keys(v)
  return own.length === keys.length && own.every((k) => keys.includes(k))
}

/** file part 꼴인가(칸 검사 전) — checkedParts·phoneDispatcher 가 같은 기준으로 가른다 */
function isFilePart(p: unknown): p is Record<string, unknown> {
  return !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'file'
}

const IMAGE_TYPE_SET: ReadonlySet<string> = new Set(IMAGE_TYPES)

/**
 * sendUser 의 칸 목록을 거른다 — 목록이 아니면 거절. 받는 칸은 셋뿐(허용 목록): 글 {type,text} · 그림 {type,mediaType(IMAGE_TYPES),base64} ·
 * 파일 {type,path(절대 경로, NUL 없음),name(글),bytes(0 이상 정수)}. 다른 칸·틀린 값·모르는 type 이면 거절(엔진에 닿지 않는다) —
 * 엔진은 글·그림이 아닌 칸을 준비된 첨부(sendPath·inline)로 읽으니 그 꼴을 꾸며 경로 줄·문서 블록을 넣지 못하게.
 * bytes 는 화면이 본 크기일 뿐 — 상한(100MB)은 엔진이 원본을 fs.stat 으로 다시 재서 막는다
 */
function checkedParts(parts: unknown): UserPart[] {
  if (!Array.isArray(parts)) throw new Error(PARTS_BAD)
  return parts.map((p): UserPart => {
    if (isFilePart(p)) {
      if (!hasOnlyKeys(p, ['type', 'path', 'name', 'bytes'])) throw new Error(FILE_PART_BAD) // 준비된 꼴의 file·sendPath·remotePath 를 꾸며 넣지 못하게
      const { path: at, name, bytes } = p
      if (typeof at !== 'string' || at.includes('\u0000') || !path.isAbsolute(at)) throw new Error(FILE_PART_BAD)
      if (typeof name !== 'string') throw new Error(FILE_PART_BAD)
      if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error(FILE_PART_BAD)
      return { type: 'file', path: at, name, bytes }
    }
    if (hasOnlyKeys(p, ['type', 'text']) && p.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text }
    if (hasOnlyKeys(p, ['type', 'mediaType', 'base64']) && p.type === 'image' && typeof p.mediaType === 'string' && IMAGE_TYPE_SET.has(p.mediaType) && typeof p.base64 === 'string') {
      return { type: 'image', mediaType: p.mediaType, base64: p.base64 }
    }
    throw new Error(PARTS_BAD)
  })
}

/** addAgent 의 입력 — 화면(에이전트 추가 대화상자)이 보내는 글 넷뿐 */
function checkedNewAgent(i: unknown): { roomId: string; name: string; role: string; folder: string } {
  if (!hasOnlyKeys(i, ['roomId', 'name', 'role', 'folder'])) throw new Error(AGENT_BAD)
  const { roomId, name, role, folder } = i
  if (typeof roomId !== 'string' || typeof name !== 'string' || typeof role !== 'string' || typeof folder !== 'string') throw new Error(AGENT_BAD)
  return { roomId, name, role, folder }
}

type UiPatch = Pick<AgentPatch, 'name' | 'role' | 'auto' | 'pos' | 'color' | 'bypassNoticeClosed'>
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** updateAgent 가 받는 칸과 그 값 — Engine.updateAgent 가 store 로 넘기는 것과 같다(model·alwaysAllow·sessionId 등은 엔진이 따로) */
const PATCH_FIELDS: Record<keyof UiPatch, (v: unknown) => boolean> = {
  name: (v) => typeof v === 'string',
  role: (v) => typeof v === 'string',
  auto: (v) => typeof v === 'boolean',
  pos: (v) => hasOnlyKeys(v, ['x', 'y']) && isFiniteNumber(v.x) && isFiniteNumber(v.y),
  color: (v) => v === null || typeof v === 'string',
  bypassNoticeClosed: (v) => typeof v === 'boolean',
}

/**
 * updateAgent 의 고칠 칸 — 보통 객체 · 아는 칸(PATCH_FIELDS)만 · 칸마다 맞는 꼴(값이 undefined 면 없는 것으로). 모르는 칸이 하나라도 있으면 거절.
 * 틀린 꼴(pos:null · role:{} …)이 state.json 에 남아 창을 깨뜨리지 않게
 */
function checkedPatch(p: unknown): UiPatch {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(AGENT_BAD)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (!Object.hasOwn(PATCH_FIELDS, k)) throw new Error(AGENT_BAD)
    if (v === undefined) continue
    if (!PATCH_FIELDS[k as keyof UiPatch](v)) throw new Error(AGENT_BAD)
    out[k] = k === 'pos' ? { x: (v as { x: number }).x, y: (v as { y: number }).y } : v
  }
  return out as UiPatch
}

/** 몇 개까지 — 1 이상 정수 · Infinity(내보내기 — 창 IPC 만. 휴대폰 JSON 은 Infinity 를 null 로 바꿔 거절된다) */
const isLimit = (v: unknown): v is number => typeof v === 'number' && (v === Infinity || (Number.isSafeInteger(v) && v >= 1))

/**
 * history 의 o — 없음, 또는 { all?: 참거짓, limit?: 1 이상 정수 · Infinity(내보내기), before?: 유한한 수(앞쪽 불러오기 — 그 시각보다 앞) }.
 * 값이 undefined 인 칸은 없는 것으로
 */
function checkedHistoryOpts(o: unknown): { all?: boolean; limit?: number; before?: number } | undefined {
  if (o === undefined) return undefined
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(HISTORY_BAD)
  const out: { all?: boolean; limit?: number; before?: number } = {}
  for (const [k, v] of Object.entries(o)) {
    if (k !== 'all' && k !== 'limit' && k !== 'before') throw new Error(HISTORY_BAD)
    if (v === undefined) continue
    if (k === 'all') {
      if (typeof v !== 'boolean') throw new Error(HISTORY_BAD)
      out.all = v
    } else if (k === 'before') {
      if (!isFiniteNumber(v)) throw new Error(HISTORY_BAD)
      out.before = v
    } else {
      if (!isLimit(v)) throw new Error(HISTORY_BAD)
      out.limit = v
    }
  }
  return out
}

/** search 의 o — 없음, 또는 { roomId?: 글 }(지금 방). 상한은 받지 않는다(엔진 기본 50). 값이 undefined 인 칸은 없는 것으로 */
function checkedSearchOpts(o: unknown): { roomId?: string } {
  if (o === undefined) return {}
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(SEARCH_BAD)
  const out: { roomId?: string } = {}
  for (const [k, v] of Object.entries(o)) {
    if (k !== 'roomId') throw new Error(SEARCH_BAD)
    if (v === undefined) continue
    if (typeof v !== 'string') throw new Error(SEARCH_BAD)
    out.roomId = v
  }
  return out
}

/** 끊긴 찾기의 답 — 화면은 버린다(늦게 온 앞 찾기 결과가 새 결과를 덮지 않게) */
const SEARCH_CANCELLED = { hits: [], more: false, cancelled: true } as const

/**
 * search — 디스패처(창)마다 하나만 돈다: 새 찾기가 오면 앞 찾기의 AbortController 를 끊는다(엔진은 파일 읽기를 그만둔다).
 * 끊긴 찾기는 끝난 꼴과 상관없이(그만둠·오류·늦게 끝남) SEARCH_CANCELLED. 꼴이 틀린 요청은 앞 찾기를 끊지 않고 거절
 */
function searchHandler(): Handler {
  let running: AbortController | null = null
  return async (e, _d, query, o) => {
    if (typeof query !== 'string') throw new Error(SEARCH_BAD)
    const { roomId } = checkedSearchOpts(o)
    running?.abort()
    const ac = new AbortController()
    running = ac
    try {
      const found = await e.search(query, roomId !== undefined ? { roomId, signal: ac.signal } : { signal: ac.signal })
      return ac.signal.aborted ? SEARCH_CANCELLED : found
    } catch (err) {
      if (ac.signal.aborted) return SEARCH_CANCELLED
      throw err
    } finally {
      if (running === ac) running = null
    }
  }
}

/** conversation 의 o — 없음, 또는 { limit?: 1 이상 정수 · Infinity(내보내기) }. 값이 undefined 인 칸은 없는 것으로 */
function checkedConversationOpts(o: unknown): { limit?: number } | undefined {
  if (o === undefined) return undefined
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(CONV_BAD)
  const out: { limit?: number } = {}
  for (const [k, v] of Object.entries(o)) {
    if (k !== 'limit') throw new Error(CONV_BAD)
    if (v === undefined) continue
    if (!isLimit(v)) throw new Error(CONV_BAD)
    out.limit = v
  }
  return out
}

/**
 * answerRequest 의 답 — Decision 꼴만: { type:'allow' } · { type:'allow-always' } · { type:'deny', message?: 글 } ·
 * { type:'answer', answers: 글 → 글 }. 다른 칸·틀린 값이면 거절(엔진엔 정한 칸만 — undefined 인 message 는 없는 것으로)
 */
function checkedDecision(d: unknown): Decision {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(DECISION_BAD)
  const x = d as Record<string, unknown>
  const keys = Object.keys(x).filter((k) => x[k] !== undefined)
  const only = (...ks: string[]) => keys.length === ks.length && keys.every((k) => ks.includes(k))
  if ((x.type === 'allow' || x.type === 'allow-always') && only('type')) return { type: x.type }
  if (x.type === 'deny' && (only('type') || (only('type', 'message') && typeof x.message === 'string'))) {
    return typeof x.message === 'string' ? { type: 'deny', message: x.message } : { type: 'deny' }
  }
  if (x.type === 'answer' && only('type', 'answers')) {
    const a = x.answers
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error(DECISION_BAD)
    const entries = Object.entries(a)
    if (!entries.every(([, v]) => typeof v === 'string')) throw new Error(DECISION_BAD)
    // fromEntries — '__proto__' 같은 칸 이름도 그냥 글 칸으로(원형을 바꾸지 않는다)
    return { type: 'answer', answers: Object.fromEntries(entries) as Record<string, string> }
  }
  throw new Error(DECISION_BAD)
}

function agentViews(engine: Engine): AgentView[] {
  return engine.agents().map((a) => {
    const flags = engine.flags(a.id)
    return {
      ...a,
      status: engine.status(a.id),
      errorText: engine.errorText(a.id),
      bypass: flags.bypass,
      bypassBySettings: flags.bySettings,
      bypassPending: flags.pending,
      heldInput: engine.heldInput(a.id),
      planMode: engine.planMode(a.id),
      ...engine.sleepState(a.id),
      background: engine.backgroundRunning(a.id),
      hold: engine.hold(a.id),
      effortNow: engine.effortNow(a.id),
      modelNow: engine.modelNow(a.id),
      subagentsRunning: engine.subagentsRunning(a.id),
      pastCount: engine.pastCount(a.id),
      remoteIssue: engine.remoteIssue(a.id),
    }
  })
}

function snapshot(engine: Engine | null): Snapshot {
  if (!engine) {
    return { claudeMissing: true, rooms: [], agents: [], messages: [], requests: [], autoChainLimit: 0, allowBypass: false, notify: { asks: true, finished: false }, theme: 'system', sleepAfterMin: SLEEP_DEFAULT_MIN, usage: null }
  }
  return {
    claudeMissing: false,
    rooms: engine.rooms(),
    agents: agentViews(engine),
    messages: engine.messages(),
    requests: engine.pendingRequests(),
    autoChainLimit: engine.autoChainLimit(),
    allowBypass: engine.allowBypass(),
    notify: engine.notify(),
    theme: engine.theme(),
    sleepAfterMin: engine.sleepAfter(),
    usage: engine.usage(),
  }
}

type Handler = (e: Engine, deps: DispatchDeps, ...a: any[]) => unknown
type EngineMethod = (typeof METHODS)[number]
/** 상태 없는 엔진·창 쪽 일 — search 는 디스패처마다 끊기 상태가 있어 createDispatcher 가 붙인다(searchHandler) */
const HANDLERS: Record<Exclude<EngineMethod, 'search'>, Handler> = {
  snapshot: (e) => snapshot(e),
  addRoom: (e, _d, name, remote) => {
    if (typeof name !== 'string') throw new Error(REMOTE_BAD)
    // remote 는 없음·null 또는 { host: 글 } 뿐 — 그 밖의 칸은 거절
    if (remote == null) return e.addRoom(name)
    const r = remote as Record<string, unknown>
    if (typeof remote !== 'object' || Array.isArray(remote) || typeof r.host !== 'string' || Object.keys(r).length !== 1) throw new Error(REMOTE_BAD)
    return e.addRoom(name, { host: r.host })
  },
  sshAvailable: (e) => e.sshAvailable(),
  sshHosts: (e) => e.sshHosts(),
  checkRemote: (e, _d, host) => {
    if (typeof host !== 'string') throw new Error(REMOTE_BAD)
    return e.checkRemote(host)
  },
  checkRemoteFolder: (e, _d, roomId, folder) => {
    if (typeof roomId !== 'string' || typeof folder !== 'string') throw new Error(REMOTE_BAD)
    return e.checkRemoteFolder(roomId, folder)
  },
  renameRoom: (e, _d, id, name) => {
    if (typeof id !== 'string' || typeof name !== 'string') throw new Error(ROOM_NAME_BAD)
    return e.renameRoom(id, name) // 빈 이름·겹침은 엔진이
  },
  removeRoom: (e, _d, id) => e.removeRoom(id),
  addAgent: (e, _d, i) => e.addAgent(checkedNewAgent(i)),
  updateAgent: (e, _d, id, p) => {
    if (typeof id !== 'string') throw new Error(AGENT_BAD)
    return e.updateAgent(id, checkedPatch(p))
  },
  removeAgent: (e, _d, id) => e.removeAgent(id),
  setSelected: (e, _d, id) => e.setSelected(id),
  sendUser: (e, _d, id, parts, o) => e.sendUser(id, checkedParts(parts), (o as { plan?: unknown } | undefined)?.plan === true ? { plan: true } : undefined),
  setPlanMode: (e, _d, id, on) => e.setPlanMode(id, on),
  resumeHold: (e, _d, id) => e.resumeHold(id),
  dropHoldItem: (e, _d, id, itemId) => e.dropHoldItem(id, itemId),
  dropHold: (e, _d, id) => e.dropHold(id),
  revokeAlwaysAllow: (e, _d, id, toolName) => e.revokeAlwaysAllow(id, toolName),
  interrupt: (e, _d, id) => e.interrupt(id),
  newConversation: (e, _d, id) => e.newConversation(id),
  setModel: (e, _d, id, model) => {
    // null = 기본 모델 · 글은 1~MODEL_MAX 자(claude 의 --model 로 간다)
    if (typeof id !== 'string' || !(model === null || (typeof model === 'string' && model.length > 0 && model.length <= MODEL_MAX))) {
      throw new Error(MODEL_BAD)
    }
    return e.setModel(id, model)
  },
  setEffort: (e, _d, id, level) => e.setEffort(id, level),
  refreshUsage: (e) => e.refreshUsage(),
  describe: (e, _d, id) => e.describe(id),
  history: (e, _d, id, o) => {
    if (typeof id !== 'string') throw new Error(HISTORY_BAD)
    return e.history(id, checkedHistoryOpts(o))
  },
  conversations: (e, _d, id) => {
    if (typeof id !== 'string') throw new Error(CONV_BAD)
    return e.conversations(id)
  },
  conversation: (e, _d, id, key, o) => {
    if (typeof id !== 'string' || typeof key !== 'string') throw new Error(CONV_BAD)
    return e.conversation(id, key, checkedConversationOpts(o))
  },
  resumeConversation: (e, _d, id, key) => {
    if (typeof id !== 'string' || typeof key !== 'string') throw new Error(CONV_BAD)
    return e.resumeConversation(id, key)
  },
  forkAgent: (e, _d, i) => {
    const x = i as { from?: unknown; key?: unknown; name?: unknown; role?: unknown } | null
    if (!x || typeof x.from !== 'string' || typeof x.key !== 'string' || typeof x.name !== 'string' || typeof x.role !== 'string') throw new Error(CONV_BAD)
    return e.forkAgent({ from: x.from, key: x.key, name: x.name, role: x.role })
  },
  image: (e, _d, id, file) => e.image(id, file),
  openAttachment: async (e, d, id, file) => {
    // renderer 가 임의 경로를 열지 못하게 — 기록의 사본 이름만 받고, 엔진이 그 에이전트 첨부 폴더 안의 있는 사본으로 푼 경로만 연다
    if (typeof id !== 'string' || typeof file !== 'string') throw new Error(ATTACH_NOT_FOUND)
    const abs = e.attachmentPath(id, file)
    if (!abs) throw new Error(ATTACH_NOT_FOUND)
    // 허용 목록(문서·그림·소리·영상·zip)만 연다 — 그 밖(실행·스크립트·프로젝트·디스크 이미지·확장자 없음 …)은 누르기 한 번으로 돌지 않게
    // 열지 않고 탐색기에서 보인다
    if (!opensAsDocument(abs)) {
      d.showInFolder(abs)
      return
    }
    try {
      await d.openPath(abs)
    } catch {
      throw new Error(ATTACH_OPEN_FAILED) // Windows 원문(경로가 들 수 있다)은 넘기지 않는다
    }
  },
  approveMessage: (e, _d, id) => e.approveMessage(id),
  dismissMessage: (e, _d, id) => e.dismissMessage(id),
  retryMessage: (e, _d, id) => e.retryMessage(id),
  continueHeld: (e, _d, roomId) => e.continueHeld(roomId),
  answerRequest: (e, _d, id, d) => {
    if (typeof id !== 'string') throw new Error(DECISION_BAD)
    return e.answerRequest(id, checkedDecision(d))
  },
  setAutoChainLimit: (e, _d, n) => e.setAutoChainLimit(n),
  setAllowBypass: (e, _d, on) => e.setAllowBypass(on),
  setNotify: (e, _d, p) => e.setNotify(p),
  setTheme: (e, d, t) => {
    e.setTheme(t) // 저장이 거절되면(모르는 값) 창도 그대로
    d.applyTheme(t)
  },
  setBypass: (e, _d, id, on) => e.setBypass(id, on),
  sleep: (e, _d, id) => e.sleep(id),
  sleepRoom: (e, _d, roomId) => e.sleepRoom(roomId),
  sleepBlock: (e, _d, id) => e.sleepBlock(id),
  sleepableIn: (e, _d, roomId) => e.sleepableIn(roomId),
  setSleepAfter: (e, _d, min) => e.setSleepAfter(min),
  pickFolder: (_e, d) => d.pickFolder(),
  saveConversation: (_e, d, name, text) => {
    if (typeof name !== 'string' || typeof text !== 'string') throw new Error(SAVE_BAD)
    return d.saveText(saveName(name), text)
  },
  setTaskbar: (_e, d, count, png) => d.setTaskbar(count as number, (png ?? null) as string | null),
  flashWindow: (_e, d) => d.flashWindow(),
  focusWindow: (_e, d) => d.focusWindow(),
  openAgentFolder: async (e, d, id) => {
    // renderer 가 임의 경로를 열지 못하게 — 등록된 에이전트의 폴더만(경로는 엔진이 에이전트에서 푼다)
    if (typeof id !== 'string' || !e.agents().some((a) => a.id === id)) throw new Error(FOLDER_NOT_ALLOWED)
    const t = e.folderTarget(id)
    if (t.kind === 'local') return d.openFolder(t.path)
    try {
      await d.openExternal('vscode://vscode-remote/ssh-remote+' + encodeURIComponent(t.host) + t.path.split('/').map(encodeURIComponent).join('/'))
    } catch {
      throw new Error(VSCODE_MISSING)
    }
  },
}

/** 앱 쪽 메서드 — renderer 가 붙인 인자는 setPrefs 의 (다듬은) 설정만 넘긴다 */
const APP_HANDLERS: Record<AppMethod, (app: AppHost, ...a: unknown[]) => unknown> = {
  appInfo: (a) => a.appInfo(),
  prefs: (a) => a.prefs(),
  setPrefs: (a, p) => a.setPrefs(pickPrefs(p)), // 아는 칸의 불리언만 — {tourDone:'x'} 는 빈 바꿈
  setupState: (a) => a.setupState(),
  installClaude: (a) => a.installClaude(),
  loginClaude: (a) => a.loginClaude(),
  openSetupGuide: (a) => a.openSetupGuide(),
  claudeUpdateState: (a) => a.claudeUpdateState(),
  updateState: (a) => a.updateState(),
  checkUpdate: (a) => a.checkUpdate(),
  downloadUpdate: (a) => a.downloadUpdate(),
  installUpdate: (a) => a.installUpdate(),
  openReleasePage: (a) => a.openReleasePage(),
  setTourVeil: (a, on) => a.setTourVeil(on === true),
  phoneState: (a) => a.phoneState(),
  setPhone: (a, p) => a.setPhone(pickPhoneChange(p)), // 불리언인 아는 칸만 — 포트·모르는 칸은 버린다
  phoneCheck: (a) => a.phoneCheck(),
  phonePairStart: (a) => a.phonePairStart(),
  phonePairCancel: (a) => a.phonePairCancel(),
  phoneUnpair: (a, id) => {
    if (typeof id !== 'string' || id === '') throw new Error(PHONE_DEVICE_BAD)
    return a.phoneUnpair(id)
  },
  phoneNoticeSeen: (a) => a.phoneNoticeSeen(),
}

const STARTS_NOW: ReadonlySet<string> = new Set(BEFORE_START)

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 메서드 이름 + 인자 → 결과. 순서: 앱 메서드 → deps.app(엔진 없어도) · 모르는 이름 → 거절 · snapshot → 바로 ·
 * 엔진 없음 → CLAUDE_MISSING_ERROR · BEFORE_START 밖 → engineReady 뒤 · 엔진·창 쪽 일.
 * 부르는 쪽(창 IPC·휴대폰 WebSocket)이 준 값을 믿지 않는다 — 이름이 글이 아니거나 인자가 목록이 아니어도 던지지 않고 봉투로 답한다
 */
export function createDispatcher(engine: Engine | null, deps: DispatchDeps): Dispatch {
  // 기다리다 거절돼도(시작 실패) 문을 연다 — 엔진 메서드가 자기 오류를 말하게
  const ready = deps.engineReady.catch(() => {})
  const handlers: Record<EngineMethod, Handler> = { ...HANDLERS, search: searchHandler() }
  return async (method, args) => {
    try {
      const a: unknown[] = Array.isArray(args) ? args : []
      if (typeof method === 'string' && Object.hasOwn(APP_HANDLERS, method)) {
        const value = await APP_HANDLERS[method as AppMethod](deps.app, ...a)
        return { ok: true, value: value ?? null }
      }
      if (typeof method !== 'string' || !Object.hasOwn(handlers, method)) throw new Error(NOT_ALLOWED)
      if (method === 'snapshot') return { ok: true, value: snapshot(engine) }
      if (!engine) throw new Error(CLAUDE_MISSING_ERROR)
      // claude 를 띄우거나 바꾸는 일은 엔진 시작(켤 때 claude 최신으로 뒤)까지 기다린다 — 읽기·창 쪽 일은 바로
      if (!STARTS_NOW.has(method)) await ready
      const handler = handlers[method as EngineMethod]
      const value = await handler(engine, deps, ...a)
      return { ok: true, value: value ?? null }
    } catch (err) {
      return { ok: false, error: messageOf(err) } // 스택은 넘기지 않는다
    }
  }
}

/** 휴대폰이 보낸 file part 의 path 가 inbox 밖 — 휴대폰은 자기가 올린 파일(POST /api/upload → inbox)만 보낼 수 있다 */
const INBOX_ONLY = `${ATTACH_FAILED} — 휴대폰에서 올린 파일만 보낼 수 있어요`

const codeOf = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code ?? ''
/** Windows 경로는 대소문자를 가리지 않는다 — 글자 그대로 견주는 첫 거름에만 쓴다(진짜 검사는 realpath) */
const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/**
 * 휴대폰이 보낸 file part 의 path 가 inbox 바로 안의 보통 파일이면 그 경로(지울 것), 아니면 null.
 * 절대 경로 · NUL·`..` 마디·대체 데이터 스트림(드라이브 뒤의 ':') 없음 · 글자로 inbox 바로 안 · lstat 이 보통 파일(링크·폴더 아님) ·
 * 진짜 경로(realpath)로도 inbox 바로 안. 진짜 경로를 못 푸는 볼륨(없음·권한·잠김이 아닌 실패)이면 inbox 가 링크가 아닌지만 본다
 * (attachmentStore.resolve 와 같은 기준). 올리기(Task 4)는 inbox 바로 안에 `<무작위>-<이름>` 으로 쓴다 — 하위 폴더는 받지 않는다
 */
async function inboxFile(inboxDir: string, raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || raw.includes('\u0000') || !path.isAbsolute(raw)) return null
  if (raw.split(/[\\/]/).includes('..') || raw.replace(/^[A-Za-z]:/, '').includes(':')) return null
  const dir = path.resolve(inboxDir)
  const at = path.resolve(raw)
  if (!samePath(path.dirname(at), dir)) return null
  try {
    if (!(await fs.promises.lstat(at)).isFile()) return null
    let real: { at: string; dir: string } | null = null
    try {
      real = { at: await fs.promises.realpath(at), dir: await fs.promises.realpath(dir) }
    } catch (e) {
      if (REALPATH_FATAL.has(codeOf(e))) return null
    }
    if (real) return path.dirname(real.at) === real.dir ? at : null
    return (await fs.promises.lstat(dir)).isDirectory() ? at : null
  } catch {
    return null
  }
}

/** inbox 파일 지우기 — 할 수 있는 만큼. 막 쓴·막 읽은 파일은 백신 등이 잠깐 잡아 EBUSY·EPERM 이 난다: 몇 번 다시 */
async function removeInboxFile(p: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.unlink(p)
      return
    } catch (e) {
      const c = codeOf(e)
      if (i >= 3 || (c !== 'EBUSY' && c !== 'EPERM')) return // 없음 등 — 못 지운 것은 남는다(보내기 결과는 그대로)
      await new Promise((r) => setTimeout(r, 50 * (i + 1)))
    }
  }
}

/**
 * 휴대폰의 addAgent — 폴더가 전체 Windows 경로(phoneFolderOk)면 그대로. 아니면 그 방이 서버 방일 때만(서버 경로 '/…' 는 엔진이 본다) —
 * 이 PC 방·모르는 방·방 목록을 못 받음이면 거절(상대 경로가 두레가 도는 폴더로 풀리지 않게). 꼴이 틀린 입력은 안쪽 디스패처가 거절한다(AGENT_BAD)
 */
async function phoneFolderAllowed(dispatch: Dispatch, input: unknown): Promise<boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return true
  const { roomId, folder } = input as { roomId?: unknown; folder?: unknown }
  if (typeof folder !== 'string' || phoneFolderOk(folder)) return true
  const snap = await dispatch('snapshot', [])
  const rooms = snap.ok && snap.value && typeof snap.value === 'object' ? (snap.value as { rooms?: unknown }).rooms : null
  if (!Array.isArray(rooms)) return false
  return rooms.some((r) => !!r && typeof r === 'object' && (r as { id?: unknown }).id === roomId && (r as { remote?: unknown }).remote != null)
}

/**
 * 휴대폰 서버가 타는 디스패처 — 허용 목록(PHONE_ACCESS 의 'phone')만 안쪽 디스패처로, 그 밖(PC 전용·모르는 이름)은 PHONE_DENIED.
 * addRoom 의 서버 방(remote 가 null·없음이 아님)은 거절. addAgent 의 이 PC 방 폴더는 전체 Windows 경로만(PHONE_FOLDER_BAD).
 * sendUser 의 file part 는 path 가 inbox 바로 안의 파일일 때만 — 하나라도 밖이면
 * 통째로 거절(엔진에 닿지 않는다). 그 요청이 가리킨 inbox 파일은 끝나면(보냄·실패·거절 모두) 지운다 — 엔진은 보내기 전에 사본을 만든다
 */
export function phoneDispatcher(dispatch: Dispatch, o: { inboxDir: string }): Dispatch {
  return async (method, args) => {
    if (!phoneAllows(method)) return { ok: false, error: PHONE_DENIED }
    const a: unknown[] = Array.isArray(args) ? args : []
    if (method === 'addRoom' && a[1] != null) return { ok: false, error: PHONE_DENIED }
    if (method === 'addAgent' && !(await phoneFolderAllowed(dispatch, a[0]))) return { ok: false, error: PHONE_FOLDER_BAD }
    const files = method === 'sendUser' && Array.isArray(a[1]) ? a[1].filter(isFilePart) : []
    if (files.length === 0) return dispatch(method, a)
    const found = await Promise.all(files.map((f) => inboxFile(o.inboxDir, f.path)))
    const inbox = [...new Set(found.filter((p): p is string => p !== null))]
    try {
      if (found.includes(null)) return { ok: false, error: INBOX_ONLY }
      return await dispatch(method, a)
    } finally {
      await Promise.all(inbox.map(removeInboxFile))
    }
  }
}
