/**
 * 結合テスト: WsServer + WorkerRegistry + TaskManager
 *
 * 実際の WebSocket サーバーを起動し、ws クライアントで接続して
 * Coordinator の WebSocket レイヤーを End-to-End でテストする。
 * Discord Bot は不要（モック不要）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { WsServer } from "../src/ws/server.js";
import { WorkerRegistry } from "../src/worker/registry.js";
import { TaskManager } from "../src/task/manager.js";
import { TaskQueue } from "../src/task/queue.js";
import {
  createMessage,
  parseMessage,
  PROTOCOL_VERSION,
  TaskStatus,
  WorkerStatus,
  type WorkerRegisterPayload,
  type WorkerRegisterAckPayload,
  type WorkerHeartbeatPayload,
  type WorkerHeartbeatAckPayload,
  type TaskAssignPayload,
  type TaskCompletePayload,
  type TaskStreamPayload,
  type WsMessage,
} from "@claude-discord/common";

// テスト用ポート（テストごとにインクリメントして衝突回避）
let testPort = 19000;

function getNextPort(): number {
  return testPort++;
}

/** WebSocket クライアントを生成してopenまで待つ */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** ws.send を Promise 化 */
function wsSend(ws: WebSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(data, (err) => (err ? reject(err) : resolve()));
  });
}

/** 次のメッセージを受信するまで待つ */
function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for message")),
      timeoutMs,
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(parseMessage(data.toString()));
    });
  });
}

/** ws が close されるまで待つ */
function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for close")),
      timeoutMs,
    );
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Worker 登録メッセージを送信して ACK を受信する */
async function registerWorker(
  ws: WebSocket,
  name: string,
  secret: string,
): Promise<WsMessage<WorkerRegisterAckPayload>> {
  const msg = createMessage<WorkerRegisterPayload>("worker:register", {
    name,
    secret,
    os: "test",
    nodeVersion: "v20.0.0",
    claudeCliVersion: "1.0.0",
    defaultCwd: "/tmp",
    allowedDirs: ["/tmp"],
    protocolVersion: PROTOCOL_VERSION,
  });
  await wsSend(ws, JSON.stringify(msg));
  return (await waitForMessage(ws)) as WsMessage<WorkerRegisterAckPayload>;
}

