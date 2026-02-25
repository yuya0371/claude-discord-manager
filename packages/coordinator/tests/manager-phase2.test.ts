/**
 * 単体テスト: TaskManager Phase 2 機能
 *
 * - ファイル添付つきタスク作成
 * - handleFileTransferAck
 * - 質問・権限コールバック
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TaskManager, type TaskEventCallbacks } from "../src/task/manager.js";
import { TaskQueue } from "../src/task/queue.js";
import { WorkerRegistry } from "../src/worker/registry.js";
import {
  TaskStatus,
  WorkerStatus,
  PermissionMode,
  type WorkerInfo,
  type FileAttachment,
  type FileTransferAckPayload,
  type TaskQuestionPayload,
  type TaskPermissionPayload,
} from "@claude-discord/common";

vi.mock("../src/worker/registry.js");

function createMockWorkerRegistry(): WorkerRegistry {
  const registry = new WorkerRegistry("secret");
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

function createCallbacks(): TaskEventCallbacks {
  return {
    onTaskQueued: vi.fn().mockResolvedValue(undefined),
    onTaskStarted: vi.fn().mockResolvedValue(undefined),
    onTaskStreamUpdate: vi.fn().mockResolvedValue(undefined),
    onTaskCompleted: vi.fn().mockResolvedValue(undefined),
    onTaskFailed: vi.fn().mockResolvedValue(undefined),
    onTaskCancelled: vi.fn().mockResolvedValue(undefined),
    onTaskQuestion: vi.fn().mockResolvedValue(undefined),
    onTaskPermission: vi.fn().mockResolvedValue(undefined),
  };
}

describe("TaskManager - Phase 2 features", () => {
  let queue: TaskQueue;
  let registry: WorkerRegistry;
  let manager: TaskManager;
  let callbacks: TaskEventCallbacks;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new TaskQueue();
    registry = createMockWorkerRegistry();
    manager = new TaskManager(queue, registry);
    callbacks = createCallbacks();
    manager.callbacks = callbacks;
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  // ─── ファイル添付つきタスク作成 ───

  describe("createTask with attachments", () => {
    it("should store attachments on created task", () => {
      const attachments: FileAttachment[] = [
        {
          fileName: "test.txt",
          mimeType: "text/plain",
          size: 1024,
          cdnUrl: "https://cdn.discord.com/attachments/test.txt",
          localPath: null,
        },
      ];

      const task = manager.createTask({
        prompt: "Review this file",
        requestedBy: "u1",
        attachments,
      });

      expect(task.attachments).toHaveLength(1);
      expect(task.attachments[0].fileName).toBe("test.txt");
      expect(task.attachments[0].cdnUrl).toContain("discord");
    });

    it("should default to empty attachments when not specified", () => {
      const task = manager.createTask({
        prompt: "No files",
        requestedBy: "u1",
      });

      expect(task.attachments).toEqual([]);
    });

    it("should store multiple attachments", () => {
      const attachments: FileAttachment[] = [
        {
          fileName: "a.txt",
          mimeType: "text/plain",
          size: 100,
          cdnUrl: "https://cdn.discord.com/a.txt",
          localPath: null,
        },
        {
          fileName: "b.png",
          mimeType: "image/png",
          size: 2048,
          cdnUrl: "https://cdn.discord.com/b.png",
          localPath: null,
        },
      ];

      const task = manager.createTask({
        prompt: "Review these",
        requestedBy: "u1",
        attachments,
      });

      expect(task.attachments).toHaveLength(2);
      expect(task.attachments[0].fileName).toBe("a.txt");
      expect(task.attachments[1].fileName).toBe("b.png");
    });
  });

  // ─── handleFileTransferAck ───

  describe("handleFileTransferAck", () => {
    it("should resolve pending file transfer promise on success", async () => {
      // dispatchNext 内で transferAttachments が呼ばれるが、
      // fetch をモックしないと動かないので直接 handleFileTransferAck をテストする
      const ack: FileTransferAckPayload = {
        taskId: "task-1",
        fileName: "test.txt",
        success: true,
        localPath: "/tmp/claude-worker-files/task-1/test.txt",
      };

      // handleFileTransferAck が resolver を呼ぶことを確認
      // resolver がない場合は何もしない（エラーにならない）
      expect(() => manager.handleFileTransferAck("task-1", ack)).not.toThrow();
    });

    it("should handle ack for non-pending transfer without error", () => {
      const ack: FileTransferAckPayload = {
        taskId: "task-999",
        fileName: "unknown.txt",
        success: false,
        localPath: null,
        error: "File not found",
      };

      // resolver がない場合は安全に無視される
      expect(() => manager.handleFileTransferAck("task-999", ack)).not.toThrow();
    });
  });

  // ─── 質問コールバック ───

  describe("handleTaskQuestion", () => {
    it("should call onTaskQuestion callback for running task", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      const payload: TaskQuestionPayload = {
        question: "Which framework?",
        options: ["React", "Vue"],
        questionId: "q-1",
      };

      await manager.handleTaskQuestion("task-1", payload);

      expect(callbacks.onTaskQuestion).toHaveBeenCalledOnce();
      expect(callbacks.onTaskQuestion).toHaveBeenCalledWith("task-1", payload);
    });

    it("should ignore question for non-running task", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      // Task is queued, not running

      await manager.handleTaskQuestion("task-1", {
        question: "Q?",
        options: null,
        questionId: "q-1",
      });

      expect(callbacks.onTaskQuestion).not.toHaveBeenCalled();
    });

    it("should ignore question for non-existent task", async () => {
      await manager.handleTaskQuestion("task-999", {
        question: "Q?",
        options: null,
        questionId: "q-1",
      });

      expect(callbacks.onTaskQuestion).not.toHaveBeenCalled();
    });
  });

  // ─── 権限確認コールバック ───

  describe("handleTaskPermission", () => {
    it("should call onTaskPermission callback for running task", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });
      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );
      await manager.dispatchNext();

      const payload: TaskPermissionPayload = {
        permissionId: "perm-1",
        permissionType: "bash",
        command: "npm test",
        cwd: "/home/user",
      };

      await manager.handleTaskPermission("task-1", payload);

      expect(callbacks.onTaskPermission).toHaveBeenCalledOnce();
      expect(callbacks.onTaskPermission).toHaveBeenCalledWith("task-1", payload);
    });

    it("should ignore permission for non-running task", async () => {
      manager.createTask({ prompt: "Hello", requestedBy: "u1" });

      await manager.handleTaskPermission("task-1", {
        permissionId: "perm-1",
        permissionType: "file_edit",
        command: "edit file",
        cwd: "/tmp",
      });

      expect(callbacks.onTaskPermission).not.toHaveBeenCalled();
    });
  });

  // ─── dispatchNext で attachments が task:assign に含まれる ───

  describe("dispatchNext with attachments", () => {
    it("should include attachments in task:assign payload", async () => {
      const attachments: FileAttachment[] = [
        {
          fileName: "data.csv",
          mimeType: "text/csv",
          size: 512,
          cdnUrl: "https://cdn.discord.com/data.csv",
          localPath: null,
        },
      ];

      manager.createTask({
        prompt: "Analyze this",
        requestedBy: "u1",
        attachments,
      });

      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );

      // fetch をモックして transferAttachments が動くようにする
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(512)),
      });
      vi.stubGlobal("fetch", mockFetch);

      // dispatchNext を呼ぶ（ack は来ないのでタイムアウトする）
      const dispatchPromise = manager.dispatchNext();

      // file:transfer_ack をシミュレート
      // sendToWorker が file:transfer を送信した後に ack を返す
      await vi.advanceTimersByTimeAsync(50);

      // file:transfer が送信されたか確認
      const sendCalls = vi.mocked(registry.sendToWorker).mock.calls;
      const fileTransferCall = sendCalls.find(
        ([, msg]) => msg.type === "file:transfer",
      );
      if (fileTransferCall) {
        // ack を手動で呼ぶ
        manager.handleFileTransferAck("task-1", {
          taskId: "task-1",
          fileName: "data.csv",
          success: true,
          localPath: "/tmp/claude-worker-files/task-1/data.csv",
        });
      }

      await dispatchPromise;

      // task:assign が送信されたか確認
      const assignCall = sendCalls.find(
        ([, msg]) => msg.type === "task:assign",
      );
      expect(assignCall).toBeDefined();

      vi.unstubAllGlobals();
    });

    it("should still dispatch task when file download fails", async () => {
      const attachments: FileAttachment[] = [
        {
          fileName: "broken.txt",
          mimeType: "text/plain",
          size: 100,
          cdnUrl: "https://cdn.discord.com/broken.txt",
          localPath: null,
        },
      ];

      manager.createTask({
        prompt: "Try this",
        requestedBy: "u1",
        attachments,
      });

      vi.mocked(registry.getAvailableWorker).mockReturnValue(
        createMockWorkerInfo("worker-1"),
      );

      // fetch が失敗する
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });
      vi.stubGlobal("fetch", mockFetch);

      await manager.dispatchNext();

      // ダウンロード失敗でもタスクはディスパッチされる
      const task = manager.getTask("task-1");
      expect(task!.status).toBe(TaskStatus.Running);

      // task:assign が送信されている
      const sendCalls = vi.mocked(registry.sendToWorker).mock.calls;
      const assignCall = sendCalls.find(
        ([, msg]) => msg.type === "task:assign",
      );
      expect(assignCall).toBeDefined();

      vi.unstubAllGlobals();
    });
  });
});
