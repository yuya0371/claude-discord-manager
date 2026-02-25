import {
  Task,
  TaskStatus,
  PermissionMode,
  TokenUsage,
  ToolHistoryEntry,
  WorkerStatus,
  TaskAssignPayload,
  TaskStreamPayload,
  TaskCompletePayload,
  TaskErrorPayload,
  TaskCancelPayload,
  TaskQuestionPayload,
  TaskPermissionPayload,
  createMessage,
  TASK_DEFAULT_TIMEOUT_MS,
  DISCORD_STATUS_UPDATE_INTERVAL_MS,
} from "@claude-discord/common";
import { TaskQueue } from "./queue.js";
import { WorkerRegistry } from "../worker/registry.js";

export interface TaskCreateOptions {
  prompt: string;
  requestedBy: string;
  workerId?: string | null;
  cwd?: string | null;
  permissionMode?: PermissionMode;
  teamMode?: boolean;
  continueSession?: boolean;
  sessionId?: string | null;
}

/**
 * タスクのDiscordメッセージ更新コールバック
 */
export interface TaskEventCallbacks {
  onTaskQueued: (task: Task) => Promise<void>;
  onTaskStarted: (task: Task) => Promise<void>;
  onTaskStreamUpdate: (task: Task) => Promise<void>;
  onTaskCompleted: (task: Task) => Promise<void>;
  onTaskFailed: (task: Task) => Promise<void>;
  onTaskCancelled: (task: Task) => Promise<void>;
  onTaskQuestion: (taskId: string, payload: TaskQuestionPayload) => Promise<void>;
  onTaskPermission: (taskId: string, payload: TaskPermissionPayload) => Promise<void>;
}

export class TaskManager {
  /** 全タスクの管理マップ (taskId -> Task) */
  private tasks: Map<string, Task> = new Map();

  /** タスクIDカウンター */
  private taskIdCounter = 0;

  /** タスクタイムアウトタイマー */
  private timeoutTimers: Map<string, NodeJS.Timeout> = new Map();

  /** Discord Embed更新のスロットリングタイマー */
  private updateTimers: Map<string, NodeJS.Timeout> = new Map();

  /** 最後にEmbed更新した時刻 */
  private lastUpdateTime: Map<string, number> = new Map();

  /** イベントコールバック */
  public callbacks: TaskEventCallbacks | null = null;

  constructor(
    private readonly queue: TaskQueue,
    private readonly workerRegistry: WorkerRegistry
  ) {}

  /**
   * 新規タスクを作成してキューに追加する
   */
  createTask(options: TaskCreateOptions): Task {
    this.taskIdCounter++;
    const taskId = `task-${this.taskIdCounter}`;

    const task: Task = {
      id: taskId,
      prompt: options.prompt,
      status: TaskStatus.Queued,
      workerId: null,
      cwd: options.cwd ?? null,
      permissionMode: options.permissionMode ?? PermissionMode.AcceptEdits,
      teamMode: options.teamMode ?? false,
      continueSession: options.continueSession ?? false,
      sessionId: options.sessionId ?? null,
      attachments: [],
      toolHistory: [],
      resultText: null,
      errorMessage: null,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      discordMessageId: null,
      discordThreadId: null,
      requestedBy: options.requestedBy,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };

    this.tasks.set(taskId, task);
    this.queue.enqueue(taskId);

    return task;
  }

  /**
   * キューからタスクを取り出してWorkerに割り当てる
   */
  async dispatchNext(): Promise<void> {
    if (this.queue.isEmpty()) return;

    const taskId = this.queue.getAll()[0];
    if (!taskId) return;

    const task = this.tasks.get(taskId);
    if (!task) {
      this.queue.dequeue();
      return;
    }

    // 利用可能なWorkerを探す
    const worker = this.workerRegistry.getAvailableWorker();
    if (!worker) return;

    // キューから取り出す
    this.queue.dequeue();

    // タスクをrunning状態に更新
    task.status = TaskStatus.Running;
    task.workerId = worker.id;
    task.startedAt = Date.now();

    // Worker状態をbusyに
    this.workerRegistry.setWorkerStatus(worker.id, WorkerStatus.Busy);
    this.workerRegistry.setWorkerCurrentTask(worker.id, taskId);

    // タスク割り当てメッセージを送信
    const assignMsg = createMessage<TaskAssignPayload>(
      "task:assign",
      {
        taskId: task.id,
        prompt: task.prompt,
        cwd: task.cwd,
        permissionMode: task.permissionMode,
        teamMode: task.teamMode,
        continueSession: task.continueSession,
        sessionId: task.sessionId,
        attachments: task.attachments,
      },
      { taskId: task.id, workerId: worker.id }
    );

    this.workerRegistry.sendToWorker(worker.id, assignMsg);

    // タイムアウトタイマー設定
    this.setTaskTimeout(taskId);

    // コールバック
    if (this.callbacks?.onTaskStarted) {
      await this.callbacks.onTaskStarted(task);
    }

    console.log(`Task ${taskId} assigned to worker "${worker.id}"`);
  }