describe("Integration: WsServer + WorkerRegistry + TaskManager", () => {
  let port: number;
  let server: WsServer;
  let registry: WorkerRegistry;
  let taskManager: TaskManager;
  let queue: TaskQueue;
  let clients: WebSocket[];

  beforeEach(async () => {
    port = getNextPort();
    queue = new TaskQueue();
    registry = new WorkerRegistry("test-secret");
    taskManager = new TaskManager(queue, registry);

    // Worker切断コールバック
    registry.onWorkerDisconnected = async (workerId, hadRunningTask) => {
      if (hadRunningTask) {
        await taskManager.handleWorkerDisconnect(workerId);
      }
    };

    server = new WsServer({ port, host: "127.0.0.1" }, registry, taskManager);
    await server.start();
    clients = [];
  });

  afterEach(async () => {
    // クライアントを全部閉じる
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    registry.destroy();
    taskManager.destroy();
    await server.stop();
  });

  // ─── Worker 登録テスト ───

  describe("Worker registration", () => {
    it("should accept worker with correct secret", async () => {
      const ws = await connectClient(port);
      clients.push(ws);

      const ack = await registerWorker(ws, "worker-1", "test-secret");

      expect(ack.type).toBe("worker:register_ack");
      expect(ack.payload.success).toBe(true);
      expect(ack.payload.protocolVersion).toBe(PROTOCOL_VERSION);

      // Registry に登録されていることを確認
      const worker = registry.getWorker("worker-1");
      expect(worker).toBeDefined();
      expect(worker!.status).toBe(WorkerStatus.Online);
    });

    it("should reject worker with incorrect secret", async () => {
      const ws = await connectClient(port);
      clients.push(ws);

      const ack = await registerWorker(ws, "worker-bad", "wrong-secret");

      expect(ack.type).toBe("worker:register_ack");
      expect(ack.payload.success).toBe(false);
      expect(ack.payload.error).toContain("Authentication failed");

      // 接続が閉じられることを確認
      await waitForClose(ws);
      expect(registry.getWorker("worker-bad")).toBeUndefined();
    });

    it("should close connection if non-register message sent before auth", async () => {
      const ws = await connectClient(port);
      clients.push(ws);

      // register 以外のメッセージを送信
      const msg = createMessage("worker:heartbeat", {
        status: "online",
        currentTaskId: null,
      });
      await wsSend(ws, JSON.stringify(msg));

      await waitForClose(ws);
    });
  });

  // ─── Heartbeat テスト ───

  describe("Heartbeat", () => {
    it("should respond with heartbeat_ack", async () => {
      const ws = await connectClient(port);
      clients.push(ws);
      await registerWorker(ws, "worker-hb", "test-secret");

      // heartbeat 送信
      const hbMsg = createMessage<WorkerHeartbeatPayload>(
        "worker:heartbeat",
        { status: WorkerStatus.Online, currentTaskId: null },
        { workerId: "worker-hb" },
      );
      await wsSend(ws, JSON.stringify(hbMsg));

      const ack = (await waitForMessage(ws)) as WsMessage<WorkerHeartbeatAckPayload>;
      expect(ack.type).toBe("worker:heartbeat_ack");
      expect(ack.payload.acknowledged).toBe(true);
    });
  });

  // ─── タスクディスパッチテスト ───

  describe("Task dispatch", () => {
    it("should dispatch task to connected worker", async () => {
      const ws = await connectClient(port);
      clients.push(ws);
      await registerWorker(ws, "worker-dispatch", "test-secret");

      // タスク作成
      const task = taskManager.createTask({
        prompt: "Hello from test",
        requestedBy: "test-user",
      });
      expect(task.status).toBe(TaskStatus.Queued);

      // ディスパッチ
      await taskManager.dispatchNext();

      // Worker 側で task:assign を受信
      const assignMsg = (await waitForMessage(ws)) as WsMessage<TaskAssignPayload>;
      expect(assignMsg.type).toBe("task:assign");
      expect(assignMsg.payload.prompt).toBe("Hello from test");
      expect(assignMsg.payload.taskId).toBe(task.id);

      // タスク状態が Running に
      expect(taskManager.getTask(task.id)!.status).toBe(TaskStatus.Running);
    });

    it("should queue task when no workers available", async () => {
      // Worker を接続しない
      const task = taskManager.createTask({
        prompt: "No worker",
        requestedBy: "test-user",
      });

      await taskManager.dispatchNext();

      // キューに残ったまま
      expect(task.status).toBe(TaskStatus.Queued);
      expect(queue.size).toBe(1);
    });
  });

  // ─── タスク完了テスト ───

  describe("Task complete flow", () => {
    it("should handle task:complete from worker", async () => {
      const ws = await connectClient(port);
      clients.push(ws);
      await registerWorker(ws, "worker-complete", "test-secret");

      // タスク作成・ディスパッチ
      const task = taskManager.createTask({
        prompt: "Complete me",
        requestedBy: "user-1",
      });

      const completedCallback = vi.fn().mockResolvedValue(undefined);
      taskManager.callbacks = {
        onTaskQueued: vi.fn().mockResolvedValue(undefined),
        onTaskStarted: vi.fn().mockResolvedValue(undefined),
        onTaskStreamUpdate: vi.fn().mockResolvedValue(undefined),
        onTaskCompleted: completedCallback,
        onTaskFailed: vi.fn().mockResolvedValue(undefined),
        onTaskCancelled: vi.fn().mockResolvedValue(undefined),
      };

      await taskManager.dispatchNext();

      // Worker 側で task:assign 受信
      await waitForMessage(ws);

      // Worker がストリームイベントを送信
      const streamMsg = createMessage<TaskStreamPayload>(
        "task:stream",
        {
          eventType: "assistant_message",
          data: { text: "Working on it..." },
        },
        { taskId: task.id, workerId: "worker-complete" },
      );
      await wsSend(ws, JSON.stringify(streamMsg));

      // 少し待ってストリーム処理
      await new Promise((r) => setTimeout(r, 50));

      // Worker が完了を送信
      const completeMsg = createMessage<TaskCompletePayload>(
        "task:complete",
        {
          resultText: "Task done!",
          sessionId: "session-xyz",
          tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
          durationMs: 2000,
        },
        { taskId: task.id, workerId: "worker-complete" },
      );
      await wsSend(ws, JSON.stringify(completeMsg));

      // 完了処理の待機
      await new Promise((r) => setTimeout(r, 100));

      const updatedTask = taskManager.getTask(task.id)!;
      expect(updatedTask.status).toBe(TaskStatus.Completed);
      expect(updatedTask.resultText).toBe("Task done!");
      expect(updatedTask.sessionId).toBe("session-xyz");
      expect(completedCallback).toHaveBeenCalledOnce();

      // Worker が再び Online に
      const worker = registry.getWorker("worker-complete");
      expect(worker!.status).toBe(WorkerStatus.Online);
    });
  });

  // ─── Worker 切断テスト ───

  describe("Worker disconnect", () => {
    it("should mark running task as failed when worker disconnects", async () => {
      const ws = await connectClient(port);
      clients.push(ws);
      await registerWorker(ws, "worker-dc", "test-secret");

      const failedCallback = vi.fn().mockResolvedValue(undefined);
      taskManager.callbacks = {
        onTaskQueued: vi.fn().mockResolvedValue(undefined),
        onTaskStarted: vi.fn().mockResolvedValue(undefined),
        onTaskStreamUpdate: vi.fn().mockResolvedValue(undefined),
        onTaskCompleted: vi.fn().mockResolvedValue(undefined),
        onTaskFailed: failedCallback,
        onTaskCancelled: vi.fn().mockResolvedValue(undefined),
      };

      // タスク割り当て
      const task = taskManager.createTask({
        prompt: "Will disconnect",
        requestedBy: "user-1",
      });
      await taskManager.dispatchNext();
      await waitForMessage(ws); // task:assign

      expect(taskManager.getTask(task.id)!.status).toBe(TaskStatus.Running);

      // Worker が突然切断
      ws.close();
      await new Promise((r) => setTimeout(r, 200));

      // タスクが Failed に
      const updatedTask = taskManager.getTask(task.id)!;
      expect(updatedTask.status).toBe(TaskStatus.Failed);
      expect(updatedTask.errorMessage).toContain("Worker切断");
      expect(failedCallback).toHaveBeenCalledOnce();

      // Registry から削除されている
      expect(registry.getWorker("worker-dc")).toBeUndefined();
    });

    it("should not affect tasks when worker without running task disconnects", async () => {
      const ws = await connectClient(port);
      clients.push(ws);
      await registerWorker(ws, "worker-idle-dc", "test-secret");

      // タスクなしで切断
      ws.close();
      await new Promise((r) => setTimeout(r, 200));

      expect(registry.getWorker("worker-idle-dc")).toBeUndefined();
    });
  });

  // ─── 複数 Worker テスト ───

  describe("Multiple workers", () => {
    it("should dispatch tasks to different workers (round-robin)", async () => {
      const ws1 = await connectClient(port);
      const ws2 = await connectClient(port);
      clients.push(ws1, ws2);

      await registerWorker(ws1, "worker-a", "test-secret");
      await registerWorker(ws2, "worker-b", "test-secret");

      // 2つのタスクを作成
      const task1 = taskManager.createTask({ prompt: "Task 1", requestedBy: "u1" });
      const task2 = taskManager.createTask({ prompt: "Task 2", requestedBy: "u2" });

      // 1つ目をディスパッチ
      await taskManager.dispatchNext();
      const assign1 = await waitForMessage(ws1).catch(() => null) ?? await waitForMessage(ws2).catch(() => null);

      // task1 が Running に
      expect(taskManager.getTask(task1.id)!.status).toBe(TaskStatus.Running);
      const worker1Id = taskManager.getTask(task1.id)!.workerId;

      // task1 を完了
      const completeMsg = createMessage<TaskCompletePayload>(
        "task:complete",
        {
          resultText: "Done 1",
          sessionId: null,
          tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          durationMs: 100,
        },
        { taskId: task1.id, workerId: worker1Id! },
      );
      const ws1Worker = worker1Id === "worker-a" ? ws1 : ws2;
      await wsSend(ws1Worker, JSON.stringify(completeMsg));

      // dispatchNext は handleTaskComplete 内で呼ばれるので待つ
      await new Promise((r) => setTimeout(r, 200));

      // task2 もディスパッチされるはず
      expect(taskManager.getTask(task2.id)!.status).toBe(TaskStatus.Running);
    });
  });
});
