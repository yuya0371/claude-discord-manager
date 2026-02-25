import { WebSocketServer, WebSocket } from "ws";
import {
  WsMessage,
  WsMessageType,
  WorkerRegisterPayload,
  WorkerHeartbeatPayload,
  TaskStreamPayload,
  TaskCompletePayload,
  TaskErrorPayload,
  TaskQuestionPayload,
  TaskPermissionPayload,
  FileTransferAckPayload,
  TeamUpdatePayload,
  parseMessage,
} from "@claude-discord/common";
import { WorkerRegistry } from "../worker/registry.js";
import { TaskManager } from "../task/manager.js";

export interface WsServerConfig {
  port: number;
  host?: string;
}

/**
 * WebSocketサーバー
 * Worker接続受付、認証、メッセージルーティング
 */
export class WsServer {
  private wss: WebSocketServer | null = null;

  /** team:update 受信時のコールバック */
  public onTeamUpdate:
    | ((workerId: string, payload: TeamUpdatePayload) => Promise<void>)
    | null = null;

  constructor(
    private readonly config: WsServerConfig,
    private readonly workerRegistry: WorkerRegistry,
    private readonly taskManager: TaskManager
  ) {}

  /**
   * WebSocketサーバーを起動する
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({
        port: this.config.port,
        host: this.config.host ?? "0.0.0.0",
      });

      this.wss.on("listening", () => {
        console.log(
          `WebSocket server listening on ${this.config.host ?? "0.0.0.0"}:${this.config.port}`
        );
        resolve();
      });

      this.wss.on("connection", (ws: WebSocket) => {
        this.handleConnection(ws);
      });

      this.wss.on("error", (error) => {
        console.error("WebSocket server error:", error);
      });
    });
  }

  /**
   * WebSocketサーバーを停止する
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }

      this.wss.close(() => {
        console.log("WebSocket server stopped");
        resolve();
      });
    });
  }

  /**
   * 新規WebSocket接続のハンドリング
   */
  private handleConnection(ws: WebSocket): void {
    console.log("New WebSocket connection");

    let authenticated = false;
    let workerId: string | null = null;

    // 認証タイムアウト（10秒以内にregisterが来なければ切断）
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        console.warn("WebSocket connection authentication timeout");
        ws.close();
      }
    }, 10_000);

    ws.on("message", async (data: Buffer) => {
      let msg: WsMessage;
      try {
        msg = parseMessage(data.toString());
      } catch (error) {
        console.warn("Failed to parse WebSocket message:", error);
        return;
      }

      // 未認証の場合、registerメッセージのみ受け付ける
      if (!authenticated) {
        if (msg.type === "worker:register") {
          clearTimeout(authTimeout);
          const success = this.workerRegistry.handleRegister(
            ws,
            msg as WsMessage<WorkerRegisterPayload>
          );
          if (success) {
            authenticated = true;
            workerId = (msg.payload as WorkerRegisterPayload).name;
          }
          return;
        } else {
          console.warn("Received non-register message from unauthenticated connection");
          ws.close();
          return;
        }
      }

      // 認証済みメッセージのルーティング
      await this.routeMessage(workerId!, msg);
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (workerId) {
        this.workerRegistry.handleDisconnect(workerId);
      }
    });

    ws.on("error", (error) => {
      console.error(`WebSocket error for worker "${workerId}":`, error);
    });
  }

  /**
   * 認証済みWorkerからのメッセージをルーティングする
   */
  private async routeMessage(
    workerId: string,
    msg: WsMessage
  ): Promise<void> {
    const type: WsMessageType = msg.type;

    switch (type) {
      case "worker:heartbeat":
        this.workerRegistry.handleHeartbeat(
          workerId,
          msg as WsMessage<WorkerHeartbeatPayload>
        );
        break;

      case "task:stream":
        if (msg.taskId) {
          await this.taskManager.handleStreamUpdate(
            msg.taskId,
            msg.payload as TaskStreamPayload
          );
        }
        break;

      case "task:complete":
        if (msg.taskId) {
          await this.taskManager.handleTaskComplete(
            msg.taskId,
            msg.payload as TaskCompletePayload
          );
        }
        break;

      case "task:error":
        if (msg.taskId) {
          await this.taskManager.handleTaskError(
            msg.taskId,
            msg.payload as TaskErrorPayload
          );
        }
        break;

      case "task:question":
        if (msg.taskId) {
          await this.taskManager.handleTaskQuestion(
            msg.taskId,
            msg.payload as TaskQuestionPayload
          );
        }
        break;

      case "task:permission":
        if (msg.taskId) {
          await this.taskManager.handleTaskPermission(
            msg.taskId,
            msg.payload as TaskPermissionPayload
          );
        }
        break;

      case "file:transfer_ack":
        if (msg.taskId) {
          this.taskManager.handleFileTransferAck(
            msg.taskId,
            msg.payload as FileTransferAckPayload
          );
        }
        break;

      case "team:update":
        if (this.onTeamUpdate) {
          await this.onTeamUpdate(
            workerId,
            msg.payload as TeamUpdatePayload
          );
        }
        break;

      default:
        console.warn(`Unhandled message type from worker "${workerId}": ${type}`);
        break;
    }
  }
}
