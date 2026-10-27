export type RoomId = string;
export type AgentId = string;

export interface Room {
  id: RoomId;
  name: string;
  createdAt: number;
}

/** Windows 알림 — asks: 승인·질문이 올 때 · finished: 일을 끝냈을 때(창이 가려져 있을 때만 뜬다) */
/** 화면 테마 — system 은 Windows 설정을 따라간다 */
export type ThemePref = 'light' | 'dark' | 'system';
export const THEME_PREFS: readonly ThemePref[] = ['light', 'dark', 'system'];

export interface NotifyPrefs {
  asks: boolean;
  finished: boolean;
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** 쉬는 에이전트 재우기까지의 시간(분) — 0 = 끔. settings.json 의 sleepAfterMin, 없거나 이 밖의 값이면 SLEEP_DEFAULT_MIN */
export const SLEEP_CHOICES = [0, 15, 30, 60, 180] as const;
export const SLEEP_DEFAULT_MIN = 30;
/**
 * 지금 재울 수 없는 까닭(앞의 것부터 하나) — working 일하는 중 · asking 사람 답을 기다림(승인·질문·계획·에이전트 만들기) ·
 * waiting-input 기다리는 입력·붙잡기 · subagents 서브에이전트가 일하는 중 · background 뒤에서 명령이 도는 중 · unread 보낸 줄을 아직 안 읽음
 */
export type SleepBlock = 'working' | 'asking' | 'waiting-input' | 'subagents' | 'background' | 'unread';

export interface UsageWindow {
  key: 'session' | 'week' | `model:${string}`;
  label: string;
  percent: number;
  resetsAt: number | null;
}
export interface PlanUsage {
  windows: UsageWindow[];
  at: number;
}
export interface ContextUsage {
  total: number;
  max: number;
  percent: number;
  autoCompactAt: number | null;
  at: number;
}

export interface Agent {
  id: AgentId;
  roomId: RoomId;
  name: string;
  role: string;
  folder: string;
  sessionId: string;
  started: boolean;
  auto: boolean;
  model: string | null;
  alwaysAllow: string[];
  pos: { x: number; y: number };
  color: string | null;
  effort: EffortLevel | null;
  lastContext: ContextUsage | null;
  /** 사용자가 켠 '묻지 않음' — 옛 기록엔 없음 → false */
  bypassOn: boolean;
  /** 이 에이전트의 '묻지 않고 실행해요' 경고를 닫음 — 다시 띄우지 않는다(옛 기록엔 없음 → false) */
  bypassNoticeClosed?: boolean;
}

export type AgentPatch = Partial<
  Pick<Agent, 'name' | 'role' | 'auto' | 'model' | 'alwaysAllow' | 'pos' | 'color' | 'started' | 'sessionId' | 'effort' | 'lastContext' | 'bypassOn' | 'bypassNoticeClosed'>
>;

export type MessageState = 'pending' | 'held' | 'queued' | 'delivered' | 'dismissed';
// pending=사람 확인 대기(자동 꺼짐) · held=자동 상한에 걸려 대기 · queued=전달 허락됨, 받는 쪽 작업 끝 대기
export interface RelayMessage {
  id: string;
  roomId: RoomId;
  from: AgentId;
  to: AgentId;
  text: string;
  createdAt: number;
  state: MessageState;
  updatedAt: number;
}

export type UserPart = { type: 'text'; text: string } | { type: 'image'; mediaType: string; base64: string };
export type ControlRequest =
  | { subtype: 'initialize' }
  | { subtype: 'interrupt' }
  | { subtype: 'set_model'; model: string }
  | { subtype: 'get_settings' }
  | { subtype: 'set_permission_mode'; mode: string }
  | { subtype: 'get_usage'; skip_behaviors: true }
  | { subtype: 'get_context_usage'; detail: 'summary' };
export type AssistantBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
/**
 * 고친 일의 바뀐 줄 한 묶음 — 줄 머리 ' '(앞뒤 줄)·'-'(지운 줄)·'+'(더한 줄)는 통합 diff 그대로.
 * 시작 줄 번호를 모르면(하는 일 입력으로 만든 묶음) null
 */
export interface DiffHunk {
  oldStart: number | null;
  newStart: number | null;
  lines: string[];
}
export type SubagentEnd = 'completed' | 'failed' | 'stopped';
export type ApiStatus = 'requesting' | 'compacting' | null;
export type StreamEvent =
  | { kind: 'init'; sessionId: string; model: string; permissionMode: string; slashCommands: string[] }
  | { kind: 'text-delta'; text: string }
  // Claude 가 생각하는 중(active) — 생각 블록 시작(thinking·redacted_thinking)·system/thinking_tokens 면 참, 다른 블록 시작이면 끝.
  // tokens = 지금까지 생각한 추정 토큰 수(thinking_tokens 의 누적 값 — 늘 수). 블록 시작·끝은 null. 생각을 여는 건 블록 시작
  // (active 참 · tokens null)뿐이고, 수가 있는 신호는 이미 생각 중일 때 수만 바꾼다. 내용은 오지 않는다. 기록하지 않는다
  | { kind: 'thinking'; active: boolean; tokens: number | null }
  // 차례 안의 API 상태(system/status) — requesting = 모델에 요청을 보냈다(첫 내용 전) · compacting = 대화를 요약하는 중 · null = 그 상태가 끝났다.
  // 서브에이전트의 것은 쓰지 않는다. 기록하지 않는다
  | { kind: 'api-status'; status: ApiStatus; permissionMode?: string }
  | { kind: 'assistant'; blocks: AssistantBlock[]; parent?: string } // thinking 블록은 버린다. parent = 서브에이전트 줄이면 부모의 Agent tool_use id
  // patch = user 줄 최상위 tool_use_result.structuredPatch(Claude Code 가 고친 일 결과에 싣는다) — 모양이 다르면 없음
  | { kind: 'tool-result'; toolUseId: string; isError: boolean; text: string; parent?: string; patch?: DiffHunk[] }
  | { kind: 'task-started'; taskId: string; toolUseId: string; description: string; subagentType: string | null; parentTaskId: string | null }
  | { kind: 'task-ended'; taskId: string; toolUseId: string; status: SubagentEnd; summary: string; toolUses: number | null; durationMs: number | null }
  // 뒤에서 도는 일(백그라운드 명령 등)의 지금 목록(system/background_tasks_changed, probe18) — 비면 하나도 안 돈다. 기록·화면엔 안 나간다(엔진이 세션마다 들고 있다)
  | { kind: 'background-tasks'; taskIds: string[] }
  | { kind: 'local-output'; text: string } // 로컬 명령(/model 등) 출력 에코
  // 보낸 사람 말을 Claude 가 읽었다(--replay-user-messages 의 되돌림) — 글 조각만. 화면·기록엔 안 나간다(보낼 때 기록했다)
  | { kind: 'replay'; text: string }
  | { kind: 'result'; ok: boolean; subtype: string; text: string; denials: { toolName: string; toolUseId: string }[] }
  | { kind: 'control-response'; requestId: string; ok: boolean; payload: any }
  | { kind: 'rate-limit'; info: unknown }
  | { kind: 'compacted' }
  | { kind: 'ignored'; type: string };

/** 그림의 file = 그림 칸(images/<에이전트>/)에 저장한 이름 — 저장 전에 보낸 그림·저장을 못 한 그림엔 없다 */
export type HistoryPart = { type: 'text'; text: string } | { type: 'image'; mediaType: string; bytes: number; file?: string };
export type HistoryItem = { t: number } & (
  | { kind: 'user'; source: 'human' | 'relay'; parts: HistoryPart[]; messageId?: string }
  | { kind: 'assistant'; blocks: AssistantBlock[]; parent?: string }
  // patch = 수정(Edit·MultiEdit·NotebookEdit)의 바뀐 줄 — 모두 합쳐 앞 400줄·줄마다 500자, 잘랐으면 patchCut
  | { kind: 'tool-result'; toolUseId: string; isError: boolean; text: string; viaApproval: boolean; parent?: string; patch?: DiffHunk[]; patchCut?: true }
  | { kind: 'subagent-start'; toolUseId: string; taskId: string; description: string; subagentType: string | null; parentTaskId: string | null }
  | { kind: 'subagent-end'; toolUseId: string; taskId: string; status: SubagentEnd; summary: string; toolUses: number | null; durationMs: number | null }
  | { kind: 'local-output'; text: string }
  | { kind: 'result'; ok: boolean; subtype: string }
  | { kind: 'notice'; text: string } // 멈춤·오류·종료 같은 알림
  | { kind: 'boundary' } // 새 대화 경계
);

export type SessionStatus = 'idle' | 'working' | 'stopped' | 'error';
export type AgentStatus = SessionStatus | 'awaiting'; // awaiting = 승인 대기 — 엔진이 겹쳐 계산

export type Decision =
  | { type: 'allow' }
  | { type: 'allow-always' }
  | { type: 'deny'; message?: string }
  | { type: 'answer'; answers: Record<string, string> };
/** 새 에이전트 만들기 카드의 입력(kind 'create-agent') — folder 는 정규화한 전체 경로, task 는 첫 할 일(없으면 null) */
export interface CreateAgentInput {
  name: string;
  role: string;
  folder: string;
  task: string | null;
}
export interface PendingRequest {
  id: string;
  agentId: AgentId;
  /** create-agent 면 'mcp__dure__create_agent' */
  toolName: string;
  /** create-agent 면 CreateAgentInput */
  input: unknown;
  toolUseId?: string;
  /** create-agent = 에이전트가 두레 도구 create_agent 로 새 에이전트를 만들려 한다 — allow·deny 로만 답한다 · plan = ExitPlanMode — 계획을 보고 진행(allow)이나 고쳐 달라고 하기(deny + 의견)로만 답한다 */
  kind: 'permission' | 'question' | 'create-agent' | 'plan';
  createdAt: number;
  /** 서브에이전트가 물은 것(tool_use id 로 가른다) — 부모 차례가 끝나도 도는 동안 남는다. 부모 것엔 칸이 없다 */
  fromSubagent?: true;
}

/**
 * 붙잡은 것 하나 — id: 내 입력이면 엔진이 붙인 id, 메시지면 메시지 id · from: 메시지를 보낸 에이전트(내 입력이면 null) ·
 * text: 글의 첫 줄(200자까지, 글이 없으면 '') · images: 그림 수(그림 자체는 싣지 않는다)
 */
export interface HoldItem {
  id: string;
  source: 'human' | 'relay';
  from: AgentId | null;
  text: string;
  images: number;
}
/**
 * 붙잡기 — 멈출 때 그 에이전트에게 기다리던 내 입력·전달 대기(queued) 메시지. 사람이 고를 때까지(이어서 보내기·빼기·모두 버리기) 나가지 않는다.
 * since: 붙잡은 시각 · items: 내 입력, 그다음 메시지(붙잡힌 동안 전달 대기가 된 메시지는 끝에)
 */
export interface Hold {
  since: number;
  items: HoldItem[];
}

export interface EngineEventMap {
  'agent-event': { agentId: AgentId; event: StreamEvent; viaApproval?: boolean };
  status: { agentId: AgentId; status: AgentStatus; errorText: string | null };
  message: RelayMessage;
  held: { roomId: RoomId };
  request: PendingRequest;
  'request-resolved': { id: string; agentId: AgentId };
  /**
   * bypass = Claude 가 알려 준 실제 모드(세션이 없으면 다음에 띄울 때의 모드) · bySettings = 두레 스위치가 아니라 내 Claude 설정 때문에 bypass ·
   * pending = 옵션 없이 뜬 세션을 켜려고 그 차례 뒤의 다시 띄우기를 기다리는 중(실제 모드는 아직 그대로)
   */
  flags: { agentId: AgentId; bypass: boolean; bySettings: boolean; pending: boolean };
  /**
   * 계획 모드 — 그 에이전트 세션의 실제 모드가 plan 인가(세션이 없거나 아직 모드를 모르면 바라는 값 — 띄울 때 맞춘다). 바뀔 때만
   */
  'plan-mode': { agentId: AgentId; on: boolean };
  'engine-error': { agentId: string | null; message: string };
  history: { agentId: AgentId; item: HistoryItem };
  'held-input': { agentId: AgentId; count: number };
  /** 늘 허용 목록이 바뀔 때마다(승인 카드의 '앞으로 … 묻지 않기' · 되돌리기) — 바뀐 뒤의 목록 전체 */
  'always-allow': { agentId: AgentId; alwaysAllow: string[] };
  /** 붙잡기가 바뀔 때마다(붙잡음 · 항목이 붙거나 빠짐) — 풀리면(이어서 보내기·다 빠짐·에이전트 지움) null */
  hold: { agentId: AgentId; hold: Hold | null };
  usage: PlanUsage | null;
  context: { agentId: AgentId; value: ContextUsage | null };
  effort: { agentId: AgentId; effort: EffortLevel | null; effortNow: EffortLevel | null };
  'model-now': { agentId: AgentId; modelNow: string | null };
  /** 도는 서브에이전트 — 부모의 Agent tool_use id, 시작 순. 바뀔 때마다(시작·끝·세션이 끝나 비울 때) */
  subagents: { agentId: AgentId; running: string[] };
  /** 엔진이 에이전트를 만들었다(create_agent 를 사람이 승인) — by = 만든 에이전트. 사람이 화면에서 더한 것엔 오지 않는다 */
  'agent-added': { agent: Agent; by: AgentId };
  /**
   * 잠듦(시작한 적 있는데 살아 있는 claude 가 없다 — 오류·지우는 중 제외) · 깨우는 중(잠든 에이전트를 띄운 세션이 첫 init 전에 일하는 중).
   * 둘 중 하나라도 바뀔 때만. 상태(status)와 따로 — 잠든 에이전트의 상태는 그대로 idle
   */
  sleep: { agentId: AgentId; asleep: boolean; waking: boolean };
}

export interface AgentDescription {
  commands: { name: string; description: string; argumentHint: string }[];
  models: { value: string; displayName: string; description?: string; resolvedModel?: string; supportsEffort?: boolean; effortLevels?: EffortLevel[] }[];
  permissionMode: string;
}
