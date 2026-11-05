import fs from 'node:fs'
import path from 'node:path'
import type { Engine } from '../engine'
import {
  APP_METHODS, BEFORE_START, CLAUDE_MISSING_ERROR, METHODS,
  type AgentView, type DureApi, type InvokeResult, type Snapshot,
} from '../shared/ipcContract'
import { ATTACH_FAILED, ATTACH_NOT_FOUND, ATTACH_OPEN_FAILED, opensAsDocument } from '../shared/attachments'
import { PHONE_DENIED, phoneAllows } from '../shared/phoneAccess'
import { REALPATH_FATAL } from '../engine/attachmentStore'
import { SLEEP_DEFAULT_MIN, type ThemePref, type UserPart } from '../engine/types'
import { pickPrefs } from './appPrefs'

// IPC(창)와 휴대폰 서버가 같이 타는 디스패처 — 메서드 이름 + 인자 → 앱 쪽·엔진·창 쪽 일. 누가 불렀는지(창 프레임·휴대폰 기기)는
// 부르는 쪽이 먼저 가린다: IPC 는 isAppPage(registerIpc), 휴대폰은 phoneDispatcher(허용 목록)

type AppMethod = (typeof APP_METHODS)[number]
/** 엔진 없이 도는 앱 쪽 일 — APP_METHODS 14개(main 이 준비 흐름·claude 최신으로·두레 업데이트로 채운다) */
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
/** 화면이 보내는 file part 의 칸 — 이것뿐(준비된 꼴의 file·sendPath·remotePath 를 꾸며 넣지 못하게) */
const FILE_PART_KEYS: ReadonlySet<string> = new Set(['type', 'path', 'name', 'bytes'])

/** file part 꼴인가(칸 검사 전) — checkedParts·phoneDispatcher 가 같은 기준으로 가른다 */
function isFilePart(p: unknown): p is Record<string, unknown> {
  return !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'file'
}

/**
 * sendUser 의 칸 목록을 거른다 — 목록이 아니면 거절. file part 는 type·path(절대 경로, NUL 없음)·name(글)·bytes(0 이상 정수)만,
 * 다른 칸·틀린 값이면 거절(엔진에 닿지 않는다). 글·그림 칸은 지금처럼 그대로 엔진으로(엔진이 다룬다).
 * bytes 는 화면이 본 크기일 뿐 — 상한(100MB)은 엔진이 원본을 fs.stat 으로 다시 재서 막는다
 */
function checkedParts(parts: unknown): UserPart[] {
  if (!Array.isArray(parts)) throw new Error(PARTS_BAD)
  return parts.map((p) => {
    if (!isFilePart(p)) return p as UserPart
    const keys = Object.keys(p)
    if (keys.length !== FILE_PART_KEYS.size || !keys.every((k) => FILE_PART_KEYS.has(k))) throw new Error(FILE_PART_BAD)
    const { path: at, name, bytes } = p
    if (typeof at !== 'string' || at.includes('\u0000') || !path.isAbsolute(at)) throw new Error(FILE_PART_BAD)
    if (typeof name !== 'string') throw new Error(FILE_PART_BAD)
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error(FILE_PART_BAD)
    return { type: 'file', path: at, name, bytes }
  })
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
const HANDLERS: Record<(typeof METHODS)[number], Handler> = {
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
  renameRoom: (e, _d, id, name) => e.renameRoom(id, name),
  removeRoom: (e, _d, id) => e.removeRoom(id),
  addAgent: (e, _d, i) => e.addAgent(i),
  updateAgent: (e, _d, id, p) => e.updateAgent(id, p),
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
  setModel: (e, _d, id, model) => e.setModel(id, model),
  setEffort: (e, _d, id, level) => e.setEffort(id, level),
  refreshUsage: (e) => e.refreshUsage(),
  describe: (e, _d, id) => e.describe(id),
  history: (e, _d, id, o) => e.history(id, o),
  conversations: (e, _d, id) => {
    if (typeof id !== 'string') throw new Error(CONV_BAD)
    return e.conversations(id)
  },
  conversation: (e, _d, id, key, o) => {
    if (typeof id !== 'string' || typeof key !== 'string') throw new Error(CONV_BAD)
    return e.conversation(id, key, o)
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
  continueHeld: (e, _d, roomId) => e.continueHeld(roomId),
  answerRequest: (e, _d, id, d) => e.answerRequest(id, d),
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
  return async (method, args) => {
    try {
      const a: unknown[] = Array.isArray(args) ? args : []
      if (typeof method === 'string' && Object.hasOwn(APP_HANDLERS, method)) {
        const value = await APP_HANDLERS[method as AppMethod](deps.app, ...a)
        return { ok: true, value: value ?? null }
      }
      if (typeof method !== 'string' || !Object.hasOwn(HANDLERS, method)) throw new Error(NOT_ALLOWED)
      if (method === 'snapshot') return { ok: true, value: snapshot(engine) }
      if (!engine) throw new Error(CLAUDE_MISSING_ERROR)
      // claude 를 띄우거나 바꾸는 일은 엔진 시작(켤 때 claude 최신으로 뒤)까지 기다린다 — 읽기·창 쪽 일은 바로
      if (!STARTS_NOW.has(method)) await ready
      const handler = HANDLERS[method as keyof typeof HANDLERS]
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
 * 휴대폰 서버가 타는 디스패처 — 허용 목록(PHONE_ACCESS 의 'phone')만 안쪽 디스패처로, 그 밖(PC 전용·모르는 이름)은 PHONE_DENIED.
 * addRoom 의 서버 방(remote 가 null·없음이 아님)은 거절. sendUser 의 file part 는 path 가 inbox 바로 안의 파일일 때만 — 하나라도 밖이면
 * 통째로 거절(엔진에 닿지 않는다). 그 요청이 가리킨 inbox 파일은 끝나면(보냄·실패·거절 모두) 지운다 — 엔진은 보내기 전에 사본을 만든다
 */
export function phoneDispatcher(dispatch: Dispatch, o: { inboxDir: string }): Dispatch {
  return async (method, args) => {
    if (!phoneAllows(method)) return { ok: false, error: PHONE_DENIED }
    const a: unknown[] = Array.isArray(args) ? args : []
    if (method === 'addRoom' && a[1] != null) return { ok: false, error: PHONE_DENIED }
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
