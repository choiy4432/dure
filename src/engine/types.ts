export type RoomId = string;
export type AgentId = string;

export interface Room {
  id: RoomId;
  name: string;
  createdAt: number;
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
}

export type AgentPatch = Partial<
  Pick<Agent, 'name' | 'role' | 'auto' | 'model' | 'alwaysAllow' | 'pos' | 'color' | 'started' | 'sessionId'>
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
export type ControlRequest = { subtype: 'initialize' } | { subtype: 'interrupt' } | { subtype: 'set_model'; model: string };
export type AssistantBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
export type StreamEvent =
  | { kind: 'init'; sessionId: string; model: string; permissionMode: string; slashCommands: string[] }
  | { kind: 'text-delta'; text: string }
  | { kind: 'assistant'; blocks: AssistantBlock[] } // thinking 블록은 버린다
  | { kind: 'tool-result'; toolUseId: string; isError: boolean; text: string }
  | { kind: 'local-output'; text: string } // 로컬 명령(/model 등) 출력 에코
  | { kind: 'result'; ok: boolean; subtype: string; text: string; denials: { toolName: string; toolUseId: string }[] }
  | { kind: 'control-response'; requestId: string; ok: boolean; payload: any }
  | { kind: 'rate-limit'; info: unknown }
  | { kind: 'ignored'; type: string };

export type HistoryPart = { type: 'text'; text: string } | { type: 'image'; mediaType: string; bytes: number };
export type HistoryItem = { t: number } & (
  | { kind: 'user'; source: 'human' | 'relay'; parts: HistoryPart[]; messageId?: string }
  | { kind: 'assistant'; blocks: AssistantBlock[] }
  | { kind: 'tool-result'; toolUseId: string; isError: boolean; text: string; viaApproval: boolean }
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
export interface PendingRequest {
  id: string;
  agentId: AgentId;
  toolName: string;
  input: unknown;
  toolUseId?: string;
  kind: 'permission' | 'question';
  createdAt: number;
}
