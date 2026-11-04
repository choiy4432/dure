import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { CONTROL_CHAR, openStore, renameRetrying, REMOTE_FOLDER_ABSOLUTE, type Store } from './store';
import {
  attachmentRemoveScript, attachmentsCleanupScript, checkScript, classifyExit, classifyUploadExit, cleanupScript, hostArgs, isLoginFailure, launchArgs,
  launchPreamble, parseCheckOutput, parsePid, parseUploadHome, posixJoin, remoteAttachDir, remoteLaunchScript, remoteRunFiles, runArgs, sshErrorLines,
  transcriptCheckScript, updateScript, uploadScript, uploadWriteText, type RemoteIssueKind,
} from './remote';
import { killTree } from './killTree';
import { REMOTE_CLEANUP_FAILED, remoteIssueText, remotePortBlockedText } from '../shared/remoteTexts';
import { readSshHosts, type SshHostEntry } from './sshConfig';
import { openMessageLog, type MessageLog } from './messageLog';
import { capPatch, lastN, openHistory, patchFromInput, trimToolInput, type History } from './history';
import { conversationFacts, splitConversations, type Conversation } from './conversations';
import { claudeDirOf, existingSessions } from './claudeSessions';
import { openImageStore, type ImageStore } from './imageStore';
import { openAttachmentStore, type AttachmentStore } from './attachmentStore';
import { ATTACH_FAILED, ATTACH_MAX_BYTES, ATTACH_TOO_BIG } from '../shared/attachments';
import { sentText } from './streamProtocol';
import { buildArgs, buildMcpConfig, buildUsageArgs, CREATE_AGENT_TOOL, SPAWN_ENV_EXTRA } from './claudeArgs';
import { buildRoomPrompt } from './roomPrompt';
import { ClaudeSession } from './claudeSession';
import { startMcpServer, type McpServerHandle } from './mcpServer';
import { Permissions } from './permissions';
import { DENY } from '../shared/denyTexts';
import { josa } from '../shared/josa';
import { pastWhyText } from '../shared/pastWhy';
import { Router, AUTO_CHAIN_LIMIT, joinDeliveries, type Delivery } from './router';
import { EFFORT_LEVELS, SLEEP_CHOICES, SLEEP_DEFAULT_MIN, THEME_PREFS, type EffortLevel, type NotifyPrefs, type SleepBlock, type ThemePref } from './types';
import { toContextUsage } from './usage';
import { UsageWatcher, USAGE_TIMING, type UsageTiming } from './usageWatcher';
import type {
  Agent, AgentDescription, ConversationSummary, AgentId, AgentPatch, AgentStatus, ContextUsage, CreateAgentInput, Decision, DiffHunk, EngineEventMap, FileInput, FileReady, HistoryItem, HistoryPart, Hold, HoldItem, PendingRequest, PlanUsage, ReadyPart, RelayMessage, RemoteIssue, Room, RoomId, StreamEvent, UserPart,
} from './types';

export interface EngineOptions {
  dataDir: string;
  claude: { command: string; argsPrefix?: string[] };
  /** 서버(SSH) 방의 ssh — 기본은 윈도우 OpenSSH(main 이 정한다). 없으면 서버 방을 못 만든다. 시험은 가짜 ssh */
  ssh?: { command: string; argsPrefix?: string[] };
  /** ~/.ssh/config 를 찾는 홈 — 없으면 os.homedir(). 시험용(진짜 ~/.ssh 를 읽지 않게) */
  sshHome?: string;
  autoChainLimit?: number;
  /** 서버(SSH) 방의 claude 를 최신으로(`claude update`) 바꿀지 — 서버마다 엔진이 산 동안 한 번, 처음 닿을 때. 호출 때마다 본다. 기본 () => false */
  claudeAutoUpdate?: () => boolean;
  env?: NodeJS.ProcessEnv;
  /** 기본 true — false 면 대기 메시지 전달(flushAll)을 미루고 engine.start() 가 한다(리스너를 붙인 뒤 부르기 위함) */
  autoStart?: boolean;
  /** 플랜 사용량 묻기 — 없으면 USAGE_TIMING, 일부만 주면 나머지는 USAGE_TIMING, false 면 끔 */
  usage?: false | Partial<UsageTiming>;
  /** 엔진이 보낸 /effort 에 답(result)이 없을 때 다시 띄우기까지 — 기본 EFFORT_TIMEOUT_MS(시험은 짧게) */
  effortTimeoutMs?: number;
  /**
   * 엔진이 보낸 set_permission_mode(와 끄기 앞의 get_settings)에 답이 없을 때 실패로 치기까지 — 기본 BYPASS_TIMEOUT_MS,
   * 띄울 때 보낸 것은 BYPASS_SPAWN_TIMEOUT_MS. 주면 둘 다 이 값(시험은 짧게)
   */
  bypassTimeoutMs?: number;
  /** 띄울 때(아직 모드를 알리지 않은 세션에) 보낸 set_permission_mode 의 한도만 따로 — 없으면 bypassTimeoutMs, 그것도 없으면 BYPASS_SPAWN_TIMEOUT_MS. 시험용 */
  bypassSpawnTimeoutMs?: number;
  /** 세션 하나를 끌 때 기다리는 상한(ms) — 없으면 STOP_LIMIT_MS. 시험용 */
  stopLimitMs?: number;
  /** 승인·두레 도구를 부른 tool_use id 를 이 세션 스트림에서 아직 못 봤을 때 기다리는 한도(ms) — 없으면 SEEN_WAIT_MS. 시험은 짧게 */
  seenWaitMs?: number;
  /**
   * 뒤에서 돈 서브에이전트가 끝난 뒤 Claude 가 스스로 여는 차례(보고 전달)를 쉬는 동안 기다리는 시간(ms) — 없으면 AUTO_TURN_GRACE_MS.
   * 그동안 다시 띄우기·/effort 를 미루고 화면은 작업 중. 시험은 짧게
   */
  autoTurnGraceMs?: number;
  /**
   * 차례 도중에 보낸 말을 Claude 가 아직 읽지 않았는데 차례가 끝났을 때, 그 말로 새 차례가 열리기를 기다리는 시간(ms) — 없으면 MID_GRACE_MS.
   * 지나면 읽은 것으로 본다(되돌림을 못 맞춘 경우 쉬지 못하고 멈춰 있지 않게). 시험은 짧게
   */
  midGraceMs?: number;
  /** 미리 띄웠지만 아무 줄도 안 받은 세션을 고르지 않게 된 뒤 끄기까지(ms) — 없으면 PREWARM_IDLE_MS. 시험은 짧게 */
  prewarmIdleMs?: number;
  /** 재우기 시간(sleepAfter 의 분)을 재는 '1분'의 길이(ms) — 없으면 SLEEP_MINUTE_MS. 시험·e2e 는 짧게 */
  sleepMinuteMs?: number;
  /** 살아 있는 세션을 훑어 재우는 간격(ms) — 없으면 sleepMinuteMs(1분마다) */
  sleepSweepMs?: number;
  /**
   * 서버 방 원격 포트(-R)를 고르는 범위 — 없으면 REMOTE_PORT_FROM~REMOTE_PORT_TO. random = 훑기 시작 자리(0 이상 1 미만, 없으면 crypto).
   * 시험용(좁히고 시작 자리를 고정해 겹침 피하기를 본다)
   */
  remotePorts?: { from: number; to: number; random?: () => number };
  /** 서버 방 첨부 하나를 올리는 ssh 의 상한(ms) — 없으면 UPLOAD_MS(10분). 시험용 */
  uploadTimeoutMs?: number;
}

// 이벤트:
//  'agent-event' { agentId; event: StreamEvent; viaApproval?: boolean }  (tool-result 일 때 viaApproval = permissions.wasAsked, patch 는 빼고 — 기록에만)
//  'status'      { agentId; status: AgentStatus; errorText: string | null }
//  'message'     RelayMessage     'held' { roomId }
//  'request'     PendingRequest   'request-resolved' { id; agentId }
//  'flags'       { agentId; bypass; bySettings; pending }   (bypass = 실제 모드 — init.permissionMode · set_permission_mode 응답의 mode 가 'bypassPermissions'.
//                bySettings = 내 Claude 설정 때문 — 그 세션의 get_settings 기본 모드가 bypassPermissions(probe12: 세션 모드와 따로),
//                못 읽었으면 두레 스위치(허용 + bypassOn)가 아닌 것. pending = 옵션 없이 뜬 세션을 켜려고 그 차례 뒤에 다시 띄우기를
//                기다리는 중(실제 모드는 아직 그대로 — 화면은 바뀌는 중으로). 살아 있는 세션이 없으면 다음에 띄울 때의 모드.
//                init · 응답 · 스위치 · 허용 · 내 설정을 읽을 때마다, 다시 띄우기를 미루고 풀 때, 세션이 끝날 때)
//                계획 모드 동안은 bypass 가 아니다(세션이 없으면 다음에 띄울 때 계획 모드로 맞추니 false)
//  'plan-mode'   { agentId; on }   (planMode() 가 바뀔 때만 — 세션의 실제 모드가 plan 인가. 세션이 없거나 아직 모드를 모르면 바라는 값)
//  'history'     { agentId; item: HistoryItem }   (대화 기록에 한 항목이 더해질 때마다 — text-delta·thinking·init·rate-limit 은 기록하지 않는다)
//  'held-input'  { agentId; count }   (보낼 차례를 기다리는 사람 입력 수가 바뀔 때마다 — 붙잡힌 것은 세지 않는다)
//  'always-allow' { agentId; alwaysAllow }   (늘 허용 목록이 바뀔 때마다 — 승인 카드의 allow-always · 되돌리기. 바뀐 뒤의 목록)
//  'hold'        { agentId; hold: Hold | null }   (붙잡기가 바뀔 때마다 — 멈춰서 붙잡음 · 항목이 붙거나 빠짐. 풀리면 null)
//  'effort'      { agentId; effort; effortNow }   (고른 값이 바뀌거나 Claude 에게 지금 값을 읽을 때마다)
//  'context'     { agentId; value: ContextUsage | null }   (차례 끝에 대화 공간을 받았을 때 · 요약·새 대화 직후엔 null)
//  'model-now'   { agentId; modelNow }   (차례의 init 이 알려 준 모델 id 가 바뀔 때 · setModel 은 null 로 비운다)
//  'subagents'   { agentId; running }   (도는 서브에이전트 목록이 바뀔 때마다 — 부모의 Agent tool_use id, 시작 순. 세션이 끝나면 빈 목록)
//  'agent-added' { agent; by }   (에이전트가 create_agent 로 만든 에이전트를 사람이 승인해 더했을 때 — by = 만든 에이전트. 화면에서 더한 것엔 없다)
//  'sleep'       { agentId; asleep; waking }   (sleepState() 가 바뀔 때만 — 상태를 알리는 자리(emitStatus)·깨운 세션의 첫 차례의 init 에서 견준다)
//  'usage'       PlanUsage | null   (플랜 사용량을 받을 때마다 — 모르는 모양·한도 없음이면 null)
//  'engine-error' { agentId: string | null; message: string }  (프로세스 이벤트 처리·듣는 쪽에서 난 오류 — 앱을 죽이지 않고 알린다)
export interface Engine extends EventEmitter {
  /** autoStart: false 로 만들었을 때 대기 메시지 전달을 시작한다(여러 번 불러도 한 번만) */
  start(): void;
  rooms(): Room[];
  agents(roomId?: RoomId): Agent[];
  /** remote = 서버(SSH) 방(host 는 hostArgs 로 검사) — ssh 가 없으면(sshAvailable false) 던진다 */
  addRoom(name: string, remote?: { host: string } | null): Room;
  /** 서버 방에 쓸 ssh 실행 파일이 있는가 — 화면이 서버 칸을 그리기 전에 묻는다 */
  sshAvailable(): boolean;
  /** ~/.ssh/config 의 서버 목록(리터럴 Host 만) — 없거나 못 읽으면 [] */
  sshHosts(): SshHostEntry[];
  /** 서버에 접속해 claude 를 찾는다(ssh 한 번, 상한 15초) — 서버 이름이 올바르지 않거나 ssh 가 없으면 던진다 */
  checkRemote(host: string): Promise<{ ok: true; claudeVersion: string } | { ok: false; kind: RemoteIssueKind; detail: string | null }>;
  /**
   * 서버 방의 폴더가 서버에 있는가 + claude — folder = 서버가 펼친 절대 경로(`~`·`~/x` 입력은 $HOME 아래로).
   * '/'·'~'·'~/' 로 시작하지 않으면 ssh 없이 던진다
   */
  checkRemoteFolder(
    roomId: RoomId,
    folder: string,
  ): Promise<{ ok: true; folder: string; claudeVersion: string } | { ok: false; kind: RemoteIssueKind; detail: string | null }>;
  /**
   * 서버 방 에이전트의 지금 문제 — 두레가 내리지 않았는데 ssh 가 끝났을 때 가른 것(접속·키·서버 키·claude·폴더·끊김 — 다음 실행이 뜨면 지운다),
   * 서버 claude 로그인 만료(다음 정상 답에서 지운다). 없거나 이 PC 방이면 null. 바뀌면 'status' 사건(remoteIssue 칸)으로 알린다
   */
  remoteIssue(id: AgentId): RemoteIssue | null;
  renameRoom(id: RoomId, name: string): Room;
  removeRoom(id: RoomId): Promise<void>;
  addAgent(i: { roomId: RoomId; name: string; role: string; folder: string }): Agent;
  updateAgent(id: AgentId, p: Pick<AgentPatch, 'name' | 'role' | 'auto' | 'pos' | 'color' | 'bypassNoticeClosed'>): Agent;
  removeAgent(id: AgentId): Promise<void>;
  /**
   * 승인 대기 · 오류가 앞선다. 세션이 쉬어도(부모 차례가 끝나도) 서브에이전트가 돌면 working — 끝난 뒤 Claude 가 스스로 열 차례를
   * 기다리는 동안(autoTurnGraceMs)도
   */
  status(id: AgentId): AgentStatus;
  /** 보낼 차례를 기다리는 내 입력 수 — 붙잡힌 것은 세지 않는다(붙잡기 목록이 보여 준다) */
  heldInput(id: AgentId): number;
  /** 멈춰서 붙잡은 대기열 — 없으면 null */
  hold(id: AgentId): Hold | null;
  /** 이어서 보내기 — 붙잡기를 풀고 차례대로 보낸다(내 입력 먼저, 그다음 메시지). 세션이 없으면 띄운다. 붙잡기가 없으면 아무 일도 안 한다 */
  resumeHold(id: AgentId): void;
  /** 빼기 — 내 입력은 버리고 메시지는 dismissed. 다 빠지면 붙잡기도 풀린다. 없는 항목이면 아무 일도 안 한다 */
  dropHoldItem(id: AgentId, itemId: string): void;
  /** 모두 버리기 — 내 입력은 버리고 메시지는 모두 dismissed, 붙잡기를 푼다 */
  dropHold(id: AgentId): void;
  /** 도는 서브에이전트 — 부모의 Agent tool_use id, 시작 순. 살아 있는 세션이 없으면 빈 목록 */
  subagentsRunning(id: AgentId): string[];
  /**
   * bypass = Claude 가 알려 준 실제 모드 · bySettings = 그 bypass 가 두레 스위치가 아니라 내 Claude 설정 때문 ·
   * pending = 켜려고 그 차례 뒤의 다시 띄우기를 기다리는 중. 살아 있는 세션이 없으면 다음에 띄울 때의 모드
   */
  flags(id: AgentId): { bypass: boolean; bySettings: boolean; pending: boolean };
  setAutoChainLimit(n: number): void;
  autoChainLimit(): number;
  allowBypass(): boolean;
  /** Windows 알림 설정 — settings.json 의 notifyAsks(기본 true)·notifyFinished(기본 false). 불리언이 아니면 기본값 */
  notify(): NotifyPrefs;
  /** 바꾼 칸만 settings.json 에 남긴다 — 안 넘긴 칸은 그대로 */
  setNotify(p: Partial<NotifyPrefs>): void;
  /** 화면 테마 — settings.json 의 theme(기본 system = Windows 따라감). 모르는 값이면 기본값 */
  theme(): ThemePref;
  setTheme(t: ThemePref): void;
  /** 쉬는 에이전트를 재우기까지의 시간(분, 0 = 끔) — settings.json 의 sleepAfterMin(없거나 SLEEP_CHOICES 밖이면 SLEEP_DEFAULT_MIN) */
  sleepAfter(): number;
  /** SLEEP_CHOICES 만 받는다(아니면 던진다) — 저장하고 다음 훑기부터 새 시간으로(이미 더 오래 쉰 에이전트는 다음 훑기에 잠든다) */
  setSleepAfter(min: number): void;
  /**
   * asleep = 대화를 시작한 적 있는데 지금 살아 있는 claude 가 없다(재워서든 앱을 막 켜서든 — 오류로 멈춤·지우는 중은 아니다) ·
   * waking = 잠든 에이전트를 띄운 세션이 아직 첫 차례의 init 전인데(엔진이 먼저 쓴 /effort 차례는 치지 않는다) 일거리가 있다
   * (줄을 썼거나 기다리는 입력·전달 대기 메시지가 있다)
   */
  sleepState(id: AgentId): { asleep: boolean; waking: boolean };
  /** 지금 재울 수 없는 까닭(앞의 것부터 하나) — 살아 있는 세션이 없으면 'no-session', 재울 수 있으면 null. 메뉴를 열 때 묻는다 */
  sleepBlock(id: AgentId): SleepBlock | 'no-session' | null;
  /** 그 방에서 지금 재울 수 있는(sleepBlock 이 null 인) 에이전트 수 — 고른 에이전트도 센다 */
  sleepableIn(roomId: RoomId): number;
  /**
   * 지금 재운다(고른 에이전트도) — 재웠으면 true, 세션이 없거나 재울 수 없으면 false. 말을 걸면(사람 입력·받은 메시지) --resume 으로 깨어난다.
   * 고른 채 재운 에이전트는 같은 고르기로 곧바로 다시 띄우지 않는다(다른 에이전트를 골랐다 돌아오거나 깨우면 풀린다)
   */
  sleep(id: AgentId): Promise<boolean>;
  /** 그 방에서 재울 수 있는 에이전트를 차례로 모두 재운다(고른 에이전트 포함) — 재운 수 */
  sleepRoom(roomId: RoomId): Promise<number>;
  /**
   * 저장 + (끄면) 모든 에이전트 bypassOn=false 저장 — 켜져 있던 에이전트의 살아 있는 세션은 내 Claude 설정의 기본 모드로
   * 돌린다(다시 띄우지 않는다). 다음에 띄울 때는 옵션 없이
   */
  setAllowBypass(on: boolean): Promise<void>;
  /** 늘 허용에서 그 도구를 뺀다 — 다음 요청부터 다시 묻는다. 없는 도구면 그대로, 바뀌면 'always-allow' */
  revokeAlwaysAllow(id: AgentId, toolName: string): Agent;
  /**
   * 에이전트의 '묻지 않음' — 저장하고 살아 있는 세션에 적용한다. 허용이 꺼져 있으면 켜기는 던진다.
   * 켜기: 옵션으로 떠 있으면 바로 set_permission_mode, 옵션 없이 떠 있으면 쉴 때 --resume 으로 다시 띄운다(일하는·승인 기다리는 중이면
   * 그 차례 뒤, 서브에이전트가 돌면 그 일이 끝난 뒤 — 그동안 flags.pending · 대화 안내 한 줄, 끄면 거둔다).
   * 끄기: 내 Claude 설정의 기본 모드로. 실패는 던지지 않는다 — engine-error · 대화 안내 한 줄 · flags(실제 모드)로 알린다
   */
  setBypass(id: AgentId, on: boolean): Promise<void>;
  errorText(id: AgentId): string | null;
  /**
   * 화면에서 고른 에이전트(없으면 null) — 아직 claude 가 안 떠 있으면 미리 띄운다(띄울 때의 로컬 요청만 — 토큰을 쓰지 않는다).
   * 오류로 멈춘 에이전트는 띄우지 않는다. 미리 띄운 뒤 아무 줄도 안 받은 세션은 고르지 않게 되고 PREWARM_IDLE_MS 뒤에 끈다
   * (그 사이 다시 고르면 그대로). 던지지 않는다 — 폴더가 없으면 보낼 때와 같은 오류 상태
   */
  setSelected(id: AgentId | null): void;
  /**
   * 사람 입력 — 차례 중·승인 대기면 그 차례 뒤에. plan(계획 먼저): 그 입력을 쓰기 직전에 set_permission_mode plan(이미 계획 모드면 생략).
   * 묻지 않고 실행하는 세션(bypass)이면 그 답을 기다렸다 쓴다 — 못 바꾸면 쓰지 않고 붙잡는다(hold).
   * Claude 는 계획을 ExitPlanMode 승인 요청(kind plan)으로 올리고, 허용하면 CLI 가 스스로 기본 모드로 간다(probe16)
   */
  sendUser(id: AgentId, parts: UserPart[], o?: { plan?: boolean }): Promise<void>;
  /**
   * 멈춘다 — 떠 있던 승인 요청은 거절로 치우고, 계획 모드였으면 평소 모드로(묻지 않음이 켜진 에이전트면 bypass, 아니면 default).
   * 기다리던 내 입력·전달 대기 메시지가 있으면 붙잡는다(hold) — 사람이 고를 때까지 나가지 않는다. 일하는 중 끼워 넣은 말을 Claude 가 아직 안 읽었으면
   * claude 를 내려 그 말까지 돌려받아 붙잡고 --resume 으로 다시 띄운다(probe20)
   */
  interrupt(id: AgentId): Promise<void>;
  /** 새 대화 — 계획 모드는 끈 채로 시작한다 */
  newConversation(id: AgentId): Promise<void>;
  /**
   * 그 에이전트 세션의 실제 모드가 plan 인가(init · status 줄 · set_permission_mode 응답으로 안다). 세션이 없거나 아직 모드를 모르면
   * 바라는 값 — 계획 모드였던 에이전트는 다시 띄울 때(오류 뒤·effort·묻지 않음 다시 띄우기) 띄운 뒤 plan 으로 다시 맞춘다
   */
  planMode(id: AgentId): boolean;
  /**
   * 켜기 = plan, 끄기 = 평소 모드(묻지 않음이 켜진 에이전트면 bypass, 아니면 default). 세션이 없으면 바라는 값만 바꾼다(띄우지 않는다).
   * true·false 가 아니면 던진다. 모드 바꾸기 실패는 던지지 않는다 — engine-error · 대화 안내 한 줄 · plan-mode 로 알린다
   */
  setPlanMode(id: AgentId, on: boolean): Promise<void>;
  setModel(id: AgentId, model: string | null): Promise<void>;
  /**
   * 저장하고, 세션이 살아 있으면 세션 명령 `/effort <단계>` 로 적용한다 — 차례 중이면 그 차례가 끝난 뒤(기다리던 입력보다 먼저),
   * 서브에이전트가 돌면 그 일이 끝난 뒤(그사이 입력은 먼저 간다), 세션이 없으면 다음에 띄울 때 첫 줄로. Claude 를 켜지 않는다
   */
  setEffort(id: AgentId, level: EffortLevel): Promise<void>;
  /** 지금 세션이 쓰는 effort — /effort 의 답, 고른 값이 없으면 내 설정(get_settings) · 모르면 null */
  effortNow(id: AgentId): EffortLevel | null;
  /** 마지막 init 이 알려 준, 지금 실제로 쓰는 모델 id — 모르면 null */
  modelNow(id: AgentId): string | null;
  describe(id: AgentId): Promise<AgentDescription>;
  /** 마지막으로 받은 플랜 사용량 — 아직 없거나 모르는 모양·꺼짐이면 null */
  usage(): PlanUsage | null;
  /** 화면이 사용량을 볼 때 — 마지막 값이 1분보다 오래됐으면 다시 묻는다 */
  refreshUsage(): void;
  history(id: AgentId, o?: { all?: boolean; limit?: number }): HistoryItem[];
  /** 대화 목록 — 새것부터. user 없는 대화는 빠진다. Claude 대화 파일은 있는지만 본다(부를 때마다 새로) — 서버 방은 서버의 기록을 ssh 로(5초 한도, 못 보면 모두 이어 갈 수 있음) */
  conversations(id: AgentId): Promise<ConversationSummary[]>;
  /** 폴더 열기 대상 — 이 PC 방은 이 PC 폴더, 서버 방은 서버와 서버 폴더 */
  folderTarget(id: AgentId): FolderTarget;
  /** 한 대화(key)의 마지막 limit(기본 500)줄 — 없는 key 는 [] */
  conversation(id: AgentId, key: string, o?: { limit?: number }): HistoryItem[];
  /** 지금 대화를 뺀, user 있는 대화 수 */
  pastCount(id: AgentId): number;
  /**
   * 그 지난 대화로 돌아간다 — 계획 모드를 끄고 지금 세션을 끝낸 뒤 경계(ended·resumed)·알림 한 줄을 남기고 그 세션으로(다음 실행은 --resume).
   * 고른 에이전트면 미리 띄운다. 던진다(글은 그대로 화면에): 일하는 중·카드를 기다림·붙잡은 입력이 있음 · 이어 갈 수 없는 대화(old·gone) ·
   * 없는 key·지금 대화
   */
  resumeConversation(id: AgentId, key: string): Promise<void>;
  /**
   * 그 지난 대화로 새 에이전트를 만든다(갈래) — 원래 에이전트의 방·폴더, 모델·effort 는 원래 것(이름 검사는 addAgent 그대로).
   * 그 대화의 줄을 새 에이전트 기록에 복사하고(그림 파일도 — 복사 못 한 그림은 file 없이) 알림 한 줄. 첫 실행만 그 세션에서 갈래 친다
   * (--resume <그 세션> --fork-session). 원래 에이전트의 기록·세션은 그대로. 던진다: 이어 갈 수 없는 대화(old·gone) · 없는 key·지금 대화
   */
  forkAgent(i: { from: AgentId; key: string; name: string; role: string }): Promise<Agent>;
  /** 사람이 보낸 그림(기록의 file) — data URL. 이름이 틀리거나 없으면 null, 없는 에이전트면 던진다 */
  image(id: AgentId, file: string): Promise<string | null>;
  messages(f?: Parameters<MessageLog['list']>[0]): RelayMessage[];
  approveMessage(id: string): void;
  dismissMessage(id: string): void;
  continueHeld(roomId: RoomId): void;
  pendingRequests(agentId?: AgentId): PendingRequest[];
  answerRequest(id: string, d: Decision): void;
  shutdown(): Promise<void>;
}

const STOP_LIMIT_MS = 5000; // ClaudeSession.stop() 의 kill 뒤 대기는 끝이 없다 — 엔진이 따로 끊는다
const FORCE_KILL_WAIT_MS = 1000; // shutdown 마지막에 직접 끈 claude 가 꺼지기를 기다리는 상한
const EXITED: string = DENY.claudeExited;
const STOPPED_BY_USER: string = DENY.userStopped;
const TURN_ENDED: string = DENY.turnEnded;
const TOOL_TEXT_KEEP = 2000;
/** 바뀐 줄(patch)을 남기는 하는 일 — 화면의 '수정'. 만듦(Write)의 결과에도 structuredPatch 가 오지만 남기지 않는다 */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
/** 결과를 기다리는 고친 일의 입력 묶음 상한(세션마다) — 결과가 끝내 안 온 것(멈춤 등)이 쌓이지 않게 오래된 것부터 버린다 */
const EDITS_PENDING_MAX = 32;
const STOPPED_NOTICE = '멈췄어요';
/** 멈출 때 Claude 가 아직 안 읽은 끼운 말을 claude 를 내려 돌려받았다 — 붙잡기 목록에 있다 */
const stoppedHeldNotice = (n: number) => `멈췄어요 — Claude 가 아직 읽지 않은 말 ${n}개는 붙잡았어요`;
/** 붙잡기 목록의 글 — 첫 줄을 이만큼까지(코드 포인트로) */
const HOLD_TEXT_MAX = 200;
const NO_AGENT = '에이전트를 찾을 수 없습니다.';
const NO_CONVERSATION = '그 대화를 찾을 수 없어요';
/** 돌아가기를 막는 까닭 — 재울 수 없는 까닭(blockOf)과 같은 표 + 보내는 중(첨부를 복사·올리는 보내기 차례) */
const RESUME_BLOCKED: Record<SleepBlock | 'sending', string> = {
  working: '일이 끝나면 돌아갈 수 있어요',
  subagents: '일이 끝나면 돌아갈 수 있어요',
  background: '뒤에서 도는 명령이 끝나면 돌아갈 수 있어요', // 끝나지 않는 명령(dev 서버)일 수 있다 — 끄지 않고 막는다
  unread: '일이 끝나면 돌아갈 수 있어요',
  asking: '기다리는 카드를 먼저 처리해 주세요',
  'waiting-input': '붙잡아 둔 입력을 먼저 처리해 주세요',
  // 준비가 끝나면 그 입력은 지금 대화로 간다 — 돌아간 뒤에 끝나면 돌아간 대화로 흘러간다(끊지 않고 막는다 — 몇 분짜리 올리기일 수 있다)
  sending: '보내는 중인 입력이 끝나면 돌아갈 수 있어요',
};
const RESUMED_NOTICE = '이 대화로 돌아왔어요';
/** --resume 했는데 Claude 쪽 대화 기록이 없었다(probe21) — 새 대화로 이어 간다 */
const RESUME_LOST_NOTICE = 'Claude 쪽 기록이 없어 이어 가지 못했어요 — 새 대화로 시작해요';
/** 그때 claude 의 stderr — `No conversation found with session ID: <id>`(probe21) */
const NO_TRANSCRIPT_ERR = 'No conversation found';
/** 새 에이전트로 이어 가기 — 날짜는 그 대화의 at(로컬 시간) */
const forkedNotice = (name: string, at: number) => {
  const d = new Date(at);
  return `${name}의 ${d.getMonth() + 1}월 ${d.getDate()}일 대화에서 이어 만들었어요`;
};
/** 갈래 칠 원래 세션의 Claude 쪽 기록이 없었다 — 새 대화로 시작한다 */
const FORK_LOST_NOTICE = '그 대화를 이어 오지 못했어요 — 새 대화로 시작해요';
const LIMIT_INVALID = '상한은 1 이상이어야 해요.';
const THEME_INVALID = '화면 테마는 라이트·다크·Windows 따라감 중 하나예요';
const DURE_TOOL_PREFIX = 'mcp__dure__';
const DURE_TOOL_DENIED = '두레 도구는 승인 대상이 아니에요.';
const SUBAGENT_DURE_TOOL: string = DENY.subagentDureTool;
/** create_agent 미리 보기 — 이름 빔·겹침·폴더 문구는 store 의 것을 그대로 쓴다 */
const ROLE_EMPTY = '역할을 입력하세요';
/**
 * create_agent 의 이름·역할 — 시스템 안내문·메시지 머리에 그대로 들어가니 줄을 나누는 글자는 받지 않고, 길이도 묶는다
 * (사람이 더하는 길은 그대로 — 이 검사는 create_agent 에만). 제어 문자 = C0·DEL·C1, 그리고 줄 나눔 문자(U+2028·2029) — store 의 CONTROL_CHAR
 */
const NAME_MAX = 40;
const ROLE_MAX = 200;
const NAME_CONTROL = '이름에 줄바꿈이나 제어 문자를 쓸 수 없어요';
const ROLE_CONTROL = '역할에 줄바꿈이나 제어 문자를 쓸 수 없어요';
const NAME_LONG = `이름은 ${NAME_MAX}자까지예요`;
const ROLE_LONG = `역할은 ${ROLE_MAX}자까지예요`;
/** 글자 수 — 코드 포인트로 센다(이모지 하나가 둘로 세지지 않게) */
const chars = (s: string): number => [...s].length;

/**
 * Git Bash 꼴 경로(/c/Users/…) → Windows 경로(C:/Users/…) — Claude 의 셸이 Git Bash 라 그 꼴로 넘길 수 있다.
 * 맨 앞이 '/' + 드라이브 글자 하나 + ('/' 또는 끝)일 때만. 드라이브만(/c)이면 그 드라이브 맨 위(C:/ — 'C:' 만이면 그 드라이브의 현재 폴더다).
 * 빗금은 뒤의 path.resolve 가 역빗금으로 바꾼다
 */
function fromGitBashPath(p: string): string {
  const m = /^\/([A-Za-z])(\/.*)?$/s.exec(p);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : p;
}

/**
 * create_agent 의 폴더 — 만든 쪽 폴더 기준. 서버 방은 POSIX 로 잇는다(Git Bash 꼴로 바꾸지 않음).
 * 서버 방의 `~`·`~/…` 는 이을 수 없어 그대로 둔다 — create_agent 가 서버 확인(checkRemoteFolder)으로 펼친다
 */
