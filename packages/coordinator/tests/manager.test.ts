import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TaskManager, type TaskEventCallbacks } from "../src/task/manager.js";
import { TaskQueue } from "../src/task/queue.js";
import { WorkerRegistry } from "../src/worker/registry.js";
import {
  TaskStatus,
  WorkerStatus,
  PermissionMode,
  type WorkerInfo,
  type TaskCompletePayload,
  type TaskErrorPayload,
  type TaskStreamPayload,
} from "@claude-discord/common";

// WorkerRegistry をモック化
vi.mock("../src/worker/registry.js");

function createMockWorkerRegistry(): WorkerRegistry {
  const registry = new WorkerRegistry("secret");

  // vi.mock でクラス全体をモックしているので、メソッドは自動的にvi.fn()になる
  // ただしデフォルトの返り値を設定する
  vi.mocked(registry.getAvailableWorker).mockReturnValue(null);
  vi.mocked(registry.sendToWorker).mockReturnValue(true);

  return registry;
}

function createMockWorkerInfo(id: string): WorkerInfo {
  return {
    id,
    name: id,
    status: WorkerStatus.Online,
    currentTaskId: null,
    os: "linux",
    nodeVersion: "v20.0.0",
    claudeCliVersion: "1.0.0",
    defaultCwd: "/home/user",
    allowedDirs: ["/home/user"],
    lastHeartbeat: Date.now(),
    connectedAt: Date.now(),
  };
}

