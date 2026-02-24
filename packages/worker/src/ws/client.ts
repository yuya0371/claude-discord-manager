// packages/worker/src/ws/client.ts

import WebSocket from "ws";
import { EventEmitter } from "node:events";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  type WsMessage,
  type WsMessageType,
  type WorkerRegisterPayload,
  type WorkerHeartbeatPayload,
  type WorkerRegisterAckPayload,
  WorkerStatus,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_MAX_MS,
  PROTOCOL_VERSION,
  createMessage,
  parseMessage,
} from "@claude-discord/common";

export interface WsClientConfig {
  coordinatorUrl: string;
  secret: string;
  workerName: string;
  defaultCwd: string;
  allowedDirs?: string[];
}

export interface WsClientEvents {
  connected: () => void;
  disconnected: () => void;
  registered: () => void;
  register_failed: (error: string) => void;
  message: (msg: WsMessage) => void;
}

/**
 * Coordinator への WebSocket クライアント。
 * 自動再接続(指数バックオフ)、ハートビート送信を行う。
 */
export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private _registered = false;
  private _shutdown = false;

  private currentTaskId: string | null = null;
  private workerStatus: WorkerStatus = WorkerStatus.Online;

  private readonly claudeCliVersion: string;

  constructor(private readonly config: WsClientConfig) {
    super();
    this.claudeCliVersion = this.detectClaudeCliVersion();
  }

  get registered(): boolean {
    return this._registered;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Coordinator に接続する */
  connect(): void {
    if (this._shutdown) return;

    console.log(`[WsClient] Connecting to ${this.config.coordinatorUrl}...`);

    this.ws = new WebSocket(this.config.coordinatorUrl);

    this.ws.on("open", () => {
      console.log("[WsClient] Connected to Coordinator");
      this.reconnectAttempts = 0;
      this.emit("connected");
      this.sendRegister();
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      try {
        const msg = parseMessage(raw.toString());
        this.handleMessage(msg);
      } catch (err) {
        console.error("[WsClient] Failed to parse message:", (err as Error).message);
      }
    });

    this.ws.on("close", (code, reason) => {
      console.log(`[WsClient] Disconnected: code=${code}, reason=${reason.toString()}`);
      this.cleanup();
      this.emit("disconnected");

      if (!this._shutdown) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      console.error("[WsClient] WebSocket error:", err.message);
    });
  }

  /** メッセージを送信する */
  send<T>(type: WsMessageType, payload: T, taskId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[WsClient] Cannot send: not connected");
      return;
    }

    const msg = createMessage(type, payload, {
      workerId: this.config.workerName,
      taskId,
    });

    this.ws.send(JSON.stringify(msg));
  }

  /** Worker の状態を更新する */
  setStatus(status: WorkerStatus, taskId: string | null = null): void {
    this.workerStatus = status;
    this.currentTaskId = taskId;
  }

  /** 接続を閉じてシャットダウンする */
  shutdown(): void {
    this._shutdown = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, "Worker shutting down");
      this.ws = null;
    }
  }

  /** worker:register メッセージを送信する */
  private sendRegister(): void {
    const payload: WorkerRegisterPayload = {
      name: this.config.workerName,
      secret: this.config.secret,
      os: `${os.platform()} ${os.release()}`,
      nodeVersion: process.version,
      claudeCliVersion: this.claudeCliVersion,
      defaultCwd: this.config.defaultCwd,
      allowedDirs: this.config.allowedDirs ?? [this.config.defaultCwd],
      protocolVersion: PROTOCOL_VERSION,
    };

    this.send("worker:register", payload);
  }

  /** ハートビートを送信する */
  private sendHeartbeat(): void {
    const payload: WorkerHeartbeatPayload = {
      status: this.workerStatus,
      currentTaskId: this.currentTaskId,
    };

    this.send("worker:heartbeat", payload);
  }

  /** ハートビートタイマーを開始する */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  /** ハートビートタイマーを停止する */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 受信メッセージのハンドリング */
  private handleMessage(msg: WsMessage): void {
    switch (msg.type) {
      case "worker:register_ack": {
        const ack = msg.payload as WorkerRegisterAckPayload;
        if (ack.success) {
          console.log("[WsClient] Registration successful");
          this._registered = true;
          this.startHeartbeat();
          this.emit("registered");
        } else {
          console.error("[WsClient] Registration failed:", ack.error);
          this.emit("register_failed", ack.error ?? "Unknown error");
        }
        break;
      }

      case "worker:heartbeat_ack":
        // ACK 受信 - 特に処理なし
        break;

      default:
        // task:assign, task:cancel, task:answer, task:permission_response, file:transfer
        // は上位レイヤーで処理する
        this.emit("message", msg);
        break;
    }
  }

  /** 指数バックオフで再接続をスケジュールする */
  private scheduleReconnect(): void {
    const delay = Math.min(
      WS_RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      WS_RECONNECT_MAX_MS,
    );
    // ジッター追加(+/-20%)
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    const actualDelay = Math.round(delay + jitter);

    console.log(`[WsClient] Reconnecting in ${actualDelay}ms (attempt #${this.reconnectAttempts + 1})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, actualDelay);
  }

  /** タイマー等のクリーンアップ */
  private cleanup(): void {
    this._registered = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Claude CLI のバージョンを取得する */
  private detectClaudeCliVersion(): string {
    try {
      const output = execSync("claude --version", { timeout: 5000 }).toString().trim();
      return output;
    } catch {
      console.warn("[WsClient] Could not detect Claude CLI version");
      return "unknown";
    }
  }
}