export function newAgentFolder(remote: boolean, base: string, rel: string): string {
  if (!remote) return path.resolve(base, fromGitBashPath(rel));
  return rel === '~' || rel.startsWith('~/') ? rel : posixJoin(base, rel);
}
/** 부른 tool_use id 를 스트림에서 못 봤을 때 기다리는 한도 — 그 줄은 보통 부르기보다 먼저 온다(probe13·14) */
const SEEN_WAIT_MS = 2000;
/** 끝 알림 뒤 스스로 시작한 차례는 곧바로 온다(probe13) — 멈추기로 끝났으면 오지 않으니(probe14 C) 짧게만 기다린다 */
const AUTO_TURN_GRACE_MS = 1500;
/** 차례 도중에 보낸 말이 안 읽힌 채 차례가 끝났을 때 그 말의 차례를 기다리는 시간 — 멈추면 곧바로 열린다(probe17) */
const MID_GRACE_MS = 5000;
/** 미리 띄웠지만 아무 줄도 안 받은 세션 — 고르지 않게 된 뒤 이만큼 지나면 끈다(둘러보기만 한 에이전트의 프로세스가 쌓이지 않게) */
const PREWARM_IDLE_MS = 5 * 60_000;
/** 재우기 시간을 재는 '1분' — 살아 있는 세션은 이만큼마다 훑는다(probe18: 재웠다 --resume 으로 깨워도 토큰 손해가 없고 띄우는 시간만 든다) */
const SLEEP_MINUTE_MS = 60_000;
const SLEEP_INVALID = '고를 수 없는 시간이에요';
const EFFORT_UNKNOWN = '알 수 없는 effort 예요.';
const CLOSED = '두레 엔진이 종료되었습니다.';
const NO_SSH = '윈도우 OpenSSH 를 찾지 못했어요';
const NOT_REMOTE = '서버 방이 아니에요';
/** 폴더 열기 대상 */
export type FolderTarget = { kind: 'local'; path: string } | { kind: 'remote'; host: string; path: string };

/** 확인 ssh(접속·폴더) 한 번의 상한 — ssh 자신의 ConnectTimeout(10초) 뒤 로그인 셸까지 */
const REMOTE_CHECK_MS = 15_000;
/** 지난 대화 기록 확인 ssh 의 상한(ConnectTimeout 도 같이) — 화면이 오래 기다리지 않게 */
const REMOTE_QUICK_MS = 5_000;
/** 서버의 claude update 한 번의 상한 */
const REMOTE_UPDATE_MS = 90_000;
/** ssh 확인 결과 — code = 종료 코드(못 띄웠거나 시간 초과면 null) */
interface SshRun {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** 올리기 ssh 한 번 — 시간 넘김 · ssh 를 못 띄움(ENOENT 말고) · 이 PC 사본을 못 읽어 껐음(둘 다 오류 코드만, 원문엔 내 PC 경로가 실린다) */
interface UploadRun extends SshRun {
  timedOut?: true;
  spawnFailed?: { code: string | null };
  readFailed?: { code: string | null };
}
/** 서버 방 첨부 하나를 올리는 ssh 의 상한 — 100MB(ATTACH_MAX_BYTES) 기준 넉넉히. 넘으면 끄고 실패 */
const UPLOAD_MS = 600_000;
/** 올리기 ssh 의 stdout·stderr 에서 남길 끝부분 — DURE_HOME 줄은 맨 끝에 온다 */
const UPLOAD_OUT_KEEP = 64 * 1024;
/** 서버 방 원격 포트(-R) 범위 — 띄울 때마다 이 PC 의 다른 서버 세션이 쓰지 않는 것 하나 */
const REMOTE_PORT_FROM = 40000;
const REMOTE_PORT_TO = 49999;
/** 원격 포트를 서버가 못 열면(ssh 가 명령 전에 그 포트 줄을 내고 끝난다 — classifyExit 'port') 다른 포트로 다시 — 그 횟수, 넘으면 오류(전용 안내) */
const PORT_RETRIES = 5;
/** 띄우기 id — 서버의 표식(DURE_RUN)·run 폴더 이름. 띄우기마다 새로(옛 띄우기의 정리가 새 것을 건드리지 않게) */
const LAUNCH_ID_LEN = 8;
const LAUNCH_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** DURE_PID 를 찾을 stderr 앞부분 — 로그인 셸 프로필이 앞에 찍을 수 있다 */
const LAUNCH_ERR_KEEP = 8192;
/**
 * 서버 방 세션 하나(ssh 하나) — 그 띄우기의 원격 포트·서버 pid.
 * started = stdout 줄을 하나라도 받았다(DURE_PID 는 치지 않는다 — claude 가 없어도 셸이 먼저 알린다) ·
 * ended = 두레가 내렸다(endSession — 그 뒤 온 pid 는 저장하지 않고 정리) · cleanQueued = 이 띄우기의 정리를 세웠다 ·
 * stopJob = 내린 뒤 pid 를 보고 정리할 일이 아직 줄에서 기다린다
 */
interface RemoteRun {
  host: string;
  port: number;
  launchId: string;
  pid: number | null;
  err: string;
  started: boolean;
  ended: boolean;
  cleanQueued: boolean;
  stopJob: boolean;
}
/** /effort 의 답(로컬 명령 — 모델을 부르지 않는다): "Set effort level to max (this session only): …" (probe9) */
const EFFORT_SET = /Set effort level to (low|medium|high|xhigh|max)\b/;
const EFFORT_BUSY = '/effort 차례가 끝나면 보낸다';
/** /effort 답을 기다리는 한도 — 띄운 직후엔 CLI 시작·--resume 대화 읽기까지 기다리므로 넉넉히 */
const EFFORT_TIMEOUT_MS = 30_000;
const EFFORT_STUCK = 'effort 를 정하는 동안 Claude 가 답하지 않아 다시 띄웠어요 — 이번 실행엔 고른 effort 를 적용하지 못했어요.';
/** 위 일을 사람에게 — 그 에이전트 대화에 안내 한 줄 */
const EFFORT_STUCK_NOTICE = 'effort 를 적용하지 못해 기본값으로 이어 가요';
const BYPASS_MODE = 'bypassPermissions';
/** get_settings 에서 내 기본 모드를 못 읽으면 */
const DEFAULT_MODE = 'default';
/** set_permission_mode 답을 기다리는 한도 — 로컬 제어 요청이라 보통 바로 온다(probe10) */
const BYPASS_TIMEOUT_MS = 15_000;
/** 띄울 때 보낸 set_permission_mode — CLI 시작·--resume 대화 읽기 뒤에야 답하니 /effort 와 같은 만큼 기다린다 */
const BYPASS_SPAWN_TIMEOUT_MS = EFFORT_TIMEOUT_MS;
const BYPASS_NOT_ALLOWED = '설정에서 묻지 않고 실행을 허용해야 켤 수 있어요.';
/** 켜고 끄는 값은 true·false 만 — 문자열 'false' 같은 값이 켜짐으로 저장되지 않게 */
const BYPASS_VALUE_INVALID = '켜기·끄기 값이 올바르지 않아요.';
const BYPASS_ON_FAILED = "'묻지 않음'을 켜지 못했어요 — Claude 가 권한 모드를 바꾸지 않았어요.";
const BYPASS_ON_FAILED_NOTICE = "'묻지 않음'을 켜지 못해 평소처럼 승인을 물어요";
const BYPASS_OFF_FAILED = "'묻지 않음'을 끄지 못했어요 — Claude 가 권한 모드를 바꾸지 않았어요.";
const BYPASS_OFF_FAILED_NOTICE = "'묻지 않음'을 끄지 못해 쉴 때 다시 띄워 평소처럼 승인을 물어요";
/** 옵션 없이 떠 일하는·승인 기다리는 세션을 켰다 — 그 차례가 끝나면 다시 띄운다(거두면 더하지 않는다) */
const BYPASS_RESTART_QUEUED_NOTICE = "이 차례가 끝나면 다시 시작해 '묻지 않음'을 켜요";
/** 계획 모드(계획 먼저) — 계획은 ExitPlanMode 승인으로 오고, 허용하면 CLI 가 스스로 기본 모드로 간다(probe16) */
const PLAN_MODE = 'plan';
const PLAN_ON_FAILED = '계획 모드로 바꾸지 못했어요 — Claude 가 권한 모드를 바꾸지 않았어요.';
const PLAN_ON_FAILED_NOTICE = '계획 모드로 바꾸지 못했어요';
/** 계획 모드를 바라고 쓴 차례가 도는 중이었다 — 계획 없이 일하지 않게 멈췄다 */
const PLAN_ON_FAILED_STOPPED_NOTICE = '계획 모드로 바꾸지 못해 멈췄어요';
const PLAN_OFF_FAILED = '계획 모드를 끄지 못했어요 — Claude 가 권한 모드를 바꾸지 않았어요.';
const PLAN_OFF_FAILED_NOTICE = '계획 모드를 끄지 못해 계획 모드 그대로예요';
/** 첨부 보내기 실패의 까닭(ATTACH_FAILED 뒤 ' — <이름>: ' 다음) */
const ATTACH_BAD_PATH = '파일 경로가 올바르지 않아요';
/** 서버 방 — 올리는 중(또는 올리기 전) 멈춤·새 대화·지우기·끄기로 올리기를 끊었다(그 입력은 붙잡지 않고 실패로) */
const ATTACH_UPLOAD_STOPPED = '서버로 올리는 중에 그만뒀어요';
/** 서버 방 — 올리기가 상한(UPLOAD_MS)을 넘었다 */
const ATTACH_UPLOAD_SLOW = '서버로 올리는 데 너무 오래 걸려 그만뒀어요';
/** 서버 방 — 올렸다는데 서버가 $HOME 을 알리지 않았다(DURE_HOME 줄 없음) */
const ATTACH_UPLOAD_NO_HOME = '서버에 올린 파일의 경로를 알 수 없어요';
/** 서버 방 — ssh 를 띄우지 못했다(없음 ENOENT 은 NO_SSH). 오류 원문엔 내 PC 의 ssh 경로가 실린다 — 코드만 */
const attachSshSpawnText = (code: string | null) => `ssh 를 실행하지 못했어요${code ? `(${code})` : ''}`;
/** 서버 방 — 올리던 이 PC 사본을 읽지 못했다(백신이 잡음 등). 원문엔 내 PC 경로가 실린다 — 코드만 */
const attachCopyReadText = (code: string | null) => `이 PC 사본을 읽지 못했어요${code ? `(${code})` : ''}`;
/** 서버 첨부(되돌리기)를 못 지웠다 — 기록만(engine-error). 남는 건 그 사용자만 읽는 파일이고, 에이전트를 지울 때 폴더째 지운다 */
const ATTACH_REMOTE_LEFT = '서버의 첨부 파일을 다 지우지 못했어요';
/** 지운 에이전트의 서버 첨부 폴더를 못 지웠다(서버가 내려가 있음 등) — 기다리는 첨부 정리 목록에 남아 다음에 켤 때 다시 */
const ATTACH_REMOTE_FOLDER_LEFT = '서버의 첨부 폴더를 다 지우지 못했어요 — 두레를 다시 켜면 다시 지워요';
const ATTACH_FOLDER = '폴더는 보낼 수 없어요';
const ATTACH_NOT_FILE = '보통 파일이 아니에요';
const ATTACH_CREDENTIALS = '자격 증명 파일은 보낼 수 없어요';
/** Claude 자격 증명 파일 이름 — 첨부로도 읽거나 옮기지 않는다 */
const CREDENTIALS_FILE = '.credentials.json';
/** 에이전트를 지웠는데 첨부 폴더가 잠겨 남았다(다른 프로그램이 연 파일 등) — 켤 때 주인 없는 첨부 폴더를 다시 지운다(prune) */
const ATTACH_LEFT = '첨부 폴더를 다 지우지 못했어요 — 두레를 다시 켜면 다시 지워요';

/** 엔진이 써 넣은 /effort 한 줄 — 그 result 까지 */
interface EffortTurn {
  heard: EffortLevel | null; // 답 글에서 읽은 단계
  timer: NodeJS.Timeout | null; // 답이 없으면 다시 띄운다
}

/**
 * 보낼 차례를 기다리는 사람 입력 — id: 엔진이 붙인 것(붙잡기 목록의 항목 id) · plan: 계획 먼저(쓰기 직전에 계획 모드로) ·
 * parts: 준비를 마친 꼴(첨부는 이미 사본·경로 — 원본이 사라져도 그대로 간다)
 */
interface HeldInput {
  id: string;
  parts: ReadyPart[];
  plan?: true;
}

/** 붙잡은 것 하나 — item: 화면에 알리는 모양 · input: 내 입력이면 보낼 것(메시지는 기록에 queued 로 남아 있다 — item.id = 메시지 id) */
interface HoldEntry {
  item: HoldItem;
  input?: HeldInput;
}

/**
 * 멈출 때 붙잡은 대기열(에이전트마다) — 그동안 entries 의 내 입력은 기다리는 줄(held) 밖에 두고, 그 에이전트는 전달 쪽에서 바쁨이다.
 * 새로 친 말은 거치지 않는다. 그 에이전트에게 새로 queued 가 된 메시지는 끝에 붙고, queued 가 아니게 된 메시지는 빠진다
 */
interface HoldState {
  since: number;
  entries: HoldEntry[];
}

/** 프로세스에 써 넣었지만 아직 아무 이벤트도 안 온 줄 — 읽기 전에 죽으면 되살린다 */
/** 보내고 아직 Claude 가 읽지 않은 줄 — mid: 차례 도중에 보낸 사람 말(그 되돌림으로만 읽은 것으로 본다, probe17) */
/** 보낸 줄 — 전달 메시지는 한 줄에 여럿(묶음)일 수 있고 text 는 쓴 글 그대로(차례 도중에 끼운 줄의 되돌림을 맞춘다) */
type InFlight = ({ kind: 'relay'; messageIds: string[]; text: string } | { kind: 'human'; input: HeldInput }) & { mid?: true };

/** 도는 서브에이전트 — background: 부모가 도는 중에 그 Agent 의 결과(Async agent launched)를 받았다. 끝나면 Claude 가 스스로 차례를 연다(probe13) */
interface RunningSubagent {
  toolUseId: string; // 부모의 Agent tool_use id
  background: boolean;
}

/** 뒤에서 돈 서브에이전트가 끝나 Claude 가 스스로 열 차례를 기다리는 중 — left: 아직 안 온 차례 수, timer: 쉬는 동안 도는 기다림 */
interface AutoTurnWait {
  left: number;
  timer: NodeJS.Timeout | null;
}

/**
 * 한 세션 스트림에서 본 하는 일 — tool_use id → 서브에이전트 줄이면 부모의 Agent tool_use id, 부모 줄이면 null.
 * 승인·두레 도구를 부른 쪽을 가른다(spec §4.4). 못 본 id 를 기다리는 쪽은 그 id 가 오거나 세션이 끝나면 깬다
 */
class SeenToolUses {
  private ids = new Map<string, string | null>();
  private waiters = new Map<string, Set<() => void>>();

  note(ev: Extract<StreamEvent, { kind: 'assistant' }>): void {
    for (const b of ev.blocks) {
      if (b.type !== 'tool_use' || typeof b.id !== 'string') continue;
      this.ids.set(b.id, ev.parent ?? null);
      const waiting = this.waiters.get(b.id);
      if (waiting) for (const wake of [...waiting]) wake();
    }
  }

  /** 본 id 면 바로, 못 본 id 면 그 id 가 올 때까지(최대 ms) 기다렸다 다시 본다 — 끝내 못 보면 undefined */
  async lookup(id: string, ms: number): Promise<string | null | undefined> {
    if (!this.ids.has(id)) {
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(id) ?? new Set<() => void>();
        this.waiters.set(id, set);
        const wake = () => {
          clearTimeout(timer);
          set.delete(wake);
          if (set.size === 0 && this.waiters.get(id) === set) this.waiters.delete(id);
          resolve();
        };
        const timer = setTimeout(wake, ms);
        timer.unref?.();
        set.add(wake);
      });
    }
    return this.ids.get(id);
  }

  /** 세션이 끝났다 — 본 것을 비우고 기다리던 쪽을 모두 깨운다(못 본 id 로 끝난다). 끝난 뒤엔 엔진이 이 객체를 다시 쓰지 않는다 */
  close(): void {
    this.ids.clear();
    for (const set of [...this.waiters.values()]) for (const wake of [...set]) wake();
  }
}

class EngineImpl extends EventEmitter implements Engine {
  private sessions = new Map<AgentId, ClaudeSession>();
  private held = new Map<AgentId, HeldInput[]>(); // 일하는 중에 사람이 넣은 입력 — 끝나면 순서대로(붙잡힌 것은 holds 에)
  private holds = new Map<AgentId, HoldState>(); // 멈춰서 붙잡은 대기열 — 사람이 고를 때까지. 메모리만(다시 켜면 풀린다), 비면 지운다
  private errors = new Map<AgentId, string>(); // 세션 없이 남은 오류(비정상 종료·폴더 없음) — 다음 실행까지
  private shown = new Map<AgentId, { status: AgentStatus; errorText: string | null; issue: RemoteIssue | null }>();
  private described = new WeakMap<ClaudeSession, Promise<AgentDescription>>();
  private inFlight = new WeakMap<ClaudeSession, InFlight[]>();
  // 차례 도중에 보낸 말이 안 읽힌 채 차례가 끝났다 — 그 말의 차례를 기다리는 타이머(MID_GRACE_MS)
  private midGrace = new WeakMap<ClaudeSession, NodeJS.Timeout>();
  private removing = new Set<AgentId>();
  // 미리 띄우기 — 화면에서 고른 에이전트는 첫 메시지 전에 claude 를 띄워 둔다(시작·대화 읽기 시간을 앞당긴다, 토큰 없음)
  private selected: AgentId | null = null;
  private prewarmed = new WeakSet<ClaudeSession>(); // 미리 띄운 뒤 아직 아무 줄(사람 입력·받은 메시지)도 안 쓴 세션 — 고르지 않게 되면 끈다
  private coolTimers = new Map<AgentId, NodeJS.Timeout>(); // 고르지 않게 된 미리 띄운 세션을 끄기까지
  private modes = new WeakMap<ClaudeSession, string>(); // 그 세션의 실제 권한 모드 이름 — 마지막 init · status 줄 · set_permission_mode 응답
  // 계획 모드를 바라는 에이전트 — 계획 먼저로 보낼 때·켤 때·Claude 가 계획 모드가 됐을 때 넣고, 계획을 승인했을 때(CLI 가 스스로 나옴)·
  // 끌 때·멈출 때·새 대화에서 뺀다. 세션을 다시 띄우면 띄운 뒤 plan 으로 다시 맞춘다(메모리만)
  private planWant = new Set<AgentId>();
  private planShown = new Map<AgentId, boolean>(); // 마지막으로 알린 계획 모드 — 바뀔 때만 'plan-mode'
  private planEntering = new WeakMap<ClaudeSession, Promise<void>>(); // 가는 중인 계획 모드 요청(답·실패 처리까지) — 마지막 것
  private planSeq = new Map<AgentId, number>(); // 마지막 계획 모드 요청의 차례 번호 — 그 실패는 다른 모드 바꾸기가 끼어도 알린다
  // 계획 먼저 입력을 쥐고 계획 모드 답을 기다리는 중 — 묻지 않고 실행하는 세션(bypass)에 답 전에 쓰면 그 차례가 계획 없이 돌 수 있다.
  // 답이 와 계획 모드가 되면 쓰고, 못 되면 붙잡는다. 멈추기·세션 끝은 기다리는 줄 맨 앞으로 돌려놓는다
  private planGates = new WeakMap<ClaudeSession, HeldInput>();
  // 묻지 않음: 허용이면 --allow-dangerously-skip-permissions 로 띄우고(그것만으론 평소 모드), 켠 에이전트만 set_permission_mode 로 켠다(probe10·11)
  private optioned = new WeakSet<ClaudeSession>(); // 그 옵션으로 뜬 세션 — 실행 중에 bypass 로 바꿀 수 있다
  // 권한 모드 때문에 다시 띄울 세션 — 쉴 때(pump) --resume 으로. 둘 중 하나: 옵션 없이 떠서 켜려면 다시 띄워야 한다(flags.pending),
  // 또는 끄기에 실패해 두레가 켠 bypass 가 남았다(옵션으로 뜬 세션 — 스위치가 꺼져 있어 새 세션엔 켜기를 보내지 않는다)
  private restartWant = new WeakSet<ClaudeSession>();
  private modeApplying = new WeakMap<ClaudeSession, Promise<void>>(); // 띄울 때 보낸 set_permission_mode(답·실패 처리까지) — 다시 띄운 쪽이 기다린다
  private modeSeq = new Map<AgentId, number>(); // 모드 바꾸기 차례 번호 — 그새 다시 바뀌었으면 옛 요청의 실패는 되돌리지 않는다
  private settingsDefaults = new WeakMap<ClaudeSession, string>(); // 그 세션이 읽은 내 기본 권한 모드(get_settings) — bySettings 의 근거
  private settingsDefaultOf = new Map<AgentId, string>(); // 에이전트마다 마지막으로 읽은 내 기본 권한 모드 — 세션이 끝난 뒤 다음 모드 예측에(메모리만)
  private offsInFlight = new WeakMap<ClaudeSession, number>(); // 진행 중인 끄기(settleOff) 수 — init 이 bypass 여도 겹쳐 끄지 않는다
  private modelNows = new Map<AgentId, string>(); // 마지막 init 의 풀린 모델 id
  private pastCounts = new Map<AgentId, number>(); // pastCount 기억 — forgetPastCount 가 버린다
  // 이어 가기 — --resume 으로 띄워 아직 init 을 못 본 세션 → 이어 간 세션 id(init 에서 빠진다). Claude 쪽 대화 기록이 없으면 init 없이
  // 오류 result 한 줄을 내고 끝난다(probe21) — 그 result 는 기록·전달하지 않고 resumeLost 에 표시만, 끝나면(exit) 새 대화로
  private resuming = new WeakMap<ClaudeSession, string>();
  private resumeLost = new WeakSet<ClaudeSession>();
  private forking = new WeakSet<ClaudeSession>(); // 갈래 실행(--fork-session) — 이어 가기 실패면 이 에이전트의 대화가 아니니 경계에 세션을 남기지 않는다
  // 엔진이 멈추기(interrupt)를 보낸 세션 — init 전 오류 result 가 멈춘 차례의 끝일 수 있다(기록 없음으로 치지 않는다. 정말 없으면 끝날 때 stderr 가 말한다)
  private interrupted = new WeakSet<ClaudeSession>();
  private effortNows = new Map<AgentId, EffortLevel>(); // Claude 에게 마지막으로 읽은 지금 effort
  // effort 는 세션 명령 `/effort <단계>` 로 정한다 — 설정 층(apply_flag_settings)엔 max 가 없어 조용히 무시되고,
  // get_settings 는 세션 값을 모른다(probe9). 사람 입력처럼 한 줄씩 쓰지만 기록·사건·작업 중 표시는 남기지 않는다.
  private effortWant = new WeakMap<ClaudeSession, EffortLevel>(); // 보낼 /effort — 차례가 끝나면 기다리던 사람 입력보다 먼저(마지막 값 하나만)
  private effortTurn = new WeakMap<ClaudeSession, EffortTurn>(); // 써 넣은 /effort — 그 result 까지 이벤트를 삼킨다
  private effortBroken = new Set<AgentId>(); // /effort 가 막혀 다시 띄움 — 고르기·모델 바꾸기 전까지 /effort 없이 띄운다(메모리만)
  private compactedTurn = new WeakSet<ClaudeSession>(); // 이번 차례에 요약됨 — 그 차례의 result 뒤엔 값을 받지 않는다
  // 도는 서브에이전트 — task_id → 부모의 Agent tool_use id 등(넣은 순서 = 시작 순). 끝 알림·세션 끝에 빠진다(메모리만, 빈 목록은 지운다)
  private subagents = new Map<AgentId, Map<string, RunningSubagent>>();
  // 뒤에서 돈 서브에이전트가 끝나 Claude 가 스스로 열 차례를 기다린다 — 그동안 다시 띄우기·/effort 를 미루고 화면은 작업 중(세션 끝에 지운다)
  private autoTurns = new Map<AgentId, AutoTurnWait>();
  private bgTasks = new WeakMap<ClaudeSession, string[]>(); // 그 세션이 마지막으로 알린 뒤에서 도는 일의 id 목록 — 비지 않으면 재우지 않는다(끄면 그 명령도 죽는다)
  // 재우기 — 한동안 쉰 세션을 끈다(메모리를 비운다). 말을 걸면 ensure 가 --resume 으로 깨운다(앱을 다시 켠 뒤 처음 말을 걸 때와 같은 길)
  private sleepMin: number; // 재우기까지의 시간(분) — 0 = 끔
  private sweepTimer: NodeJS.Timeout | null = null; // 살아 있는 세션 훑기(start 에서 켜고 shutdown 에서 끈다)
  // 마지막 활동 — 띄울 때 · 그 세션이 보낸 줄(제어 응답 말고 어떤 사건이든) · 그 세션에 쓴 줄(/effort 포함) · 고른 에이전트에서 다른 에이전트로 옮긴 순간.
  // 엔진이 제 일로 보내는 제어 요청(사용량·설정 읽기·권한 모드)과 그 답은 치지 않는다.
  // 흐른 시간(performance.now)으로 잰다 — 벽시계면 PC 시계를 뒤로 돌린 만큼(3일이면 3일) 아무도 잠들지 않는다
  private lastActive = new WeakMap<ClaudeSession, number>();
  // 손으로 재운 에이전트 — 렌더러는 고른 카드를 다시 눌러도 setSelected 를 다시 부르니, 미리 띄우기가 곧바로 깨우지 않게 건너뛴다.
  // 깨우면(ensure 가 새로 띄움) · 다른 에이전트를 골랐다가 돌아오면 · 새 대화를 시작하면 풀린다(메모리만)
  private handSlept = new Set<AgentId>();
  private waking = new WeakSet<ClaudeSession>(); // 잠든 에이전트를 띄운 세션 — 첫 차례의 init 에서 빠진다(/effort 차례 것 말고. 그 전에 일거리가 있으면 깨우는 중)
  private shownSleep = new Map<AgentId, { asleep: boolean; waking: boolean }>(); // 마지막으로 알린 잠듦 — 바뀔 때만 'sleep'
  private seen = new WeakMap<ClaudeSession, SeenToolUses>(); // 그 세션 스트림에서 본 하는 일 — 승인·두레 도구를 부른 쪽을 가른다(세션이 끝나면 비운다)
  // 결과를 기다리는 고친 일(EDIT_TOOLS) — tool_use id → 입력으로 만들어 기록용으로 줄인 바뀐 줄(못 만들면 null). 결과가 오면 빼고, 세션이 끝나면 비운다.
  // 결과에 structuredPatch 가 없을 때(서브에이전트 줄 등)만 쓴다. 입력 통째는 들고 있지 않는다
  private edits = new WeakMap<ClaudeSession, Map<string, { patch: DiffHunk[]; cut: boolean } | null>>();
  private started = false;
  private limit: number;
  private allow: boolean;
  private closed = false;
  private closing: Promise<void> | null = null;
  private stopping = new Set<Promise<void>>(); // 끄는 중인 세션(상한 STOP_LIMIT_MS) — 맵에서 빠졌어도 shutdown 이 기다린다
  private unstopped = new Set<ClaudeSession>(); // stop() 이 아직 안 끝난 세션 — 상한이 먼저 지나도 shutdown 이 마지막에 직접 끈다
  // ── 서버(SSH) 방 ──
  private remoteRuns = new WeakMap<ClaudeSession, RemoteRun>(); // 서버 방 세션의 띄우기
  private remoteIssues = new Map<AgentId, RemoteIssue>(); // 에이전트의 지금 서버 문제(메모리만)
  private livePorts = new Set<number>(); // 끝나지 않은 서버 세션이 쓰는 원격 포트 — 새로 띄울 때 피한다
  private portTries = new Map<AgentId, { n: number; failed: Set<number> }>(); // 원격 포트 겹침으로 다시 띄운 횟수·겹친 포트 — 뜨면 지운다
  private remoteChain = new Map<AgentId, Promise<void>>(); // 에이전트마다 서버 정리 줄 — 같은 에이전트의 다음 띄우기는 이 줄이 끝난 뒤(startAfter)
  private remoteWork = new Set<Promise<void>>(); // 도는 서버 정리 — shutdown 이 상한 안에서 기다린다
  private cleaning = new Set<string>(); // 줄에 선 정리의 띄우기(`<에이전트>:<pid>.<띄우기>`) — 같은 띄우기를 두 번 세우지 않는다
  private finished = false; // shutdown 이 다 끝났다 — 그 뒤에 끝난 정리는 저장·기록하지 않는다(다음에 켤 때 다시)
  private cleanFailNoticed = new Set<string>(); // 정리 실패를 알린 지운 에이전트의 띄우기 — 켤 때마다 한 번만(기다리는 정리 목록에 남아 다음에 다시)
  private perms: Permissions;
  private router: Router;
  private mcp!: McpServerHandle;
  private watcher: UsageWatcher | null;

  private images: ImageStore;
  private attachments: AttachmentStore;
  // 에이전트마다 보내기 차례 — 첨부를 준비하는(복사하는) 보내기가 있으면 그 에이전트의 다음 보내기는 그 뒤에(앞지르지 않는다).
  // 끝난 차례는 바로 빠진다 — 준비할 것도 기다릴 것도 없는 보내기는 부른 그 자리에서(동기) 줄에 선다
  private sending = new Map<AgentId, Promise<void>>();
  private stops = new Map<AgentId, number>(); // 멈춤 횟수 — 준비하는(또는 그 뒤에 기다리던) 사이 멈췄으면 그 입력은 붙잡는다(메모리만)
  private written = new WeakSet<HeldInput>(); // Claude 에게 쓴 내 입력 — 기록에 남았다(붙잡혀 버려도 첨부 사본은 칩이 쓴다)
  private pruning: Promise<void> = Promise.resolve(); // 켤 때 주인 없는 첨부 폴더 지우기 — 끌 때 기다린다
  // 첨부가 든 보내기마다 하나 — 멈춤·새 대화·지우기·끄기가 끊는다(서버 방이면 올리는 ssh 를 끄고 그 입력은 실패로 — 몇 분짜리 올리기를 기다리지 않는다)
  private uploads = new Map<AgentId, Set<AbortController>>();
  // 끼운 말을 돌려받으며 멈추는 중(stopRetracting) — 그사이 준비를 마친 입력은 이 끝을 기다렸다 붙잡힌다(붙잡기 목록이 보낸 차례대로)
  private retracting = new Map<AgentId, Promise<void>>();

  constructor(private o: EngineOptions, private store: Store, private log: MessageLog, private hist: History) {
    super();
    this.images = openImageStore(o.dataDir);
    this.attachments = openAttachmentStore(o.dataDir);
    this.limit = this.loadLimit(o.autoChainLimit ?? AUTO_CHAIN_LIMIT);
    const settings = this.readSettings();
    this.allow = settings.allowBypass === true;
    const sleepMin = settings.sleepAfterMin;
    this.sleepMin = (SLEEP_CHOICES as readonly unknown[]).includes(sleepMin) ? (sleepMin as number) : SLEEP_DEFAULT_MIN;
    // 막 켰을 때 시작한 에이전트는 모두 잠듦이다(세션이 없다) — 처음 상태 받기(sleepState)와 같은 값에서 견주어야 깨어남이 사건으로 나간다
    for (const a of store.agents()) if (a.started) this.shownSleep.set(a.id, { asleep: true, waking: false });
    this.watcher =
      o.usage === false
        ? null
        : new UsageWatcher({
            liveSession: () => [...this.sessions.values()].find((s) => s.status === 'idle' || s.status === 'working') ?? null,
            spawnProbe: () => this.spawnUsageProbe(),
            // 서브에이전트만 돌아도(부모 차례는 끝남) 일하는 중 — 사용량이 그동안에도 는다
            anyWorking: () => [...this.sessions.values()].some((s) => s.status === 'working') || this.subagents.size > 0,
            now: () => Date.now(),
            emit: (u) => this.guard(null, () => this.emit('usage', u)),
            timing: { ...USAGE_TIMING, ...o.usage },
          });
    this.perms = new Permissions(store);
    this.router = new Router({
      store,
      log,
      limit: this.limit,
      deliver: (id, batch, mid) => {
        const s = this.ensure(id);
        // 막 띄운 세션이 /effort 차례 중 — 던지면 queued 로 남고, 그 차례가 끝나면 pump → onIdle 이 꺼낸다(두 줄을 동시에 쓰지 않는다)
        if (this.effortTurn.has(s)) throw new Error(EFFORT_BUSY);
        this.sendRelay(id, s, batch, mid);
      },
      // 붙잡힌 에이전트도 바쁨 — 전달 대기 메시지는 queued 로 남아 붙잡기 목록에 붙는다
      isBusy: (id) => this.waiting(id) || (this.held.get(id)?.length ?? 0) > 0 || this.holds.has(id),
      // 일하는 중이면 사람 말처럼 지금 차례에 끼워 넣는다 — '멈춰라' 같은 말이 그 차례가 끝날 때까지 묶여 있지 않게
      canInterject: (id) => {
        const s = this.sessions.get(id);
        return !!s && this.canInterject(id, s);
      },
    });
    // 아래 알림은 프로세스 이벤트·MCP 요청 처리 중에도 불린다 — 듣는 쪽이 던져도 남은 일(상태·다음 입력)은 한다
    this.perms.on('request', (r: PendingRequest) => {
      this.guard(r.agentId, () => this.emit('request', r));
      this.guard(r.agentId, () => this.emitStatus(r.agentId));
    });
    this.perms.on('resolved', (r: { id: string; agentId: AgentId }) => {
      this.guard(r.agentId, () => this.emit('request-resolved', r));
      this.guard(r.agentId, () => {
        this.emitStatus(r.agentId);
        this.pump(r.agentId);
      });
    });
    this.perms.on('always-allow', (p: EngineEventMap['always-allow']) => this.guard(p.agentId, () => this.emit('always-allow', p)));
    this.router.on('message', (m: RelayMessage) => {
      this.guard(null, () => this.emit('message', m));
      this.guard(m.to, () => this.noteHoldMessage(m));
      this.guard(m.to, () => this.emitSleep(m.to)); // 깨운 세션의 /effort 차례 중에 queued 로 남은 메시지도 깨우는 중
    });
    this.router.on('held', (h: { roomId: RoomId }) => this.guard(null, () => this.emit('held', h)));
  }