  /**
   * ストリーム更新を処理
   */
  async handleStreamUpdate(
    taskId: string,
    payload: TaskStreamPayload
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.Running) return;

    switch (payload.eventType) {
      case "assistant_message": {
        const data = payload.data as { text: string };
        // resultTextに蓄積（最終的にresultイベントで上書きされる）
        task.resultText = (task.resultText ?? "") + data.text;
        break;
      }
      case "tool_use_begin": {
        const data = payload.data as { toolName: string; summary: string };
        const entry: ToolHistoryEntry = {
          toolName: data.toolName,
          summary: data.summary,
          status: "running",
          timestamp: Date.now(),
        };
        task.toolHistory.push(entry);
        break;
      }
      case "tool_use_end": {
        const data = payload.data as {
          toolName: string;
          summary: string;
          success: boolean;
        };
        // 最後のrunning状態のエントリを更新
        for (let i = task.toolHistory.length - 1; i >= 0; i--) {
          if (
            task.toolHistory[i].toolName === data.toolName &&
            task.toolHistory[i].status === "running"
          ) {
            task.toolHistory[i].status = data.success
              ? "completed"
              : "error";
            task.toolHistory[i].summary = data.summary;
            break;
          }
        }
        break;
      }
      case "token_usage": {
        const data = payload.data as {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        };
        task.tokenUsage = {
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          cacheReadTokens: data.cacheReadTokens,
          cacheWriteTokens: data.cacheWriteTokens,
        };
        break;
      }
      case "result": {
        const data = payload.data as {
          text: string;
          sessionId: string | null;
        };
        task.resultText = data.text;
        task.sessionId = data.sessionId;
        break;
      }
      case "error": {
        const data = payload.data as { message: string };
        task.errorMessage = data.message;
        break;
      }
    }

