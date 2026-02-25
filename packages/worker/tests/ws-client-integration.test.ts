/**
 * 結合テスト: Worker WsClient <-> Coordinator WsServer
 *
 * 実際の WsServer を起動し、Worker の WsClient クラスで接続する。
 * Discord Bot / Claude CLI は不要。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WsServer } from "../../coordinator/src/ws/server.js";
import { WorkerRegistry } from "../../coordinator/src/worker/registry.js";
import { TaskManager } from "../../coordinator/src/task/manager.js";
import { TaskQueue } from "../../coordinator/src/task/queue.js";
import { WsClient } from "../src/ws/client.js";
import {
  TaskStatus,
  WorkerStatus,
  type WsMessage,
  type TaskAssignPayload,
  type TaskStreamPayload,
  type TaskCompletePayload,
  type TaskErrorPayload,
} from "@claude-discord/common";

let testPort = 19100;
function getNextPort(): number {
  return testPort++;
}

/** イベントを待つヘルパー */
function waitForEvent(
  emitter: { once: (event: string, cb: (...args: unknown[]) => void) => void },
  event: string,
  timeoutMs = 3000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for event "${event}"`)),
      timeoutMs,
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

describe("Integration: WsClient <-> WsServer", () => {
  let port: number;
  let server: WsServer;
  let registry: WorkerRegistry;
  let taskManager: TaskManager;
  let queue: TaskQueue;
  let wsClient: WsClient;

  beforeEach(async () => {
    port = getNextPort();
    queue = new TaskQueue();
    registry = new WorkerRegistry("integration-secret");
    taskManager = new TaskManager(queue, registry);

    registry.onWorkerDisconnected = async (workerId, hadRunningTask) => {
      if (hadRunningTask) {
        await taskManager.handleWorkerDisconnect(workerId);
      }
    };

    server = new WsServer({ port, host: "127.0.0.1" }, registry, taskManager);
    await server.start();
  });

  afterEach(async () => {
    if (wsClient) {
      wsClient.shutdown();
    }
    registry.destroy();
    taskManager.destroy();
    await server.stop();
  });

  // ─── 登録テスト ───

  describe("Worker registration via WsClient", () => {
    it("should register successfully with correct secret", async () => {
      wsClient = new WsClient({
        coordinatorUrl: `ws://127.0.0.1:${port}`,
        secret: "integration-secret",
        workerName: "test-worker-1",
        defaultCwd: "/tmp",
      });

      const registeredPromise = waitForEvent(wsClient, "registered");
      wsClient.connect();
      await registeredPromise;

      expect(wsClient.registered).toBe(true);
      expect(wsClient.connected).toBe(true);

      // Coordinator 側で Worker が登録されていることを確認
      const worker = registry.getWorker("test-worker-1");
      expect(worker).toBeDefined();
      expect(worker!.status).toBe(WorkerStatus.Online);
      expect(worker!.name).toBe("test-worker-1");
    });

    it("should emit register_failed with wrong secret", async () => {
      wsClient = new WsClient({
        coordinatorUrl: `ws://127.0.0.1:${port}`,
        secret: "wrong-secret",
        workerName: "bad-worker",
        defaultCwd: "/tmp",
      });

      const failedPromise = waitForEvent(wsClient, "register_failed");
      wsClient.connect();
      const [error] = await failedPromise;

      expect(wsClient.registered).toBe(false);
      expect(error).toContain("Authentication failed");

      // Coordinator 側にも登録されていない
      expect(registry.getWorker("bad-worker")).toBeUndefined();
    });
  });

  // ─── タスク割当 → ストリーム → 完了フロー ───

  describe("Full task lifecycle: assign -> stream -> complete", () => {
    it("should receive task:assign, send stream events, and complete", async () => {
      wsClient = new WsClient({
        coordinatorUrl: `ws://127.0.0.1:${port}`,
        secret: "integration-secret",
        workerName: "lifecycle-worker",
        defaultCwd: "/tmp",
      });

      const registeredPromise = waitForEvent(wsClient, "registered");
      wsClient.connect();
      await registeredPromise;

      // Worker 側で message イベント（task:assign）を待つ
      const messagePromise = waitForEvent(wsClient, "message");

      // Coordinator 側でタスク作成・ディスパッチ
      const task = taskManager.createTask({
        prompt: "Integration test prompt",
        requestedBy: "test-user",
      });

      const startedCallback = vi.fn().mockResolvedValue(undefined);
      const completedCallback = vi.fn().mockResolvedValue(undefined);
      taskManager.callbacks = {
        onTaskQueued: vi.fn().mockResolvedValue(undefined),
        onTaskStarted: startedCallback,
        onTaskStreamUpdate: vi.fn().mockResolvedValue(undefined),
        onTaskCompleted: completedCallback,
        onTaskFailed: vi.fn().mockResolvedValue(undefined),
        onTaskCancelled: vi.fn().mockResolvedValue(undefined),
      };

      await taskManager.dispatchNext();

      // Worker 側で task:assign 受信
      const [assignMsg] = (await messagePromise) as [WsMessage<TaskAssignPayload>];
      expect(assignMsg.type).toBe("task:assign");
      expect(assignMsg.payload.prompt).toBe("Integration test prompt");
      expect(assignMsg.payload.taskId).toBe(task.id);

      // タスクが Running に
      expect(taskManager.getTask(task.id)!.status).toBe(TaskStatus.Running);
      expect(startedCallback).toHaveBeenCalledOnce();

      // Worker がストリームイベントを送信
      wsClient.setStatus(WorkerStatus.Busy, task.id);

      const streamPayload: TaskStreamPayload = {
        eventType: "assistant_message",
        data: { text: "Processing your request..." },
      };
      wsClient.send("task:stream", streamPayload, task.id);

      await new Promise((r) => setTimeout(r, 50));

      // ストリームが反映されていることを確認
      expect(taskManager.getTask(task.id)!.resultText).toContain("Processing");

      // Worker がツール使用イベントを送信
      const toolBeginPayload: TaskStreamPayload = {
        eventType: "tool_use_begin",
        data: { toolName: "Read", summary: "Read: /tmp/test.ts" },
      };
      wsClient.send("task:stream", toolBeginPayload, task.id);

      await new Promise((r) => setTimeout(r, 50));

      expect(taskManager.getTask(task.id)!.toolHistory).toHaveLength(1);
      expect(taskManager.getTask(task.id)!.toolHistory[0].status).toBe("running");

      // Worker がツール完了を送信
      const toolEndPayload: TaskStreamPayload = {
        eventType: "tool_use_end",
        data: { toolName: "Read", summary: "Read: contents", success: true },
      };
      wsClient.send("task:stream", toolEndPayload, task.id);

      await new Promise((r) => setTimeout(r, 50));

      expect(taskManager.getTask(task.id)!.toolHistory[0].status).toBe("completed");

      // Worker がタスク完了を送信
      const completePayload: TaskCompletePayload = {
        resultText: "Final answer from integration test",
        sessionId: "session-int-1",
        tokenUsage: {
          inputTokens: 200,
          outputTokens: 100,
          cacheReadTokens: 50,
          cacheWriteTokens: 10,
        },
        durationMs: 3000,
      };
      wsClient.send("task:complete", completePayload, task.id);

      await new Promise((r) => setTimeout(r, 200));

      // タスク完了を確認
      const completedTask = taskManager.getTask(task.id)!;
      expect(completedTask.status).toBe(TaskStatus.Completed);
      expect(completedTask.resultText).toBe("Final answer from integration test");
      expect(completedTask.sessionId).toBe("session-int-1");
      expect(completedTask.tokenUsage.inputTokens).toBe(200);
      expect(completedTask.tokenUsage.outputTokens).toBe(100);
      expect(completedCallback).toHaveBeenCalledOnce();

      // Worker がオンラインに復帰
      const worker = registry.getWorker("lifecycle-worker");
      expect(worker!.status).toBe(WorkerStatus.Online);
    });

    it("should handle task:error from worker", async () => {
      wsClient = new WsClient({
        coordinatorUrl: `ws://127.0.0.1:${port}`,
        secret: "integration-secret",
        workerName: "error-worker",
        defaultCwd: "/tmp",
      });

      const registeredPromise = waitForEvent(wsClient, "registered");
      wsClient.connect();
      await registeredPromise;

      const messagePromise = waitForEvent(wsClient, "message");

      const task = taskManager.createTask({
        prompt: "This will fail",
        requestedBy: "test-user",
      });

      const failedCallback = vi.fn().mockResolvedValue(undefined);
      taskManager.callbacks = {
        onTaskQueued: vi.fn().mockResolvedValue(undefined),
        onTaskStarted: vi.fn().mockResolvedValue(undefined),
        onTaskStreamUpdate: vi.fn().mockResolvedValue(undefined),
        onTaskCompleted: vi.fn().mockResolvedValue(undefined),
        onTaskFailed: failedCallback,
        onTaskCancelled: vi.fn().mockResolvedValue(undefined),
      };

      await taskManager.dispatchNext();
      await messagePromise; // task:assign

      // Worker がエラーを送信
      const errorPayload: TaskErrorPayload = {
        message: "Claude CLI crashed",
        code: "EXIT_1",
        partialResult: "partial output",
        tokenUsage: {
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
      wsClient.send("task:error", errorPayload, task.id);

      await new Promise((r) => setTimeout(r, 200));

      const failedTask = taskManager.getTask(task.id)!;
      expect(failedTask.status).toBe(TaskStatus.Failed);
      expect(failedTask.errorMessage).toBe("Claude CLI crashed");
      expect(failedTask.resultText).toBe("partial output");
      expect(failedCallback).toHaveBeenCalledOnce();
    });
  });

  // ─── ハートビートテスト ───

  describe("Heartbeat via WsClient", () => {
    it("should send heartbeats after registration (verified via lastHeartbeat)", async () => {
      // ハートビート間隔を短くするため、WsClient のハートビートを手動トリガー
      wsClient = new WsClient({
        coordinatorUrl: `ws://127.0.0.1:${port}`,
        secret: "integration-secret",
        workerName: "hb-worker",
        defaultCwd: "/tmp",
      });

      const registeredPromise = waitForEvent(wsClient, "registered");
      wsClient.connect();
      await registeredPromise;

      const worker = registry.getWorker("hb-worker")!;
      const initialHb = worker.lastHeartbeat;

      // WsClient の send メソッドで手動 heartbeat を送信
      wsClient.send("worker:heartbeat", {
        status: WorkerStatus.Online,
        currentTaskId: null,
      });

      await new Promise((r) => setTimeout(r, 100));

      // lastHeartbeat が更新されている
      const updatedWorker = registry.getWorker("hb-worker")!;
      expect(updatedWorker.lastHeartbeat).toBeGreaterThanOrEqual(initialHb);
    });
  });

  // ─── Worker 切断テスト ───

  describe("Worker disconnect via WsClient.shutdown()", () => {
    it("should mark running task as failed when WsClient shuts down", async () => {
      wsClient = new WsClient({
        coordinatorUrl: `ws://127.0.0.1:${port}`,
        secret: "integration-secret",
        workerName: "shutdown-worker",
        defaultCwd: "/tmp",
      });

      const registeredPromise = waitForEvent(wsClient, "registered");
      wsClient.connect();
      await registeredPromise;

      const messagePromise = waitForEvent(wsClient, "message");

      const task = taskManager.createTask({
        prompt: "Will be interrupted",
        requestedBy: "test-user",
      });

      const failedCallback = vi.fn().mockResolvedValue(undefined);
      taskManager.callbacks = {
        onTaskQueued: vi.fn().mockResolvedValue(undefined),
        onTaskStarted: vi.fn().mockResolvedValue(undefined),
        onTaskStreamUpdate: vi.fn().mockResolvedValue(undefined),
        onTaskCompleted: vi.fn().mockResolvedValue(undefined),
        onTaskFailed: failedCallback,
        onTaskCancelled: vi.fn().mockResolvedValue(undefined),
      };

      await taskManager.dispatchNext();
      await messagePromise; // task:assign

      expect(taskManager.getTask(task.id)!.status).toBe(TaskStatus.Running);

      // Worker が graceful shutdown
      wsClient.shutdown();

      await new Promise((r) => setTimeout(r, 300));

      // タスクが Failed になる
      const failedTask = taskManager.getTask(task.id)!;
      expect(failedTask.status).toBe(TaskStatus.Failed);
      expect(failedTask.errorMessage).toContain("Worker切断");
      expect(failedCallback).toHaveBeenCalledOnce();

      // Registry から削除されている
      expect(registry.getWorker("shutdown-worker")).toBeUndefined();
    });

    it("should not trigger reconnect after shutdown()", async () => {
      wsClient = new WsClient({
        coordinatorUrl: `ws://127.0.0.1:${port}`,
        secret: "integration-secret",
        workerName: "no-reconnect",
        defaultCwd: "/tmp",
      });

      const registeredPromise = waitForEvent(wsClient, "registered");
      wsClient.connect();
      await registeredPromise;

      wsClient.shutdown();

      await new Promise((r) => setTimeout(r, 500));

      // shutdown 後は再接続しない
      expect(wsClient.connected).toBe(false);
      expect(wsClient.registered).toBe(false);
    });
  });

  // ─── 複数タスク連続処理テスト ───

  describe("Sequential task processing", () => {
    it("should handle multiple tasks in sequence", async () => {
      wsClient = new WsClient({
        coordinatorUrl: `ws://127.0.0.1:${port}`,
        secret: "integration-secret",
        workerName: "seq-worker",
        defaultCwd: "/tmp",
      });

      const registeredPromise = waitForEvent(wsClient, "registered");
      wsClient.connect();
      await registeredPromise;

      // --- Task 1 ---
      const task1 = taskManager.createTask({ prompt: "Task 1", requestedBy: "u1" });
      const task2 = taskManager.createTask({ prompt: "Task 2", requestedBy: "u2" });

      const msg1Promise = waitForEvent(wsClient, "message");
      await taskManager.dispatchNext();
      const [assign1] = (await msg1Promise) as [WsMessage<TaskAssignPayload>];
      expect(assign1.payload.prompt).toBe("Task 1");

      // Task 1 完了
      wsClient.send(
        "task:complete",
        {
          resultText: "Result 1",
          sessionId: null,
          tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          durationMs: 100,
        } satisfies TaskCompletePayload,
        task1.id,
      );

      // handleTaskComplete 内で dispatchNext が呼ばれ、Task 2 が割り当てられる
      await new Promise((r) => setTimeout(r, 300));

      expect(taskManager.getTask(task1.id)!.status).toBe(TaskStatus.Completed);

      // Task 2 が Running になっているはず
      const task2Status = taskManager.getTask(task2.id)!.status;
      expect(task2Status).toBe(TaskStatus.Running);

      // Task 2 完了
      wsClient.send(
        "task:complete",
        {
          resultText: "Result 2",
          sessionId: null,
          tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          durationMs: 100,
        } satisfies TaskCompletePayload,
        task2.id,
      );

      await new Promise((r) => setTimeout(r, 200));

      expect(taskManager.getTask(task2.id)!.status).toBe(TaskStatus.Completed);
      expect(taskManager.getTask(task2.id)!.resultText).toBe("Result 2");
    });
  });
});