  async init(): Promise<void> {
    this.mcp = await startMcpServer({
      listAgents: async (agentId, toolUseId) => {
        const me = await this.dureCaller(agentId, toolUseId);
        const peers = this.store.agents(me.roomId).filter((a) => a.id !== me.id);
        return JSON.stringify(peers.map((a) => ({ name: a.name, role: a.role, status: this.status(a.id) })));
      },
      sendMessage: async (agentId, to, text, toolUseId) => this.router.send((await this.dureCaller(agentId, toolUseId)).id, to, text),
      approve: async (agentId, args, signal) => {
        if (String(args.tool_name).startsWith(DURE_TOOL_PREFIX)) return { behavior: 'deny', message: DURE_TOOL_DENIED };
        if (this.closed || this.removing.has(agentId)) return { behavior: 'deny', message: EXITED };
        // 늘 허용한 도구는 부른 쪽과 상관없이 허용 — 못 본 id 라고 기다리지 않는다(질문은 늘 묻는다)
        if (this.perms.allowsAlways(agentId, args.tool_name)) return { behavior: 'allow', updatedInput: args.input };
        const s = this.sessions.get(agentId);
        const fromSubagent = (await this.origin(agentId, args.tool_use_id)) === 'subagent';
        // 기다리는 사이 끝났다 — 세션이 끝났으면 endSession 이 대기를 이미 정리했다: 그 뒤에 카드를 만들지 않는다
        if (this.closed || this.removing.has(agentId) || (s && this.sessions.get(agentId) !== s)) return { behavior: 'deny', message: EXITED };
        return this.perms.request(agentId, args, signal, { fromSubagent }); // 부른 프로세스가 끊기면 카드도 사라진다
      },
      createAgent: (agentId, args, toolUseId, signal) => this.createAgentFor(agentId, args, toolUseId, signal),
    });
    if (this.o.autoStart !== false) this.start();
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    // 지난번에 끄지 못한 서버 claude(끊김·비정상 종료·끄기 정리 상한) — 정리를 먼저 줄에 세운다. 기다리지 않는다(그 에이전트를 띄우는 것만 그 뒤로)
    for (const a of this.store.agents()) {
      const remote = this.remoteOf(a);
      if (remote && a.remoteLaunch) this.guard(a.id, () => void this.queueClean(a.id, remote.host, a.remoteLaunch!));
    }
    // 지운 에이전트의 서버 claude 중 정리하지 못한 것(기다리는 정리 목록) — 되면 목록에서 뺀다(forgetLaunch), 안 되면 남겨 다음에 켤 때 다시
    for (const p of this.store.pendingCleanups()) this.guard(null, () => void this.queueClean(p.agentId, p.host, p.launch));
    // 지운 에이전트의 서버 첨부 폴더 중 지우지 못한 것(기다리는 첨부 정리) — 되면 목록에서 뺀다. 아직 있는 에이전트의 것은 건드리지 않는다
    for (const p of this.store.pendingAttachmentCleanups()) {
      if (!this.store.agent(p.agentId)) this.guard(null, () => this.queueAttachmentsCleanup(p.agentId, p.host));
    }
    // 지운 에이전트의 첨부 폴더가 잠겨 남았던 것 — 주인(에이전트)이 없는 폴더만 조용히 지운다. 기다리지 않는다(끌 때는 기다린다)
    this.pruning = this.attachments.prune((id) => !!this.store.agent(id));
    this.router.flushAll();
    this.watcher?.start();
    this.sweepTimer = setInterval(() => this.guard(null, () => this.sweep()), this.o.sleepSweepMs ?? this.minuteMs());
    this.sweepTimer.unref?.();
  }

  // ── 설정 ──
  private settingsFile() { return path.join(this.o.dataDir, 'settings.json'); }

