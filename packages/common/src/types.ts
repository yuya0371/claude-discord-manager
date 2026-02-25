// packages/common/src/types.ts

// ─── Enum定義 ───

/** タスクの状態 */
export enum TaskStatus {
  Queued = "queued",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

/** Workerの状態 */
export enum WorkerStatus {
  Online = "online",
  Busy = "busy",
  Offline = "offline",
}

/** Claude CLIの権限モード */
export enum PermissionMode {
  AcceptEdits = "acceptEdits",
  Auto = "auto",
  Confirm = "confirm",
}

/** 通知レベル */
export enum NotifyLevel {
  All = "all",
  Important = "important",
  None = "none",
}

// ─── コアデータ型 ───

/** タスク情報 */
export interface Task {
  id: string;
  prompt: string;
  status: TaskStatus;
  workerId: string | null;
  cwd: string | null;
  permissionMode: PermissionMode;
  teamMode: boolean;
  continueSession: boolean;
  sessionId: string | null;
  attachments: FileAttachment[];
  toolHistory: ToolHistoryEntry[];
  resultText: string | null;
  errorMessage: string | null;
  tokenUsage: TokenUsage;
  discordMessageId: string | null;
  discordThreadId: string | null;
  requestedBy: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** ファイル添付情報 */
export interface FileAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  cdnUrl: string;
  localPath: string | null;
}

/** ツール呼び出し履歴エントリ */
export interface ToolHistoryEntry {
  toolName: string;
  summary: string;
  status: "running" | "completed" | "error";
  timestamp: number;
}

/** トークン使用量 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Worker情報 */
export interface WorkerInfo {
  id: string;
  name: string;
  status: WorkerStatus;
  currentTaskId: string | null;
  os: string;
  nodeVersion: string;
  claudeCliVersion: string;
  defaultCwd: string;
  allowedDirs: string[];
  lastHeartbeat: number;
  connectedAt: number;
}

/** プロジェクトエイリアス */
export interface ProjectAlias {
  alias: string;
  path: string;
  preferredWorker: string | null;
}

/** Agent Teamsの情報 */
export interface TeamInfo {
  teamName: string;
  workerId: string;
  members: TeamMember[];
  tasks: TeamTask[];
  recentMessages: TeamMessage[];
}

/** Teamメンバー */
export interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
  status: "active" | "idle" | "offline";
}

/** Teamタスク */
export interface TeamTask {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  owner: string | null;
}

/** Teamメンバー間メッセージ */
export interface TeamMessage {
  from: string;
  to: string;
  summary: string;
  timestamp: number;
}

/** トークン使用量の集計レコード */
export interface TokenUsageRecord {
  taskId: string;
  workerId: string;
  usage: TokenUsage;
  timestamp: number;
}

// ─── WebSocketメッセージ型 ───

/** WebSocket通信の基本メッセージ型 */
export interface WsMessage<T = unknown> {
  type: WsMessageType;
  taskId?: string;
  workerId?: string;
  payload: T;
  timestamp: number;
}

/** メッセージ種別 */
export type WsMessageType =
  | "worker:register"
  | "worker:register_ack"
  | "worker:heartbeat"
  | "worker:heartbeat_ack"
  | "task:assign"
  | "task:stream"
  | "task:complete"
  | "task:error"
  | "task:cancel"
  | "task:question"
  | "task:answer"
  | "task:permission"
  | "task:permission_response"
  | "file:transfer"
  | "file:transfer_ack"
  | "team:update"
  | "token:usage";

// ─── ペイロード型 ───

export interface WorkerRegisterPayload {
  name: string;
  secret: string;
  os: string;
  nodeVersion: string;
  claudeCliVersion: string;
  defaultCwd: string;
  allowedDirs: string[];
  protocolVersion: string;
}

export interface WorkerRegisterAckPayload {
  success: boolean;
  error?: string;
  protocolVersion: string;
}

export interface WorkerHeartbeatPayload {
  status: WorkerStatus;
  currentTaskId: string | null;
  systemInfo?: {
    cpuUsage: number;
    memoryUsage: number;
  };
}

export interface WorkerHeartbeatAckPayload {
  acknowledged: true;
}

export interface TaskAssignPayload {
  taskId: string;
  prompt: string;
  cwd: string | null;
  permissionMode: PermissionMode;
  teamMode: boolean;
  continueSession: boolean;
  sessionId: string | null;
  attachments: FileAttachment[];
}

export interface TaskStreamPayload {
  eventType: StreamEventType;
  data: StreamEventData;
}

export type StreamEventType =
  | "assistant_message"
  | "tool_use_begin"
  | "tool_use_end"
  | "token_usage"
  | "system_message"
  | "result"
  | "error"
  | "rate_limit";

export type StreamEventData =
  | AssistantMessageData
  | ToolUseBeginData
  | ToolUseEndData
  | TokenUsageData
  | SystemMessageData
  | ResultData
  | StreamErrorData
  | RateLimitData;

export interface AssistantMessageData {
  text: string;
}

export interface ToolUseBeginData {
  toolName: string;
  summary: string;
}

export interface ToolUseEndData {
  toolName: string;
  summary: string;
  success: boolean;
}

export interface TokenUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SystemMessageData {
  message: string;
}

export interface ResultData {
  text: string;
  sessionId: string | null;
  costUsd?: number | null;
}

export interface RateLimitData {
  status: string;
  resetsAt: number | null;
  rateLimitType: string | null;
}

export interface StreamErrorData {
  message: string;
  code?: string;
}

export interface TaskCompletePayload {
  resultText: string;
  sessionId: string | null;
  tokenUsage: TokenUsage;
  durationMs: number;
}

export interface TaskErrorPayload {
  message: string;
  code: string;
  partialResult: string | null;
  tokenUsage: TokenUsage;
}

export interface TaskCancelPayload {
  reason: string;
}

export interface TaskQuestionPayload {
  question: string;
  options: string[] | null;
  questionId: string;
}

export interface TaskAnswerPayload {
  questionId: string;
  answer: string;
}

export interface TaskPermissionPayload {
  permissionId: string;
  permissionType: "bash" | "file_edit";
  command: string;
  cwd: string;
}

export interface TaskPermissionResponsePayload {
  permissionId: string;
  granted: boolean;
}

export interface FileTransferPayload {
  taskId: string;
  fileName: string;
  mimeType: string;
  size: number;
  data: string; // base64
}

export interface FileTransferAckPayload {
  taskId: string;
  fileName: string;
  success: boolean;
  localPath: string | null;
  error?: string;
}

export interface TeamUpdatePayload {
  teamInfo: TeamInfo;
}

export interface TokenUsagePayload {
  taskId: string;
  usage: TokenUsage;
}
