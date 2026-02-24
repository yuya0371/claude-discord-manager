// packages/worker/src/index.ts

import "dotenv/config";
import {
  type WsMessage,
  type TaskAssignPayload,
  type TaskCancelPayload,
  type TaskAnswerPayload,
  type TaskPermissionResponsePayload,
  type FileTransferPayload,
  type TaskStreamPayload,
  type TaskCompletePayload,
  type TaskErrorPayload,
  type FileTransferAckPayload,
  type TokenUsage,
  WorkerStatus,
  PermissionMode,
} from "@claude-discord/common";
import { WsClient } from "./ws/client.js";
import { ClaudeExecutor, type ExecuteOptions } from "./claude/executor.js";
import type { ParsedEvent } from "./claude/parser.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── 設定読み込み ───

const COORDINATOR_URL = process.env.COORDINATOR_URL ?? "ws://localhost:8765";
const COORDINATOR_SECRET = process.env.COORDINATOR_SECRET ?? "";
const WORKER_NAME = process.env.WORKER_NAME ?? `worker-${os.hostname()}`;
const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd();

if (!COORDINATOR_SECRET) {
  console.error("[Worker] COORDINATOR_SECRET is required. Set it in .env");
  process.exit(1);
}

// ─── WorkerApp ───

class WorkerApp {
  private readonly wsClient: WsClient;
  private readonly executor = new ClaudeExecutor();
  private currentTaskId: string | null = null;
  private taskStartTime = 0;
  private accumulatedTokens: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  private lastResultText = "";
  private lastSessionId: string | null = null;
  private stderrBuffer = "";

  constructor() {
    this.wsClient = new WsClient({
      coordinatorUrl: COORDINATOR_URL,
      secret: COORDINATOR_SECRET,
      workerName: WORKER_NAME,
      defaultCwd: DEFAULT_CWD,
    });

    this.setupWsHandlers();
    this.setupExecutorHandlers();
  }

  /** Worker を起動する */
  start(): void {
    console.log(`[Worker] Starting worker "${WORKER_NAME}"`);
    console.log(`[Worker] Coordinator: ${COORDINATOR_URL}`);
    console.log(`[Worker] Default CWD: ${DEFAULT_CWD}`);
    this.wsClient.connect();
  }

  /** Worker をシャットダウンする */
  async shutdown(): Promise<void> {
    console.log("[Worker] Shutting down...");

    // 実行中タスクがあればキャンセル
    if (this.executor.running) {
      await this.executor.kill();
    }

    this.wsClient.shutdown();
    console.log("[Worker] Shutdown complete");
  }

  // ─── WebSocket イベントハンドラ ───

  private setupWsHandlers(): void {
    this.wsClient.on("registered", () => {
      console.log("[Worker] Registered with Coordinator, ready for tasks");
    });

    this.wsClient.on("register_failed", (error: string) => {
      console.error(`[Worker] Registration failed: ${error}`);
      console.error("[Worker] Check COORDINATOR_SECRET and try again");
    });

    this.wsClient.on("message", (msg: WsMessage) => {
      this.handleWsMessage(msg);
    });

    this.wsClient.on("disconnected", () => {
      console.log("[Worker] Disconnected from Coordinator");
    });
  }

  private handleWsMessage(msg: WsMessage): void {
    switch (msg.type) {
      case "task:assign":
        this.handleTaskAssign(msg.payload as TaskAssignPayload);
        break;

      case "task:cancel":
        this.handleTaskCancel(msg.payload as TaskCancelPayload);
        break;

      case "task:answer":
        this.handleTaskAnswer(msg.payload as TaskAnswerPayload);
        break;

      case "task:permission_response":
        this.handlePermissionResponse(msg.payload as TaskPermissionResponsePayload);
        break;

      case "file:transfer":
        this.handleFileTransfer(msg.payload as FileTransferPayload);
        break;

      default:
        console.warn(`[Worker] Unhandled message type: ${msg.type}`);
    }
  }

  /** タスク割り当てハンドラ */
  private handleTaskAssign(payload: TaskAssignPayload): void {
    if (this.executor.running) {
      console.warn("[Worker] Received task:assign but already running a task");
      return;
    }

    console.log(`[Worker] Assigned task: ${payload.taskId}`);
    this.currentTaskId = payload.taskId;
    this.taskStartTime = Date.now();
    this.accumulatedTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    this.lastResultText = "";
    this.lastSessionId = null;
    this.stderrBuffer = "";

    this.wsClient.setStatus(WorkerStatus.Busy, payload.taskId);

    const cwd = payload.cwd ?? DEFAULT_CWD;
    const options: ExecuteOptions = {
      prompt: payload.prompt,
      cwd,
      permissionMode: payload.permissionMode ?? PermissionMode.AcceptEdits,
      teamMode: payload.teamMode ?? false,
      sessionId: payload.continueSession ? payload.sessionId : null,
      attachmentPaths: (payload.attachments ?? [])
        .filter((a) => a.localPath)
        .map((a) => a.localPath as string),
    };

    this.executor.execute(options);
  }

  /** タスクキャンセルハンドラ */
  private async handleTaskCancel(payload: TaskCancelPayload): Promise<void> {
    console.log(`[Worker] Cancel requested: ${payload.reason}`);
    if (this.executor.running) {
      await this.executor.kill();
    }
  }