  /** 설정 파일 — 없거나 깨졌으면 빈 객체 */
  private readSettings(): {
    autoChainLimit?: unknown; allowBypass?: unknown; notifyAsks?: unknown; notifyFinished?: unknown; theme?: unknown; sleepAfterMin?: unknown;
  } {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsFile(), 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  /** 있던 값은 그대로 두고 patch 만 덮어 쓴다 */
  private writeSettings(patch: {
    autoChainLimit?: number; allowBypass?: boolean; notifyAsks?: boolean; notifyFinished?: boolean; theme?: ThemePref; sleepAfterMin?: number;
  }): void {
    const file = this.settingsFile();
    fs.mkdirSync(this.o.dataDir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...this.readSettings(), ...patch }, null, 2));
    renameRetrying(`${file}.tmp`, file);
  }

  /** 저장된 값이 없거나 깨졌으면 fallback */
  private loadLimit(fallback: number): number {
    const n = this.readSettings().autoChainLimit;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : fallback;
  }

  allowBypass(): boolean { return this.allow; }

  async setAllowBypass(on: boolean): Promise<void> {
    if (typeof on !== 'boolean') throw new Error(BYPASS_VALUE_INVALID);
    const was = this.allow;
    // 허용이 꺼진 채 남은 켜짐(손으로 고친 파일 등)은 끈 것으로 친다 — 켤 때 살아나지 않게 허용을 저장하기 전에 지운다
    // (허용을 켜면 모두 꺼진 채 시작. 지우다 실패하면 허용도 저장하지 않는다 — 켜지 않은 에이전트가 켜진 채 남지 않게)
    if (on && !was) for (const a of this.store.agents()) if (a.bypassOn) this.store.updateAgent(a.id, { bypassOn: false });
    this.writeSettings({ allowBypass: on });
    this.allow = on;
    // 켜져 있던 에이전트 + 스위치는 꺼졌지만 두레가 켠 bypass 가 남은 세션(끄기 실패·늦은 켜기)
    const targets = on ? [] : this.store.agents().filter((a) => a.bypassOn || this.leftover(a.id));
    for (const a of targets) if (a.bypassOn) this.store.updateAgent(a.id, { bypassOn: false });
    for (const a of this.store.agents()) this.emitFlags(a.id); // bySettings 가 허용에 따라 바뀐다
    // 내 기본 모드로 — 옵션으로 떠 있는 세션도 다시 띄우지 않는다(옵션만으론 bypass 가 아니다)
    await Promise.all(targets.map((a) => this.applyBypass(a.id, false)));
  }

  /** 켜고 끄는 일이 드물어 캐시 없이 파일을 읽는다 — 값이 어디에도 두 벌로 남지 않는다 */
  notify(): NotifyPrefs {
    const s = this.readSettings();
    return {
      asks: typeof s.notifyAsks === 'boolean' ? s.notifyAsks : true,
      finished: typeof s.notifyFinished === 'boolean' ? s.notifyFinished : false,
    };
  }

  setNotify(p: Partial<NotifyPrefs>): void {
    // 렌더러에서 온 값이라 불리언인 칸만 받는다 — 바꾼 칸만 쓰므로 기본값 그대로인 칸은 파일에 남지 않는다
    const patch: { notifyAsks?: boolean; notifyFinished?: boolean } = {};
    if (typeof p?.asks === 'boolean') patch.notifyAsks = p.asks;
    if (typeof p?.finished === 'boolean') patch.notifyFinished = p.finished;
    if (Object.keys(patch).length > 0) this.writeSettings(patch);
  }

  theme(): ThemePref {
    const t = this.readSettings().theme;
    return THEME_PREFS.includes(t as ThemePref) ? (t as ThemePref) : 'system';
  }

  setTheme(t: ThemePref): void {
    if (!THEME_PREFS.includes(t)) throw new Error(THEME_INVALID);
    this.writeSettings({ theme: t });
  }

  sleepAfter(): number { return this.sleepMin; }

  setSleepAfter(min: number): void {
    // 렌더러에서 온 값 — 고를 수 있는 수만(문자열 '15' 같은 것도 받지 않는다). 훑기는 다음 차례부터 새 값으로 잰다
    if (!(SLEEP_CHOICES as readonly unknown[]).includes(min)) throw new Error(SLEEP_INVALID);
    this.writeSettings({ sleepAfterMin: min });
    this.sleepMin = min;
  }

  autoChainLimit(): number { return this.limit; }

  setAutoChainLimit(n: number): void {
    if (!Number.isInteger(n) || n < 1) throw new Error(LIMIT_INVALID);
    this.writeSettings({ autoChainLimit: n });
    this.limit = n;
    this.router.setLimit(n);
  }

  // ── 방·에이전트 ──
  rooms() { return this.store.rooms(); }
  agents(roomId?: RoomId) { return this.store.agents(roomId); }
  addRoom(name: string, remote?: { host: string } | null) {
    if (remote && !this.sshAvailable()) throw new Error(NO_SSH);
    return this.store.addRoom(name, remote);
  }
  renameRoom(id: RoomId, name: string) { return this.store.renameRoom(id, name); }
  addAgent(i: { roomId: RoomId; name: string; role: string; folder: string }) { return this.store.addAgent(i); }

  remoteIssue(id: AgentId): RemoteIssue | null {
    this.need(id);
    return this.remoteIssues.get(id) ?? null;
  }

  // ── 서버(SSH) ──
  sshAvailable(): boolean {
    const ssh = this.o.ssh;
    return !!ssh && (ssh.command === process.execPath || fs.existsSync(ssh.command));
  }

  sshHosts(): SshHostEntry[] {
    return readSshHosts(this.o.sshHome ?? undefined);
  }

  async checkRemote(host: string): Promise<{ ok: true; claudeVersion: string } | { ok: false; kind: RemoteIssueKind; detail: string | null }> {
    const h = host.trim();
    hostArgs(h); // 올바르지 않으면 ssh 없이 던진다
    const r = await this.remoteCheck(h, undefined);
    return r.ok ? { ok: true, claudeVersion: r.claudeVersion } : r;
  }

  async checkRemoteFolder(
    roomId: RoomId,
    folder: string,
  ): Promise<{ ok: true; folder: string; claudeVersion: string } | { ok: false; kind: RemoteIssueKind; detail: string | null }> {
    const room = this.store.rooms().find((r) => r.id === roomId);
    if (!room) throw new Error(`방을 찾을 수 없습니다: ${roomId}`);
    if (!room.remote) throw new Error(NOT_REMOTE);
    const f = folder.trim();
    // 서버 전체 경로 · ~ · ~/… 만(~사용자 는 아님) — 줄바꿈 같은 제어 문자도 받지 않는다
    if (!(f.startsWith('/') || f === '~' || f.startsWith('~/')) || CONTROL_CHAR.test(f)) throw new Error(REMOTE_FOLDER_ABSOLUTE);
    const r = await this.remoteCheck(room.remote.host, f);
    if (!r.ok) return r;
    // 서버가 펼친 폴더가 없으면(찍히지 않음) 그 폴더를 확인하지 못한 것
    return r.folder ? { ok: true, folder: r.folder, claudeVersion: r.claudeVersion } : { ok: false, kind: 'no-folder', detail: null };
  }

  /**
   * 확인 ssh 한 번(checkScript) — 0 이 아닌 종료는 classifyExit(시작 전)로, 그 밖(시간 초과·모르는 종료)은 접속 실패 + ssh 오류 첫 줄.
   * 됐으면 parseCheckOutput(로그인 셸 프로필이 앞에 찍을 수 있다): 마지막 줄 = claude 버전, folder 를 줬으면 DURE_DIR= 줄 = 펼친 폴더
   */
  private async remoteCheck(
    host: string,
    folder: string | undefined,
  ): Promise<{ ok: true; folder: string | null; claudeVersion: string } | { ok: false; kind: RemoteIssueKind; detail: string | null }> {
    await this.remoteUpdated(host); // 보이는 버전이 업데이트 뒤 값이 되게
    const run = await this.sshRun(host, checkScript(folder));
    if (run.code !== 0) {
      const issue = classifyExit({ code: run.code, stderr: run.stderr, started: false });
      if (issue) return { ok: false, ...issue };
      return { ok: false, kind: 'unreachable', detail: sshErrorLines(run.stderr)[0] ?? null };
    }
    const out = parseCheckOutput(run.stdout);
    if (!out.claudeVersion) return { ok: false, kind: 'no-claude', detail: null };
    return { ok: true, folder: folder === undefined ? null : out.folder, claudeVersion: out.claudeVersion };
  }

  private remoteUpdates = new Map<string, Promise<void>>();

  /**
   * 서버의 claude 를 최신으로 — 켜져 있을 때 서버마다 엔진이 산 동안 한 번(그 약속을 메모). 결과·실패는 버린다(조용히).
   * 꺼져 있으면 아무것도 안 하고 메모도 하지 않는다 — 나중에 켜면 그때 처음 닿는 것으로 친다
   */
  private remoteUpdated(host: string): Promise<void> {
    if (!(this.o.claudeAutoUpdate?.() ?? false)) return Promise.resolve();
    let p = this.remoteUpdates.get(host);
    if (!p) {
      p = this.sshRun(host, updateScript(), { timeoutMs: REMOTE_UPDATE_MS }).then(
        () => undefined,
        () => undefined,
      );
      this.remoteUpdates.set(host, p);
    }
    return p;
  }

  /**
   * 확인·정리·기록 확인 ssh — 셸 없이(execFile), 상한 REMOTE_CHECK_MS(quick 이면 REMOTE_QUICK_MS), 전달 없음(runArgs). login false = bash -c(정리).
   * ssh 가 없으면 NO_SSH 로 던진다
   */
  private sshRun(host: string, script: string, o: { quick?: boolean; login?: boolean; timeoutMs?: number } = {}): Promise<SshRun> {
    const ssh = this.o.ssh;
    if (!ssh || !this.sshAvailable()) return Promise.reject(new Error(NO_SSH));
    const quick = o.quick === true;
    const args = [
      ...(ssh.argsPrefix ?? []),
      ...runArgs({ host, script, login: o.login, connectTimeout: quick ? REMOTE_QUICK_MS / 1000 : undefined }),
    ];
    return new Promise((resolve, reject) => {
      const child = execFile(
        ssh.command,
        args,
        { windowsHide: true, timeout: o.timeoutMs ?? (quick ? REMOTE_QUICK_MS : REMOTE_CHECK_MS), env: { ...process.env, ...this.o.env }, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr });
          const code: unknown = err.code;
          if (code === 'ENOENT') return reject(new Error(NO_SSH));
          // 못 띄움(글 코드)·시간 초과(null)는 code null — 글이 없으면 그 오류 글을 stderr 자리에
          resolve({ code: typeof code === 'number' ? code : null, stdout, stderr: stderr || (typeof code === 'string' ? err.message : '') });
        },
      );
      child.stdin?.end(); // 확인 명령은 입력을 읽지 않는다
    });
  }

  /** 그 에이전트의 방이 서버 방이면 그 서버 — 아니면 null */
  private remoteOf(a: Agent): { host: string } | null {
    return this.store.rooms().find((r) => r.id === a.roomId)?.remote ?? null;
  }

  /**
   * 서버 방 세션 — ssh 로 서버에서 claude 를 띄운다(launchArgs, ssh 의 작업 폴더 = 이 PC 의 run 폴더). MCP 설정(url = 서버 쪽 원격 포트 —
   * -R 이 두레로 잇는다)·방 안내문은 stdin 머리말로 서버 run 폴더 파일에(토큰을 명령 인자에 싣지 않는다), claude 인자는 지금 그대로에서
   * 그 두 경로만 서버 것으로. 서버 첨부 폴더는 --add-dir "$HOME/…"(셸이 펼친다 — 띄우기가 만든다). 저장된 옛 띄우기가 있으면 그 정리를
   * 먼저 줄에 세우고, 그 에이전트의 정리 줄이 끝난 뒤에 띄운다(startAfter)
   */
  private remoteSession(
    id: AgentId,
    agent: Agent,
    host: string,
    runDir: string,
    prompt: string,
    argsWith: (mcpConfigPath: string, promptPath: string, addDirs?: string[]) => string[],
  ): ClaudeSession {
    const ssh = this.o.ssh!;
    const launchId = Array.from(crypto.randomBytes(LAUNCH_ID_LEN), (b) => LAUNCH_ID_CHARS[b % LAUNCH_ID_CHARS.length]).join('');
    const port = this.pickRemotePort(id);
    const files = remoteRunFiles(id, launchId);
    void this.remoteUpdated(host); // 띄우기는 기다리지 않는다 — 시작만
    const claudeArgs = argsWith(files.mcp, files.prompt, [remoteAttachDir(id)]);
    const script = remoteLaunchScript({ agentId: id, launchId, folder: agent.folder, claudeArgs });
    const mcpJson = JSON.stringify(buildMcpConfig({ port, token: this.mcp.token, agentId: id }));
    if (agent.remoteLaunch) void this.queueClean(id, host, agent.remoteLaunch); // 끊김·비정상 종료 뒤 남았을 수 있다
    const gate = this.remoteChain.get(id);
    const run: RemoteRun = {
      host, port, launchId, pid: null, err: '', started: false, ended: false, cleanQueued: false, stopJob: false,
    };
    const s = new ClaudeSession({
      command: ssh.command,
      args: [...(ssh.argsPrefix ?? []), ...launchArgs({ host, remotePort: port, localPort: this.mcp.port, script })],
      cwd: runDir,
      // ssh 는 환경을 서버로 넘기지 않는다 — claude 의 환경(SPAWN_ENV_EXTRA)은 스크립트가 export 한다
      env: { ...process.env, ...this.o.env },
      stdinPreamble: launchPreamble(mcpJson, prompt),
      onStderr: (chunk) => this.guard(id, () => this.noteRemotePid(id, run, chunk)),
      ...(gate ? { startAfter: gate } : {}),
    });
    this.remoteRuns.set(s, run);
    return s;
  }

  /**
   * 원격 포트 하나 — 범위의 아무 자리에서 시작해 차례로 훑어, 끝나지 않은 서버 세션이 쓰는 것은 피하고 이번에 겹쳤던 포트도 되도록 피한다
   * (남은 것이 없으면 시작 자리 그대로 — 겹치면 다시 시도가 받는다)
   */
  private pickRemotePort(id: AgentId): number {
    const { from, to, random } = this.o.remotePorts ?? { from: REMOTE_PORT_FROM, to: REMOTE_PORT_TO };
    const size = to - from + 1;
    const start = random ? Math.min(size - 1, Math.floor(random() * size)) : crypto.randomInt(size);
    const failed = this.portTries.get(id)?.failed;
    const scan = (ok: (p: number) => boolean): number | null => {
      for (let i = 0; i < size; i++) {
        const p = from + ((start + i) % size);
        if (ok(p)) return p;
      }
      return null;
    };
    return scan((p) => !this.livePorts.has(p) && !failed?.has(p)) ?? scan((p) => !this.livePorts.has(p)) ?? from + start;
  }

  /**
   * 띄운 셸이 stderr 로 알린 DURE_PID — 저장한다(앱이 비정상으로 꺼져도 다음에 켤 때·띄울 때 정리). 두레가 이미 내린 띄우기면 저장하지 않고
   * 정리한다(내린 뒤 기다리는 일이 있으면 그 일이 본다)
   */
  private noteRemotePid(id: AgentId, run: RemoteRun, chunk: string): void {
    if (run.pid !== null) return;
    if (run.err.length < LAUNCH_ERR_KEEP) run.err += chunk;
    const pid = parsePid(run.err);
    if (pid === null) return;
    run.pid = pid;
    run.err = '';
    const launch = { pid, run: run.launchId };
    if (!run.ended) this.store.updateAgent(id, { remoteLaunch: launch });
    else if (!run.stopJob && !run.cleanQueued) {
      run.cleanQueued = true;
      void this.queueClean(id, run.host, launch);
    }
  }

  /** 서버 세션이 처음 말했다(stdout 한 줄) — 시작됨. 포트 다시 시도를 접고, 지난 접속 문제(로그인 말고 — 그건 정상 답이 지운다)를 지운다 */
  private remoteStarted(id: AgentId, s: ClaudeSession, run: RemoteRun): void {
    run.started = true;
    if (this.sessions.get(id) !== s) return;
    this.portTries.delete(id);
    const cur = this.remoteIssues.get(id);
    if (cur && cur.kind !== 'login') this.setRemoteIssue(id, null);
  }

  /** 서버 방 차례의 result — 로그인이 풀렸다는 글이면 login 문제(답 줄은 대화에 그대로), 정상 답이면 그 문제를 지운다 */
  private noteRemoteResult(id: AgentId, ev: Extract<StreamEvent, { kind: 'result' }>): void {
    const cur = this.remoteIssues.get(id);
    if (isLoginFailure(ev.text)) {
      if (cur?.kind !== 'login') this.setRemoteIssue(id, { kind: 'login', detail: null });
    } else if (ev.ok && cur?.kind === 'login') this.setRemoteIssue(id, null);
  }

  /** 문제를 바꾸고 상태 사건으로 알린다(상태가 그대로여도 — remoteIssue 칸) */
  private setRemoteIssue(id: AgentId, issue: RemoteIssue | null): void {
    if (issue) this.remoteIssues.set(id, issue);
    else this.remoteIssues.delete(id);
    this.emitStatus(id);
  }

  /**
   * 두레가 내리지 않았는데 서버 방 ssh 가 끝났다(부른 쪽이 세션을 맵에서 뺐다) — classifyExit 로 가른다(시작됨 = stdout 한 줄이라도).
   * 서버가 원격 포트를 못 열어 명령 전에 끝난 것은 '포트' — 다른 포트로 다시(PORT_RETRIES 번까지 — 기다린 입력은 새 세션으로), 다 안 되면
   * 전용 안내(서버가 전달을 막았다). 가른 문제는 오류 대신 remoteIssue + 안내 한 줄(바뀔 때만), 보낸 줄은 기다리는 줄로.
   * 못 가르면 지금의 '예기치 않게 종료' 길 — 오류 글은 ssh 잡음(known_hosts 경고·DURE_PID)을 뺀 stderr. 상태는 부른 쪽(exit)이 알린다
   */
  private remoteExited(id: AgentId, s: ClaudeSession, run: RemoteRun, code: number | null, stderr: string): void {
    // DURE_PID 를 받았으면 그 뒤의 ssh 쪽 종료(255·-1)는 끊김 — 서버에서 명령이 돈 뒤다(claude 가 아직 한 줄도 안 낸 미리 띄운 세션 등)
    let issue = classifyExit({ code, stderr, started: run.started, pidSeen: run.pid !== null, port: run.port });
    let blocked = false; // 포트를 다 바꿔 봐도 서버가 전달을 열지 않았다
    // 끊김이면 서버 claude 가 남았을 수 있다 — 다음에 띄울 때(저장된 pid 로) 정리한다. 그 밖은 지금(claude 는 없어도 토큰이 든 run 폴더가 남는다)
    if (issue?.kind !== 'disconnected') this.cleanExited(id, run);
    this.guard(id, () => this.restoreInFlight(id, s));
    this.perms.cancelForAgent(id, EXITED);
    if (issue?.kind !== 'port') this.portTries.delete(id); // 첫 줄 전에 다른 까닭으로 끝났다 — 다음 띄우기는 다시 처음부터
    if (issue?.kind === 'port') {
      const tries = this.portTries.get(id) ?? { n: 0, failed: new Set<number>() };
      tries.failed.add(run.port);
      if (tries.n < PORT_RETRIES) {
        tries.n++;
        this.portTries.set(id, tries);
        // 다른 포트로 다시 — resumeFailed 와 같은 길(기다리는 것이 없으면 고른 에이전트만 미리 띄운다)
        try {
          if (this.hasWaitingWork(id)) this.ensure(id, { quiet: true });
          else this.prewarm(id);
        } catch {
          return; // ensure 가 오류 상태를 남겼다
        }
        this.pump(id);
        return;
      }
      this.portTries.delete(id);
      issue = null; // 다시 해도 겹친다 — 오류로
      blocked = true;
    }
    if (issue) {
      const cur = this.remoteIssues.get(id);
      this.remoteIssues.set(id, issue);
      // 같은 문제가 이어지면(고를 때마다 미리 띄우기 등) 알림 줄을 또 남기지 않는다 — 안내 띠가 계속 보여 준다
      if (cur?.kind !== issue.kind || cur.detail !== issue.detail) this.guard(id, () => this.record(id, { kind: 'notice', text: remoteIssueText(run.host, issue) }));
      return;
    }
    const why = blocked ? remotePortBlockedText(run.host) : sshErrorLines(stderr).join('\n') || `Claude 가 예기치 않게 종료됨(code ${code})`;
    this.guard(id, () => this.record(id, { kind: 'notice', text: why }));
    this.errors.set(id, why);
    // 지금 문제는 이 오류다 — 지난 접속 문제는 내린다(로그인 만료는 정상 답까지 남긴다)
    if (this.remoteIssues.get(id)?.kind !== 'login') this.remoteIssues.delete(id);
  }

  /** 스스로 끝난 서버 세션의 띄우기 — pid 를 받았으면 지금 정리를 줄에 세운다(다음 띄우기가 기다린다) */
  private cleanExited(id: AgentId, run: RemoteRun): void {
    if (run.pid === null || run.cleanQueued) return;
    run.cleanQueued = true;
    void this.queueClean(id, run.host, { pid: run.pid, run: run.launchId });
  }

  /**
   * 두레가 서버 세션을 내린다(endSession) — ssh 를 끈 뒤(stopped) 그 띄우기를 정리한다. 그 에이전트의 정리 줄에 세워 다음 띄우기가 기다린다.
   * pid 를 아직 못 받았으면 끈 뒤에 본다(서버에서 띄우기 전에 끝났으면 정리할 것이 없다)
   */
  private cleanAfterStop(id: AgentId, run: RemoteRun, stopped: Promise<void>): void {
    if (run.cleanQueued) return;
    if (run.pid !== null) {
      run.cleanQueued = true;
      void this.queueClean(id, run.host, { pid: run.pid, run: run.launchId }, stopped);
      return;
    }
    run.stopJob = true;
    void this.queueRemote(id, async () => {
      await stopped;
      run.stopJob = false;
      if (run.pid === null || run.cleanQueued) return;
      run.cleanQueued = true;
      await this.cleanRemote(id, run.host, { pid: run.pid, run: run.launchId });
    });
  }

  /** 그 띄우기의 정리를 그 에이전트의 정리 줄 끝에(after 가 끝난 뒤) — 같은 띄우기가 이미 줄에 있으면 세우지 않는다 */
  private queueClean(id: AgentId, host: string, launch: { pid: number; run: string }, after?: Promise<unknown>): Promise<void> {
    const key = `${id}:${launch.pid}.${launch.run}`;
    if (this.cleaning.has(key)) return this.remoteChain.get(id) ?? Promise.resolve();
    this.cleaning.add(key);
    return this.queueRemote(id, async () => {
      try {
        await after;
        await this.cleanRemote(id, host, launch);
      } finally {
        this.cleaning.delete(key);
      }
    });
  }

  /** 그 에이전트의 서버 정리 줄 끝에 일 하나 — 앞의 일이 끝난 뒤 돈다. 던지지 않는다(engine-error). shutdown 이 상한 안에서 기다린다 */
  private queueRemote(id: AgentId, job: () => Promise<void>): Promise<void> {
    const prev = this.remoteChain.get(id) ?? Promise.resolve();
    const p: Promise<void> = prev.then(job).catch((e: unknown) =>
      this.guard(id, () => this.emit('engine-error', { agentId: id, message: e instanceof Error ? e.message : String(e) })),
    );
    this.remoteChain.set(id, p);
    this.remoteWork.add(p);
    void p.finally(() => {
      this.remoteWork.delete(p);
      if (this.remoteChain.get(id) === p) this.remoteChain.delete(id);
    });
    return p;
  }

  /**
   * 서버 정리 한 번(cleanupScript — 별도 ssh, 상한 REMOTE_CHECK_MS) — 되면 저장된 띄우기가 이것일 때만 비운다(그새 새로 띄운 것은 그대로).
   * 안 되면 한 번 더, 그래도 안 되면 그 에이전트 기록에 알림 한 줄(저장은 남겨 다음에 다시 — 지운 에이전트면 engine-error). 던지지 않는다
   */
  private async cleanRemote(id: AgentId, host: string, launch: { pid: number; run: string }): Promise<void> {
    let script: string;
    try {
      script = cleanupScript({ pid: launch.pid, agentId: id, launchId: launch.run });
    } catch {
      return; // 깨진 값 — store 가 읽을 때 거르니 오지 않는다
    }
    for (let i = 0; i < 2; i++) {
      let r: SshRun | null = null;
      try {
        r = await this.sshRun(host, script, { login: false });
      } catch {
        /* ssh 없음·서버 이름 — 실패로 친다 */
      }
      if (r?.code === 0) {
        if (!this.finished) this.guard(id, () => this.forgetLaunch(id, launch));
        return;
      }
    }
    if (this.finished) return;
    if (this.removing.has(id) || !this.store.agent(id)) {
      // 지운 에이전트 — 띄우기는 기다리는 정리 목록에 남아 다음에 켤 때 다시 한다. 알림은 켤 때마다 그 띄우기 하나에 한 번
      const key = `${id}:${launch.pid}.${launch.run}`;
      if (this.cleanFailNoticed.has(key)) return;
      this.cleanFailNoticed.add(key);
      this.guard(null, () => this.emit('engine-error', { agentId: id, message: REMOTE_CLEANUP_FAILED }));
      return;
    }
    this.guard(id, () => this.record(id, { kind: 'notice', text: REMOTE_CLEANUP_FAILED }));
  }

  /** 정리한 띄우기를 잊는다 — 에이전트에 저장된 것이 이것이면 비우고, 지운 에이전트의 기다리는 정리 목록에서도 뺀다 */
  private forgetLaunch(id: AgentId, launch: { pid: number; run: string }): void {
    const cur = this.store.agent(id)?.remoteLaunch;
    if (cur && cur.pid === launch.pid && cur.run === launch.run) this.store.updateAgent(id, { remoteLaunch: null });
    this.store.dropPendingCleanup(id, launch);
  }

  /** 도는 서버 정리를 기다린다 — 상한 stopLimitMs(STOP_LIMIT_MS). 못 끝낸 띄우기는 저장돼 있어 다음에 켤 때 다시 정리한다 */
  private async waitRemoteWork(): Promise<void> {
    if (this.remoteWork.size === 0) return;
    await this.waitWithin([...this.remoteWork]);
  }

  /** 다 끝날 때까지 — 상한 stopLimitMs(STOP_LIMIT_MS)까지만 */
  private async waitWithin(ps: Promise<unknown>[]): Promise<void> {
    if (ps.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((r) => {
      timer = setTimeout(r, this.o.stopLimitMs ?? STOP_LIMIT_MS);
    });
    await Promise.race([Promise.all(ps), limit]);
    clearTimeout(timer);
  }

  updateAgent(id: AgentId, p: Pick<AgentPatch, 'name' | 'role' | 'auto' | 'pos' | 'color' | 'bypassNoticeClosed'>) {
    this.need(id);
    const { name, role, auto, pos, color } = p; // model·alwaysAllow·sessionId 는 엔진이 따로 다룬다
    // 경고 닫힘은 true·false 만 — 다른 값은 없는 것으로
    const bypassNoticeClosed = typeof p.bypassNoticeClosed === 'boolean' ? p.bypassNoticeClosed : undefined;
    return this.store.updateAgent(id, { name, role, auto, pos, color, bypassNoticeClosed });
  }

  async removeRoom(id: RoomId) {
    for (const a of this.store.agents(id)) await this.removeAgent(a.id);
    this.store.removeRoom(id); // 없는 방이면 여기서 던진다(그 전엔 할 일이 없다)
  }

  async removeAgent(id: AgentId) {
    this.need(id);
    this.removing.add(id);
    this.disarmCool(id);
    this.cancelUploads(id); // 올리는 중인 첨부 — ssh 를 끈다(그 보내기는 실패로 끝난다, 서버 폴더는 아래에서 통째로)
    if (this.selected === id) this.selected = null;
    // 붙잡기도 같이 — 아래에서 버리는 메시지가 목록에서 하나씩 빠지며 알리지 않게 먼저 지운다(풀림은 끝에 한 번)
    const hadHold = this.holds.delete(id);
    try {
      await this.endSession(id);
      // 세션 없이 서버에 남은 claude(끊긴 뒤·정리 실패 뒤) — 지우기 전에 정리를 세운다(방금 내린 세션의 것과 같으면 한 번만).
      // store 가 지우며 그 띄우기를 기다리는 정리 목록으로 옮긴다 — 실패하면(engine-error) 다음에 켤 때 다시, 되면 목록에서 뺀다
      const gone = this.store.agent(id);
      const remote = gone && this.remoteOf(gone);
      if (remote && gone.remoteLaunch) void this.queueClean(id, remote.host, gone.remoteLaunch);
      for (const m of this.log.list({ states: ['pending', 'held', 'queued'] })) {
        if (m.to === id || m.from === id) this.router.dismiss(m.id);
      }
      // store 가 지우며 서버 첨부 폴더를 기다리는 첨부 정리 목록에 넣는다 — 지금 한 번 해 보고, 되면 목록에서 뺀다(안 되면 다음에 켤 때 다시)
      this.store.removeAgent(id);
      if (remote) this.queueAttachmentsCleanup(id, remote.host);
      this.hist.remove(id);
      this.images.remove(id);
      // 첨부 사본도 — 다른 프로그램이 연 채 잠가 못 지워도 지우기는 끝낸다(남은 것은 알리고, 다음에 켤 때 다시 지운다)
      this.removeAttachments(id);
    } finally {
      this.removing.delete(id);
      this.shown.delete(id);
      this.shownSleep.delete(id);
      this.handSlept.delete(id);
      const had = this.held.get(id)?.length ?? 0;
      this.held.delete(id); // 기다리던 사람 입력은 에이전트와 함께 버린다
      this.settingsDefaultOf.delete(id);
      this.modeSeq.delete(id);
      this.planSeq.delete(id);
      this.planWant.delete(id);
      this.planShown.delete(id);
      this.effortNows.delete(id);
      this.forgetPastCount(id);
      this.effortBroken.delete(id);
      this.modelNows.delete(id);
      this.remoteIssues.delete(id);
      this.portTries.delete(id);
      this.stops.delete(id);
      if (had > 0) this.guard(id, () => this.emit('held-input', { agentId: id, count: 0 }));
      if (hadHold) this.guard(id, () => this.emit('hold', { agentId: id, hold: null }));
    }
  }

  // ── 상태 ──
  status(id: AgentId): AgentStatus {
    this.need(id);
    if (this.perms.pending(id).length > 0) return 'awaiting';
    const s = this.sessions.get(id);
    if (!s) return this.errors.has(id) ? 'error' : 'idle';
    if (s.status !== 'idle') return s.status;
    // 계획 모드 답을 기다리며 쥔 내 입력 — 이미 보낸 것과 같다(답이 오면 바로 쓴다)
    if (this.planGates.has(s)) return 'working';
    // 차례 도중에 보낸 말이 안 읽힌 채 차례가 끝났다 — 곧 그 말로 새 차례가 열린다(probe17, 쉬는 틈으로 깜박이지 않게)
    if (this.midUnread(s)) return 'working';
    // 부모 차례는 끝났어도 서브에이전트가 돌면 작업 중 — 끝난 뒤 Claude 가 스스로 열 차례를 기다리는 동안도(대기로 깜박이지 않게)
    if (this.subagents.has(id) || this.autoTurns.has(id)) return 'working';
    // 엔진이 보낸 /effort 차례 중에 사람 입력이 기다리면 작업 중 — 첫 입력이 멈춘 듯 보이지 않게(멈추기도 켜진다)
    return this.effortTurn.has(s) && (this.held.get(id)?.length ?? 0) > 0 ? 'working' : 'idle';
  }

  heldInput(id: AgentId): number {
    this.need(id);
    return this.held.get(id)?.length ?? 0;
  }

  hold(id: AgentId): Hold | null {
    this.need(id);
    return this.holdView(id);
  }

  subagentsRunning(id: AgentId): string[] {
    this.need(id);
    return [...(this.subagents.get(id)?.values() ?? [])].map((sub) => sub.toolUseId);
  }

  flags(id: AgentId): { bypass: boolean; bySettings: boolean; pending: boolean } {
    return this.flagsOf(this.need(id));
  }

  private flagsOf(a: Agent): { bypass: boolean; bySettings: boolean; pending: boolean } {
    const s = this.sessions.get(a.id);
    // 살아 있는 세션이 없으면 다음에 띄울 때의 모드를 알린다 — ensure() 가 첫 입력 전에 적용하니 사실과 같다
    // (세션 없이는 읽은 모드가 없어서, 저장된 켜짐이 꺼짐으로 보여 스위치가 갇히던 것)
    if (!s) return { ...this.nextMode(a), pending: false };
    const recorded = this.modes.get(s);
    // 막 띄운 세션 — 띄울 때 보낸 켜기의 답이 오기 전엔 다음 모드 그대로(세션이 없을 때 알린 값과 같다: 스냅샷을 다시 받아도 스위치가 꺼졌다 켜지지 않게)
    if (recorded === undefined && this.modeApplying.has(s)) return { ...this.nextMode(a), pending: false };
    // 원인 = 그 세션이 읽은 내 Claude 설정의 기본 모드(get_settings — 세션이 bypass 여도 내 설정 값 그대로, probe12). 아직이면 그 에이전트가 전에 읽은 값.
    // 두레가 켠 채 남은 bypass 는 내 설정 탓이 아니라 잠그지 않는다(다시 끌 수 있게).
    // 둘 다 모르면 두레 스위치로 가른다 — 허용이 꺼진 채 남은 bypassOn 은 끈 것으로 친다
    const settings = this.settingsDefaults.get(s) ?? this.settingsDefaultOf.get(a.id);
    const on = this.allow && !!a.bypassOn;
    // 아직 모드를 알리지 않은 세션은 내 기본 모드로 시작한다(probe10)
    const bypass = recorded !== undefined ? recorded === BYPASS_MODE : settings === BYPASS_MODE;
    // 켜려고 다시 띄우기를 기다리는 중 — 옵션 없이 뜬 세션이라 실제 모드는 아직 그대로(끄기 실패 뒤의 다시 띄우기는 옵션으로 뜬 세션이라 빠진다)
    const pending = this.restartWant.has(s) && !this.optioned.has(s) && on;
    return { bypass, bySettings: bypass && (settings !== undefined ? settings === BYPASS_MODE : !on), pending };
  }

  /**
   * 다음에 띄울 때의 모드 — 사용자가 켰으면(허용 + 스위치) 띄울 때 켜고, 아니면 내 Claude 설정의 기본 모드(그 에이전트가 마지막으로 읽은 값)로
   * 시작한다. 원인은 두레 스위치가 켜져 있으면 두레(끌 수 있게), 아니면 내 설정
   */
  private nextMode(a: Agent): { bypass: boolean; bySettings: boolean } {
    // 계획 모드였던 에이전트는 띄운 뒤 계획 모드로 맞춘다(ensure — bypass 는 계획을 승인하거나 끈 뒤로 미룬다)
    if (this.planWant.has(a.id)) return { bypass: false, bySettings: false };
    const on = this.allow && !!a.bypassOn;
    const mine = this.settingsDefaultOf.get(a.id) === BYPASS_MODE;
    return { bypass: on || mine, bySettings: mine && !on };
  }

  errorText(id: AgentId): string | null {
    this.need(id);
    const s = this.sessions.get(id);
    if (s?.status === 'error') return s.errorText;
    return this.errors.get(id) ?? null;
  }

  // ── 미리 띄우기 ──
  setSelected(id: AgentId | null) {
    if (this.closed) return;
    const prev = this.selected;
    this.selected = id;
    if (prev && prev !== id) {
      this.armCool(prev);
      // 고르지 않게 된 순간이 마지막 활동 — 패널에서 보고 있던 동안은 재우지 않았으니, 그때부터 다시 잰다
      const left = this.sessions.get(prev);
      if (left) this.lastActive.set(left, performance.now());
    }
    if (!id) return;
    if (prev !== id) this.handSlept.delete(id); // 다른 에이전트를 골랐다가 돌아왔다 — 손으로 재운 에이전트도 다시 미리 띄운다
    this.disarmCool(id);
    this.prewarm(id);
  }

  /**
   * 고른 에이전트에 세션이 없으면 미리 띄운다 — 오류로 멈춘 에이전트는 고르기만으로 띄우지 않는다. 손으로 재운 에이전트도 띄우지 않는다
   * (고른 카드를 다시 눌러도 setSelected 가 다시 온다 — 재우자마자 깨우지 않게). 던지지 않는다
   */
  private prewarm(id: AgentId): void {
    if (this.closed || this.selected !== id || !this.store.agent(id) || this.removing.has(id) || this.sessions.has(id) || this.errors.has(id)) return;
    if (this.handSlept.has(id)) return;
    try {
      this.prewarmed.add(this.ensure(id));
    } catch {
      /* 폴더 없음 — ensure 가 오류 상태를 남겼다(보낼 때와 같다) */
    }
  }

  /** 고르지 않게 된 에이전트 — 미리 띄운 뒤 아무 줄도 안 받은 세션이면 끄기를 잰다(울릴 때의 세션을 본다 — 그새 다시 띄웠어도) */
  private armCool(id: AgentId): void {
    const s = this.sessions.get(id);
    if (!s || !this.prewarmed.has(s) || this.coolTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.coolTimers.delete(id);
      const cur = this.sessions.get(id);
      if (!cur) return;
      void this.cool(id, cur).catch((e) => this.guard(id, () => this.emit('engine-error', { agentId: id, message: e instanceof Error ? e.message : String(e) })));
    }, this.o.prewarmIdleMs ?? PREWARM_IDLE_MS);
    timer.unref?.();
    this.coolTimers.set(id, timer);
  }

  private disarmCool(id: AgentId): void {
    const timer = this.coolTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.coolTimers.delete(id);
  }

  /**
   * 그 세션이 아직 미리 띄운 그대로(고르지 않음·줄 없음·쉬는 중·기다리는 입력 없음)면 끈다 — 다음에 고르거나 보낼 때 다시 띄운다.
   * 쉬지 않는 중(띄울 때의 /effort 차례 등)이면 다시 잰다
   */
  private async cool(id: AgentId, s: ClaudeSession): Promise<void> {
    if (this.closed || this.selected === id || !this.live(id, s) || !this.prewarmed.has(s)) return;
    if (!this.resting(id, s) || (this.held.get(id)?.length ?? 0) > 0 || this.subagents.has(id)) {
      this.armCool(id);
      return;
    }
    await this.endSession(id);
    this.emitStatus(id);
  }

  // ── 재우기 ──
  sleepState(id: AgentId): { asleep: boolean; waking: boolean } {
    this.need(id);
    return this.sleepOf(id);
  }

  sleepBlock(id: AgentId): SleepBlock | 'no-session' | null {
    this.need(id);
    return this.blockOf(id);
  }

  sleepableIn(roomId: RoomId): number {
    return this.store.agents(roomId).filter((a) => !this.removing.has(a.id) && this.blockOf(a.id) === null).length;
  }

  async sleep(id: AgentId): Promise<boolean> {
    this.need(id);
    const s = this.sessions.get(id);
    return !!s && this.putToSleep(id, s, true);
  }

  async sleepRoom(roomId: RoomId): Promise<number> {
    let n = 0;
    // 하나씩 — 끄는 사이 바뀐 것(일을 받음·지움)은 그 차례에 다시 본다
    for (const a of this.store.agents(roomId)) {
      if (this.removing.has(a.id) || !this.store.agent(a.id)) continue;
      if (await this.sleep(a.id)) n++;
    }
    return n;
  }

  /** 잠듦·깨우는 중 — 세션 맵에서 계산한다(한 곳). 화면엔 emitSleep 이 바뀔 때만 알린다 */
  private sleepOf(id: AgentId): { asleep: boolean; waking: boolean } {
    const s = this.sessions.get(id);
    // 오류로 멈춘 에이전트는 잠듦이 아니다 — 엔진이 끈 세션(재우기·미리 띄운 세션 끄기)·막 켠 앱만. 새 에이전트는 이어 갈 대화가 없다
    if (!s) return { asleep: !!this.store.agent(id)?.started && !this.errors.has(id) && !this.removing.has(id), waking: false };
    // 깨우는 중 = 그 세션이 아직 첫 차례의 init 전인데 일거리가 있다 — 쓴 줄을 기다리거나(엔진 상태 working), /effort·계획 모드 답 뒤에
    // 내 입력이나 전달 메시지가 기다린다(effort 를 고른 에이전트는 /effort 를 먼저 몰래 써서 세션 상태가 쉬는 채고, 메시지는 그 차례가 끝날
    // 때까지 queued 다). 붙잡힌 메시지는 사람이 고를 때까지 안 나가니 치지 않는다. 고르기로만 깨우면 쉬는 중
    return { asleep: false, waking: this.waking.has(s) && (this.status(id) === 'working' || this.hasWaitingWork(id)) };
  }

  /** 띄운 세션에 곧 쓸 것 — 기다리는 내 입력, 또는 붙잡히지 않은 전달 대기(queued) 메시지 */
  private hasWaitingWork(id: AgentId): boolean {
    if ((this.held.get(id)?.length ?? 0) > 0) return true;
    return !this.holds.has(id) && this.log.list({ to: id, states: ['queued'] }).length > 0;
  }

  /**
   * 지금 재울 수 없는 까닭 — 앞의 것부터 하나(설계 §2 의 표). 재우면 그 일이 끊기거나(차례·서브에이전트·뒤에서 도는 명령은 프로세스와 함께
   * 죽는다) 사람이 기다리는 것(답·붙잡은 입력)이 사라진다
   */
  private blockOf(id: AgentId): SleepBlock | 'no-session' | null {
    const s = this.sessions.get(id);
    if (!s) return 'no-session';
    const asking = this.perms.pending(id).length > 0; // 서브에이전트가 물은 것 포함
    // 일하는 중 — 차례가 돈다(사람 답을 기다리며 멈춘 차례는 아래 '답을 기다림' — status() 의 awaiting 과 같다), 또는 엔진이 쥔 일:
    // /effort 차례 · 차례 도중에 보낸 말이 안 읽힘 · 계획 모드 답을 기다리며 쥔 입력 · 권한 모드 때문에 다시 띄울 세션
    if (
      (s.status !== 'idle' && !asking) || this.effortTurn.has(s) || this.midUnread(s) || this.planGates.has(s) || this.planBlocked(id, s) ||
      this.restartWant.has(s)
    ) return 'working';
    if (asking) return 'asking';
    if ((this.held.get(id)?.length ?? 0) > 0 || this.holds.has(id)) return 'waiting-input';
    // 끝난 뒤 Claude 가 스스로 열 차례(보고 전달)를 기다리는 동안도 서브에이전트의 일 — 재우면 그 보고가 사라진다
    if (this.subagents.has(id) || this.autoTurns.has(id)) return 'subagents';
    // 종류를 가리지 않는다 — 끝나지 않는 dev 서버를 띄운 에이전트는 잠들지 않는다(재우면 그 서버가 함께 죽는다)
    if ((this.bgTasks.get(s)?.length ?? 0) > 0) return 'background';
    if ((this.inFlight.get(s)?.length ?? 0) > 0) return 'unread';
    return null;
  }

  /**
   * 쉬는 세션을 끈다(재우기 — 미리 띄운 세션 끄기 cool 과 같은 길). 끄기 직전에 그 세션이 아직 그 에이전트의 세션이고 재울 수 있는지 다시 본다
   * (그사이 바뀌었으면 false). 끄기는 세션을 맵에서 먼저 빼므로 끄는 사이에 온 입력·메시지는 새 세션이 받는다(ensure 가 깨운다).
   * hand: 손으로 재움 — 표는 끄기 전에 단다(끄는 사이의 같은 고르기도 띄우지 않게). 던지지 않는다(상태 알림 오류는 engine-error)
   */
  private async putToSleep(id: AgentId, s: ClaudeSession, hand = false): Promise<boolean> {
    if (this.closed || !this.live(id, s) || this.blockOf(id) !== null) return false;
    if (hand) this.handSlept.add(id);
    await this.endSession(id);
    this.guard(id, () => this.emitStatus(id)); // 상태는 그대로 idle — 잠듦만 바뀐다(emitStatus 가 함께 알린다)
    return true;
  }

  /** 1분마다 — 고른 에이전트가 아니고, 마지막 활동에서 설정 시간 이상 지났고, 재울 수 있는 세션을 재운다. 끔(0)이면 아무것도 안 한다 */
  private sweep(): void {
    if (this.closed || this.sleepMin === 0) return;
    const now = performance.now();
    const after = this.sleepMin * this.minuteMs();
    for (const [id, s] of [...this.sessions]) {
      if (this.selected === id || this.removing.has(id)) continue;
      const last = this.lastActive.get(s);
      if (last === undefined || now - last < after || this.blockOf(id) !== null) continue;
      void this.putToSleep(id, s).catch((e) =>
        this.guard(id, () => this.emit('engine-error', { agentId: id, message: e instanceof Error ? e.message : String(e) })),
      );
    }
  }

  private minuteMs(): number {
    return this.o.sleepMinuteMs ?? SLEEP_MINUTE_MS;
  }

  /** 잠듦이 바뀌었으면 알린다 — 바뀔 때만. 지우는 중·지운 에이전트엔 안 보낸다(emitStatus 와 같다), 끄는 중인 엔진도 */
  private emitSleep(id: AgentId): void {
    if (this.closed || this.removing.has(id) || !this.store.agent(id)) return;
    const now = this.sleepOf(id);
    const prev = this.shownSleep.get(id) ?? { asleep: false, waking: false };
    if (prev.asleep === now.asleep && prev.waking === now.waking) return;
    this.shownSleep.set(id, now);
    this.emit('sleep', { agentId: id, ...now });
  }

  // ── 대화 ──
  async sendUser(id: AgentId, parts: UserPart[], o?: { plan?: boolean }) {
    this.need(id);
    const before = this.sending.get(id);
    // 첨부도 없고 앞에 준비 중인 보내기도 없으면 기다림 없이 — 부른 그 자리에서(동기) 끼우거나 줄에 선다
    if (!before && noFiles(parts)) return this.deliverUser(id, parts, o, false);
    // 첨부는 맨 먼저 — 사본을 다 만든 뒤에 끼우기·줄 세우기·붙잡기. 하나라도 실패하면 만든 것을 되돌리고 던진다(아무것도 안 보냄).
    // 복사는 비동기라 그 에이전트의 보내기를 한 줄로 세운다 — 준비하는 동안 온 말(/compact 포함)은 그 뒤에(순서 그대로).
    // 앞 보내기가 실패해도 뒤 보내기는 제 차례에 간다(따로 친 말이다)
    const stopsAt = this.stops.get(id) ?? 0;
    let done!: () => void;
    const mine = new Promise<void>((r) => (done = r));
    this.sending.set(id, mine);
    // 첨부가 든 보내기는 끊을 수 있게 — 앞 차례를 기다리는 동안 끊겨도(서버 방이면 올리기 전에) 실패로 끝난다
    const cut = noFiles(parts) ? null : new AbortController();
    if (cut) this.uploadsOf(id).add(cut);
    try {
      await before;
      const ready: ReadyPart[] = noFiles(parts) ? parts : await this.prepareParts(id, parts, cut!.signal);
      // 준비하는(또는 앞을 기다리는) 사이 멈췄다 — 멈출 때 기다리던 입력처럼 붙잡는다. 멈춤이 끼운 말을 아직 돌려받는 중이면 그 끝을
      // 기다린다 — 돌려받은 말·기다리던 말이 먼저 붙잡혀야 붙잡기 목록이 보낸 차례대로다
      const stopped = (this.stops.get(id) ?? 0) !== stopsAt;
      if (stopped) await this.retracting.get(id);
      this.deliverUser(id, ready, o, stopped);
    } finally {
      if (cut) this.uploads.get(id)?.delete(cut);
      if (this.sending.get(id) === mine) this.sending.delete(id); // 마지막 차례면 빠진다 — 다음 보내기는 다시 그 자리에서
      done();
    }
  }

  private uploadsOf(id: AgentId): Set<AbortController> {
    let set = this.uploads.get(id);
    if (!set) this.uploads.set(id, (set = new Set()));
    return set;
  }

  /** 그 에이전트의 첨부 보내기를 끊는다 — 서버 방이면 올리는 ssh 를 끄고 그 보내기는 실패로(되돌림). 이 PC 방 복사는 그대로 끝난다 */
  private cancelUploads(id: AgentId): void {
    const set = this.uploads.get(id);
    if (!set) return;
    this.uploads.delete(id);
    for (const c of set) c.abort();
  }

  /**
   * 준비를 마친 사람 입력을 보낸다 — 일하는 중이면 지금 차례에 끼우고, 아니면 줄에 세운다. stopped: 준비하는 사이 멈췄다(붙잡는다).
   * 줄에 선·붙잡힌 입력엔 원본 경로가 아니라 준비된 꼴이 들어간다(원본이 사라져도 그대로 간다)
   */
  private deliverUser(id: AgentId, ready: ReadyPart[], o: { plan?: boolean } | undefined, stopped: boolean): void {
    // 아래에서 보내지도 줄에 서지도 못하고 던지면 이번에 만든 사본을 되돌린다
    const undo = (e: unknown): never => {
      this.dropPrepared(id, ready);
      throw e;
    };
    let agent: Agent;
    try {
      agent = this.need(id); // 준비하는 사이 지워졌을 수 있다
    } catch (e) {
      return undo(e);
    }
    this.router.humanInput(agent.roomId);
    if (stopped) {
      this.holdInput(id, { id: crypto.randomUUID(), parts: ready, ...(o?.plan === true ? { plan: true as const } : {}) });
      return;
    }
    // 일하는 중이면 바로 보낸다 — Claude Code 처럼 지금 차례에 끼어든다(다음 걸음에서 읽는다, probe17)
    const s = this.sessions.get(id);
    if (s && o?.plan !== true && this.canSendMid(id, s, ready)) {
      try {
        this.sendTo(id, s, ready, { kind: 'human', input: { id: crypto.randomUUID(), parts: ready }, mid: true });
      } catch (e) {
        return undo(e); // 쓰기 전에 막혔다(세션이 실행 중이 아님) — 기록도 없다
      }
      this.emitStatus(id);
      return;
    }
    const q = this.heldOf(id);
    // 계획 먼저는 그 입력에 붙여 둔다 — 차례 중이면 지금 차례를 계획 모드로 바꾸지 않고, 그 입력을 쓸 때(pump) 바꾼다
    // 붙잡힌 동안 새로 친 말도 여기로 — 붙잡기를 거치지 않고 보통처럼 나간다(사람이 지금 하는 말이 가장 급하다)
    q.push({ id: crypto.randomUUID(), parts: ready, ...(o?.plan === true ? { plan: true as const } : {}) });
    try {
      this.ensure(id);
    } catch (e) {
      q.pop();
      return undo(e);
    }
    this.emitHeld(id);
    this.pump(id); // 차례 중·승인 대기면 그대로 두고, 그 차례의 result 에서 보낸다 — 두 줄을 동시에 보내지 않는다
    this.emitStatus(id); // /effort 차례 중이면 기다리는 입력 때문에 작업 중
  }

  /**
   * 첨부를 보낼 꼴로 — 글·그림은 그대로, 파일은 차례대로 하나씩 준비한다(prepareFile — 서버 방이면 올리기까지). 하나라도 실패하면 이번에
   * 만든 사본·서버 파일을 지우고 그 파일의 오류('파일을 보내지 못했어요 — <이름>: <이유>')를 던진다. signal: 끊으면(멈춤 등) 서버 방은 실패로
   */
  private async prepareParts(id: AgentId, parts: UserPart[], signal: AbortSignal): Promise<ReadyPart[]> {
    const agent = this.need(id);
    const remote = this.remoteOf(agent);
    // 서버 방인데 ssh 가 없다 — 사본을 만들기 전에
    if (remote && !this.sshAvailable()) throw new Error(`${ATTACH_FAILED} — ${NO_SSH}`);
    const out: ReadyPart[] = [];
    try {
      for (const p of parts) out.push(p.type === 'file' ? await this.prepareFile(id, p, remote, signal) : p);
    } catch (e) {
      this.dropPrepared(id, out);
      throw e;
    }
    return out;
  }

  /**
   * 첨부 하나 — 원본이 보통 파일이고 ATTACH_MAX_BYTES 이하인지 엔진이 다시 잰 뒤(화면이 준 bytes 는 믿지 않는다) 그 에이전트의
   * 첨부 폴더로 복사한다. 원본은 읽기만 한다. Claude 에게는 사본의 절대 경로가 간다.
   * 서버 방이면 이 PC 사본(칩이 연다)을 만든 뒤 그 사본을 서버로 올린다(uploadFile) — Claude 에게는 서버의 절대 경로가 간다
   */
  private async prepareFile(id: AgentId, p: FileInput, remote: { host: string } | null, signal: AbortSignal): Promise<FileReady> {
    const shown = typeof p.name === 'string' ? firstLine(p.name) : '';
    const fail = (why: string) => new Error(`${ATTACH_FAILED} — ${shown ? `${shown}: ` : ''}${why}`);
    // 서버 방에서 이미 끊겼으면(앞 차례를 기다리는 사이 멈춤 등) 사본도 만들지 않는다
    if (remote && signal.aborted) throw fail(ATTACH_UPLOAD_STOPPED);
    if (typeof p.path !== 'string' || !path.isAbsolute(p.path)) throw fail(ATTACH_BAD_PATH);
    // 대체 데이터 스트림(`파일:스트림`, `파일::$DATA`)은 보내지 않는다 — 드라이브 글자(C:) 뒤의 ':' 는 이것뿐이고, 이름 검사도 비껴간다
    if (p.path.replace(/^[A-Za-z]:/, '').includes(':')) throw fail(ATTACH_BAD_PATH);
    // 자격 증명 파일은 읽지도 옮기지도 않는다(약관 경계) — 사용자가 골라도
    if (isCredentials(p.path)) throw fail(ATTACH_CREDENTIALS);
    // 짧은 이름(8.3)·링크로 가린 자격 증명 파일도 — 진짜 경로의 이름으로 다시 본다(fs.promises.realpath 는 realpath.native 와 같은 뜻)
    // 진짜 경로를 못 푸는 볼륨(RAM 디스크·일부 가상 FS)도 있다 — 없음·권한·잠김이 아니면 이름 검사만으로 넘어가 stat 으로 간다
    // (자격 증명 파일은 시스템 드라이브에 있어 realpath 가 늘 된다)
    let real: string | null = null;
    try {
      real = await fs.promises.realpath(p.path);
    } catch (e) {
      if (REALPATH_FATAL.has((e as NodeJS.ErrnoException | null)?.code ?? '')) throw fail(fileErrorText(e));
    }
    if (real !== null && isCredentials(real)) throw fail(ATTACH_CREDENTIALS);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(p.path);
    } catch (e) {
      throw fail(fileErrorText(e));
    }
    if (st.isDirectory()) throw fail(ATTACH_FOLDER);
    if (!st.isFile()) throw fail(ATTACH_NOT_FILE);
    if (st.size > ATTACH_MAX_BYTES) throw fail(ATTACH_TOO_BIG);
    const name = shown || path.basename(p.path);
    let copy: { file: string; abs: string };
    try {
      copy = await this.attachments.copyIn(id, p.path, name); // 비동기 — 큰·느린 원본을 복사하는 동안 main 을 막지 않는다
    } catch (e) {
      throw fail(fileErrorText(e));
    }
    // 잰 뒤 복사하는 사이 원본이 커졌을 수 있다 — 상한·기록의 크기는 사본으로
    let bytes: number;
    try {
      bytes = (await fs.promises.stat(copy.abs)).size;
    } catch (e) {
      this.dropFile(id, copy.file);
      throw fail(fileErrorText(e));
    }
    if (bytes > ATTACH_MAX_BYTES) {
      this.dropFile(id, copy.file);
      throw fail(ATTACH_TOO_BIG);
    }
    if (!remote) return { type: 'file', name, bytes, file: copy.file, sendPath: copy.abs };
    // 서버 방 — 사본을 서버로 올린다. 실패하면 이 사본을 지우고(서버에 반쯤 쓴 것도 uploadFile 이 되돌린다) 던진다
    let remotePath: string;
    try {
      remotePath = await this.uploadFile(id, remote.host, copy, signal);
    } catch (e) {
      this.dropFile(id, copy.file);
      throw fail(e instanceof Error ? e.message : String(e));
    }
    return { type: 'file', name, bytes, file: copy.file, sendPath: remotePath, remotePath };
  }

  /**
   * 이 PC 사본 하나를 서버 첨부 폴더로(uploadScript — 바이트는 ssh stdin, 상한 uploadTimeoutMs). 되면 서버 절대 경로
   * (`<DURE_HOME>/.dure/attachments/<에이전트>/<사본 이름>`). 안 되면 쉬운 까닭으로 던진다(ssh·서버의 영어 원문·경로는 싣지 않는다) —
   * 서버에 반쯤 썼을 수 있으면(끊김·끊음·시간 넘김·서버 명령 실패) 그 파일 지우기를 그 에이전트의 서버 줄에 세운다
   * (접속도 못 했거나 ssh 를 못 띄웠거나 이 PC 사본을 못 읽었으면 지우러 가지 않는다)
   */
  private async uploadFile(id: AgentId, host: string, copy: { file: string; abs: string }, signal: AbortSignal): Promise<string> {
    // 앞서 세운 되돌리기(서버 파일 지우기)가 끝난 뒤에 — 같은 이름으로 다시 올린 파일을 늦게 온 지우기가 지우지 않게.
    // 끊기면(멈춤·새 대화·지우기·끄기) 그 줄을 기다리지 않는다 — 앞선 정리가 느린·내려간 서버에서 수십 초 걸릴 수 있다
    await untilAborted(this.remoteChain.get(id), signal);
    if (signal.aborted) throw new Error(ATTACH_UPLOAD_STOPPED);
    const r = await this.sshUpload(host, uploadScript(id, copy.file), copy.abs, this.o.uploadTimeoutMs ?? UPLOAD_MS, signal);
    if (r.spawnFailed) throw new Error(attachSshSpawnText(r.spawnFailed.code)); // ssh 가 돌지 않았다 — 서버에 쓴 것이 없다
    const undo = () => this.dropRemote(id, [copy.file]);
    if (signal.aborted) {
      undo();
      throw new Error(ATTACH_UPLOAD_STOPPED);
    }
    if (r.readFailed) throw new Error(attachCopyReadText(r.readFailed.code));
    if (r.timedOut) {
      undo();
      throw new Error(ATTACH_UPLOAD_SLOW);
    }
    if (r.code !== 0) {
      const issue = classifyUploadExit(r.code, r.stderr);
      if (issue) {
        if (issue.kind === 'disconnected') undo(); // 도중에 끊겼다 — 반쯤 쓴 파일이 남았을 수 있다
        throw new Error(remoteIssueText(host, issue));
      }
      undo(); // 서버에서 명령이 돌았다(디스크 가득 등) — 반쯤 쓴 파일
      throw new Error(uploadWriteText(r.code, r.stderr));
    }
    const home = parseUploadHome(r.stdout);
    if (!home) {
      undo();
      throw new Error(ATTACH_UPLOAD_NO_HOME);
    }
    return `${home.replace(/\/+$/, '')}/.dure/attachments/${id}/${copy.file}`;
  }

  /**
   * 올리기 ssh 한 번 — 확인·정리와 같은 옵션(runArgs: 전달 없음·BatchMode·RemoteCommand=none, bash -c — 셸 시작 파일을 읽지 않는다),
   * 파일은 스트림으로 stdin 에(명령 인자에 싣지 않는다 — 크기와 상관없이 메모리에 다 올리지 않는다). 시간을 넘기거나 끊으면(signal) ssh 를
   * 나무째 끄고(ProxyJump·ProxyCommand 의 자식 ssh 가 같은 파이프를 쥐면 'close' 가 늦다) code null(timedOut 이면 시간 넘김).
   * ssh 가 없으면 NO_SSH 로 던진다 · 그 밖의 이유로 못 띄우면 spawnFailed · 사본을 못 읽어 껐으면 readFailed(둘 다 오류 코드만).
   * 끝나기 전에 사본 읽기를 닫는다(되돌릴 때 지울 수 있게)
   */
  private sshUpload(host: string, script: string, srcPath: string, timeoutMs = UPLOAD_MS, signal?: AbortSignal): Promise<UploadRun> {
    const ssh = this.o.ssh;
    if (!ssh || !this.sshAvailable()) return Promise.reject(new Error(NO_SSH));
    const args = [...(ssh.argsPrefix ?? []), ...runArgs({ host, script, login: false })];
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(ssh.command, args, { windowsHide: true, env: { ...process.env, ...this.o.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        // 실행 파일이 아니다(EFTYPE) 등 — 원문엔 내 PC 의 ssh 경로가 실린다
        if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') reject(new Error(NO_SSH));
        else resolve({ code: null, stdout: '', stderr: '', spawnFailed: { code: errCode(e) } });
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let readFailed: { code: string | null } | null = null;
      let settled = false;
      let killing = false;
      /** 나무째(taskkill /T /F) — 다 끈 뒤 그 ssh 를 한 번 더(이미 끝났으면 아무 일 없음) */
      const kill = () => {
        if (killing || child.pid === undefined) return;
        killing = true;
        void killTree(child.pid).then(() => {
          try {
            child.kill();
          } catch {
            // 이미 끝났다
          }
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) kill();
      child.stdout!.setEncoding('utf8').on('data', (d: string) => (stdout = (stdout + d).slice(-UPLOAD_OUT_KEEP)));
      child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-UPLOAD_OUT_KEEP)));
      const input = fs.createReadStream(srcPath);
      const inputClosed = new Promise<void>((r) => input.once('close', () => r()));
      // 사본을 못 읽으면 ssh 를 끈다 — stdin 이 닫히면 서버 cat 은 반쯤 받은 것으로 끝나 DURE_HOME 까지 찍는다(완성으로 치지 않게)
      input.on('error', (e) => {
        readFailed = { code: errCode(e) };
        kill();
      });
      // ssh 가 먼저 끝나면(접속 실패 등) stdin 쓰기가 EPIPE·EOF(윈도우) — 오류는 버리고 종료 코드로 가른다
      child.stdin!.on('error', () => {});
      pipeline(input, child.stdin!, () => {});
      /** 한 번만 — 사본 읽기를 닫은 뒤에 알린다(되돌릴 때 그 사본을 지울 수 있게) */
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        input.destroy();
        void inputClosed.then(fn);
      };
      // 띄우지도 못했다(pid 없음) — 'close' 가 오지 않을 수 있다
      child.on('error', (e: NodeJS.ErrnoException) => {
        if (child.pid !== undefined) return;
        settle(() => (e.code === 'ENOENT' ? reject(new Error(NO_SSH)) : resolve({ code: null, stdout, stderr, spawnFailed: { code: errCode(e) } })));
      });
      child.on('close', (code) =>
        settle(() =>
          resolve({
            code: timedOut || readFailed || signal?.aborted ? null : code,
            stdout,
            stderr,
            ...(timedOut ? { timedOut: true as const } : {}),
            ...(readFailed ? { readFailed } : {}),
          }),
        ),
      );
    });
  }

  /** 서버에 올린(또는 반쯤 쓴) 첨부를 지운다 — 그 에이전트의 서버 줄에(다음 올리기·띄우기가 기다린다). 실패는 기록만 */
  private dropRemote(id: AgentId, files: string[]): void {
    if (files.length === 0) return;
    const agent = this.store.agent(id);
    const remote = agent && this.remoteOf(agent);
    if (!remote) return; // 지운 에이전트 — 서버 첨부 폴더째 지운다(removeAgent)
    let script: string;
    try {
      script = attachmentRemoveScript(id, files);
    } catch {
      return; // 사본 이름 모양이 아니다 — 올리지도 않았다
    }
    this.queueRemoteAttachments(id, remote.host, script);
  }

  /**
   * 서버 첨부 지우기 한 번(별도 ssh, bash -c, 상한 REMOTE_CHECK_MS) — 그 에이전트의 서버 줄 끝에(shutdown 이 상한 안에서 기다린다).
   * 다시 하지 않는다 — 실패는 engine-error 로 기록만(남는 건 그 사용자만 읽는 파일, 에이전트를 지울 때 폴더째 지운다)
   */
  private queueRemoteAttachments(id: AgentId, host: string, script: string): void {
    void this.queueRemote(id, async () => {
      let r: SshRun | null = null;
      try {
        r = await this.sshRun(host, script, { login: false });
      } catch {
        /* ssh 없음 — 실패로 친다 */
      }
      if (r?.code !== 0) this.guard(id, () => this.emit('engine-error', { agentId: id, message: ATTACH_REMOTE_LEFT }));
    });
  }

  /**
   * 지운 에이전트의 서버 첨부 폴더를 통째로(attachmentsCleanupScript — 별도 ssh, bash -c) — 그 에이전트의 서버 줄 끝에. 되면 기다리는 첨부
   * 정리 목록에서 뺀다. 안 되면 목록에 남겨(다음에 켤 때 다시) engine-error 한 번(main 이 기록) — 지금 다시 하지 않는다. 던지지 않는다
   */
  private queueAttachmentsCleanup(id: AgentId, host: string): void {
    void this.queueRemote(id, async () => {
      let r: SshRun | null = null;
      try {
        r = await this.sshRun(host, attachmentsCleanupScript(id), { login: false });
      } catch {
        /* ssh 없음 — 실패로 친다 */
      }
      if (this.finished) return; // 끈 뒤에 끝났다 — 목록은 그대로(다음에 켤 때 다시)
      if (r?.code === 0) this.guard(id, () => this.store.dropPendingAttachmentCleanup(id));
      else this.guard(id, () => this.emit('engine-error', { agentId: id, message: ATTACH_REMOTE_FOLDER_LEFT }));
    });
  }

  /**
   * 준비한 첨부를 되돌린다(보내지도 줄에 서지도 못했다) — 이 PC 사본과 서버에 올린 것을 지운다(서버는 줄에 세워 — 실패는 기록만).
   * 그새 에이전트가 지워졌으면 이 PC 첨부 폴더째(서버 폴더는 지우기가 통째로)
   */
  private dropPrepared(id: AgentId, parts: ReadyPart[]): void {
    for (const p of parts) if (p.type === 'file') this.dropFile(id, p.file);
    this.dropRemote(id, uploadedOf(parts));
    if (!this.store.agent(id)) this.removeAttachments(id);
  }

  private dropFile(id: AgentId, file: string): void {
    try {
      this.attachments.removeFile(id, file);
    } catch {
      // 못 지운 사본은 에이전트를 지울 때 폴더째 지워진다 — 보내기 실패의 까닭을 가리지 않는다
    }
  }

  /**
   * 버린 내 입력의 첨부 사본(서버 방이면 서버에 올린 것도) — Claude 에게 한 번도 쓰지 않은(기록에 없는) 입력만.
   * 돌려받은 말은 이미 기록에 있다(칩이 그 사본을 쓰고, Claude 의 기억이 그 서버 경로를 안다)
   */
  private dropUnsent(id: AgentId, input: HeldInput): void {
    if (this.written.has(input)) return;
    for (const p of input.parts) if (p.type === 'file') this.dropFile(id, p.file);
    this.dropRemote(id, uploadedOf(input.parts));
  }

  /** 그 에이전트의 첨부 폴더를 지운다 — 못 지우면(잠김) 쉬운 말로 알린다(오류 원문엔 영어·내 PC 경로가 실린다). 남은 것은 켤 때 prune */
  private removeAttachments(id: AgentId): void {
    try {
      this.attachments.remove(id);
    } catch {
      this.guard(id, () => this.emit('engine-error', { agentId: id, message: ATTACH_LEFT }));
    }
  }

  async interrupt(id: AgentId) {
    this.need(id);
    // 첨부를 준비하는(또는 그 뒤에 기다리는) 보내기는 멈춘 뒤에 줄에 서지 않고 붙잡힌다(sendUser 가 이 수를 견준다).
    // 서버 방에서 아직 다 올리지 못한 보내기는 올리기를 끊고 실패로 끝낸다(몇 분짜리 올리기를 멈춤이 기다리지 않는다 — 되돌림)
    this.stops.set(id, (this.stops.get(id) ?? 0) + 1);
    this.cancelUploads(id);
    // 계획 모드 답을 기다리며 쥔 입력도 기다리던 것 — 줄 맨 앞으로 돌려놓아 아래에서 함께 붙잡는다(늦게 온 답이 쓰지 않게)
    const gated = this.ungate(id, this.sessions.get(id));
    const live = this.sessions.get(id);
    // 끼워 넣은 말을 Claude 가 아직 안 읽었다 — 그 말로 새 차례가 열리지 않게 돌려받아 붙잡는다.
    // 그동안 준비를 마친 첨부 입력은 이 끝을 기다렸다 붙잡힌다(sendUser — 붙잡기 목록이 보낸 차례대로)
    if (live && this.midUnread(live) && !this.effortTurn.has(live)) {
      const p = this.stopRetracting(id, live);
      const settled = p.then(
        () => undefined,
        () => undefined,
      );
      this.retracting.set(id, settled);
      void settled.then(() => {
        if (this.retracting.get(id) === settled) this.retracting.delete(id);
      });
      return p;
    }
    const hadInput = (this.held.get(id)?.length ?? 0) > 0; // 아래 /effort 다시 띄우기의 근거 — 붙잡으면 줄이 빈다
    // 멈춤 = 하던 일 끊기 + 대기열 붙잡기. 승인 카드를 치우기 전에 붙잡는다 — 치우면 pump 가 돌아 기다리던 것을 보낼 수 있다
    this.holdQueue(id);
    this.perms.cancelForAgent(id, STOPPED_BY_USER);
    // 멈춤 = 그만 — 계획 모드였으면 평소 모드로(떠 있던 계획 요청은 위에서 거절로 치웠다). 멈추기 제어 요청보다 먼저 쓴다.
    // 세션이 없으면 바라는 값만 · 아래에서 다시 띄우면 계획 모드 없이(바라는 값은 여기서 거둔다)
    const leaving = this.leavePlan(id);
    const s = this.sessions.get(id);
    if (!s) return leaving;
    // 엔진이 보낸 /effort 차례 중 — 기다리는 사람 입력이 있었으면(화면엔 작업 중이었다 — 이제 붙잡혔다) 그 /effort 를 끊으려 다시 띄운다
    // (답 없음과 같은 길 — 붙잡힌 것은 이어서 보내기를 고르면 새 세션으로). 없으면(남은 승인 카드만 멈춤) 카드만 치우고 그 /effort 는 그대로 끝나게 둔다
    if (this.effortTurn.has(s)) {
      if (hadInput) return this.restartAfterEffort(id, s, 'interrupt');
      return leaving;
    }
    // 부모 차례와 도는 서브에이전트 모두(spec §4.6) — 서브에이전트만 돌아도 interrupt 하나로 멈춘다(끝 알림 stopped, probe14 C)
    const wasWorking = s.status === 'working' || this.subagents.has(id) || gated;
    await this.sendInterrupt(s);
    await leaving;
    if (wasWorking) this.guard(id, () => this.record(id, { kind: 'notice', text: STOPPED_NOTICE }));
  }

  /**
   * 일하는 중 끼워 넣은 말을 Claude 가 아직 안 읽은 채 멈춘다 — interrupt 만 보내면 Claude 가 그 말로 곧바로 새 차례를 연다(probe17).
   * 이미 claude 안에 들어간 말을 돌려받는 길은 claude 를 내리는 것뿐이고, 안 읽은 말은 대화 기록에 안 남는다 — --resume 하면 그대로 이어진다(probe20).
   * 내리면 못 읽은 줄이 돌아온다(restoreInFlight — 내 말은 기다리는 줄 맨 앞, 메시지는 queued) → 기다리던 것과 함께 붙잡는다.
   * 그다음 --resume 으로 다시 띄워 둔다 — 잠듦으로 보이지 않고 이어서 보낼 때 깨우는 시간이 없다. 붙잡은 것은 이어서 보내기 전엔 안 나간다
   */
  private async stopRetracting(id: AgentId, s: ClaudeSession): Promise<void> {
    this.perms.cancelForAgent(id, STOPPED_BY_USER);
    const unread = this.inFlight.get(s)?.filter((x) => x.mid).length ?? 0;
    await this.endSession(id, { now: true });
    this.holdQueue(id);
    await this.leavePlan(id); // 세션이 없으니 바라는 값만 거둔다 — 다시 띄울 때 계획 모드 없이
    this.guard(id, () => this.record(id, { kind: 'notice', text: stoppedHeldNotice(unread) }));
    try {
      this.ensure(id, { quiet: true });
    } catch {
      // 폴더 없음 등 — ensure 가 오류 상태를 남겼다(붙잡은 것은 이어서 보내기를 고르면 그때)
    }
    this.emitStatus(id); // 다시 띄운 뒤에 — 잠듦도 함께 견준다(먼저 알리면 '잠듦'으로 남는다)
  }

  resumeHold(id: AgentId): void {
    this.need(id);
    const h = this.holds.get(id);
    if (!h) return;
    this.holds.delete(id);
    // 내 입력은 기다리는 줄 끝으로(붙잡힌 동안 새로 친 말이 앞선다). 메시지는 queued 그대로 — 내 입력이 다 나간 뒤 pump → onIdle 이 꺼낸다
    const inputs = h.entries.flatMap((e) => (e.input ? [e.input] : []));
    if (inputs.length > 0) {
      this.heldOf(id).push(...inputs);
      this.emitHeld(id);
    }
    this.emitHold(id);
    // 붙잡기는 비지 않는다(다 빠지면 풀린다) — 보낼 것이 있으니 세션이 없으면 띄운다(계획 먼저 입력이 맨 앞이면 띄울 때 계획 모드로)
    if (!this.sessions.has(id)) {
      try {
        this.ensure(id, { quiet: true });
      } catch {
        return; // 폴더 없음 등 — ensure 가 status error·errorText 를 남겼다(기다리는 것은 다음 실행에)
      }
    }
    this.pump(id); // 차례 중·승인 대기면 그 차례의 result 에서
    this.emitStatus(id);
  }

  dropHoldItem(id: AgentId, itemId: string): void {
    this.need(id);
    const entry = this.holds.get(id)?.entries.find((e) => e.item.id === itemId);
    if (!entry) return;
    // 메시지는 '버림'으로 — 그 message 사건에서 목록에서 빠진다(noteHoldMessage). 내 입력은 그냥 버린다(안 간 입력의 첨부 사본도)
    if (!entry.input) this.router.dismiss(itemId);
    else this.dropUnsent(id, entry.input);
    this.unhold(id, entry);
  }

  dropHold(id: AgentId): void {
    this.need(id);
    const h = this.holds.get(id);
    if (!h) return;
    // 먼저 푼다 — 버리는 메시지가 목록에서 하나씩 빠지며 알리지 않게(풀림은 한 번)
    this.holds.delete(id);
    for (const e of h.entries) {
      if (!e.input) this.guard(id, () => this.router.dismiss(e.item.id));
      else this.dropUnsent(id, e.input);
    }
    this.emitHold(id);
  }

  async newConversation(id: AgentId) {
    const agent = this.need(id);
    // 서버로 올리는 중인 첨부 — 멈춤처럼 끊고 되돌린다(준비 중이던 입력이 새 대화로 흘러가지 않게)
    this.cancelUploads(id);
    // 새 대화는 계획 모드를 끈 채로 — 끝내는 세션의 모드는 세션과 함께 사라진다(세션 끝 정리가 알린다)
    this.wantPlan(id, false);
    this.handSlept.delete(id); // 사람이 새 대화를 골랐다 — 손으로 재운 표를 풀어 고른 에이전트면 새 대화로 미리 띄운다
    const ended = agent.started ? agent.sessionId : null; // 한 마디라도 한 대화만 — 돌아갈 대화가 있다
    const ending = this.endSession(id);
    this.guard(id, () => this.record(id, ended ? { kind: 'boundary', ended } : { kind: 'boundary' }));
    // 첫 실행 전인 갈래도 새 대화는 갈래 치지 않는다
    this.store.updateAgent(id, { sessionId: crypto.randomUUID(), started: false, forkOf: null });
    this.guard(id, () => this.setContext(id, null));
    this.emitStatus(id);
    await ending;
    // 끝낸 세션이 못 읽었거나 기다리던 사람 입력은 새 대화로 보낸다 — 두면 사람이 다시 칠 때까지 멈춰 있고 메시지도 쌓인다.
    // 없으면 고른 에이전트만 새 대화로 미리 띄운다(새 대화 다음엔 곧 입력이 온다)
    if ((this.held.get(id)?.length ?? 0) === 0) {
      this.prewarm(id);
      return;
    }
    try {
      this.ensure(id);
    } catch {
      return; // 폴더 없음 등 — ensure 가 status error·errorText 를 남겼다
    }
    this.pump(id);
  }

  async resumeConversation(id: AgentId, key: string) {
    const agent = this.need(id);
    const target = (await this.conversations(id)).find((c) => c.key === key && !c.current);
    if (!target) throw new Error(NO_CONVERSATION);
    const block = this.resumeBlock(id);
    if (block) throw new Error(RESUME_BLOCKED[block]);
    if (target.why) throw new Error(pastWhyText(target.why, target.at, Date.now()));
    // 새 대화와 같은 길 — 계획 모드는 끈 채로, 손으로 재운 표는 풀어 고른 에이전트면 돌아간 대화로 미리 띄운다
    this.wantPlan(id, false);
    this.handSlept.delete(id);
    const ended = agent.started ? agent.sessionId : null; // 한 마디라도 한 대화만 — 다시 돌아올 수 있게
    const ending = this.endSession(id);
    this.guard(id, () => this.record(id, ended ? { kind: 'boundary', ended, resumed: key } : { kind: 'boundary', resumed: key }));
    this.guard(id, () => this.record(id, { kind: 'notice', text: RESUMED_NOTICE }));
    this.store.updateAgent(id, { sessionId: key, started: true, forkOf: null });
    this.forgetPastCount(id); // 경계를 남길 때 버렸지만 그 history 사건을 듣는 쪽이 옛 세션으로 다시 셌을 수 있다
    this.guard(id, () => this.setContext(id, null));
    this.emitStatus(id);
    await ending;
    this.prewarm(id);
  }

  async forkAgent(i: { from: AgentId; key: string; name: string; role: string }): Promise<Agent> {
    const src = this.need(i.from);
    const target = (await this.conversations(i.from)).find((c) => c.key === i.key && !c.current);
    if (!target) throw new Error(NO_CONVERSATION);
    if (target.why) throw new Error(pastWhyText(target.why, target.at, Date.now()));
    const conv = this.splitOf(i.from).find((c) => c.key === i.key)!;
    const added = this.store.addAgent({ roomId: src.roomId, name: i.name, role: i.role, folder: src.folder });
    // 자동·묻지 않음·늘 허용은 새 에이전트 기본값(addAgent) 그대로
    const agent = this.store.updateAgent(added.id, { model: src.model, effort: src.effort, forkOf: conv.sessionId });
    // 기록은 쓰기만 — 사건은 없다(화면이 더한 에이전트와 같다). 줄은 시각 그대로, 경계 없이
    for (const it of conv.items) this.guard(agent.id, () => this.hist.append(agent.id, this.forkedItem(i.from, agent.id, it)));
    this.guard(agent.id, () => this.hist.append(agent.id, { t: Date.now(), kind: 'notice', text: forkedNotice(src.name, target.at) }));
    return agent;
  }

  /**
   * 갈래로 옮길 기록 한 줄 — 사람이 보낸 그림은 새 에이전트 칸으로 복사, 복사 못 한 그림은 file 을 뺀다(크기·형식은 그대로).
   * 첨부도 이 PC 사본을 새 에이전트 첨부 폴더로 같은 이름에 복사한다 — 기록의 file 은 이제 새 폴더의 사본(못 하면 칩은 남고 열 때 없다고 한다).
   * 서버 파일은 다시 올리지 않는다(remotePath 그대로 — Claude 의 기억 속 경로는 원래 에이전트의 첨부)
   */
  private forkedItem(from: AgentId, to: AgentId, it: HistoryItem): HistoryItem {
    if (it.kind !== 'user' || !it.parts.some((p) => (p.type === 'image' && p.file) || p.type === 'file')) return it;
    const parts = it.parts.map((p): HistoryPart => {
      if (p.type === 'file') {
        try {
          this.attachments.copy(from, to, p.file);
        } catch {
          // 디스크가 막혀도 갈래는 만든다 — 그 첨부만 다시 열 수 없다
        }
        return p;
      }
      if (p.type !== 'image' || !p.file) return p;
      try {
        if (this.images.copy(from, to, p.file)) return p;
      } catch {
        // 디스크가 막혀도 갈래는 만든다 — 그 그림만 다시 볼 수 없다
      }
      const { file: _file, ...rest } = p;
      return rest;
    });
    return { ...it, parts };
  }

  /**
   * 돌아가기를 막는 까닭 — 보내는 중(첨부를 복사·올리는 보내기 차례, 방 종류와 상관없이)이면 먼저, 그다음 재울 수 없는 까닭(blockOf)과 같다.
   * 세션이 없어도 기다리는·붙잡은 입력이 있으면 막는다
   */
  private resumeBlock(id: AgentId): SleepBlock | 'sending' | null {
    if (this.sending.has(id)) return 'sending';
    const block = this.blockOf(id);
    if (block !== 'no-session') return block;
    return (this.held.get(id)?.length ?? 0) > 0 || this.holds.has(id) ? 'waiting-input' : null;
  }

  async setModel(id: AgentId, model: string | null) {
    this.need(id);
    this.store.updateAgent(id, { model });
    this.effortBroken.delete(id); // 모델이 바뀌었다 — /effort 를 다시 해 본다
    this.guard(id, () => this.setModelNow(id, null)); // 다음 차례가 풀 모델은 다르다
    this.guard(id, () => this.forgetEffortNow(id)); // 모델이 바뀌면 지금 effort 도 다시 읽을 때까지 모른다
    const s = this.sessions.get(id);
    if (!s) return;
    await s.request({ subtype: 'set_model', model: model ?? 'default' });
    // 세션 effort 가 새 모델로 이어지는지 모른다 — 고른 값이 있으면 다시 보낸다(해롭지 않다), 없으면 내 설정을 다시 읽는다
    if (this.live(id, s)) this.applyEffort(id, s);
  }

  private setModelNow(id: AgentId, value: string | null) {
    if (this.removing.has(id) || !this.store.agent(id)) return;
    if ((this.modelNows.get(id) ?? null) === value) return;
    if (value === null) this.modelNows.delete(id);
    else this.modelNows.set(id, value);
    this.emit('model-now', { agentId: id, modelNow: value });
  }

  async setEffort(id: AgentId, level: EffortLevel) {
    this.need(id);
    if (!(EFFORT_LEVELS as readonly unknown[]).includes(level)) throw new Error(EFFORT_UNKNOWN);
    this.store.updateAgent(id, { effort: level });
    this.effortBroken.delete(id); // 새로 골랐다 — /effort 를 다시 해 본다
    // 전에 읽은 지금 값은 버린다 — 남겨 두면 화면이 새로 고른 값 대신 옛 값으로 돌아간다(/effort 의 답이 채운다)
    this.effortNows.delete(id);
    this.emitEffort(id);
    const s = this.sessions.get(id);
    if (s) this.applyEffort(id, s);
  }

  /** 늘 허용에서 그 도구를 뺀다 — 다음 요청부터 다시 묻는다. 없는 도구면 그대로(사건 없음). 바뀌면 'always-allow' */
  revokeAlwaysAllow(id: AgentId, toolName: string): Agent {
    const a = this.need(id);
    if (!a.alwaysAllow.includes(toolName)) return a;
    const next = this.store.updateAgent(id, { alwaysAllow: a.alwaysAllow.filter((t) => t !== toolName) });
    this.guard(id, () => this.emit('always-allow', { agentId: id, alwaysAllow: [...next.alwaysAllow] }));
    return next;
  }

  async setBypass(id: AgentId, on: boolean) {
    this.need(id);
    if (typeof on !== 'boolean') throw new Error(BYPASS_VALUE_INVALID);
    if (on && !this.allow) throw new Error(BYPASS_NOT_ALLOWED);
    this.store.updateAgent(id, { bypassOn: on });
    this.emitFlags(id);
    await this.applyBypass(id, on);
  }

  planMode(id: AgentId): boolean {
    this.need(id);
    return this.planModeOf(id);
  }

  async setPlanMode(id: AgentId, on: boolean) {
    this.need(id);
    if (typeof on !== 'boolean') throw new Error(BYPASS_VALUE_INVALID);
    if (!on) return this.leavePlan(id);
    const s = this.sessions.get(id);
    if (!s) {
      this.wantPlan(id, true); // 다음에 띄울 때 맞춘다
      return;
    }
    if (!this.inPlan(id, s)) await this.enterPlan(id, s);
  }

  modelNow(id: AgentId): string | null {
    return this.modelNows.get(id) ?? null;
  }

  effortNow(id: AgentId): EffortLevel | null {
    return this.effortNows.get(id) ?? null;
  }

  describe(id: AgentId): Promise<AgentDescription> {
    try {
      this.need(id);
      const s = this.ensure(id);
      let p = this.described.get(s);
      if (!p) {
        p = s.request({ subtype: 'initialize' }).then(toDescription);
        this.described.set(s, p);
        p.catch(() => this.described.delete(s));
      }
      return p;
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // ── 메시지·승인 ──
  history(id: AgentId, o: { all?: boolean; limit?: number } = {}): HistoryItem[] {
    this.need(id);
    if (o.all) return this.hist.read(id, { sinceBoundary: false, limit: o.limit ?? Infinity });
    // 지금 대화 = 지금 세션의 모든 구간(돌아간 대화는 경계 앞에도 이어진다)
    const sid = this.store.agent(id)?.sessionId ?? '';
    const all = this.hist.read(id, { sinceBoundary: false, limit: Infinity });
    const cur = splitConversations(all, sid).find((c) => c.key === sid);
    return cur ? lastN(cur.items, o.limit ?? 500) : [];
  }
  /** 기록을 대화로 나눈다 — 세션 id 를 모르는 지금 세션은 '' */
  private splitOf(id: AgentId): Conversation[] {
    const sid = this.store.agent(id)?.sessionId ?? '';
    return splitConversations(this.hist.read(id, { sinceBoundary: false, limit: Infinity }), sid);
  }
  /** 넘겨받은 말의 보낸 쪽 — 메시지 기록의 from 에이전트의 지금 이름(없으면 null) */
  private senderNameOf(messageId: string): string | null {
    const from = this.log.get(messageId)?.from;
    return from ? this.store.agent(from)?.name ?? null : null;
  }
  async conversations(id: AgentId): Promise<ConversationSummary[]> {
    const agent = this.need(id);
    const cur = agent.sessionId;
    const rows = this.splitOf(id).flatMap((c) => {
      const f = conversationFacts(c, (m) => this.senderNameOf(m));
      return f ? [{ c, f }] : [];
    });
    const past = rows.filter((r) => r.c.key !== cur && r.c.sessionId);
    const alive = await this.aliveSessions(agent, past.map((r) => r.c.sessionId!));
    return rows
      .map(({ c, f }): ConversationSummary => {
        const current = c.key === cur;
        const why = current ? null : !c.sessionId ? 'old' : !alive || alive.has(c.sessionId) ? null : 'gone';
        return { key: c.key, current, ...f, resumable: !current && why === null, why };
      })
      .sort((x, y) => y.at - x.at);
  }
  /**
   * Claude 쪽 기록이 있는 세션 id — 이 PC 방은 이 PC 의 파일, 서버 방은 서버에서 ssh 한 번(접속 한도 REMOTE_QUICK_MS).
   * null = 알 수 없음(서버에 못 닿음 등) → 막지 않고 모두 이어 갈 수 있음으로 — 이어 가다 실패하면 새 대화 길이 받는다
   */
  private async aliveSessions(agent: Agent, ids: string[]): Promise<Set<string> | null> {
    const remote = this.remoteOf(agent);
    if (!remote) return existingSessions(claudeDirOf(this.o.env), ids);
    if (ids.length === 0) return new Set();
    try {
      const run = await this.sshRun(remote.host, transcriptCheckScript(ids), { quick: true });
      if (run.code !== 0) return null;
      return new Set(run.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    } catch {
      return null;
    }
  }
  folderTarget(id: AgentId): FolderTarget {
    const agent = this.need(id);
    const remote = this.remoteOf(agent);
    return remote ? { kind: 'remote', host: remote.host, path: agent.folder } : { kind: 'local', path: agent.folder };
  }
  conversation(id: AgentId, key: string, o: { limit?: number } = {}): HistoryItem[] {
    this.need(id);
    const c = this.splitOf(id).find((x) => x.key === key);
    return c ? lastN(c.items, o.limit ?? 500) : [];
  }
  pastCount(id: AgentId): number {
    const agent = this.need(id);
    let n = this.pastCounts.get(id);
    if (n === undefined) {
      n = this.splitOf(id).filter((c) => c.key !== agent.sessionId && conversationFacts(c, () => null)).length;
      this.pastCounts.set(id, n);
    }
    return n;
  }
  /** 지난 대화 수 기억을 버린다 — 경계를 남길 때·이어 갈 때·에이전트를 지울 때 */
  private forgetPastCount(id: AgentId): void { this.pastCounts.delete(id); }
  async image(id: AgentId, file: string): Promise<string | null> {
    this.need(id);
    const img = typeof file === 'string' ? this.images.read(id, file) : null;
    return img ? `data:${img.mediaType};base64,${img.base64}` : null;
  }
  messages(f?: Parameters<MessageLog['list']>[0]) { return this.log.list(f); }
  approveMessage(id: string) { this.router.approve(id); }
  dismissMessage(id: string) { this.router.dismiss(id); }
  continueHeld(roomId: RoomId) { this.router.continueHeld(roomId); }
  pendingRequests(agentId?: AgentId) { return this.perms.pending(agentId); }
  answerRequest(id: string, d: Decision) { this.perms.answer(id, d); }

  // ── 사용량 ──
  usage(): PlanUsage | null { return this.watcher?.current() ?? null; }
  refreshUsage(): void { this.watcher?.requested(); }

  shutdown(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      for (const timer of this.coolTimers.values()) clearTimeout(timer);
      this.coolTimers.clear();
      if (this.sweepTimer) clearInterval(this.sweepTimer);
      this.sweepTimer = null;
      const ids = [...this.sessions.keys()];
      for (const r of this.perms.pending()) this.perms.cancelForAgent(r.agentId, EXITED);
      // 올리는 중인 첨부 — ssh 를 끈다(앱이 닫힌 뒤 떠돌지 않게). 그 보내기들이 되돌리기(서버 파일 지우기)를 줄에 세울 때까지 상한 안에서 기다린다
      for (const id of [...this.uploads.keys()]) this.cancelUploads(id);
      const sends = this.waitWithin([...this.sending.values()]);
      // 맵에서 이미 빠진 채 끄는 중인 세션(다시 띄우기·새 대화)도 기다린다 — 각각 STOP_LIMIT_MS 상한
      await Promise.all([this.stopWatcher(), ...ids.map((id) => this.endSession(id)), ...this.stopping, this.pruning, sends]);
      // 상한이 먼저 지나 아직 살아 있는 claude(바쁜 PC 에서 taskkill 이 늦음) — 앱이 닫힌 뒤 떠돌지 않게 직접 끈다.
      // 서버 방 정리(끄기·시작 때 것)도 함께 기다린다 — 상한 안에서만(못 끝낸 띄우기는 저장돼 있어 다음에 켤 때 다시)
      await Promise.all([this.waitRemoteWork(), ...[...this.unstopped].map((s) => s.forceKill(FORCE_KILL_WAIT_MS))]);
      await this.mcp.close();
      this.finished = true;
    })();
    return this.closing;
  }

  // ── 내부 ──
  private need(id: AgentId): Agent {
    const a = this.removing.has(id) ? undefined : this.store.agent(id);
    if (!a) throw new Error(`에이전트를 찾을 수 없습니다: ${id}`);
    return a;
  }

  /** MCP 로 부른 에이전트 — 모르면 도구 오류로 돌아간다 */
  private caller(id: AgentId): Agent {
    const a = this.closed || this.removing.has(id) ? undefined : this.store.agent(id);
    if (!a) throw new Error(NO_AGENT);
    return a;
  }

  /**
   * 두레 도구를 부른 에이전트 — 서브에이전트가 불렀으면 실행하지 않고 던진다(도구 오류로 Claude 에게 돌아간다, spec §4.7).
   * 다른 에이전트와 말하는 건 에이전트 자신뿐 — 서브에이전트는 부모에게 보고한다
   */
  private async dureCaller(agentId: AgentId, toolUseId: string | undefined): Promise<Agent> {
    this.caller(agentId); // 모르는 에이전트면 기다리지 않고
    const s = this.sessions.get(agentId);
    if ((await this.origin(agentId, toolUseId)) === 'subagent') throw new Error(SUBAGENT_DURE_TOOL);
    // 기다리는 사이 세션이 끝났다(origin 은 부모로 돌려준다) — 끝난 세션의 부르기는 실행하지 않는다(승인과 같은 거절 문구)
    if (s && this.sessions.get(agentId) !== s) throw new Error(EXITED);
    return this.caller(agentId); // 기다리는 사이 지워졌을 수 있다
  }

  /**
   * 두레 도구 create_agent — 에이전트가 같은 방에 새 에이전트를 만든다. 사람이 카드에서 [만들기] 해야 생긴다.
   * 부른 쪽 가르기는 다른 두레 도구와 같다(서브에이전트면 거절 · 기다리는 사이 세션이 끝나면 EXITED). 카드는 살아 있는 세션의
   * 부르기에만 띄운다 — 그 세션이 끝나면(멈추기·새 대화·종료·비정상 종료) 세션 끝 정리가 카드를 거절로 치운다, 부른 쪽이 끊겨도(signal).
   * 미리 보기(이름·역할·겹침·폴더)가 실패하면 카드 없이 그 이유로 던진다. [만들기] 때 같은 검사를 다시 한다(그사이 이름이 겹치게
   * 됐거나 폴더가 사라졌으면 만들지 않는다). 새 에이전트는 만든 쪽의 모델·effort·자동을 물려받고, 묻지 않음은 꺼짐·늘 허용은 빈 목록.
   * 첫 할 일이 있으면 만든 쪽이 보낸 메시지로 — [만들기]가 그 메시지의 승인이다(router.sendApproved)
   */
  private async createAgentFor(
    agentId: AgentId,
    args: { name: string; role: string; folder?: string; task?: string },
    toolUseId: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const s = this.sessions.get(agentId);
    const me = await this.dureCaller(agentId, toolUseId);
    // 살아 있는 세션의 부르기만 — 세션 없이 온 부르기(끝난 프로세스의 늦은 호출)의 카드는 세션 끝 정리가 치우지 못한다
    if (!s || this.sessions.get(agentId) !== s) throw new Error(EXITED);
    const remote = this.remoteOf(me);
    const plan: CreateAgentInput = {
      name: args.name.trim(),
      role: args.role.trim(),
      folder: newAgentFolder(!!remote, me.folder, args.folder ?? '.'),
      task: args.task?.trim() ? args.task : null,
    };
    if (remote) {
      // 서버 방 — 이름·역할·겹침을 먼저 보고(폴더는 아래 ssh 확인이 본다 — '/' 는 그 자리만 채운다), 그 폴더가 서버에 있는지 카드를 띄우기 전에
      // 확인한다. ~·~/x 도 직접 더하기처럼 서버가 펼친 경로로. 없거나 접속이 안 되면 그 글로 던진다
      this.checkNewAgent(me.roomId, { ...plan, folder: '/' });
      const r = await this.checkRemoteFolder(me.roomId, plan.folder);
      if (!r.ok) throw new Error(remoteIssueText(remote.host, r));
      plan.folder = r.folder;
      // 확인하는 사이 세션이 끝났거나 지워졌다 — 카드를 띄우지 않는다
      if (this.closed || this.removing.has(agentId) || this.sessions.get(agentId) !== s) throw new Error(EXITED);
    }
    this.checkNewAgent(me.roomId, plan); // 미리 보기 — 카드 없이 던진다(서버 방은 펼친 폴더로 다시)
    const res = await this.perms.request(agentId, { tool_name: CREATE_AGENT_TOOL, input: plan, tool_use_id: toolUseId }, signal, { kind: 'create-agent' });
    if (res.behavior === 'deny') throw new Error(res.message); // 거절·멈춤·세션 끝·끊김 — 그 글 그대로
    // [만들기] — 그사이 세션이 끝났거나 만든 쪽이 지워졌으면 만들지 않는다(세션 끝 정리가 카드를 먼저 거절하지만 겹쳐 지킨다)
    if (this.closed || this.removing.has(agentId) || this.sessions.get(agentId) !== s) throw new Error(EXITED);
    const creator = this.caller(agentId); // 지금 저장값 — 카드가 떠 있는 사이 바뀐 모델·effort·자동도
    this.checkNewAgent(creator.roomId, plan); // 다시 확인
    const added = this.store.addAgent({ roomId: creator.roomId, name: plan.name, role: plan.role, folder: plan.folder });
    const agent = this.store.updateAgent(added.id, {
      model: creator.model, effort: creator.effort, auto: creator.auto, bypassOn: false, alwaysAllow: [],
    });
    this.guard(null, () => this.emit('agent-added', { agent, by: creator.id }));
    if (plan.task !== null) this.router.sendApproved(creator.id, agent.id, plan.task);
    return `에이전트 '${agent.name}'${josa(agent.name, '을/를')} 만들었어요.${plan.task !== null ? ' 첫 메시지를 보냈어요.' : ''}`;
  }

  /**
   * 새 에이전트를 더할 수 있는가 — create_agent 의 미리 보기와 [만들기] 때 다시 확인이 같이 쓴다.
   * 이름 빔 → 이름 제어 문자 → 이름 길이 → 역할 빔 → 역할 제어 문자 → 역할 길이 → 방 안 이름 겹침 → 폴더 순.
   * 빔·겹침·폴더는 store 의 검사·문구 그대로(이름이 비었으면 store 가 먼저 '이름을 입력하세요'). 길이는 앞뒤 빈칸을 자른 값으로
   */
  private checkNewAgent(roomId: RoomId, n: CreateAgentInput): void {
    if (n.name.trim()) {
      if (CONTROL_CHAR.test(n.name)) throw new Error(NAME_CONTROL);
      if (chars(n.name.trim()) > NAME_MAX) throw new Error(NAME_LONG);
      if (!n.role.trim()) throw new Error(ROLE_EMPTY);
      if (CONTROL_CHAR.test(n.role)) throw new Error(ROLE_CONTROL);
      if (chars(n.role.trim()) > ROLE_MAX) throw new Error(ROLE_LONG);
    }
    this.store.checkAgent({ roomId, name: n.name, folder: n.folder });
  }

  /**
   * 승인·두레 도구를 부른 쪽(spec §4.4) — tool_use id 가 없으면 부모(지금처럼). 이 세션 스트림에서 본 id 면 그 줄에 parent 가 있었는지.
   * 못 본 id 는 seenWaitMs 동안 기다렸다 다시 보고, 끝내 못 보면 서브에이전트: 부모와 바로 아래 서브에이전트의 줄은 부르기보다 먼저 오고
   * (probe13·14), 끝내 안 오는 건 안쪽 서브에이전트의 줄뿐이다(probe14 A). 그래서 보통 부모의 부르기는 기다리지 않는다.
   * 살아 있는 세션이 없으면 가를 스트림이 없다 — 부모(지금처럼 세션 끝 정리를 따른다). 기다리는 사이 그 세션이 끝났어도(못 본 채 깨어남)
   * 서브에이전트로 치지 않고 부모 — 끝난 세션의 부르기다
   */
  private async origin(id: AgentId, toolUseId: string | undefined): Promise<'parent' | 'subagent'> {
    if (!toolUseId) return 'parent';
    const s = this.sessions.get(id);
    const seen = s && this.seen.get(s);
    if (!seen) return 'parent';
    const parent = await seen.lookup(toolUseId, this.o.seenWaitMs ?? SEEN_WAIT_MS);
    if (this.sessions.get(id) !== s) return 'parent';
    return parent === null ? 'parent' : 'subagent';
  }

  /** 세션이 끝났다 — 본 하는 일을 비우고 기다리던 부르기를 깨운다 */
  private forgetSeen(s: ClaudeSession): void {
    this.seen.get(s)?.close();
    this.seen.delete(s);
  }

  /** 차례가 끝나도 남길 승인 — 도는 서브에이전트가 물은 것(spec §4.4). 도는 것이 없으면 서브에이전트 것도 지금처럼 거절 */
  private keepSubagentAsks(id: AgentId): (r: PendingRequest) => boolean {
    return (r) => !!r.fromSubagent && this.subagents.has(id);
  }

  /**
   * 지금 차례 중(엔진이 보낸 /effort 차례 포함)이거나 부모가 사람 답을 기다리는 중, 또는 다시 띄우기를 기다리는 중(켜지 않은 세션에
   * 보내지 않게 — 서브에이전트가 돌면 쉬는 채로 미뤄진다). 서브에이전트가 물은 승인은 막지 않는다 — 부모 차례가 끝났으면 받은 메시지는 간다
   */
  private waiting(id: AgentId): boolean {
    const s = this.sessions.get(id);
    return (
      s?.status === 'working' ||
      (!!s && (this.effortTurn.has(s) || this.restartWant.has(s) || this.planBlocked(id, s) || this.midUnread(s))) ||
      this.parentAsking(id)
    );
  }

  /**
   * 쉬는 중 — 차례 중도 아니고(엔진이 보낸 /effort 차례 포함), 부모가 사람 답을 기다리지도 않는다(서브에이전트가 물은 것은 세지 않는다).
   * 묻지 않고 실행하는 세션이 계획 모드 답을 기다리는 동안도 쉬지 않는다 — 그 사이 쓴 줄은 계획 없이 묻지 않고 돈다
   */
  private resting(id: AgentId, s: ClaudeSession): boolean {
    return s.status === 'idle' && !this.effortTurn.has(s) && !this.parentAsking(id) && !this.planBlocked(id, s) && !this.midUnread(s);
  }

  /**
   * 지금 차례에 줄을 끼워 보낼 수 있나 — Claude 차례가 도는 중(사람 승인 대기 포함)이고, 엔진이 몰래 연 차례(/effort)·다시 띄우기·
   * 계획 모드로 바꾸는 중이 아니고, 먼저 기다리는 입력·붙잡기가 없을 때(차례를 앞지르지 않게). 사람 말·전달 메시지 둘 다
   */
  private canInterject(id: AgentId, s: ClaudeSession): boolean {
    if (!this.live(id, s) || s.status !== 'working') return false;
    if (this.effortTurn.has(s) || this.restartWant.has(s) || this.planEntering.has(s) || this.planGates.has(s)) return false;
    return (this.held.get(id)?.length ?? 0) === 0 && !this.holds.has(id);
  }

  /** 사람 말을 지금 차례에 끼워 보낼 수 있나 — 위 조건에 슬래시 명령이 아닐 때(명령은 쉴 때 차례로) */
  private canSendMid(id: AgentId, s: ClaudeSession, parts: ReadyPart[]): boolean {
    return this.canInterject(id, s) && !inputText(parts).trimStart().startsWith('/');
  }

  /**
   * 차례 도중에 보낸 말을 Claude 가 아직 읽지 않았다 — 그동안은 쉬지 않는다(다른 줄이 끼어들지 않게). 다음 걸음에서 읽거나,
   * 멈췄으면 곧바로 그 말로 새 차례가 열린다(probe17)
   */
  private midUnread(s: ClaudeSession): boolean {
    return this.inFlight.get(s)?.some((x) => x.mid) ?? false;
  }

  /**
   * 보낸 줄을 읽었나 — 차례 도중에 보낸 말은 그 되돌림(replay, 같은 글)으로만, 쉴 때 보낸 줄은 Claude 의 첫 줄로
   * (그 줄의 init 이 되돌림보다 먼저 온다). 읽은 줄을 목록에서 뺀다
   */
  private noteRead(s: ClaudeSession, ev: StreamEvent): boolean {
    const list = this.inFlight.get(s);
    if (!list?.length) return false;
    if (ev.kind === 'replay') {
      const i = list.findIndex((x) => x.mid && (x.kind === 'human' ? inputText(x.input.parts) : x.text) === ev.text);
      if (i < 0) return false;
      list.splice(i, 1);
      if (!this.midUnread(s)) this.clearMidGrace(s);
      return true;
    }
    if (!readsInput(ev) || list[0].mid) return false;
    list.shift();
    return true;
  }

  private clearMidGrace(s: ClaudeSession): void {
    const t = this.midGrace.get(s);
    if (t) clearTimeout(t);
    this.midGrace.delete(s);
  }

  /**
   * 차례가 끝났는데 차례 도중에 보낸 말이 아직 안 읽혔다 — 그 말로 새 차례가 곧 열린다(probe17). 열리지 않으면(되돌림을 못 맞춘 경우)
   * 기다린 뒤 읽은 것으로 보고 다시 쉰다
   */
  private armMidGrace(id: AgentId, s: ClaudeSession): void {
    if (!this.midUnread(s) || this.midGrace.has(s)) return;
    const timer = setTimeout(() => {
      this.midGrace.delete(s);
      if (this.sessions.get(id) !== s || s.status !== 'idle' || !this.midUnread(s)) return;
      this.inFlight.set(s, (this.inFlight.get(s) ?? []).filter((x) => !x.mid));
      this.guard(id, () => this.pump(id));
      this.emitStatus(id);
    }, this.o.midGraceMs ?? MID_GRACE_MS);
    timer.unref?.();
    this.midGrace.set(s, timer);
  }

  /** 부모가 물은 승인·질문이 떠 있다 — 서브에이전트가 물은 것(fromSubagent)은 부모 차례와 상관없이 남는다(spec §4.4) */
  private parentAsking(id: AgentId): boolean {
    return this.perms.pending(id).some((r) => !r.fromSubagent);
  }

  /**
   * 서브에이전트 일이 다 끝났다 — 도는 것도, 끝난 뒤 Claude 가 스스로 열 차례를 기다리는 것도 없다. 다시 띄우기·/effort 는 이때만
   * (다시 띄우면 서브에이전트가 죽고, /effort 차례는 사건을 삼켜 그 사이 온 끝 알림·스스로 시작한 차례가 사라진다 — spec §4.3)
   */
  private subagentsSettled(id: AgentId): boolean {
    return !this.subagents.has(id) && !this.autoTurns.has(id);
  }

  /**
   * 한가하면 — 권한 모드 때문에 다시 띄울 세션이면(묻지 않음을 켜려고, 또는 끄기에 실패해 남은 bypass 를 걷으려고) 그것부터
   * (기다리던 입력은 새 세션이 받는다), 다음은 줄에 선 /effort, 다음은 사람 입력, 없으면 다른 에이전트가 보낸 대기 메시지(붙잡혀 있으면
   * 꺼내지 않는다 — 사람이 이어서 보내기를 고를 때까지) — 한 번에 한 줄.
   * 다시 띄우기·/effort 는 서브에이전트 일이 다 끝날 때까지 줄에 둔다 — 다시 띄우기를 기다리는 동안은 입력도 보내지 않고,
   * /effort 만 미뤄지면 사람 입력·받은 메시지는 그대로 간다
   */
  private pump(id: AgentId): void {
    const s = this.sessions.get(id);
    if (!s || !this.resting(id, s)) return;
    this.armAutoTurn(id);
    const settled = this.subagentsSettled(id);
    if (this.restartWant.has(s)) {
      if (settled) void this.restartForMode(id, s);
      return; // 다시 띄운 세션에서 다시 pump · 미뤘으면 서브에이전트 일이 끝난 뒤 다시 pump
    }
    const level = this.effortWant.get(s);
    if (level && settled) {
      this.sendEffort(id, s, level);
      return; // 그 차례의 result 에서 다시 pump
    }
    const next = this.held.get(id)?.shift();
    if (next) {
      this.emitHeld(id);
      // 계획 먼저 — 그 입력을 쓰기 직전에 계획 모드로(제어 요청이 먼저 줄에 들어가 그 입력보다 먼저 처리된다 — 띄울 때의 bypass 와 같은 길).
      // 이미 계획 모드거나 그리 바꾸는 중이면 생략
      if (next.plan && !this.inPlan(id, s)) void this.enterPlan(id, s);
      // 묻지 않고 실행하는 세션이면 계획 모드 답을 기다렸다 쓴다 — 차례가 먼저 시작되면 계획 없이 묻지 않고 돈다(답이 오면 planSettled 가)
      if (this.planBlocked(id, s)) {
        this.planGates.set(s, next);
        this.emitStatus(id);
        return;
      }
      this.sendTo(id, s, next.parts, { kind: 'human', input: next });
    }
    else if (!this.holds.has(id)) this.router.onIdle(id);
  }

  /**
   * 묻지 않고 실행하는 세션이 계획 모드 답을 기다린다 — 그동안은 쉬지 않는다(사람 입력·받은 메시지를 쓰지 않는다).
   * 지금 모드가 bypass, 또는 아직 모드를 모르는데 내 Claude 설정의 기본 모드가 bypass(그 모드로 시작한다)
   */
  private planBlocked(id: AgentId, s: ClaudeSession): boolean {
    if (!this.planEntering.has(s)) return false;
    const now = this.modes.get(s);
    return now === BYPASS_MODE || (now === undefined && (this.settingsDefaults.get(s) ?? this.settingsDefaultOf.get(id)) === BYPASS_MODE);
  }

  /**
   * 계획 모드 요청이 끝났다(답·실패 처리까지) — 아직 다른 계획 모드 요청이 가면 그 끝에서. 쥔 입력은 계획 모드가 됐으면 쓰고,
   * 못 됐으면(planOnFailed 가 알렸다) 계획 없이 보내지 않고 붙잡는다(기다리던 것도 함께 — 순서를 바꾸지 않는다). 그다음 다시 pump
   */
  private planSettled(id: AgentId, s: ClaudeSession): void {
    if (!this.live(id, s) || this.planEntering.has(s)) return;
    const input = this.planGates.get(s);
    if (input) {
      this.planGates.delete(s);
      if (this.modes.get(s) === PLAN_MODE) this.sendTo(id, s, input.parts, { kind: 'human', input });
      else {
        this.heldOf(id).unshift(input);
        this.holdQueue(id);
      }
    }
    this.pump(id);
    this.emitStatus(id);
  }

  /** 계획 모드 답을 기다리며 쥔 입력을 기다리는 줄 맨 앞으로 돌려놓는다(멈추기 — 곧 붙잡는다 · 세션 끝 — 다음 세션이 받는다). 있었으면 true */
  private ungate(id: AgentId, s: ClaudeSession | undefined): boolean {
    const input = s && this.planGates.get(s);
    if (!s || !input) return false;
    this.planGates.delete(s);
    this.heldOf(id).unshift(input);
    this.emitHeld(id);
    return true;
  }

  private sendTo(id: AgentId, s: ClaudeSession, parts: ReadyPart[], item: Extract<InFlight, { kind: 'human' }>): void {
    this.write(s, parts, item);
    this.written.add(item.input); // 돌려받아 붙잡혔다 버려도 첨부 사본은 둔다 — 기록·Claude 의 기억이 그 경로를 안다
    // 실제로 쓴 줄만 기록한다 — 대기 중인 입력은 보낼 때 나타난다
    this.guard(id, () => this.record(id, { kind: 'user', source: 'human', parts: parts.map((p) => this.historyPart(id, p)) }));
  }

  /**
   * 받은 메시지를 넘긴다 — 여럿이면 한 줄로 묶어(Claude 는 다 읽고 한 번에 처리), 기록은 메시지마다 따로(대화의 넘겨받은 줄·'대화에서 보기').
   * mid 면 지금 차례에 끼워 넣는다(다음 걸음에서 읽는다 — 되돌림이 와야 읽힌 것)
   */
  private sendRelay(id: AgentId, s: ClaudeSession, batch: Delivery[], mid: boolean): void {
    const text = joinDeliveries(batch.map((d) => d.text));
    this.write(s, [{ type: 'text', text }], { kind: 'relay', messageIds: batch.map((d) => d.messageId), text, ...(mid ? { mid: true as const } : {}) });
    for (const d of batch) {
      this.guard(id, () => this.record(id, { kind: 'user', source: 'relay', parts: [{ type: 'text', text: d.text }], messageId: d.messageId }));
    }
  }

  private write(s: ClaudeSession, parts: ReadyPart[], item: InFlight): void {
    s.send(parts);
    this.lastActive.set(s, performance.now());
    const list = this.inFlight.get(s) ?? [];
    list.push(item);
    this.inFlight.set(s, list);
    this.prewarmed.delete(s); // 일을 받은 세션 — 고르지 않게 돼도 끄지 않는다(앱을 끌 때까지)
  }

  /**
   * 기록 한 칸 — 그림은 내용을 그림 칸에 따로 두고 기록엔 크기·이름만(저장을 못 하면 이름 없이, 보내기는 막지 않는다).
   * 첨부는 칩에 쓸 이름·크기·사본 이름(서버 방이면 서버 경로)만 — 원본 경로·보낸 경로는 남기지 않는다
   */
  private historyPart(id: AgentId, p: ReadyPart): HistoryPart {
    if (p.type === 'text') return { type: 'text', text: p.text };
    if (p.type === 'file') return { type: 'file', name: p.name, bytes: p.bytes, file: p.file, ...(p.remotePath ? { remotePath: p.remotePath } : {}) };
    const part: HistoryPart = { type: 'image', mediaType: p.mediaType, bytes: Buffer.from(p.base64, 'base64').length };
    try {
      const file = this.images.save(id, p.mediaType, p.base64);
      if (file) part.file = file;
    } catch {
      // 디스크가 막혀도 대화는 이어진다 — 그 그림만 다시 볼 수 없다
    }
    return part;
  }

  private record(id: AgentId, item: HistoryItem | (Omit<HistoryItem, 't'> & { t?: number })): void {
    const full = { t: Date.now(), ...item } as HistoryItem;
    this.hist.append(id, full);
    if (full.kind === 'boundary') this.forgetPastCount(id);
    this.guard(id, () => this.emit('history', { agentId: id, item: full }));
  }

  private emitHeld(id: AgentId): void {
    this.guard(id, () => this.emit('held-input', { agentId: id, count: this.held.get(id)?.length ?? 0 }));
  }

  private heldOf(id: AgentId): HeldInput[] {
    const q = this.held.get(id) ?? [];
    this.held.set(id, q);
    return q;
  }

  /**
   * 멈출 때 — 기다리던 내 입력(기다리는 줄에서 옮긴다)과 그 에이전트에게 온 전달 대기 메시지를 붙잡는다. 둘 다 없으면 붙잡지 않는다.
   * 이미 붙잡혀 있으면(붙잡힌 동안 새로 친 말이 기다리다 또 멈춤) 그 목록에 — 내 입력은 내 입력 끝에, 메시지는 맨 끝에
   */
  private holdQueue(id: AgentId): void {
    const inputs = this.held.get(id) ?? [];
    const h = this.holds.get(id) ?? { since: Date.now(), entries: [] };
    const known = new Set(h.entries.map((e) => e.item.id));
    const queued = this.log.list({ to: id, states: ['queued'] }).filter((m) => !known.has(m.id));
    if (inputs.length === 0 && queued.length === 0) return;
    const mine = h.entries.filter((e) => e.input).length;
    h.entries.splice(mine, 0, ...inputs.map((input) => ({ item: humanItem(input), input })));
    h.entries.push(...queued.map((m) => ({ item: relayItem(m) })));
    this.holds.set(id, h);
    if (inputs.length > 0) {
      this.held.delete(id);
      this.emitHeld(id);
    }
    this.emitHold(id);
    this.emitStatus(id); // /effort 차례 중 기다리던 입력 때문에 작업 중이었으면 이제 대기
  }

  /** 준비하는 사이 멈춘 내 입력 — 붙잡기의 내 입력 끝에(holdQueue 와 같은 자리). 붙잡기가 없으면 새로 연다 */
  private holdInput(id: AgentId, input: HeldInput): void {
    const h = this.holds.get(id) ?? { since: Date.now(), entries: [] };
    const mine = h.entries.filter((e) => e.input).length;
    h.entries.splice(mine, 0, { item: humanItem(input), input });
    this.holds.set(id, h);
    this.emitHold(id);
    this.emitStatus(id);
  }

  /** 기록이 바뀐 메시지 — 받는 쪽이 붙잡혀 있으면 새로 queued 가 된 것은 목록 끝에, queued 가 아니게 된 것(버림 등)은 목록에서 뺀다 */
  private noteHoldMessage(m: RelayMessage): void {
    const h = this.holds.get(m.to);
    if (!h) return;
    const entry = h.entries.find((e) => !e.input && e.item.id === m.id);
    if (m.state === 'queued' && !entry) {
      h.entries.push({ item: relayItem(m) });
      this.emitHold(m.to);
    } else if (m.state !== 'queued' && entry) {
      this.unhold(m.to, entry);
    }
  }

  /** 붙잡기에서 하나를 뺀다(이미 빠졌으면 그대로) — 다 빠지면 붙잡기도 풀린다(사건 null) */
  private unhold(id: AgentId, entry: HoldEntry): void {
    const h = this.holds.get(id);
    const i = h ? h.entries.indexOf(entry) : -1;
    if (!h || i < 0) return;
    h.entries.splice(i, 1);
    if (h.entries.length === 0) this.holds.delete(id);
    this.emitHold(id);
  }

  private holdView(id: AgentId): Hold | null {
    const h = this.holds.get(id);
    return h ? { since: h.since, items: h.entries.map((e) => ({ ...e.item })) } : null;
  }

  private emitHold(id: AgentId): void {
    this.guard(id, () => this.emit('hold', { agentId: id, hold: this.holdView(id) }));
  }

  /** 사용량 전용 claude — 데이터 폴더 안 빈 폴더에서, 에이전트와 같은 환경으로(start 는 UsageWatcher 가) */
  private spawnUsageProbe(): ClaudeSession {
    const cwd = path.join(this.o.dataDir, 'usage-probe');
    fs.mkdirSync(cwd, { recursive: true });
    return new ClaudeSession({
      command: this.o.claude.command,
      args: [...(this.o.claude.argsPrefix ?? []), ...buildUsageArgs()],
      cwd,
      env: this.spawnEnv(),
    });
  }

  private spawnEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.o.env, ...SPAWN_ENV_EXTRA };
  }

  /** 타이머를 끄고 떠 있는 사용량 전용 claude 를 끈다 — 상한 STOP_LIMIT_MS(세션 끝내기와 같은 까닭) */
  private async stopWatcher(): Promise<void> {
    if (!this.watcher) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((r) => {
      timer = setTimeout(r, STOP_LIMIT_MS);
    });
    await Promise.race([this.watcher.stop(), limit]);
    clearTimeout(timer);
  }

  /**
   * 필요할 때 띄운다 — 띄울 때마다 MCP 설정·방 안내문을 새로 쓴다(포트·토큰·동료 목록 최신).
   * quiet: 띄운 뒤 상태를 알리지 않는다(부른 쪽이 보내고 나서 알린다)
   */
  private ensure(id: AgentId, o: { quiet?: boolean } = {}): ClaudeSession {
    if (this.closed) throw new Error(CLOSED);
    const agent = this.need(id);
    const live = this.sessions.get(id);
    if (live) return live;
    const wasAsleep = this.sleepOf(id).asleep; // 깨우기 — 띄우기 전에 본다(띄우면 잠듦이 아니다)
    const remote = this.remoteOf(agent);
    if (remote && !this.sshAvailable()) {
      // 서버 방인데 ssh 가 없다 — 폴더 없음처럼 띄우지 않는다
      this.errors.set(id, NO_SSH);
      this.emitStatus(id);
      throw new Error(NO_SSH);
    }

    const runDir = path.join(this.o.dataDir, 'run', id);
    fs.mkdirSync(runDir, { recursive: true });
    const peers = this.store.agents(agent.roomId).filter((a) => a.id !== id);
    const allow = this.allow;
    // 갈래(새 에이전트로 이어 가기)의 첫 실행 — 원래 세션의 기록을 이어 받은 새 세션(id = 이 에이전트의 sessionId)으로. init 까지 그대로(앱을 다시 켜도)
    const forkOf = agent.forkOf ?? null;
    const argsWith = (mcpConfigPath: string, promptPath: string, addDirs?: string[]) =>
      buildArgs({
        sessionId: agent.sessionId, resume: agent.started, forkOf, mcpConfigPath, promptPath, model: agent.model, name: agent.name,
        allowBypass: allow, addDirs,
      });
    let s: ClaudeSession;
    if (remote) s = this.remoteSession(id, agent, remote.host, runDir, buildRoomPrompt(agent, peers), argsWith);
    else {
      const mcpConfigPath = path.join(runDir, 'mcp.json');
      const promptPath = path.join(runDir, 'prompt.md');
      fs.writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig({ port: this.mcp.port, token: this.mcp.token, agentId: id })));
      fs.writeFileSync(promptPath, buildRoomPrompt(agent, peers));
      // 첨부 폴더는 띄울 때마다 미리 허용한다 — 첨부를 읽을 때 승인 카드가 뜨지 않게(probe27 A1). 없으면 만든다
      const attachDir = this.attachments.dir(id);
      fs.mkdirSync(attachDir, { recursive: true });
      s = new ClaudeSession({
        command: this.o.claude.command,
        args: [...(this.o.claude.argsPrefix ?? []), ...argsWith(mcpConfigPath, promptPath, [attachDir])],
        cwd: agent.folder,
        env: this.spawnEnv(),
      });
    }
    const run = this.remoteRuns.get(s); // 서버 방 세션이면 그 띄우기
    this.seen.set(s, new SeenToolUses());
    // 갈래도 이어 가기 — 원래 세션의 Claude 쪽 기록이 없으면 같은 길(resumeFailed)로 새 대화
    if (forkOf) {
      this.resuming.set(s, forkOf);
      this.forking.add(s);
    } else if (agent.started) this.resuming.set(s, agent.sessionId);
    // 세션 콜백 안에서 던지면 stdout 처리 중 잡히지 않은 예외가 되어 앱이 죽는다 — 모두 guard 로 감싼다
    s.on('event', (ev: StreamEvent) =>
      this.guard(id, () => {
        // 서버 세션이 처음 말했다 — 시작됨(끊김을 가르는 근거) · 지난 접속 문제를 지운다
        if (run && !run.started) this.remoteStarted(id, s, run);
        // 이어 갈 Claude 기록이 없다는 오류 result — 읽은 줄·기록·전달로 치지 않는다(곧 끝나면 exit 가 새 대화로)
        if (this.noteResume(s, ev)) return;
        // 보낸 줄을 읽었나 — 끝내는 중인 세션이어도 센다(endSession 이 본다)
        const answered = this.noteRead(s, ev);
        if (this.sessions.get(id) !== s) return;
        // 그 세션이 보낸 줄은 무엇이든 활동이다 — 뒤에서 도는 일 목록도. 제어 응답만 뺀다: 엔진이 제 일로 물은 것(사용량·설정·권한 모드)의
        // 답이다 — 사용량은 일하는 에이전트가 있는 동안 떠 있는 첫 세션에 주기마다 물어, 치면 그 쉬는 에이전트가 영영 잠들지 않는다
        if (ev.kind !== 'control-response') this.lastActive.set(s, performance.now());
        // 깨운 세션의 첫 차례의 init — 깨어났다. 엔진이 먼저 쓴 /effort 차례의 init 은 아니다: 그 뒤에 기다리는 입력·메시지가 남아 있다
        if (ev.kind === 'init' && !this.effortTurn.has(s) && this.waking.delete(s)) this.emitSleep(id);
        // 뒤에서 도는 일 목록 — 세션마다 마지막 것만 든다(재우기가 비어 있을 때만 재운다). 기록·화면엔 안 보낸다
        if (ev.kind === 'background-tasks') {
          this.bgTasks.set(s, ev.taskIds);
          return;
        }
        if (ev.kind === 'replay') return; // 되돌림은 읽었다는 표시일 뿐 — 기록·화면엔 보낼 때 이미 있다
        if (ev.kind === 'init') this.clearMidGrace(s); // 멈춘 뒤 안 읽힌 말로 새 차례가 열렸다
        // 본 하는 일 — 승인·두레 도구를 부른 쪽을 가르는 근거(/effort 차례 중에 온 줄도)
        if (ev.kind === 'assistant') this.seen.get(s)?.note(ev);
        // 권한 모드가 바뀌었다는 status 줄(probe16 — 계획 승인으로 CLI 가 스스로 기본 모드로 갈 때도) — 차례 밖이어도, /effort 차례 중에도 받는다
        if (ev.kind === 'api-status' && ev.permissionMode !== undefined) this.noteMode(id, s, ev.permissionMode);
        if (ev.kind !== 'control-response' && this.effortTurn.has(s)) this.onEffortEvent(id, s, ev);
        else {
          // 차례의 init — 보낸 줄 없이 왔으면 Claude 가 스스로 연 차례: 서브에이전트가 끝난 뒤 기다리던 것 하나(그 result 가 pump 한다)
          if (ev.kind === 'init') this.turnStarted(id, !answered && !this.midUnread(s));
          if (run && ev.kind === 'result') this.noteRemoteResult(id, ev);
          this.onEvent(id, ev);
        }
      }),
    );
    s.on('status', () =>
      this.guard(id, () => {
        // 이어 갈 기록이 없어 끝나는 세션의 오류는 알리지 않는다 — 곧 새 대화로 이어 간다(exit)
        if (s.status === 'error' && this.lostTranscript(s, s.errorText ?? '')) return;
        // 서버 방 세션의 오류는 끝난 뒤(exit) 가른다 — ssh 잡음 섞인 글·접속 문제를 오류로 먼저 알리지 않게
        if (s.status === 'error' && run) return;
        if (this.sessions.get(id) === s) this.emitStatus(id);
      }),
    );
    s.on('exit', ({ code, expected, stderrTail }: { code: number | null; expected: boolean; stderrTail: string }) =>
      this.guard(id, () => {
        if (run) this.livePorts.delete(run.port); // ssh 가 끝났다 — 원격 포트를 놓는다
        if (this.sessions.get(id) !== s) return; // 엔진이 끝낸 세션은 endSession 이 정리
        this.sessions.delete(id);
        this.guard(id, () => this.ungate(id, s)); // 계획 모드 답을 기다리며 쥔 입력 — 다음 실행에(보낸 줄을 되살리는 것과 같다)
        this.endEffortTurn(s); // /effort 차례 중이었으면 그 타이머도(다음에 띄울 때 다시 보낸다)
        this.forgetSeen(s);
        this.edits.delete(s);
        this.guard(id, () => this.forgetEffortNow(id));
        this.guard(id, () => this.forgetMode(id));
        this.guard(id, () => this.forgetSubagents(id));
        if (!expected && this.lostTranscript(s, stderrTail)) {
          if (run) this.guard(id, () => this.cleanExited(id, run)); // 스스로 끝난 서버 claude — 다시 띄우기 전에 정리
          this.guard(id, () => this.resumeFailed(id, s)); // 오류로 멈추지 않고 새 대화로
        } else if (!expected && run) {
          this.guard(id, () => this.remoteExited(id, s, run, code, stderrTail));
        } else if (!expected) {
          this.guard(id, () => this.restoreInFlight(id, s)); // 기록 실패여도 아래 정리는 한다
          const why = s.errorText ?? EXITED;
          this.guard(id, () => this.record(id, { kind: 'notice', text: why }));
          this.errors.set(id, why);
          this.perms.cancelForAgent(id, EXITED);
        }
        this.emitStatus(id);
      }),
    );
    s.start();
    if (s.status === 'error') {
      // 폴더 없음 — 띄우지 않았다
      const why = s.errorText ?? EXITED;
      this.errors.set(id, why);
      this.emitStatus(id);
      throw new Error(why);
    }
    this.errors.delete(id);
    this.sessions.set(id, s);
    if (run) this.livePorts.add(run.port); // 끝날 때(exit) 놓는다 — 그동안 다른 서버 세션은 이 포트를 피한다
    this.lastActive.set(s, performance.now());
    this.handSlept.delete(id); // 깨웠다 — 손으로 재운 표는 풀린다
    if (wasAsleep) this.waking.add(s);
    if (allow) this.optioned.add(s);
    // 사용자가 켠 에이전트만(허용 + 스위치) — 어떤 입력(/effort 포함)보다, 상태 알림보다도 먼저 제어 요청을 쓴다(듣는 쪽이 바로 보내도 뒤에 선다).
    // 오류 뒤·새 대화·다시 띄우기가 모두 여기를 지난다. 띄운 직후엔 CLI 시작·--resume 대화 읽기 뒤에야 답하니 /effort 만큼 기다린다.
    // 계획 모드였던 에이전트, 또는 맨 앞에 기다리는 입력이 계획 먼저면 같은 자리에서 plan 으로 맞춘다(그 입력을 쓸 때 pump 는 바꾸는 중이라 건너뛴다) —
    // bypass 는 계획을 승인하거나 끈 뒤로(settleNormal) 미룬다(계획 없이 파일이 고쳐지는 틈을 두지 않는다)
    const sending = this.planWant.has(id) || this.held.get(id)?.[0]?.plan
      ? this.enterPlan(id, s)
      : allow && agent.bypassOn
        ? this.sendMode(id, s, BYPASS_MODE, {
          seq: this.nextModeSeq(id), timeoutMs: this.spawnModeTimeout(), failed: () => this.modeFailed(id, s, true, false),
        })
        : null;
    if (sending) {
      // 끝나면(답·실패 처리까지) 지운다 — 가는 동안만 flags 가 다음 모드를 알린다
      const applying: Promise<void> = sending.finally(() => {
        if (this.modeApplying.get(s) === applying) this.modeApplying.delete(s);
      });
      this.modeApplying.set(s, applying);
    }
    if (!o.quiet) this.emitStatus(id);
    // 막 띄운 세션은 한가하다 — 고른 effort 가 있으면 어떤 입력보다 먼저 /effort 를 쓴다(pump 는 부르지 않는다: router 가 deliver 중일 수 있다).
    // 전에 /effort 가 막혀 다시 띄운 에이전트면 /effort 없이(고르기·모델 바꾸기 전까지)
    const effortSent = !!agent.effort && !this.effortBroken.has(id);
    if (agent.effort && effortSent) this.sendEffort(id, s, agent.effort);
    // 내 설정 읽기(기다리지 않는다) — 고른 effort 가 없으면 지금 effort 를, 허용이면 내 기본 권한 모드를(bySettings 의 근거)
    if (!effortSent || allow) void this.readClaudeSettings(id, s);
    return s;
  }

  /**
   * --resume 실행의 init 전 사건 — init 이면 이어 왔다(표시를 지운다). 오류 result(error_during_execution)면 Claude 쪽 대화 기록이 없다는
   * 뜻이라(probe21) 표시만 하고 true — 그 사건은 버린다. 엔진이 멈추기를 보낸 세션이면 멈춘 차례의 끝일 수 있어 평소처럼 넘긴다
   * (정말 기록이 없으면 끝날 때 stderr 로 안다 — lostTranscript)
   */
  private noteResume(s: ClaudeSession, ev: StreamEvent): boolean {
    if (!this.resuming.has(s)) return false;
    if (ev.kind === 'init') this.resuming.delete(s);
    if (ev.kind !== 'result' || ev.subtype !== 'error_during_execution') return false;
    if (this.interrupted.has(s)) return false;
    this.resumeLost.add(s);
    return true;
  }

  /** 엔진이 보내는 멈추기 — 보낸 세션을 적어 둔다(noteResume) */
  private sendInterrupt(s: ClaudeSession): Promise<void> {
    this.interrupted.add(s);
    return s.interrupt();
  }

  /** --resume 실행이 init 없이 끝난 까닭이 Claude 쪽 대화 기록이 없어서인가 — 그 오류 result 를 봤거나 stderr 가 그렇게 말한다 */
  private lostTranscript(s: ClaudeSession, stderr: string): boolean {
    return this.resuming.has(s) && (this.resumeLost.has(s) || stderr.includes(NO_TRANSCRIPT_ERR));
  }

  /**
   * --resume 으로 띄운 세션이 Claude 쪽 대화 기록이 없어 끝났다(30일이 지나 지워짐 · 돌아간 대화의 기록이 없음 · 갈래 칠 원래 세션이 없음) —
   * 오류로 멈추지 않고 새 대화로: 경계(이어 가려던 세션 — 갈래면 이 에이전트의 대화가 아니라 세션 없이) · 알림 한 줄 · 새 세션 id(갈래 표시도 지운다).
   * 보낸 줄은 되살려 새 대화로 보내고, 기다리는 것이 없으면 고른 에이전트만 미리 띄운다. 상태는 부른 쪽(exit)이 알린다
   */
  private resumeFailed(id: AgentId, s: ClaudeSession): void {
    const ended = this.resuming.get(s)!;
    const fork = this.forking.has(s);
    this.guard(id, () => this.record(id, fork ? { kind: 'boundary' } : { kind: 'boundary', ended }));
    this.guard(id, () => this.record(id, { kind: 'notice', text: fork ? FORK_LOST_NOTICE : RESUME_LOST_NOTICE }));
    // 저장이 실패해도 아래 정리(보낸 줄 되살리기)는 한다 — 저장값은 메모리에선 이미 바뀌었다(store.updateAgent 는 바꾼 뒤 쓴다)
    this.guard(id, () => this.store.updateAgent(id, { sessionId: crypto.randomUUID(), started: false, forkOf: null }));
    this.forgetPastCount(id);
    this.guard(id, () => this.setContext(id, null));
    this.guard(id, () => this.restoreInFlight(id, s));
    this.perms.cancelForAgent(id, EXITED);
    // 되살린 내 말·다시 queued 가 된 메시지 — 새 대화로 띄워 보낸다(restartAfterEffort 와 같다)
    try {
      if (this.hasWaitingWork(id)) this.ensure(id, { quiet: true });
      else this.prewarm(id);
    } catch {
      return; // 폴더 없음 등 — ensure 가 status error·errorText 를 남겼다
    }
    this.pump(id);
  }

  /** 고른 effort 를 살아 있는 세션에 — 있으면 /effort 를 줄 맨 앞에 세우고(한가하면 바로), 없으면 내 설정을 읽는다 */
  private applyEffort(id: AgentId, s: ClaudeSession): void {
    const want = this.store.agent(id)?.effort;
    if (!want) {
      void this.readClaudeSettings(id, s);
      return;
    }
    this.effortWant.set(s, want); // 줄에 선 옛 값은 바뀐다
    this.pump(id);
  }

  /**
   * /effort 를 쓴다 — 상태는 working 으로 바꾸지 않고, 기록하지 않는다(그 차례의 이벤트는 onEffortEvent 가 삼킨다).
   * result 가 effortTimeoutMs 안에 안 오면 다시 띄운다(restartAfterEffort).
   */
  private sendEffort(id: AgentId, s: ClaudeSession, level: EffortLevel): void {
    this.effortWant.delete(s);
    const turn: EffortTurn = { heard: null, timer: null };
    this.effortTurn.set(s, turn);
    try {
      s.send([{ type: 'text', text: `/effort ${level}` }], { quiet: true });
      this.lastActive.set(s, performance.now());
    } catch {
      this.effortTurn.delete(s); // 이미 끝난 세션 — 다음에 띄울 때 다시 보낸다
      return;
    }
    turn.timer = setTimeout(() => {
      if (this.effortTurn.get(s) === turn) void this.restartAfterEffort(id, s, 'timeout');
    }, this.o.effortTimeoutMs ?? EFFORT_TIMEOUT_MS);
    turn.timer.unref?.();
    this.emitStatus(id); // 기다리는 사람 입력이 있으면 작업 중
  }

  /** /effort 차례를 끝낸다(타이머 끔) — result · 세션 끝 · 다시 띄우기 */
  private endEffortTurn(s: ClaudeSession): EffortTurn | undefined {
    const turn = this.effortTurn.get(s);
    if (!turn) return undefined;
    if (turn.timer) clearTimeout(turn.timer);
    this.effortTurn.delete(s);
    return turn;
  }

  /** 엔진이 보낸 /effort 차례의 이벤트 — 기록·사건 없이 삼키고, 답에서 지금 effort 를 읽는다 */
  private onEffortEvent(id: AgentId, s: ClaudeSession, ev: StreamEvent): void {
    const turn = this.effortTurn.get(s)!;
    if (ev.kind === 'init') {
      this.noteInit(id, ev); // /effort 만 받은 세션도 저장된다 — started 를 남겨야 다음 실행이 --resume 한다(같은 --session-id 는 거절됨)
    } else if (ev.kind === 'rate-limit') {
      this.onEvent(id, ev); // 사용량 신호는 평소처럼 알린다(기록은 원래 안 한다)
    } else if (ev.kind === 'assistant') {
      turn.heard ??= effortSaid(ev.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
    } else if (ev.kind === 'local-output') {
      turn.heard ??= effortSaid(ev.text); // 답을 <local-command-stdout> 로 내는 CLI 도 있을 수 있다
    } else if (ev.kind === 'result') {
      this.endEffortTurn(s);
      const heard = turn.heard ?? effortSaid(ev.text);
      // 그새 다시 고른 값이 줄에 서 있으면 이 답은 옛 값 — 받지 않는다(화면이 옛 값으로 돌아갔다 오지 않게).
      // 모르는 답(effort 없는 모델·바뀐 문구)이면 지금 값은 비운 채 — 화면은 고른 값을 보인다
      if (heard && !this.effortWant.has(s)) {
        this.effortNows.set(id, heard);
        this.emitEffort(id);
      }
      this.perms.cancelForAgent(id, TURN_ENDED, this.keepSubagentAsks(id)); // 끝난 차례에 남은 승인 질문(떠난 프로세스의 호출 등) — 평소 result 와 같게
      this.pump(id);
      this.emitStatus(id);
    }
  }

  /**
   * /effort 에 답이 없거나(timeout) 그 사이 사람이 멈췄다(interrupt). 같은 프로세스에 다음 줄을 이어 쓰면 늦게 온 /effort 답이
   * 그 줄의 답처럼 보이고 그 차례를 일찍 끝낸다 — 대신 세션을 끝내고, 다시 띄워 기다리던 입력·메시지를 보낸다.
   * 답이 없었으면 /effort 없이 띄우고 고르기·모델 바꾸기 전까지 다시 보내지 않는다(effortBroken · 대화에 안내 한 줄).
   * 멈추기면 /effort 부터 다시 보낸다(멀쩡한데 느린 시작일 수 있다 — 정말 막혔으면 다시 시간 초과가 잡는다).
   */
  private async restartAfterEffort(id: AgentId, s: ClaudeSession, why: 'timeout' | 'interrupt'): Promise<void> {
    try {
      if (this.closed || !this.effortTurn.has(s) || !this.live(id, s)) return;
      if (why === 'timeout') {
        // 막힌 CLI — 이번 실행 동안 /effort 없이(고르기·모델 바꾸기 전까지). 멈추기는 멀쩡한 /effort 일 수 있어 다시 띄울 때 /effort 부터 다시 보낸다
        this.effortBroken.add(id);
        this.guard(id, () => this.emit('engine-error', { agentId: id, message: EFFORT_STUCK }));
        this.guard(id, () => this.record(id, { kind: 'notice', text: EFFORT_STUCK_NOTICE }));
      }
      await this.endSession(id); // 기다리던 입력·queued 메시지는 그대로 — /effort 는 보낸 줄로 치지 않아 되살릴 것이 없다
      if (this.closed || this.removing.has(id) || !this.store.agent(id)) return;
      // 붙잡힌 메시지는 기다리는 것으로 치지 않는다 — 이어서 보내기를 고르면 그때 띄운다
      const waiting = this.hasWaitingWork(id);
      // 그새 누가 띄웠으면 그 세션을 쓴다. 상태는 보내고 나서 한 번만 알린다(다시 띄우는 사이 대기로 깜박이지 않게)
      if (!this.sessions.has(id) && waiting) this.ensure(id, { quiet: true });
      else this.prewarm(id); // 기다리는 것이 없으면 고른 에이전트만 다시 미리 띄운다
      this.pump(id);
      this.emitStatus(id);
    } catch (e) {
      this.guard(id, () => this.emitStatus(id));
      this.guard(id, () => this.emit('engine-error', { agentId: id, message: e instanceof Error ? e.message : String(e) }));
    }
  }

  /**
   * get_settings 를 읽는다 — 내 기본 권한 모드는 그 세션에 기억하고(bySettings 의 근거), effort 는 고른 값이 없을 때(또는 /effort 가
   * 막혀 적용하지 못했을 때)만 지금 값으로 받는다. 실패·시간 초과는 조용히 넘어간다. 고른 effort 가 있으면 effort 답은 버린다 —
   * 세션 값(/effort)을 모르는 설정 층이라 화면이 그 값으로 돌아간다.
   */
  private async readClaudeSettings(id: AgentId, s: ClaudeSession): Promise<void> {
    try {
      const res: any = await s.request({ subtype: 'get_settings' });
      if (!this.live(id, s)) return;
      this.noteSettingsDefault(id, s, res);
      if (this.store.agent(id)?.effort && !this.effortBroken.has(id)) return;
      const now = res?.effective?.effortLevel;
      if (!(EFFORT_LEVELS as readonly unknown[]).includes(now)) return;
      this.effortNows.set(id, now);
      this.emitEffort(id);
    } catch {
      /* 요청 실패·세션 종료 — 표시만 비운 채 둔다 */
    }
  }

  // ── 묻지 않음(bypass) ──
  private bypassTimeout(): number {
    return this.o.bypassTimeoutMs ?? BYPASS_TIMEOUT_MS;
  }

  /** 막 띄운 세션에 보낸 set_permission_mode 의 한도 — CLI 시작·--resume 대화 읽기 뒤에야 답한다 */
  private spawnModeTimeout(): number {
    return this.o.bypassSpawnTimeoutMs ?? this.o.bypassTimeoutMs ?? BYPASS_SPAWN_TIMEOUT_MS;
  }

  private nextModeSeq(id: AgentId): number {
    const n = (this.modeSeq.get(id) ?? 0) + 1;
    this.modeSeq.set(id, n);
    return n;
  }

  /**
   * get_settings 답의 내 기본 권한 모드(effective.permissions.defaultMode)를 그 세션과 에이전트에 기억한다 — 세션이 bypass 로 바뀌어도
   * 내 설정 값 그대로라(probe12) '내 설정 때문'을 가르는 근거이고, 세션이 끝난 뒤 다음 모드 예측의 근거다
   * (내 설정이 전부 허용이면 세션이 끝나도 경고 띠가 남게). 보이는 값이 바뀌면 flags
   */
  private noteSettingsDefault(id: AgentId, s: ClaudeSession, res: any): string | undefined {
    const m = res?.effective?.permissions?.defaultMode;
    if (typeof m !== 'string' || m === '') return undefined;
    const a = this.live(id, s) ? this.store.agent(id) : undefined;
    const shown = a ? this.flagsOf(a) : null;
    this.settingsDefaults.set(s, m);
    if (a) this.settingsDefaultOf.set(id, m);
    if (a && shown && !sameFlags(shown, this.flagsOf(a))) this.emitFlags(id);
    return m;
  }

  /** 두레가 켠 채 남은 bypass — 옵션으로 뜬 세션이 bypass 인데 내 설정의 기본 모드는 bypass 가 아니다(끄기 실패·늦은 켜기) */
  private leftover(id: AgentId): boolean {
    const s = this.sessions.get(id);
    return !!s && this.optioned.has(s) && this.modes.get(s) === BYPASS_MODE && this.settingsDefaults.get(s) !== BYPASS_MODE;
  }

  /**
   * 스위치 값을 살아 있는 세션에 — 세션이 없으면 할 일이 없다(다음에 띄울 때 ensure 가 한다). 던지지 않는다.
   * 켜기: 옵션으로 떴으면 바로 set_permission_mode. 아니면(허용 전에 띄운 세션 — bypass_not_launched 로 거절된다) 다시 띄운다:
   *   쉬는 중이면 지금, 아니면 그 차례가(서브에이전트가 돌면 그 일까지) 끝난 뒤 pump 가.
   * 끄기: 미뤄 둔 다시 띄우기를 거두고, 옵션으로 떴으면 내 Claude 설정의 기본 모드로. 옵션 없이 뜬 세션은 두레가 모드를 바꾼 적이 없어 보낼 것이 없다.
   * 이미 떠 있는 승인 카드는 그대로 둔다 — 사람이 답하면 평소처럼(probe11: 바꾼 뒤의 도구 호출부터 새 모드).
   * 계획 모드 중(또는 그리 바꾸는 중)이면 옵션으로 뜬 세션에도 모드를 보내지 않는다 — 계획 모드를 풀지 않고, 계획을 승인하거나 끄면 그때의
   * 평소 모드로 간다(settleNormal). 끄기 실패로 미뤄 둔 다시 띄우기만 거둔다(남은 bypass 가 아니라 계획 모드다)
   */
  private async applyBypass(id: AgentId, on: boolean): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.optioned.has(s) && this.inPlan(id, s)) {
      if (this.restartWant.delete(s)) this.pump(id);
      return; // 차례 번호도 그대로 — 가는 중인 계획 모드 바꾸기의 실패를 덮지 않게
    }
    // 차례 번호는 실제로 요청을 보내는 길에서만 올린다 — 보내는 것 없이 올리면 가는 중인 요청(계획 모드 등)의 실패를 말없이 덮는다
    if (on) {
      if (this.optioned.has(s)) {
        const deferred = this.restartWant.delete(s); // 끄기 실패로 미뤄 둔 다시 띄우기 — 다시 켜니 필요 없다
        await this.sendMode(id, s, BYPASS_MODE, { seq: this.nextModeSeq(id), failed: () => this.modeFailed(id, s, true, false) });
        if (deferred) this.pump(id); // 미뤄 둔 다시 띄우기가 막던 입력(아래와 같다)
        return;
      }
      const queued = this.restartWant.has(s);
      this.restartWant.add(s);
      if (this.resting(id, s) && this.subagentsSettled(id)) return this.restartForMode(id, s);
      if (queued) return; // 이미 그 차례 뒤로 미뤄 뒀다 — 안내는 한 번
      // 일하는·승인 기다리는 중이거나 서브에이전트가 돈다 — 그 차례·서브에이전트 일이 끝나면 pump 가 다시 띄운다. 그동안 스위치는 바뀌는 중(flags.pending), 대화에 안내 한 줄.
      // 다시 띄우면(세션이 끝나며 flags) 풀리고, 끄거나 허용을 끄면 아래에서 거둔다(그때의 flags 가 풀린 값을 알린다)
      this.emitFlags(id);
      this.guard(id, () => this.record(id, { kind: 'notice', text: BYPASS_RESTART_QUEUED_NOTICE }));
      return;
    }
    const deferred = this.restartWant.delete(s);
    if (this.optioned.has(s)) await this.settleOff(id, s, this.nextModeSeq(id));
    // 서브에이전트가 돌아 쉬는 채로 미뤄 둔 다시 띄우기가 입력·받은 메시지를 막고 있었다 — 거뒀으니 보낸다(차례 중이면 그 result 가)
    if (deferred) this.pump(id);
  }

  /** 내 Claude 설정의 기본 모드 — 못 읽으면 그 세션에 기억한 값, 그것도 없으면 'default' */
  private async defaultMode(id: AgentId, s: ClaudeSession): Promise<string> {
    try {
      const res: any = await s.request({ subtype: 'get_settings' }, this.bypassTimeout());
      return this.noteSettingsDefault(id, s, res) ?? this.settingsDefaults.get(s) ?? DEFAULT_MODE;
    } catch {
      return this.settingsDefaults.get(s) ?? DEFAULT_MODE;
    }
  }

  /**
   * 옵션으로 뜬 세션을 내 Claude 설정의 기본 모드로 — get_settings 로 읽고 set_permission_mode. 그새 끝났거나 다시 바뀌었으면 그만둔다.
   * quiet: 엔진이 바로잡는 끄기(켜기 실패 뒤 · 스위치가 꺼졌는데 bypass) — 내 설정이 bypass 면 바로잡을 것이 없고,
   * 실패해도 알리지 않고 다시 띄우기만 걸어 둔다. 계획 모드 중이면 그만둔다(계획 모드를 풀지 않는다 — 승인하거나 끄면 평소 모드로).
   * 던지지 않는다
   */
  private async settleOff(id: AgentId, s: ClaudeSession, seq: number, quiet = false): Promise<void> {
    this.offsInFlight.set(s, (this.offsInFlight.get(s) ?? 0) + 1);
    try {
      const mode = await this.defaultMode(id, s);
      if (!this.live(id, s) || this.modeSeq.get(id) !== seq) return; // 그새 세션이 끝났거나 다시 바뀌었다
      if (quiet && mode === BYPASS_MODE) return;
      if (this.inPlan(id, s)) return; // 그새 Claude 가 스스로 계획 모드가 됐다(두레가 바꿨으면 위의 차례 번호가 거른다)
      await this.sendMode(id, s, mode, { seq, failed: () => this.modeFailed(id, s, false, quiet) });
    } finally {
      this.offsInFlight.set(s, (this.offsInFlight.get(s) ?? 1) - 1);
    }
  }

  /**
   * set_permission_mode 를 쓴다 — 제어 요청이라 부르는 순간 줄에 들어간다(띄울 때 어떤 입력보다 먼저 쓰려고 ensure 가 바로 부른다).
   * 답의 mode 가 실제 모드다(manual → default, probe10) — 쉬는 세션도 다음 차례를 기다리지 않고 flags 로 알린다.
   * 실패(오류 응답·한도 안에 답 없음)는 failed(묻지 않음이면 modeFailed, 계획 모드면 planOnFailed·planOffFailed) — 그 세션이 이미 끝났거나
   * 그새 다시 바꿨으면 조용히 넘어간다(그 뒤에 보낸 요청이 claude 에서도 뒤에 처리되어 이긴다) — stillMine 이 참이면 그래도 알린다(계획 모드 요청).
   * failed 는 던지지 않아야 한다 — 이것도 던지지 않는다
   */
  private sendMode(
    id: AgentId,
    s: ClaudeSession,
    mode: string,
    o: { seq: number; timeoutMs?: number; failed: () => Promise<void> | void; stillMine?: () => boolean },
  ): Promise<void> {
    return s.request({ subtype: 'set_permission_mode', mode }, o.timeoutMs ?? this.bypassTimeout()).then(
      (res: any) => {
        if (!this.live(id, s)) return;
        const now = typeof res?.mode === 'string' ? res.mode : mode; // 답에 mode 가 없으면 받아들인 요청의 모드
        this.guard(id, () => this.setModeNow(id, now));
      },
      () => {
        if (!this.live(id, s)) return;
        if (this.modeSeq.get(id) !== o.seq && !o.stillMine?.()) return;
        return o.failed();
      },
    );
  }

  /**
   * 모드를 바꾸지 못했다(오류 응답·답 없음). flags 는 마지막 실제 모드 그대로.
   * 켜기: 스위치를 되돌리고(다음 실행에 몰래 켜지지 않게) 오류 한 줄 · 대화 안내 한 줄. 답 없이 지난 요청은 아직 claude 의 줄에 있어
   *   늦게 적용될 수 있다 — 끄기(내 기본 모드)를 이어 보내 덮는다(제어 요청은 차례대로 처리된다).
   * 끄기: 두레가 켠 bypass 가 남았다 — 쉴 때 다시 띄운다(--resume 이라 대화 그대로, 차례는 끊지 않는다. 스위치가 꺼져 있어 새 세션엔
   *   bypass 를 보내지 않는다). quiet 면 알리지 않는다(엔진이 바로잡던 끄기).
   */
  private async modeFailed(id: AgentId, s: ClaudeSession, on: boolean, quiet: boolean): Promise<void> {
    if (on) {
      this.guard(id, () => {
        if (this.store.agent(id)?.bypassOn) this.store.updateAgent(id, { bypassOn: false });
      });
      this.guard(id, () => this.emit('engine-error', { agentId: id, message: BYPASS_ON_FAILED }));
      this.guard(id, () => this.record(id, { kind: 'notice', text: BYPASS_ON_FAILED_NOTICE }));
      this.emitFlags(id);
      return this.settleOff(id, s, this.nextModeSeq(id), true);
    }
    if (!quiet) {
      this.guard(id, () => this.emit('engine-error', { agentId: id, message: BYPASS_OFF_FAILED }));
      this.guard(id, () => this.record(id, { kind: 'notice', text: BYPASS_OFF_FAILED_NOTICE }));
    }
    this.emitFlags(id);
    this.restartWant.add(s);
    if (this.resting(id, s) && this.subagentsSettled(id)) await this.restartForMode(id, s);
  }

  /**
   * 옵션으로 뜬 세션이 bypass 로 알렸는데(init) 스위치는 꺼져 있다 — 늦게 적용된 켜기 같은 것. 내 설정의 기본 모드가 bypass 가
   * 아니면 조용히 끈다(이미 끄는 중이면 그대로). 던지지 않는다
   */
  private reconcile(id: AgentId): Promise<void> | undefined {
    const s = this.sessions.get(id);
    const a = this.store.agent(id);
    if (!s || !a || !this.optioned.has(s) || (this.allow && a.bypassOn)) return undefined;
    if ((this.offsInFlight.get(s) ?? 0) > 0 || this.settingsDefaults.get(s) === BYPASS_MODE) return undefined;
    return this.settleOff(id, s, this.nextModeSeq(id), true);
  }

  /**
   * 권한 모드 때문에 세션을 다시 띄운다(--resume 이라 대화 그대로) — 옵션 없이 떠 있던 세션에서 켤 때(옵션을 붙여, 띄울 때 ensure 가
   * set_permission_mode 를 보낸다), 또는 끄기에 실패해 두레가 켠 bypass 가 남았을 때(스위치가 꺼져 있어 새 세션엔 보내지 않는다).
   * 기다리던 입력·메시지는 새 세션으로(effort 의 다시 띄우기와 같은 규칙). 기다리는 것이 없어도 띄운다 — 화면의 스위치는 실제 모드를
   * 보이니 새 세션의 답을 받아야 한다. 던지지 않는다
   */
  private async restartForMode(id: AgentId, s: ClaudeSession): Promise<void> {
    try {
      if (this.closed || !this.restartWant.delete(s) || !this.live(id, s)) return;
      const warm = this.prewarmed.has(s); // 미리 띄운 세션을 대신하면 새 세션도 미리 띄운 세션(줄을 받기 전까지 끌 수 있다)
      await this.endSession(id);
      if (this.closed || this.removing.has(id) || !this.store.agent(id)) return;
      // 그새 누가 띄웠으면(넘김 메시지 등) 그 세션을 쓴다. 상태는 보내고 나서 한 번만 알린다
      if (!this.sessions.has(id)) {
        const fresh = this.ensure(id, { quiet: true });
        if (warm) this.prewarmed.add(fresh);
      }
      const next = this.sessions.get(id);
      this.pump(id);
      this.emitStatus(id);
      if (next) await this.modeApplying.get(next);
    } catch (e) {
      this.guard(id, () => this.emitStatus(id));
      this.guard(id, () => this.emit('engine-error', { agentId: id, message: e instanceof Error ? e.message : String(e) }));
    }
  }

  /**
   * 지금 세션의 실제 모드 — init · status 줄 · set_permission_mode 응답(부른 쪽이 그 세션이 아직 지금 세션인지 본다).
   * 계획 모드가 되면(두레가 바꿨든 Claude 가 스스로든) 바라는 값을 남긴다 — 다시 띄워도 계획 모드로. 두레가 끄지 않았는데 계획 모드를
   * 나왔으면 사람이 계획을 승인해 CLI 가 스스로 기본 모드로 간 것(probe16) — 바라는 값을 거두고 평소 모드로 맞춘다(묻지 않음이면 bypass)
   */
  private setModeNow(id: AgentId, mode: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const prev = this.modes.get(s);
    this.modes.set(s, mode);
    this.emitFlags(id);
    if (mode === PLAN_MODE && prev !== PLAN_MODE) this.wantPlan(id, true);
    else if (prev === PLAN_MODE && mode !== PLAN_MODE && mode !== '' && this.wantPlan(id, false)) void this.settleNormal(id, s);
    else this.emitPlanMode(id);
  }

  /** status 줄이 알린 모드 — 바뀌었을 때만(같은 모드의 줄·응답이 겹쳐 와도 flags 를 거듭 알리지 않게) */
  private noteMode(id: AgentId, s: ClaudeSession, mode: string): void {
    if (mode === '' || this.modes.get(s) === mode) return;
    this.setModeNow(id, mode);
  }

  /**
   * 세션이 끝났다 — 그 세션의 모드는 세션과 함께 사라진다(두레가 켰을 수 있는 모드라 다음 세션의 모드가 아니다).
   * 알리는 값은 이제 다음에 띄울 때의 모드(내 설정이 전부 허용이면 그대로 bypass — 다음 세션이 다시 알린다 · 계획 모드는 바라는 값)
   */
  private forgetMode(id: AgentId): void {
    if (this.closed) return;
    this.emitFlags(id);
    this.emitPlanMode(id);
  }

  // ── 계획 먼저(plan) ──
  /** 계획 모드인가 — 세션의 실제 모드, 세션이 없거나 아직 모드를 모르면 바라는 값(띄울 때 맞춘다) */
  private planModeOf(id: AgentId): boolean {
    const s = this.sessions.get(id);
    const now = s ? this.modes.get(s) : undefined;
    return now === undefined ? this.planWant.has(id) : now === PLAN_MODE;
  }

  /** 계획 모드이거나 그리 바꾸는 중 — 바라는 값은 나왔음을 알면 바로 거두므로, 남아 있으면 계획 모드이거나 바꾸는 중이다 */
  private inPlan(id: AgentId, s: ClaudeSession): boolean {
    return this.planWant.has(id) || this.modes.get(s) === PLAN_MODE;
  }

  /** 바라는 계획 모드를 바꾼다(바뀌었으면 true) — 살아 있는 세션이 없으면 다음에 띄울 때의 모드(flags)도 바뀐다 */
  private wantPlan(id: AgentId, on: boolean): boolean {
    const changed = on !== this.planWant.has(id);
    if (on) this.planWant.add(id);
    else this.planWant.delete(id);
    if (changed && !this.sessions.has(id)) this.emitFlags(id);
    this.emitPlanMode(id);
    return changed;
  }

  /**
   * 평소 모드 — 묻지 않음이 켜진 에이전트면 bypass(옵션으로 뜬 세션만 바로 바꿀 수 있다 — 아니면 다시 띄우기가 켠다), 아니면 default.
   * 계획 승인 뒤엔 늘 보통(묻기)으로 — 내 Claude 설정의 기본 모드를 따르지 않는다
   */
  private normalMode(id: AgentId, s: ClaudeSession): string {
    return this.allow && this.store.agent(id)?.bypassOn && this.optioned.has(s) ? BYPASS_MODE : DEFAULT_MODE;
  }

  /**
   * 살아 있는 세션을 계획 모드로 — 바라는 값을 남기고(다시 띄울 때 쓴다) set_permission_mode plan. 아직 모드를 알린 적 없는 세션
   * (막 띄움·미리 띄운 뒤 아무 줄도 안 받음)은 시작·대화 읽기 중일 수 있어 띄울 때의 한도로 기다린다 — 늦은 답을 실패로 쳐 멈추지 않게.
   * 실패는 planOnFailed. 던지지 않는다
   */
  private enterPlan(id: AgentId, s: ClaudeSession): Promise<void> {
    this.wantPlan(id, true);
    const timeoutMs = this.modes.get(s) === undefined ? this.spawnModeTimeout() : undefined;
    const seq = this.nextModeSeq(id);
    this.planSeq.set(id, seq);
    const sent = this.sendMode(id, s, PLAN_MODE, {
      seq,
      timeoutMs,
      failed: () => this.planOnFailed(id, s),
      // 그새 다른 모드 바꾸기(묻지 않음 등)가 차례 번호를 올렸어도, 이것이 마지막 계획 모드 요청이고 아직 계획 모드를 바라는데 아니면 알린다 —
      // 말없이 넘기면 바라는 값이 남아(inPlan) 다음 계획 먼저 입력이 계획 모드 없이 나간다
      stillMine: () => this.planSeq.get(id) === seq && this.planWant.has(id) && this.modes.get(s) !== PLAN_MODE,
    });
    const entering: Promise<void> = sent.finally(() => {
      if (this.planEntering.get(s) === entering) this.planEntering.delete(s);
      this.guard(id, () => this.planSettled(id, s));
    });
    this.planEntering.set(s, entering);
    return entering;
  }

  /**
   * 계획 모드를 끈다(끄기·멈추기) — 바라는 값을 거두고, 살아 있는 세션이 계획 모드(또는 그리 바꾸는 중)면 평소 모드로.
   * 세션이 없으면 바라는 값만. 실패는 planOffFailed. 던지지 않는다
   */
  private leavePlan(id: AgentId): Promise<void> {
    const s = this.sessions.get(id);
    const was = this.planWant.has(id) || (!!s && this.modes.get(s) === PLAN_MODE);
    this.wantPlan(id, false);
    if (!s || !was) return Promise.resolve();
    return this.sendMode(id, s, this.normalMode(id, s), { seq: this.nextModeSeq(id), failed: () => this.planOffFailed(id, s) });
  }

  /**
   * 계획 모드가 끝났다(승인 · 바꾸기 실패) — 평소 모드가 bypass 인데 아직 아니면 맞춘다(띄울 때 계획 모드 때문에 미룬 것 · 승인 뒤 CLI 가 간 기본 모드).
   * 실패는 묻지 않음 켜기 실패와 같다(modeFailed). 던지지 않는다
   */
  private settleNormal(id: AgentId, s: ClaudeSession): Promise<void> {
    if (!this.live(id, s) || this.normalMode(id, s) !== BYPASS_MODE || this.modes.get(s) === BYPASS_MODE) return Promise.resolve();
    return this.sendMode(id, s, BYPASS_MODE, { seq: this.nextModeSeq(id), failed: () => this.modeFailed(id, s, true, false) });
  }

  /**
   * 계획 모드로 바꾸지 못했다(오류 응답·답 없음) — 바라는 값을 거두고 알린다. 차례가 도는 중이면 멈춘다: 그 차례는 계획 모드를 바라고 쓴 입력이다
   * (계획 없이 파일을 고치거나 명령을 실행하지 않게). 답을 기다리며 쥔 입력(planGates)은 쓰지 않고 붙잡는다(planSettled).
   * 띄울 때 미룬 bypass 는 지금 맞춘다. 던지지 않는다
   */
  private async planOnFailed(id: AgentId, s: ClaudeSession): Promise<void> {
    this.wantPlan(id, false);
    const working = s.status === 'working';
    // 쥐고 기다리던 계획 먼저 입력은 보내지 않고 붙잡는다(planSettled) — 그 차례를 멈춘 것과 같다
    const stopped = working || this.planGates.has(s);
    this.guard(id, () => this.emit('engine-error', { agentId: id, message: PLAN_ON_FAILED }));
    this.guard(id, () => this.record(id, { kind: 'notice', text: stopped ? PLAN_ON_FAILED_STOPPED_NOTICE : PLAN_ON_FAILED_NOTICE }));
    if (working) await this.sendInterrupt(s).catch(() => undefined);
    await this.settleNormal(id, s);
    // 계획 모드를 기다리는 동안 묻지 않음을 껐다(계획 모드 중이라 끄기를 보내지 않았다) — 아직 두레가 켠 bypass 면 내 기본 모드로
    if (this.live(id, s) && this.modes.get(s) === BYPASS_MODE) await this.reconcile(id);
  }

  /** 계획 모드를 끄지 못했다 — 아직 계획 모드면 바라는 값을 되살리고(실제와 같게 — 다시 띄워도 계획 모드) 알린다. 던지지 않는다 */
  private planOffFailed(id: AgentId, s: ClaudeSession): void {
    if (this.modes.get(s) === PLAN_MODE) this.wantPlan(id, true);
    this.guard(id, () => this.emit('engine-error', { agentId: id, message: PLAN_OFF_FAILED }));
    this.guard(id, () => this.record(id, { kind: 'notice', text: PLAN_OFF_FAILED_NOTICE }));
  }

  /** 계획 모드 표시가 바뀌었으면 알린다 — 바뀔 때만 */
  private emitPlanMode(id: AgentId): void {
    if (this.closed || this.removing.has(id) || !this.store.agent(id)) return;
    const on = this.planModeOf(id);
    if ((this.planShown.get(id) ?? false) === on) return;
    this.planShown.set(id, on);
    this.guard(id, () => this.emit('plan-mode', { agentId: id, on }));
  }

  private emitFlags(id: AgentId): void {
    if (this.removing.has(id)) return;
    const a = this.store.agent(id);
    if (!a) return;
    this.guard(id, () => this.emit('flags', { agentId: id, ...this.flagsOf(a) }));
  }

  /** 차례 끝에 대화 공간을 받는다 — 실패·모르는 모양·그새 바뀐 세션이면 조용히 넘어간다 */
  private async fetchContext(id: AgentId, s: ClaudeSession): Promise<void> {
    try {
      const raw = await s.request({ subtype: 'get_context_usage', detail: 'summary' });
      if (!this.live(id, s)) return;
      const value = toContextUsage(raw, Date.now());
      if (value) this.guard(id, () => this.setContext(id, value));
    } catch {
      /* 요청 실패·세션 종료 — 링은 마지막 값 그대로 */
    }
  }

  private setContext(id: AgentId, value: ContextUsage | null): void {
    if (this.removing.has(id) || !this.store.agent(id)) return;
    this.store.updateAgent(id, { lastContext: value });
    this.emit('context', { agentId: id, value });
  }

  /** 늦게 온 답을 받아도 되는가 — 그 세션이 아직 그 에이전트의 세션이고 에이전트도 있다 */
  private live(id: AgentId, s: ClaudeSession): boolean {
    return this.sessions.get(id) === s && !this.removing.has(id) && !!this.store.agent(id);
  }

  /** Claude 에게 읽은 지금 effort 를 잊는다(세션이 끝남·모델 바뀜) — 알고 있었으면 사건으로 알린다(화면은 내가 정한 값으로) */
  private forgetEffortNow(id: AgentId): void {
    if (!this.effortNows.delete(id)) return;
    if (!this.closed) this.emitEffort(id);
  }

  private emitEffort(id: AgentId): void {
    if (this.removing.has(id)) return;
    const a = this.store.agent(id);
    if (!a) return;
    this.guard(id, () => this.emit('effort', { agentId: id, effort: a.effort, effortNow: this.effortNow(id) }));
  }

  private onEvent(id: AgentId, ev: StreamEvent): void {
    if (ev.kind === 'control-response') return; // 내부 응답 — initialize 의 account 같은 것이 밖으로 새지 않게
    // 부모 차례 밖의 API 상태(서브에이전트만 도는 동안의 요청·result 뒤 늦게 온 끝) — 부모의 단계가 아니다
    if (ev.kind === 'api-status' && this.sessions.get(id)?.status !== 'working') return;
    // 시작을 보지 못한 일의 끝 — 서브에이전트가 아닌 일(백그라운드 명령 등)이다. 기록도 사건도 없다
    if (ev.kind === 'task-ended' && !this.subagents.get(id)?.has(ev.taskId)) return;
    if (ev.kind === 'compacted') {
      const cur = this.sessions.get(id);
      if (cur) this.compactedTurn.add(cur);
      this.guard(id, () => this.setContext(id, null));
    }
    if (ev.kind === 'init') this.noteInit(id, ev);
    if (ev.kind === 'tool-result' && !ev.parent) this.noteLaunched(id, ev.toolUseId);
    if (ev.kind === 'tool-result') {
      // 바뀐 줄(patch)은 싣지 않는다 — 자르지 않은 것(만듦이면 파일 통째)이 IPC 로 가지 않게. 화면은 기록(줄인 것)에서 읽는다
      const { patch: _patch, ...shown } = ev;
      this.guard(id, () =>
        this.emit('agent-event', { agentId: id, event: shown, viaApproval: this.perms.wasAsked(id, ev.toolUseId) }),
      );
    } else {
      this.guard(id, () => this.emit('agent-event', { agentId: id, event: ev }));
    }
    // 시작은 도는 목록을 먼저 고치고 기록한다(기록만 보이고 도는 목록에 없는 틈이 '끊김' 으로 보이지 않게),
    // 끝은 기록을 먼저 남기고 목록에서 뺀다(목록에서 빠졌는데 끝 기록이 없는 틈이 없게)
    if (ev.kind === 'task-started') this.guard(id, () => this.noteSubagent(id, ev));
    this.guard(id, () => this.recordEvent(id, ev));
    if (ev.kind === 'task-ended') this.guard(id, () => this.noteSubagent(id, ev));
    // 세션은 result 를 내보내기 직전에 idle 이 된다 — 이 차례의 result 를 먼저 알린 뒤 다음 입력을 보낸다
    if (ev.kind === 'result') {
      // 끝난 차례엔 살아 있는 부모의 권한 질문이 있을 수 없다 — 남은 것(떠난 프로세스의 호출 등)은 정리해야 다음 입력이 나간다.
      // 도는 서브에이전트가 물은 것은 남긴다 — 부모 차례가 끝나도 서브에이전트는 그 답을 기다린다(spec §4.4)
      this.perms.cancelForAgent(id, TURN_ENDED, this.keepSubagentAsks(id));
      this.guard(null, () => this.watcher?.turnEnded());
      const cur = this.sessions.get(id);
      if (cur) {
        if (this.compactedTurn.delete(cur)) {
          /* 요약한 차례 — 값을 받지 않는다(옛 값이 되살아나지 않게) */
        } else {
          void this.fetchContext(id, cur);
        }
        this.armMidGrace(id, cur);
      }
      this.pump(id);
    }
  }

  /** 차례의 init — 시작됨 · 권한 모드 · 풀린 모델 id(엔진이 보낸 /effort 차례에서도) */
  private noteInit(id: AgentId, ev: Extract<StreamEvent, { kind: 'init' }>): void {
    // 저장은 한 번에 — 나눠 쓰다 뒤 것만 실패하면 갈래가 다시 갈래 친다. 실패해도 init 은 알린다(다음 차례의 init 때 다시 쓴다)
    this.guard(id, () => {
      const agent = this.store.agent(id);
      const patch: AgentPatch = {};
      // 이어 받은 세션이 다른 id 로 시작하면 저장값을 그것으로 — 다음 --resume 이 맞는 세션을 가리키게(지난 대화 수도 다시 센다)
      if (ev.sessionId && agent?.sessionId !== ev.sessionId) patch.sessionId = ev.sessionId;
      if (agent?.started === false) patch.started = true;
      // 갈래 친 새 세션이 생겼다 — 다음 실행부터는 이 세션을 --resume
      if (agent?.forkOf) patch.forkOf = null;
      if (!Object.keys(patch).length) return;
      if (patch.sessionId) this.forgetPastCount(id); // 저장이 실패해도 메모리 값은 바뀐다(store.updateAgent 는 바꾼 뒤 쓴다)
      this.store.updateAgent(id, patch);
    });
    this.guard(id, () => {
      this.setModeNow(id, ev.permissionMode);
      // 스위치가 꺼졌는데 옵션으로 뜬 세션이 bypass — 늦게 적용된 켜기 같은 것. 내 설정 때문이 아니면 끈다
      if (ev.permissionMode === BYPASS_MODE) void this.reconcile(id);
    });
    this.guard(id, () => this.setModelNow(id, ev.model || null));
  }

  /** 서브에이전트 시작·끝 — 도는 목록을 고치고 알린다(세션이 쉬어도 도는 동안은 작업 중) */
  private noteSubagent(id: AgentId, ev: Extract<StreamEvent, { kind: 'task-started' | 'task-ended' }>): void {
    if (ev.kind === 'task-started') {
      const running = this.subagents.get(id) ?? new Map<string, RunningSubagent>();
      if (running.get(ev.taskId)?.toolUseId === ev.toolUseId) return; // 이미 아는 시작 — 목록이 그대로다
      running.set(ev.taskId, { toolUseId: ev.toolUseId, background: false });
      this.subagents.set(id, running);
    } else {
      const running = this.subagents.get(id);
      const ended = running?.get(ev.taskId);
      if (!running || !ended) return;
      running.delete(ev.taskId);
      if (running.size === 0) this.subagents.delete(id);
      // 뒤에서 돈 것 — Claude 가 보고를 전하려고 스스로 차례를 연다(probe13, 부모 차례 중이면 그 뒤에 — probe14 B).
      // 그 차례를 기다린다(작업 중 그대로 · 다시 띄우기·/effort 는 미룬다). 앞에서 돈 것의 보고는 부모 차례 안에서 이어진다
      if (ended.background) this.expectAutoTurn(id);
    }
    this.emitSubagents(id);
    // 마지막 서브에이전트가 끝났다 — 쉬는 중이면 미뤄 둔 일을 꺼낸다(기다릴 차례가 있으면 pump 가 기다림을 잰다). 뒤에서 돈다는 표시는
    // 차례 순서로 짐작한 것이라(앞에서 돌던 것이 멈춘 차례 뒤에 끝나는 등) 표시와 상관없이 — 안 하면 다시 띄우기·입력이 다음 계기까지 막힌다
    if (ev.kind === 'task-ended' && !this.subagents.has(id)) this.guard(id, () => this.pump(id));
    this.emitStatus(id);
  }

  /** 부모가 받은 하는 일 결과 — 아직 도는 서브에이전트의 Agent 면 뒤에서 도는 것이다(Async agent launched, probe13) */
  private noteLaunched(id: AgentId, toolUseId: string): void {
    for (const sub of this.subagents.get(id)?.values() ?? []) if (sub.toolUseId === toolUseId) sub.background = true;
  }

  /** 뒤에서 돈 서브에이전트가 끝났다 — Claude 가 스스로 열 차례 하나를 기다린다(기다림은 쉴 때 pump 가 잰다) */
  private expectAutoTurn(id: AgentId): void {
    const wait = this.autoTurns.get(id) ?? { left: 0, timer: null };
    wait.left++;
    this.autoTurns.set(id, wait);
  }

  /**
   * 기다리는 차례가 있고, 서브에이전트가 다 끝났고, 세션이 쉬면 기다림(autoTurnGraceMs)을 잰다 — 이미 재고 있으면 그대로.
   * 다 지나도 차례가 안 오면(멈추기로 끝났다 — probe14 C) 기다림을 접고 미뤄 둔 다시 띄우기·/effort 를 꺼낸다. 그때 차례 중이면
   * 그 result 의 pump 가 다시 잰다
   */
  private armAutoTurn(id: AgentId): void {
    const wait = this.autoTurns.get(id);
    const s = this.sessions.get(id);
    if (!wait || wait.timer || !s || this.subagents.has(id) || !this.resting(id, s)) return;
    const over = () => {
      if (this.autoTurns.get(id) !== wait) return; // 그새 차례가 왔거나 세션이 끝났다
      wait.timer = null;
      const cur = this.sessions.get(id);
      if (!cur || this.subagents.has(id) || !this.resting(id, cur)) return; // 차례 중·승인 대기·새 서브에이전트 — 끝나면 다시 잰다
      this.autoTurns.delete(id);
      this.guard(id, () => this.pump(id));
      this.emitStatus(id); // 보내고 나서 — 곧바로 다시 일하면 대기로 깜박이지 않게
    };
    wait.timer = setTimeout(() => this.guard(id, over), this.o.autoTurnGraceMs ?? AUTO_TURN_GRACE_MS);
    wait.timer.unref?.();
  }

  /**
   * 차례가 시작됐다(init) — 기다림 시계를 멈춘다(차례가 끝나 다시 쉬면 pump 가 처음부터 잰다 — 차례 앞에 걸어 둔 시계가 그 차례를 지나
   * 이어 가 끝난 뒤의 기다림이 거의 없어지지 않게). own: 보낸 줄 없이 온 init — Claude 가 스스로 연 차례라 기다리던 것 하나가 왔다
   */
  private turnStarted(id: AgentId, own: boolean): void {
    const wait = this.autoTurns.get(id);
    if (!wait) return;
    if (wait.timer) clearTimeout(wait.timer);
    wait.timer = null;
    if (own && --wait.left <= 0) this.autoTurns.delete(id);
  }

  /**
   * 세션이 끝났다 — 그 세션이 돌리던 서브에이전트도 끝났고, 스스로 열 차례도 오지 않는다. 끝 기록은 남기지 않는다
   * (화면은 끝 기록 없는 서브에이전트를 끊김으로 본다)
   */
  private forgetSubagents(id: AgentId): void {
    const wait = this.autoTurns.get(id);
    if (wait?.timer) clearTimeout(wait.timer);
    this.autoTurns.delete(id);
    if (this.subagents.delete(id)) this.emitSubagents(id);
  }

  private emitSubagents(id: AgentId): void {
    if (this.closed || this.removing.has(id) || !this.store.agent(id)) return;
    this.guard(id, () => this.emit('subagents', { agentId: id, running: this.subagentsRunning(id) }));
  }

  /** 고친 일을 불렀다 — 결과에 바뀐 줄이 없을 때 쓸 입력 묶음을 줄여 둔다(Edit·MultiEdit 만 만들 수 있다) */
  private noteEdits(id: AgentId, ev: Extract<StreamEvent, { kind: 'assistant' }>): void {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const b of ev.blocks) {
      if (b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name) || typeof b.id !== 'string') continue;
      const pending = this.edits.get(s) ?? new Map<string, { patch: DiffHunk[]; cut: boolean } | null>();
      this.edits.set(s, pending);
      const hunks = patchFromInput(b.name, b.input);
      pending.set(b.id, hunks ? capPatch(hunks) : null);
      if (pending.size > EDITS_PENDING_MAX) pending.delete(pending.keys().next().value!);
    }
  }

  /**
   * 고친 일의 결과 — 기록할 바뀐 줄: 결과의 structuredPatch, 없으면 부를 때 본 입력으로 만든 것. 둘 다 400줄·줄당 500자로 줄였다.
   * 고친 일이 아니거나(만듦 포함) 실패·거절이면 없다
   */
  private takeEdit(id: AgentId, ev: Extract<StreamEvent, { kind: 'tool-result' }>): { patch: DiffHunk[]; cut: boolean } | null {
    const s = this.sessions.get(id);
    const pending = s && this.edits.get(s);
    if (!pending?.has(ev.toolUseId)) return null;
    const fromInput = pending.get(ev.toolUseId) ?? null;
    pending.delete(ev.toolUseId);
    if (ev.isError) return null;
    const diff = ev.patch ? capPatch(ev.patch) : fromInput;
    return diff && diff.patch.length > 0 ? diff : null;
  }

  private recordEvent(id: AgentId, ev: StreamEvent): void {
    if (ev.kind === 'assistant') {
      this.noteEdits(id, ev);
      this.record(id, {
        kind: 'assistant',
        // 하는 일 입력은 화면이 읽는 칸만 — 파일 본문·넘김 본문으로 기록 파일이 커지지 않게(이벤트로 나가는 것도 같은 모양)
        blocks: ev.blocks.map((b) => (b.type === 'tool_use' ? { ...b, input: trimToolInput(b.input) } : b)),
        ...(ev.parent ? { parent: ev.parent } : {}), // 서브에이전트 줄 — 부모의 Agent tool_use id
      });
    } else if (ev.kind === 'tool-result') {
      const diff = this.takeEdit(id, ev);
      this.record(id, {
        kind: 'tool-result',
        toolUseId: ev.toolUseId,
        isError: ev.isError,
        text: ev.text.slice(0, TOOL_TEXT_KEEP),
        viaApproval: this.perms.wasAsked(id, ev.toolUseId),
        ...(ev.parent ? { parent: ev.parent } : {}),
        // 수정의 바뀐 줄 — 기록용으로 줄인 것(잘랐으면 patchCut)
        ...(diff ? { patch: diff.patch, ...(diff.cut ? { patchCut: true as const } : {}) } : {}),
      });
    } else if (ev.kind === 'task-started')
      this.record(id, {
        kind: 'subagent-start',
        toolUseId: ev.toolUseId,
        taskId: ev.taskId,
        description: ev.description,
        subagentType: ev.subagentType,
        parentTaskId: ev.parentTaskId,
      });
    else if (ev.kind === 'task-ended')
      this.record(id, {
        kind: 'subagent-end',
        toolUseId: ev.toolUseId,
        taskId: ev.taskId,
        status: ev.status,
        summary: ev.summary.slice(0, TOOL_TEXT_KEEP),
        toolUses: ev.toolUses,
        durationMs: ev.durationMs,
      });
    else if (ev.kind === 'local-output') this.record(id, { kind: 'local-output', text: ev.text });
    else if (ev.kind === 'result') this.record(id, { kind: 'result', ok: ev.ok, subtype: ev.subtype });
  }

  /** 콜백 안의 오류를 삼키고 'engine-error' 로 알린다('error' 는 듣는 쪽이 없으면 Node 가 던진다) */
  private guard(agentId: AgentId | null, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      try {
        this.emit('engine-error', { agentId, message: e instanceof Error ? e.message : String(e) });
      } catch {
        /* engine-error 듣는 쪽의 오류까지는 어쩔 수 없다 — 삼킨다 */
      }
    }
  }

  /** 세션을 맵에서 빼고(이후 이벤트 무시) 승인 대기를 정리한 뒤 멈춘다 — 상한 STOP_LIMIT_MS */
  /** now: 기다리지 않고 바로 끈다(ClaudeSession.stop) — 써 둔 줄을 Claude 가 마저 읽지 않게 */
  private async endSession(id: AgentId, o: { now?: boolean } = {}): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    this.ungate(id, s); // 계획 모드 답을 기다리며 쥔 입력 — 쓰지 않았으니 다음 세션이 받는다(기다리는 줄 맨 앞)
    if (s) this.endEffortTurn(s); // /effort 차례 중이었으면 그 타이머도
    if (s) this.forgetSeen(s);
    if (s) this.edits.delete(s); // 결과를 기다리던 고친 일 — 끝낸 세션의 결과는 오지 않는다
    this.errors.delete(id);
    this.guard(id, () => this.forgetEffortNow(id)); // 끝난 세션의 지금 값은 다음 세션의 값이 아니다
    if (s) this.guard(id, () => this.forgetMode(id)); // 알리는 권한 모드도 — 이제 다음에 띄울 때의 모드
    this.guard(id, () => this.forgetSubagents(id)); // 그 세션이 돌리던 서브에이전트도 함께 끝난다
    this.perms.cancelForAgent(id, EXITED);
    if (!s) return;
    const run = this.remoteRuns.get(s);
    if (run) {
      run.ended = true; // 이제 온 pid 는 저장하지 않고 정리한다
      this.portTries.delete(id); // 첫 줄 전에 내렸어도 포트 다시 시도는 여기서 접는다 — 다음 띄우기는 다시 처음부터
    }
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((r) => {
      timer = setTimeout(r, this.o.stopLimitMs ?? STOP_LIMIT_MS);
    });
    this.unstopped.add(s);
    const stop = s.stop(o).catch(() => undefined).finally(() => this.unstopped.delete(s));
    const stopped = Promise.race([stop, limit]).then(() => clearTimeout(timer));
    this.stopping.add(stopped);
    // 서버 방 — ssh 를 끈 뒤 서버에 정리를 따로 보낸다(같은 에이전트의 다음 띄우기는 그 정리를 기다린다). 끄기는 기다리지 않는다
    if (run) this.guard(id, () => this.cleanAfterStop(id, run, stopped));
    try {
      await stopped;
    } finally {
      this.stopping.delete(stopped);
    }
    this.restoreInFlight(id, s); // 멈출 때까지도 못 읽은 줄
  }

  /** 보낸 줄을 읽기 전에 끝났다 — 메시지는 queued 로, 사람 입력은 기다리는 줄 맨 앞으로(다음 실행·flushAll 때 다시) */
  private restoreInFlight(id: AgentId, s: ClaudeSession): void {
    const lost = this.inFlight.get(s) ?? [];
    this.inFlight.delete(s);
    this.clearMidGrace(s);
    const inputs: HeldInput[] = [];
    for (const x of lost) {
      if (x.kind === 'relay') for (const m of x.messageIds) this.router.requeue(m);
      else inputs.push(x.input);
    }
    if (inputs.length) {
      this.heldOf(id).unshift(...inputs); // 보낸 차례대로 맨 앞에
      this.emitHeld(id);
    }
  }

  /**
   * 상태가 바뀌었으면 알린다 — 잠듦도 여기서 함께 견준다(띄우기·끄기·재우기·스스로 죽음·오류·지우기가 모두 이 자리를 지난다).
   * 상태를 듣는 쪽이 던져도 잠듦은 알린다
   */
  private emitStatus(id: AgentId): void {
    if (this.removing.has(id) || !this.store.agent(id)) return;
    try {
      const status = this.status(id);
      const errorText = this.errorText(id);
      const issue = this.remoteIssues.get(id) ?? null;
      const prev = this.shown.get(id) ?? { status: 'idle', errorText: null, issue: null };
      if (prev.status === status && prev.errorText === errorText && prev.issue === issue) return;
      this.shown.set(id, { status, errorText, issue });
      // 서버 방 에이전트만 문제 칸을 싣는다 — 이 PC 방의 상태 사건은 그대로
      const agent = this.store.agent(id);
      const remote = !!agent && !!this.remoteOf(agent);
      this.emit('status', remote ? { agentId: id, status, errorText, remoteIssue: issue } : { agentId: id, status, errorText });
    } finally {
      this.guard(id, () => this.emitSleep(id));
    }
  }
}