    // Embed更新をスロットリング（1秒間隔）
    this.throttledUpdate(taskId, task);
  }

  /**
   * タスク完了処理
   */
  async handleTaskComplete(
    taskId: string,
    payload: TaskCompletePayload
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.Running) return;

    task.status = TaskStatus.Completed;
    task.resultText = payload.resultText;
    task.sessionId = payload.sessionId;
    task.tokenUsage = payload.tokenUsage;
    task.completedAt = Date.now();

    // Worker状態をonlineに戻す
    if (task.workerId) {
      this.workerRegistry.setWorkerStatus(task.workerId, WorkerStatus.Online);
      this.workerRegistry.setWorkerCurrentTask(task.workerId, null);
    }

    // タイムアウトタイマーをクリア
    this.clearTaskTimeout(taskId);
    this.clearThrottleTimer(taskId);

    console.log(`Task ${taskId} completed`);

    if (this.callbacks?.onTaskCompleted) {
      await this.callbacks.onTaskCompleted(task);
    }

    // 次のタスクをディスパッチ
    await this.dispatchNext();
  }

  /**
   * タスクエラー処理
   */
  async handleTaskError(
    taskId: string,
    payload: TaskErrorPayload
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.Running) return;

    task.status = TaskStatus.Failed;
    task.errorMessage = payload.message;
    if (payload.partialResult) {
      task.resultText = payload.partialResult;
    }
    task.tokenUsage = payload.tokenUsage;
    task.completedAt = Date.now();

    // Worker状態をonlineに戻す
    if (task.workerId) {
      this.workerRegistry.setWorkerStatus(task.workerId, WorkerStatus.Online);
      this.workerRegistry.setWorkerCurrentTask(task.workerId, null);
    }

    this.clearTaskTimeout(taskId);
    this.clearThrottleTimer(taskId);

    console.log(`Task ${taskId} failed: ${payload.message}`);

    if (this.callbacks?.onTaskFailed) {
      await this.callbacks.onTaskFailed(task);
    }

    // 次のタスクをディスパッチ
    await this.dispatchNext();
  }

  /**
   * タスクキャンセル処理
   */
  async cancelTask(taskId: string, reason: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (
      task.status === TaskStatus.Completed ||
      task.status === TaskStatus.Failed ||
      task.status === TaskStatus.Cancelled
    ) {
      return false;
    }

    if (task.status === TaskStatus.Queued) {
      // キューから削除
      this.queue.remove(taskId);
      task.status = TaskStatus.Cancelled;
      task.completedAt = Date.now();
    } else if (task.status === TaskStatus.Running && task.workerId) {
      // Workerにキャンセル送信
      const cancelMsg = createMessage<TaskCancelPayload>(
        "task:cancel",
        { reason },
        { taskId, workerId: task.workerId }
      );
      this.workerRegistry.sendToWorker(task.workerId, cancelMsg);

      task.status = TaskStatus.Cancelled;
      task.completedAt = Date.now();

      // Worker状態をonlineに戻す
      this.workerRegistry.setWorkerStatus(
        task.workerId,
        WorkerStatus.Online
      );
      this.workerRegistry.setWorkerCurrentTask(task.workerId, null);
    }

    this.clearTaskTimeout(taskId);
    this.clearThrottleTimer(taskId);

    if (this.callbacks?.onTaskCancelled) {
      await this.callbacks.onTaskCancelled(task);
    }

    // 次のタスクをディスパッチ
    await this.dispatchNext();

    return true;
  }

  /**
   * Worker切断時に、そのWorkerで実行中のタスクをfailedにする
   */
  async handleWorkerDisconnect(workerId: string): Promise<void> {
    for (const task of this.tasks.values()) {
      if (
        task.workerId === workerId &&
        task.status === TaskStatus.Running
      ) {
        task.status = TaskStatus.Failed;
        task.errorMessage = "Worker切断により実行が中断されました";
        task.completedAt = Date.now();

        this.clearTaskTimeout(task.id);
        this.clearThrottleTimer(task.id);

        if (this.callbacks?.onTaskFailed) {
          await this.callbacks.onTaskFailed(task);
        }
      }
    }
  }

  /**
   * タスクを取得
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 全タスク一覧
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 実行中のタスク一覧
   */
  getRunningTasks(): Task[] {
    return this.getAllTasks().filter((t) => t.status === TaskStatus.Running);
  }

  /**
   * Worker からの質問を処理
   */
  async handleTaskQuestion(
    taskId: string,
    payload: TaskQuestionPayload
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.Running) return;

    if (this.callbacks?.onTaskQuestion) {
      await this.callbacks.onTaskQuestion(taskId, payload);
    }
  }

  /**
   * Worker からの権限確認を処理
   */
  async handleTaskPermission(
    taskId: string,
    payload: TaskPermissionPayload
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== TaskStatus.Running) return;

    if (this.callbacks?.onTaskPermission) {
      await this.callbacks.onTaskPermission(taskId, payload);
    }
  }

  /**
   * タスクのDiscordメッセージIDを設定
   */
  setDiscordMessageId(taskId: string, messageId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.discordMessageId = messageId;
    }
  }

  /**
   * タスクのDiscordスレッドIDを設定
   */
  setDiscordThreadId(taskId: string, threadId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.discordThreadId = threadId;
    }
  }

  // --- Private methods ---

  private setTaskTimeout(taskId: string): void {
    const timer = setTimeout(async () => {
      await this.cancelTask(taskId, "タイムアウト");
    }, TASK_DEFAULT_TIMEOUT_MS);

    this.timeoutTimers.set(taskId, timer);
  }

  private clearTaskTimeout(taskId: string): void {
    const timer = this.timeoutTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(taskId);
    }
  }

  private throttledUpdate(taskId: string, task: Task): void {
    const now = Date.now();
    const lastUpdate = this.lastUpdateTime.get(taskId) ?? 0;
    const elapsed = now - lastUpdate;

    if (elapsed >= DISCORD_STATUS_UPDATE_INTERVAL_MS) {
      // 即座に更新
      this.lastUpdateTime.set(taskId, now);
      if (this.callbacks?.onTaskStreamUpdate) {
        this.callbacks.onTaskStreamUpdate(task).catch(console.error);
      }
    } else {
      // 次の更新タイミングまで遅延
      if (!this.updateTimers.has(taskId)) {
        const delay = DISCORD_STATUS_UPDATE_INTERVAL_MS - elapsed;
        const timer = setTimeout(() => {
          this.updateTimers.delete(taskId);
          this.lastUpdateTime.set(taskId, Date.now());
          if (this.callbacks?.onTaskStreamUpdate) {
            this.callbacks.onTaskStreamUpdate(task).catch(console.error);
          }
        }, delay);
        this.updateTimers.set(taskId, timer);
      }
    }
  }

  private clearThrottleTimer(taskId: string): void {
    const timer = this.updateTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.updateTimers.delete(taskId);
    }
    this.lastUpdateTime.delete(taskId);
  }

  /**
   * 全リソースをクリーンアップ
   */
  destroy(): void {
    for (const timer of this.timeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.timeoutTimers.clear();

    for (const timer of this.updateTimers.values()) {
      clearTimeout(timer);
    }
    this.updateTimers.clear();
    this.lastUpdateTime.clear();
  }
}