  /** 質問回答ハンドラ */
  private handleTaskAnswer(payload: TaskAnswerPayload): void {
    console.log(`[Worker] Answer received for question ${payload.questionId}`);
    this.executor.writeStdin(payload.answer);
  }

  /** 権限応答ハンドラ */
  private handlePermissionResponse(payload: TaskPermissionResponsePayload): void {
    console.log(`[Worker] Permission ${payload.granted ? "granted" : "denied"} for ${payload.permissionId}`);
    // Claude CLI に応答を書き込む
    this.executor.writeStdin(payload.granted ? "yes" : "no");
  }

  /** ファイル転送ハンドラ */
  private handleFileTransfer(payload: FileTransferPayload): void {
    const tmpDir = path.join(os.tmpdir(), "claude-worker-files", payload.taskId);
    const filePath = path.join(tmpDir, payload.fileName);

    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const buffer = Buffer.from(payload.data, "base64");
      fs.writeFileSync(filePath, buffer);

      console.log(`[Worker] File saved: ${filePath}`);

      const ack: FileTransferAckPayload = {
        taskId: payload.taskId,
        fileName: payload.fileName,
        success: true,
        localPath: filePath,
      };
      this.wsClient.send("file:transfer_ack", ack, payload.taskId);
    } catch (err) {
      console.error("[Worker] File transfer error:", (err as Error).message);
      const ack: FileTransferAckPayload = {
        taskId: payload.taskId,
        fileName: payload.fileName,
        success: false,
        localPath: null,
        error: (err as Error).message,
      };
      this.wsClient.send("file:transfer_ack", ack, payload.taskId);
    }
  }

  // ─── Claude Executor イベントハンドラ ───

  private setupExecutorHandlers(): void {
    this.executor.on("stream", (event: ParsedEvent) => {
      this.handleStreamEvent(event);
    });

    this.executor.on("exit", (code: number | null, signal: string | null) => {
      this.handleProcessExit(code, signal);
    });

    this.executor.on("error", (error: Error) => {
      this.handleProcessError(error);
    });

    this.executor.on("stderr", (data: string) => {
      this.stderrBuffer += data;
    });
  }

  /** ストリームイベントを Coordinator に転送する */
  private handleStreamEvent(event: ParsedEvent): void {
    if (!this.currentTaskId) return;

    // トークン使用量の累積
    if (event.eventType === "token_usage") {
      const data = event.data as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
      this.accumulatedTokens.inputTokens += data.inputTokens;
      this.accumulatedTokens.outputTokens += data.outputTokens;
      this.accumulatedTokens.cacheReadTokens += data.cacheReadTokens;
      this.accumulatedTokens.cacheWriteTokens += data.cacheWriteTokens;
    }

    // 最終結果テキストとセッションIDを記憶
    if (event.eventType === "result") {
      const data = event.data as { text: string; sessionId: string | null };
      this.lastResultText = data.text;
      this.lastSessionId = data.sessionId;
    }

    // task:stream として Coordinator に送信
    const streamPayload: TaskStreamPayload = {
      eventType: event.eventType,
      data: event.data,
    };
    this.wsClient.send("task:stream", streamPayload, this.currentTaskId);
  }

  /** プロセス正常/異常終了 */
  private handleProcessExit(code: number | null, signal: string | null): void {
    if (!this.currentTaskId) return;

    const durationMs = Date.now() - this.taskStartTime;
    const taskId = this.currentTaskId;

    if (code === 0 || (code === null && signal === null)) {
      // 正常完了
      const payload: TaskCompletePayload = {
        resultText: this.lastResultText,
        sessionId: this.lastSessionId,
        tokenUsage: { ...this.accumulatedTokens },
        durationMs,
      };
      this.wsClient.send("task:complete", payload, taskId);
      console.log(`[Worker] Task ${taskId} completed in ${durationMs}ms`);
    } else {
      // 異常終了
      const payload: TaskErrorPayload = {
        message: this.stderrBuffer.trim() || `Process exited with code ${code}, signal ${signal}`,
        code: `EXIT_${code ?? signal ?? "UNKNOWN"}`,
        partialResult: this.lastResultText || null,
        tokenUsage: { ...this.accumulatedTokens },
      };
      this.wsClient.send("task:error", payload, taskId);
      console.error(`[Worker] Task ${taskId} failed: code=${code}, signal=${signal}`);
    }

    this.currentTaskId = null;
    this.wsClient.setStatus(WorkerStatus.Online, null);
  }

  /** プロセス起動エラー */
  private handleProcessError(error: Error): void {
    if (!this.currentTaskId) return;

    const taskId = this.currentTaskId;
    const payload: TaskErrorPayload = {
      message: `Failed to start Claude CLI: ${error.message}`,
      code: "SPAWN_ERROR",
      partialResult: null,
      tokenUsage: { ...this.accumulatedTokens },
    };
    this.wsClient.send("task:error", payload, taskId);

    this.currentTaskId = null;
    this.wsClient.setStatus(WorkerStatus.Online, null);
  }
}

// ─── エントリーポイント ───

const app = new WorkerApp();
app.start();

// Graceful shutdown
const handleShutdown = async (signal: string) => {
  console.log(`[Worker] Received ${signal}`);
  await app.shutdown();
  process.exit(0);
};

process.on("SIGINT", () => void handleShutdown("SIGINT"));
process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