type Flags = { bypass: boolean; bySettings: boolean; pending: boolean };
function sameFlags(x: Flags, y: Flags): boolean {
  return x.bypass === y.bypass && x.bySettings === y.bySettings && x.pending === y.pending;
}

/**
 * 보낸 줄을 읽었다는 뜻인 사건 — 부모의 줄(init·글·하는 일·result 등). 제어 응답 · 서브에이전트 줄(parent) · 서브에이전트 시작·끝 ·
 * 버린 줄(task_progress·task_updated·background_tasks_changed 같은 서브에이전트·백그라운드 system 줄 — 세션이 보통 먼저 거른다)은
 * 보낸 줄과 상관없이 온다(부모 차례가 끝난 뒤에도 서브에이전트는 돈다). 생각 신호(thinking)·API 상태(api-status)도 치지 않는다 —
 * 늘 그 차례의 init 뒤에 오니 읽은 표시는 init 이 이미 했다
 */
/** 보낸 말의 글 — 되돌림(replay)과 맞출 때. 쓴 글 블록만 줄바꿈으로(첨부의 경로 줄 블록 포함 — 되돌림도 같은 꼴) */
function inputText(parts: ReadyPart[]): string {
  return sentText(parts);
}

/** Claude 자격 증명 파일 이름인가 — 대소문자 없이(윈도 파일 이름) */
function isCredentials(p: string): boolean {
  return path.basename(p).toLowerCase() === CREDENTIALS_FILE;
}