describe("TaskManager", () => {
  let queue: TaskQueue;
  let registry: WorkerRegistry;
  let manager: TaskManager;
  let callbacks: TaskEventCallbacks;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new TaskQueue();
    registry = createMockWorkerRegistry();
    manager = new TaskManager(queue, registry);

    callbacks = {
      onTaskQueued: vi.fn().mockResolvedValue(undefined),
      onTaskStarted: vi.fn().mockResolvedValue(undefined),
      onTaskStreamUpdate: vi.fn().mockResolvedValue(undefined),
      onTaskCompleted: vi.fn().mockResolvedValue(undefined),
      onTaskFailed: vi.fn().mockResolvedValue(undefined),
      onTaskCancelled: vi.fn().mockResolvedValue(undefined),
    };
    manager.callbacks = callbacks;
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe("createTask", () => {
    it("should create a task with queued status", () => {
      const task = manager.createTask({
        prompt: "Hello",
        requestedBy: "user-1",
      });

      expect(task.id).toBe("task-1");
      expect(task.status).toBe(TaskStatus.Queued);
      expect(task.prompt).toBe("Hello");
      expect(task.requestedBy).toBe("user-1");
    });

    it("should set default values for optional fields", () => {
      const task = manager.createTask({
        prompt: "Hello",
        requestedBy: "user-1",
      });

      expect(task.permissionMode).toBe(PermissionMode.AcceptEdits);
      expect(task.teamMode).toBe(false);
      expect(task.continueSession).toBe(false);
      expect(task.cwd).toBeNull();
      expect(task.sessionId).toBeNull();
      expect(task.workerId).toBeNull();
    });

    it("should set custom values for optional fields", () => {
      const task = manager.createTask({
        prompt: "Hello",
        requestedBy: "user-1",
        cwd: "/tmp",
        permissionMode: PermissionMode.Auto,
        teamMode: true,
        continueSession: true,
        sessionId: "session-123",
      });

      expect(task.cwd).toBe("/tmp");
      expect(task.permissionMode).toBe(PermissionMode.Auto);
      expect(task.teamMode).toBe(true);
      expect(task.continueSession).toBe(true);
      expect(task.sessionId).toBe("session-123");
    });

    it("should increment taskId counter", () => {
      const task1 = manager.createTask({ prompt: "A", requestedBy: "u1" });
      const task2 = manager.createTask({ prompt: "B", requestedBy: "u2" });
      expect(task1.id).toBe("task-1");
      expect(task2.id).toBe("task-2");
    });

    it("should add task to the queue", () => {
      manager.createTask({ prompt: "A", requestedBy: "u1" });
      expect(queue.size).toBe(1);
      expect(queue.getAll()).toEqual(["task-1"]);
    });
  });

  describe("dispatchNext", () => {
    it("should not dispatch when queue is empty", async () => {
      await manager.dispatchNext();
      expect(registry.getAvailableWorker).not.toHaveBeenCalled();
    });

    it("should not dispatch when no workers available", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(null);

      await manager.dispatchNext();

      const task = manager.getTask("task-1");
      expect(task!.status).toBe(TaskStatus.Queued);
      expect(queue.size).toBe(1);
    });

    it("should dispatch task to available worker", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );

      await manager.dispatchNext();

      const task = manager.getTask("task-1");
      expect(task!.status).toBe(TaskStatus.Running);
      expect(task!.workerId).toBe("worker-1");
      expect(task!.startedAt).not.toBeNull();
      expect(queue.isEmpty()).toBe(true);
    });

    it("should set worker status to busy after dispatch", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );

      await manager.dispatchNext();

      expect(registry.setWorkerStatus).toHaveBeenCalledWith(
        "worker-1",
        WorkerStatus.Busy,
      );
      expect(registry.setWorkerCurrentTask).toHaveBeenCalledWith(
        "worker-1",
        "task-1",
      );
    });

    it("should send task:assign message to worker", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );

      await manager.dispatchNext();

      expect(registry.sendToWorker).toHaveBeenCalledOnce();
      const [workerId, msg] = vi.mocked(registry.sendToWorker).mock.calls[0];
      expect(workerId).toBe("worker-1");
      expect(msg.type).toBe("task:assign");
    });

    it("should call onTaskStarted callback", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );

      await manager.dispatchNext();

      expect(callbacks.onTaskStarted).toHaveBeenCalledOnce();
    });
  });

  describe("handleTaskComplete", () => {
    it("should update task to completed status", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      const payload: TaskCompletePayload = {
        resultText: "Done!",
        sessionId: "session-1",
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        durationMs: 5000,
      };
      await manager.handleTaskComplete("task-1", payload);

      const task = manager.getTask("task-1");
      expect(task!.status).toBe(TaskStatus.Completed);
      expect(task!.resultText).toBe("Done!");
      expect(task!.sessionId).toBe("session-1");
      expect(task!.completedAt).not.toBeNull();
    });

    it("should set worker back to online", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      await manager.handleTaskComplete("task-1", {
        resultText: "Done!",
        sessionId: null,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        durationMs: 1000,
      });

      expect(registry.setWorkerStatus).toHaveBeenCalledWith(
        "worker-1",
        WorkerStatus.Online,
      );
    });

    it("should call onTaskCompleted callback", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      await manager.handleTaskComplete("task-1", {
        resultText: "Done!",
        sessionId: null,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        durationMs: 1000,
      });

      expect(callbacks.onTaskCompleted).toHaveBeenCalledOnce();
    });

    it("should ignore complete for non-running tasks", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      // Task is still queued, not running

      await manager.handleTaskComplete("task-1", {
        resultText: "Done!",
        sessionId: null,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        durationMs: 1000,
      });

      expect(manager.getTask("task-1")!.status).toBe(TaskStatus.Queued);
    });
  });

  describe("handleTaskError", () => {
    it("should update task to failed status", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      const payload: TaskErrorPayload = {
        message: "Something went wrong",
        code: "CLI_ERROR",
        partialResult: "partial...",
        tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
      await manager.handleTaskError("task-1", payload);

      const task = manager.getTask("task-1");
      expect(task!.status).toBe(TaskStatus.Failed);
      expect(task!.errorMessage).toBe("Something went wrong");
      expect(task!.resultText).toBe("partial...");
    });

    it("should call onTaskFailed callback", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      await manager.handleTaskError("task-1", {
        message: "error",
        code: "ERR",
        partialResult: null,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });

      expect(callbacks.onTaskFailed).toHaveBeenCalledOnce();
    });
  });

  describe("cancelTask", () => {
    it("should cancel a queued task", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });

      const result = await manager.cancelTask("task-1", "user request");

      expect(result).toBe(true);
      const task = manager.getTask("task-1");
      expect(task!.status).toBe(TaskStatus.Cancelled);
      expect(queue.isEmpty()).toBe(true);
    });

    it("should cancel a running task and send cancel to worker", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      const result = await manager.cancelTask("task-1", "user request");

      expect(result).toBe(true);
      expect(manager.getTask("task-1")!.status).toBe(TaskStatus.Cancelled);
      // Should have sent cancel message (second call after task:assign)
      expect(registry.sendToWorker).toHaveBeenCalledTimes(2);
    });

    it("should return false for already completed task", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();
      await manager.handleTaskComplete("task-1", {
        resultText: "Done",
        sessionId: null,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        durationMs: 100,
      });

      const result = await manager.cancelTask("task-1", "too late");
      expect(result).toBe(false);
    });

    it("should return false for non-existent task", async () => {
      const result = await manager.cancelTask("task-999", "reason");
      expect(result).toBe(false);
    });

    it("should call onTaskCancelled callback", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      await manager.cancelTask("task-1", "user request");
      expect(callbacks.onTaskCancelled).toHaveBeenCalledOnce();
    });
  });

  describe("handleStreamUpdate", () => {
    it("should accumulate assistant_message text", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      const payload: TaskStreamPayload = {
        eventType: "assistant_message",
        data: { text: "Hello " },
      };
      await manager.handleStreamUpdate("task-1", payload);

      const payload2: TaskStreamPayload = {
        eventType: "assistant_message",
        data: { text: "World" },
      };
      await manager.handleStreamUpdate("task-1", payload2);

      expect(manager.getTask("task-1")!.resultText).toBe("Hello World");
    });

    it("should add tool_use_begin to toolHistory", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      await manager.handleStreamUpdate("task-1", {
        eventType: "tool_use_begin",
        data: { toolName: "Read", summary: "Read: /tmp/test.ts" },
      });

      const task = manager.getTask("task-1")!;
      expect(task.toolHistory).toHaveLength(1);
      expect(task.toolHistory[0].toolName).toBe("Read");
      expect(task.toolHistory[0].status).toBe("running");
    });

    it("should update tool_use_end in toolHistory", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      await manager.handleStreamUpdate("task-1", {
        eventType: "tool_use_begin",
        data: { toolName: "Read", summary: "Read: /tmp/test.ts" },
      });
      await manager.handleStreamUpdate("task-1", {
        eventType: "tool_use_end",
        data: { toolName: "Read", summary: "Read: file contents", success: true },
      });

      const task = manager.getTask("task-1")!;
      expect(task.toolHistory[0].status).toBe("completed");
      expect(task.toolHistory[0].summary).toBe("Read: file contents");
    });

    it("should update token_usage", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      await manager.handleStreamUpdate("task-1", {
        eventType: "token_usage",
        data: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      });

      const task = manager.getTask("task-1")!;
      expect(task.tokenUsage.inputTokens).toBe(100);
      expect(task.tokenUsage.outputTokens).toBe(50);
    });

    it("should overwrite resultText on result event", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      // First accumulate some text
      await manager.handleStreamUpdate("task-1", {
        eventType: "assistant_message",
        data: { text: "streaming..." },
      });
      // Then result overwrites
      await manager.handleStreamUpdate("task-1", {
        eventType: "result",
        data: { text: "Final result", sessionId: "s1" },
      });

      const task = manager.getTask("task-1")!;
      expect(task.resultText).toBe("Final result");
      expect(task.sessionId).toBe("s1");
    });

    it("should ignore stream updates for non-running tasks", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      // Task is queued, not running
      await manager.handleStreamUpdate("task-1", {
        eventType: "assistant_message",
        data: { text: "should be ignored" },
      });

      expect(manager.getTask("task-1")!.resultText).toBeNull();
    });
  });

  describe("handleWorkerDisconnect", () => {
    it("should fail running tasks for disconnected worker", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      await manager.handleWorkerDisconnect("worker-1");

      const task = manager.getTask("task-1")!;
      expect(task.status).toBe(TaskStatus.Failed);
      expect(task.errorMessage).toContain("Worker切断");
      expect(callbacks.onTaskFailed).toHaveBeenCalledOnce();
    });

    it("should not affect tasks from other workers", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      await manager.handleWorkerDisconnect("worker-2");

      expect(manager.getTask("task-1")!.status).toBe(TaskStatus.Running);
    });
  });

  describe("getTask / getAllTasks / getRunningTasks", () => {
    it("should return undefined for non-existent task", () => {
      expect(manager.getTask("task-999")).toBeUndefined();
    });

    it("should return all tasks", () => {
      manager.createTask({ prompt: "A", requestedBy: "u1" });
      manager.createTask({ prompt: "B", requestedBy: "u2" });
      expect(manager.getAllTasks()).toHaveLength(2);
    });

    it("should return only running tasks", async () => {
      manager.createTask({ prompt: "A", requestedBy: "u1" });
      manager.createTask({ prompt: "B", requestedBy: "u2" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      const running = manager.getRunningTasks();
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe("task-1");
    });
  });

  describe("setDiscordMessageId / setDiscordThreadId", () => {
    it("should set discordMessageId on task", () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      manager.setDiscordMessageId("task-1", "msg-123");
      expect(manager.getTask("task-1")!.discordMessageId).toBe("msg-123");
    });

    it("should set discordThreadId on task", () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      manager.setDiscordThreadId("task-1", "thread-456");
      expect(manager.getTask("task-1")!.discordThreadId).toBe("thread-456");
    });
  });
});
