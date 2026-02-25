import WebSocket from "ws";
import {
  WorkerInfo,
  WorkerStatus,
  WsMessage,
  WorkerRegisterPayload,
  WorkerRegisterAckPayload,
  WorkerHeartbeatPayload,
  WorkerHeartbeatAckPayload,
  createMessage,
  WS_HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
} from "@claude-discord/common";

export class WorkerRegistry {
  /** 接続中のWorker情報 (workerId -> WorkerInfo) */
  private workers: Map<string, WorkerInfo> = new Map();

  /** WebSocket接続の管理 (workerId -> WebSocket) */
  private connections: Map<string, WebSocket> = new Map();

  /** ハートビートタイマー (workerId -> NodeJS.Timeout) */
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();

  /** ラウンドロビンのインデックス */
  private roundRobinIndex = 0;

  /** 優先Worker設定 (userId -> workerId) */
  private preferredWorkers: Map<string, string> = new Map();

  /** Worker接続時のコールバック */
  public onWorkerConnected:
    | ((worker: WorkerInfo) => void)
    | null = null;

  /** Worker切断時のコールバック */
  public onWorkerDisconnected:
    | ((workerId: string, hadRunningTask: boolean) => void)
    | null = null;

  constructor(private readonly secret: string) {}

  /**
   * Worker登録処理
   * secret照合 -> 登録 -> ACK返却
   */
  handleRegister(
    ws: WebSocket,
    msg: WsMessage<WorkerRegisterPayload>
  ): boolean {
    const payload = msg.payload;

    // 認証チェック
    if (payload.secret !== this.secret) {
      const ack = createMessage<WorkerRegisterAckPayload>(
        "worker:register_ack",
        {
          success: false,
          error: "Authentication failed: invalid secret",
          protocolVersion: PROTOCOL_VERSION,
        }
      );
      ws.send(JSON.stringify(ack));
      ws.close();
      return false;
    }

    // プロトコルバージョンチェック（警告のみ）
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      console.warn(
        `Worker "${payload.name}" protocol version mismatch: ` +
          `expected ${PROTOCOL_VERSION}, got ${payload.protocolVersion}`
      );
    }

    const workerId = payload.name;
    const now = Date.now();

    // Worker情報を登録
    const workerInfo: WorkerInfo = {
      id: workerId,
      name: payload.name,
      status: WorkerStatus.Online,
      currentTaskId: null,
      os: payload.os,
      nodeVersion: payload.nodeVersion,
      claudeCliVersion: payload.claudeCliVersion,
      defaultCwd: payload.defaultCwd,
      allowedDirs: payload.allowedDirs,
      lastHeartbeat: now,
      connectedAt: now,
    };

    this.workers.set(workerId, workerInfo);
    this.connections.set(workerId, ws);

    // ハートビート監視を開始
    this.startHeartbeatMonitor(workerId);

    // ACKを返す
    const ack = createMessage<WorkerRegisterAckPayload>(
      "worker:register_ack",
      {
        success: true,
        protocolVersion: PROTOCOL_VERSION,
      }
    );
    ws.send(JSON.stringify(ack));

    console.log(`Worker "${workerId}" registered successfully`);

    if (this.onWorkerConnected) {
      this.onWorkerConnected(workerInfo);
    }