/** 첨부가 하나도 없는 입력 — 준비 없이 그대로 보낼 꼴 */
function noFiles(parts: UserPart[]): parts is Exclude<UserPart, FileInput>[] {
  return !parts.some((p) => p.type === 'file');
}

/** 서버에 올린 첨부의 사본 이름들(서버 방 — remotePath 가 있는 것) */
function uploadedOf(parts: ReadyPart[]): string[] {
  return parts.flatMap((p) => (p.type === 'file' && p.remotePath ? [p.file] : []));
}

/** 첨부를 읽거나 복사하지 못한 까닭 — 흔한 것은 쉬운 말로, 그 밖은 오류의 첫 줄 */
function fileErrorText(e: unknown): string {
  switch ((e as NodeJS.ErrnoException | null)?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return '찾을 수 없어요';
    case 'EACCES':
    case 'EPERM':
      return '읽을 권한이 없어요';
    case 'EBUSY':
      return '다른 프로그램이 쓰고 있어요';
    case 'ENOSPC':
      return '디스크에 빈 자리가 없어요';
    case 'EISDIR':
      return ATTACH_FOLDER;
    default: {
      // 원문(영어·내 PC 경로가 섞인다)은 보이지 않는다 — 오류 코드만 덧붙인다
      const code = errCode(e);
      return code ? `읽을 수 없어요(${code})` : '읽을 수 없어요';
    }
  }
}

/** 오류의 코드(EACCES 같은 대문자 꼴일 때만) — 화면 글에 원문 대신 덧붙인다. 아니면 null */
function errCode(e: unknown): string | null {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : null;
}

/** p 가 끝나거나 signal 이 끊길 때까지 — 끊기면 p 를 기다리지 않는다(p 가 없거나 이미 끊겼으면 바로). p 의 거절은 삼킨다 */
function untilAborted(p: Promise<unknown> | undefined, signal: AbortSignal): Promise<void> {
  if (!p || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    void p.then(done, done);
  });
}

/** realpath 가 이 까닭으로 실패하면 보내지 않는다 — 그 밖(EINVAL·UNKNOWN …)은 이름 검사만으로 넘어간다 */
const REALPATH_FATAL = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY']);

function readsInput(ev: StreamEvent): boolean {
  if (
    ev.kind === 'control-response' || ev.kind === 'task-started' || ev.kind === 'task-ended' || ev.kind === 'ignored' || ev.kind === 'thinking' ||
    ev.kind === 'api-status' || ev.kind === 'background-tasks'
  ) return false;
  return !((ev.kind === 'assistant' || ev.kind === 'tool-result') && ev.parent);
}

/** 붙잡기 목록의 글 — 첫 줄(앞뒤 빈칸을 자르고 HOLD_TEXT_MAX 자까지, 코드 포인트로). 글이 없으면 '' */
function firstLine(s: string): string {
  const line = (s.trim().split(/\r?\n/, 1)[0] ?? '').trim();
  return [...line].slice(0, HOLD_TEXT_MAX).join('');
}