    return true;
  }

  /**
   * ハートビート受信処理
   */
  handleHeartbeat(
    workerId: string,
    msg: WsMessage<WorkerHeartbeatPayload>
  ): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    worker.lastHeartbeat = Date.now();
    worker.currentTaskId = msg.payload.currentTaskId;

    // ハートビート監視タイマーをリセット
    this.startHeartbeatMonitor(workerId);

    // ACKを返す
    const ws = this.connections.get(workerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const ack = createMessage<WorkerHeartbeatAckPayload>(
        "worker:heartbeat_ack",
        { acknowledged: true },
        { workerId }
      );
      ws.send(JSON.stringify(ack));
    }
  }

  /**
   * Worker切断処理
   */
  handleDisconnect(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    const hadRunningTask = worker.currentTaskId !== null;

    worker.status = WorkerStatus.Offline;
    worker.currentTaskId = null;

    // タイマークリア
    const timer = this.heartbeatTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this.heartbeatTimers.delete(workerId);
    }

    this.connections.delete(workerId);
    this.workers.delete(workerId);

    console.log(`Worker "${workerId}" disconnected`);

    if (this.onWorkerDisconnected) {
      this.onWorkerDisconnected(workerId, hadRunningTask);
    }
  }

  /**
   * オンラインで利用可能なWorkerを取得する
   */
  getAvailableWorker(preferredWorkerId?: string | null): WorkerInfo | null {
    // 優先Workerが指定されている場合
    if (preferredWorkerId) {
      const preferred = this.workers.get(preferredWorkerId);
      if (preferred && preferred.status === WorkerStatus.Online) {
        return preferred;
      }
    }

    // ラウンドロビンで利用可能なWorkerを探す
    const onlineWorkers = Array.from(this.workers.values()).filter(
      (w) => w.status === WorkerStatus.Online
    );

    if (onlineWorkers.length === 0) return null;

    const index = this.roundRobinIndex % onlineWorkers.length;
    this.roundRobinIndex++;
    return onlineWorkers[index];
  }

  /**
   * WorkerにWebSocketメッセージを送信
   */
  sendToWorker(workerId: string, message: WsMessage): boolean {
    const ws = this.connections.get(workerId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    ws.send(JSON.stringify(message));
    return true;
  }

  /**
   * Worker状態を更新
   */
  setWorkerStatus(workerId: string, status: WorkerStatus): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.status = status;
    }
  }

  /**
   * Workerの現在タスクを設定
   */
  setWorkerCurrentTask(workerId: string, taskId: string | null): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.currentTaskId = taskId;
    }
  }

  /**
   * Worker情報を取得
   */
  getWorker(workerId: string): WorkerInfo | undefined {
    return this.workers.get(workerId);
  }

  /**
   * 全Worker一覧を取得
   */
  getAllWorkers(): WorkerInfo[] {
    return Array.from(this.workers.values());
  }

  /**
   * WorkerIDをWebSocketから検索
   */
  getWorkerIdByWs(ws: WebSocket): string | null {
    for (const [id, conn] of this.connections.entries()) {
      if (conn === ws) return id;
    }
    return null;
  }

  /**
   * 優先Workerを設定
   */
  setPreferredWorker(userId: string, workerId: string | null): void {
    if (workerId) {
      this.preferredWorkers.set(userId, workerId);
    } else {
      this.preferredWorkers.delete(userId);
    }
  }

  /**
   * ユーザーの優先Worker IDを取得
   */
  getPreferredWorkerId(userId: string): string | null {
    return this.preferredWorkers.get(userId) ?? null;
  }

  /**
   * ハートビート監視を開始/リセット
   * 2回連続（60秒）でハートビートが来なければofflineとみなす
   */
  private startHeartbeatMonitor(workerId: string): void {
    const existing = this.heartbeatTimers.get(workerId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      console.warn(
        `Worker "${workerId}" heartbeat timeout (${WS_HEARTBEAT_INTERVAL_MS * 2}ms)`
      );
      this.handleDisconnect(workerId);
    }, WS_HEARTBEAT_INTERVAL_MS * 2);

    this.heartbeatTimers.set(workerId, timer);
  }

  /**
   * 全リソースをクリーンアップ
   */
  destroy(): void {
    for (const timer of this.heartbeatTimers.values()) {
      clearTimeout(timer);
    }
    this.heartbeatTimers.clear();

    for (const ws of this.connections.values()) {
      ws.close();
    }
    this.connections.clear();
    this.workers.clear();
  }
}