/** 붙잡은 내 입력 — 글은 글 칸들을 이은 것의 첫 줄(경로 줄은 빼고), 그림·첨부는 수만(첨부는 있을 때만) */
function humanItem(input: HeldInput): HoldItem {
  const texts = input.parts.flatMap((p) => (p.type === 'text' ? [p.text] : []));
  const images = input.parts.filter((p) => p.type === 'image').length;
  const files = input.parts.filter((p) => p.type === 'file').length;
  return { id: input.id, source: 'human', from: null, text: firstLine(texts.join('\n')), images, ...(files ? { files } : {}) };
}

/** 붙잡은 전달 대기 메시지 — id 는 메시지 id, 보낸 쪽은 보낸 에이전트 */
function relayItem(m: RelayMessage): HoldItem {
  return { id: m.id, source: 'relay', from: m.from, text: firstLine(m.text), images: 0 };
}

/** /effort 답에서 정해진 단계 — 모르는 말이면 null */
function effortSaid(text: string): EffortLevel | null {
  const m = EFFORT_SET.exec(text);
  return m ? (m[1] as EffortLevel) : null;
}


function toDescription(p: any): AgentDescription {
  // 필요한 필드만 골라 담는다 — account(이메일)는 읽지도 남기지도 않는다
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  return {
    commands: list(p?.commands).map((c) => ({
      name: String(c?.name ?? ''),
      description: String(c?.description ?? ''),
      argumentHint: String(c?.argumentHint ?? ''),
    })),
    models: list(p?.models).map((m) => ({
      value: String(m?.value ?? ''),
      displayName: String(m?.displayName ?? ''),
      ...(typeof m?.description === 'string' ? { description: m.description } : {}),
      ...(typeof m?.resolvedModel === 'string' ? { resolvedModel: m.resolvedModel } : {}),
      ...(m?.supportsEffort === true
        ? {
            supportsEffort: true,
            effortLevels: list(m?.supportedEffortLevels).filter((l): l is EffortLevel => (EFFORT_LEVELS as readonly unknown[]).includes(l)),
          }
        : {}),
    })),
    permissionMode: String(p?.current_permission_mode ?? ''),
  };
}

export async function createEngine(o: EngineOptions): Promise<Engine> {
  const engine = new EngineImpl(o, openStore(o.dataDir), openMessageLog(o.dataDir), openHistory(o.dataDir));
  await engine.init();
  return engine;
}
