/**
 * 単体テスト: ButtonHandler (buttons.ts)
 *
 * Discord.js のオブジェクト (ButtonInteraction, ModalSubmitInteraction, TextChannel) は
 * モックで代替し、TaskManager / WorkerRegistry もモック化する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ButtonHandler } from "../src/discord/buttons.js";
import { TaskManager } from "../src/task/manager.js";
import { TaskQueue } from "../src/task/queue.js";
import { WorkerRegistry } from "../src/worker/registry.js";
import {
  TaskStatus,
  PermissionMode,
  type Task,
  type TaskQuestionPayload,
  type TaskPermissionPayload,
} from "@claude-discord/common";

// ─── Mocks ───

vi.mock("../src/worker/registry.js");
vi.mock("../src/task/manager.js");

function createMockTaskManager(): TaskManager {
  const queue = new TaskQueue();
  const registry = new WorkerRegistry("secret");
  const manager = new TaskManager(queue, registry);
  return manager;
}

function createMockWorkerRegistry(): WorkerRegistry {
  const registry = new WorkerRegistry("secret");
  vi.mocked(registry.sendToWorker).mockReturnValue(true);
  return registry;
}

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    prompt: "test prompt",
    status: TaskStatus.Running,
    workerId: "worker-1",
    cwd: "/tmp",
    permissionMode: PermissionMode.AcceptEdits,
    teamMode: false,
    continueSession: false,
    sessionId: null,
    attachments: [],
    toolHistory: [],
    resultText: null,
    errorMessage: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    discordMessageId: null,
    discordThreadId: null,
    requestedBy: "user-1",
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

/** TextChannel モック */
function createMockChannel() {
  return {
    send: vi.fn().mockResolvedValue({ id: "msg-1" }),
  } as unknown as import("discord.js").TextChannel;
}

/** ButtonInteraction モック */
function createMockButtonInteraction(
  customId: string,
  userId: string,
  label?: string,
) {
  return {
    customId,
    user: { id: userId },
    component: { label: label ?? null },
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("discord.js").ButtonInteraction;
}

/** ModalSubmitInteraction モック */
function createMockModalSubmitInteraction(
  customId: string,
  userId: string,
  answerText: string,
) {
  return {
    customId,
    user: { id: userId },
    fields: {
      getTextInputValue: vi.fn().mockReturnValue(answerText),
    },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("discord.js").ModalSubmitInteraction;
}

// ─── Tests ───

describe("ButtonHandler", () => {
  let handler: ButtonHandler;
  let taskManager: TaskManager;
  let workerRegistry: WorkerRegistry;
  const allowedUserIds = ["user-allowed-1", "user-allowed-2"];
  const statusChannelId = "channel-status";

  beforeEach(() => {
    taskManager = createMockTaskManager();
    workerRegistry = createMockWorkerRegistry();
    handler = new ButtonHandler(
      taskManager,
      workerRegistry,
      allowedUserIds,
      statusChannelId,
    );
  });

  // ─── postQuestionMessage ───

  describe("postQuestionMessage", () => {
    it("should post question with option buttons when options are provided", async () => {
      const channel = createMockChannel();
      const payload: TaskQuestionPayload = {
        question: "Which framework?",
        options: ["React", "Vue", "Angular"],
        questionId: "q-1",
      };

      await handler.postQuestionMessage(channel, "task-1", payload);

      expect(channel.send).toHaveBeenCalledOnce();
      const sendArgs = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Embed 存在
      expect(sendArgs.embeds).toHaveLength(1);
      // Components (ActionRow) 存在
      expect(sendArgs.components).toHaveLength(1);
    });

    it("should post question with free-input button when no options", async () => {
      const channel = createMockChannel();
      const payload: TaskQuestionPayload = {
        question: "What is the answer?",
        options: null,
        questionId: "q-2",
      };

      await handler.postQuestionMessage(channel, "task-1", payload);

      expect(channel.send).toHaveBeenCalledOnce();
      const sendArgs = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendArgs.embeds).toHaveLength(1);
      expect(sendArgs.components).toHaveLength(1);
    });

    it("should limit to 5 option buttons max", async () => {
      const channel = createMockChannel();
      const payload: TaskQuestionPayload = {
        question: "Pick one",
        options: ["A", "B", "C", "D", "E", "F", "G"],
        questionId: "q-3",
      };

      await handler.postQuestionMessage(channel, "task-1", payload);

      expect(channel.send).toHaveBeenCalledOnce();
      // ActionRow の components は最大5個
      const sendArgs = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const row = sendArgs.components[0];
      // ActionRowBuilder のコンポーネント数を確認
      expect(row.components.length).toBeLessThanOrEqual(5);
    });
  });

  // ─── postPermissionMessage ───

  describe("postPermissionMessage", () => {
    it("should post permission message with grant/deny buttons for bash", async () => {
      const channel = createMockChannel();
      const payload: TaskPermissionPayload = {
        permissionId: "perm-1",
        permissionType: "bash",
        command: "rm -rf /tmp/test",
        cwd: "/home/user",
      };

      await handler.postPermissionMessage(channel, "task-1", payload);

      expect(channel.send).toHaveBeenCalledOnce();
      const sendArgs = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendArgs.embeds).toHaveLength(1);
      expect(sendArgs.components).toHaveLength(1);
    });

    it("should post permission message for file_edit", async () => {
      const channel = createMockChannel();
      const payload: TaskPermissionPayload = {
        permissionId: "perm-2",
        permissionType: "file_edit",
        command: "Edit /tmp/test.ts",
        cwd: "/home/user",
      };

      await handler.postPermissionMessage(channel, "task-1", payload);

      expect(channel.send).toHaveBeenCalledOnce();
    });
  });

  // ─── handleButton: 認証チェック ───

  describe("handleButton - auth check", () => {
    it("should reject unauthorized user", async () => {
      const interaction = createMockButtonInteraction(
        "question:task-1:q-1:0",
        "unauthorized-user",
        "React",
      );

      await handler.handleButton(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "権限がありません",
        ephemeral: true,
      });
    });

    it("should allow authorized user", async () => {
      const task = createMockTask();
      vi.mocked(taskManager.getTask).mockReturnValue(task);

      const interaction = createMockButtonInteraction(
        "question:task-1:q-1:0",
        "user-allowed-1",
        "React",
      );

      await handler.handleButton(interaction);

      // reply ではなく update が呼ばれるはず
      expect(interaction.reply).not.toHaveBeenCalledWith(
        expect.objectContaining({ content: "権限がありません" }),
      );
    });
  });

  // ─── handleButton: question (選択肢) ───

  describe("handleButton - question option select", () => {
    it("should send task:answer to worker with selected option label", async () => {
      const task = createMockTask();
      vi.mocked(taskManager.getTask).mockReturnValue(task);

      const interaction = createMockButtonInteraction(
        "question:task-1:q-1:0",
        "user-allowed-1",
        "React",
      );

      await handler.handleButton(interaction);

      // Worker に task:answer が送信される
      expect(workerRegistry.sendToWorker).toHaveBeenCalledOnce();
      const [workerId, msg] = vi.mocked(workerRegistry.sendToWorker).mock.calls[0];
      expect(workerId).toBe("worker-1");
      expect(msg.type).toBe("task:answer");
      expect(msg.payload).toEqual(
        expect.objectContaining({ questionId: "q-1", answer: "React" }),
      );

      // ボタン更新
      expect(interaction.update).toHaveBeenCalledWith({
        content: 'Answered: "React"',
        components: [],
      });
    });

    it("should fallback to option index if label is missing", async () => {
      const task = createMockTask();
      vi.mocked(taskManager.getTask).mockReturnValue(task);

      const interaction = createMockButtonInteraction(
        "question:task-1:q-1:2",
        "user-allowed-1",
        // label is null
      );
      // label を null にする
      (interaction.component as { label: string | null }).label = null;

      await handler.handleButton(interaction);

      const [, msg] = vi.mocked(workerRegistry.sendToWorker).mock.calls[0];
      expect(msg.payload).toEqual(
        expect.objectContaining({ questionId: "q-1", answer: "2" }),
      );
    });

    it("should reply with error when task not found", async () => {
      vi.mocked(taskManager.getTask).mockReturnValue(undefined);

      const interaction = createMockButtonInteraction(
        "question:task-1:q-1:0",
        "user-allowed-1",
        "React",
      );

      await handler.handleButton(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "Task not found or not running.",
        ephemeral: true,
      });
    });

    it("should reply with error when task has no workerId", async () => {
      const task = createMockTask({ workerId: null });
      vi.mocked(taskManager.getTask).mockReturnValue(task);

      const interaction = createMockButtonInteraction(
        "question:task-1:q-1:0",
        "user-allowed-1",
        "React",
      );

      await handler.handleButton(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "Task not found or not running.",
        ephemeral: true,
      });
    });
  });

  // ─── handleButton: question_input (モーダル表示) ───

  describe("handleButton - question_input (modal)", () => {
    it("should show modal for free-text input", async () => {
      const interaction = createMockButtonInteraction(
        "question_input:task-1:q-2",
        "user-allowed-1",
      );

      await handler.handleButton(interaction);

      expect(interaction.showModal).toHaveBeenCalledOnce();
    });
  });

  // ─── handleButton: permission ───

  describe("handleButton - permission", () => {
    it("should send permission_response with granted=true", async () => {
      const task = createMockTask();
      vi.mocked(taskManager.getTask).mockReturnValue(task);

      const interaction = createMockButtonInteraction(
        "permission:task-1:perm-1:grant",
        "user-allowed-1",
      );

      await handler.handleButton(interaction);

      expect(workerRegistry.sendToWorker).toHaveBeenCalledOnce();
      const [workerId, msg] = vi.mocked(workerRegistry.sendToWorker).mock.calls[0];
      expect(workerId).toBe("worker-1");
      expect(msg.type).toBe("task:permission_response");
      expect(msg.payload).toEqual(
        expect.objectContaining({ permissionId: "perm-1", granted: true }),
      );

      expect(interaction.update).toHaveBeenCalledWith({
        content: "許可しました",
        components: [],
      });
    });

    it("should send permission_response with granted=false", async () => {
      const task = createMockTask();
      vi.mocked(taskManager.getTask).mockReturnValue(task);

      const interaction = createMockButtonInteraction(
        "permission:task-1:perm-1:deny",
        "user-allowed-2",
      );

      await handler.handleButton(interaction);

      const [, msg] = vi.mocked(workerRegistry.sendToWorker).mock.calls[0];
      expect(msg.payload).toEqual(
        expect.objectContaining({ permissionId: "perm-1", granted: false }),
      );

      expect(interaction.update).toHaveBeenCalledWith({
        content: "拒否しました",
        components: [],
      });
    });

    it("should reply with error when task not found", async () => {
      vi.mocked(taskManager.getTask).mockReturnValue(undefined);

      const interaction = createMockButtonInteraction(
        "permission:task-1:perm-1:grant",
        "user-allowed-1",
      );

      await handler.handleButton(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "Task not found or not running.",
        ephemeral: true,
      });
    });
  });

  // ─── handleButton: unknown action ───

  describe("handleButton - unknown action", () => {
    it("should reply with Unknown action for unrecognized customId prefix", async () => {
      const interaction = createMockButtonInteraction(
        "unknown_action:foo:bar",
        "user-allowed-1",
      );

      await handler.handleButton(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "Unknown action",
        ephemeral: true,
      });
    });
  });

  // ─── handleModalSubmit ───

  describe("handleModalSubmit", () => {
    it("should reject unauthorized user", async () => {
      const interaction = createMockModalSubmitInteraction(
        "question_modal:task-1:q-1",
        "unauthorized-user",
        "my answer",
      );

      await handler.handleModalSubmit(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "権限がありません",
        ephemeral: true,
      });
    });

    it("should send task:answer from modal input", async () => {
      const task = createMockTask();
      vi.mocked(taskManager.getTask).mockReturnValue(task);

      const interaction = createMockModalSubmitInteraction(
        "question_modal:task-1:q-1",
        "user-allowed-1",
        "My detailed answer here",
      );

      await handler.handleModalSubmit(interaction);

      expect(workerRegistry.sendToWorker).toHaveBeenCalledOnce();
      const [workerId, msg] = vi.mocked(workerRegistry.sendToWorker).mock.calls[0];
      expect(workerId).toBe("worker-1");
      expect(msg.type).toBe("task:answer");
      expect(msg.payload).toEqual(
        expect.objectContaining({
          questionId: "q-1",
          answer: "My detailed answer here",
        }),
      );

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("My detailed answer here"),
          ephemeral: true,
        }),
      );
    });

    it("should truncate long answer in reply", async () => {
      const task = createMockTask();
      vi.mocked(taskManager.getTask).mockReturnValue(task);

      const longAnswer = "A".repeat(200);
      const interaction = createMockModalSubmitInteraction(
        "question_modal:task-1:q-1",
        "user-allowed-1",
        longAnswer,
      );

      await handler.handleModalSubmit(interaction);

      const replyArgs = (interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(replyArgs.content).toContain("...");
      expect(replyArgs.content.length).toBeLessThan(200);
    });

    it("should reply with error when task not found", async () => {
      vi.mocked(taskManager.getTask).mockReturnValue(undefined);

      const interaction = createMockModalSubmitInteraction(
        "question_modal:task-1:q-1",
        "user-allowed-1",
        "answer",
      );

      await handler.handleModalSubmit(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "Task not found or not running.",
        ephemeral: true,
      });
    });

    it("should ignore non-question_modal customId prefix", async () => {
      const interaction = createMockModalSubmitInteraction(
        "something_else:task-1:q-1",
        "user-allowed-1",
        "answer",
      );

      await handler.handleModalSubmit(interaction);

      // sendToWorker は呼ばれない
      expect(workerRegistry.sendToWorker).not.toHaveBeenCalled();
      // reply も権限エラー以外は呼ばれない
    });
  });

  // ─── customId パーステスト ───

  describe("customId parsing", () => {
    it("should correctly parse question customId: question:<taskId>:<questionId>:<index>", async () => {
      const task = createMockTask({ id: "task-42", workerId: "w-5" });
      vi.mocked(taskManager.getTask).mockReturnValue(task);

      const interaction = createMockButtonInteraction(
        "question:task-42:q-abc:3",
        "user-allowed-1",
        "Option D",
      );

      await handler.handleButton(interaction);

      const [workerId, msg] = vi.mocked(workerRegistry.sendToWorker).mock.calls[0];
      expect(workerId).toBe("w-5");
      expect(msg.payload).toEqual(
        expect.objectContaining({
          questionId: "q-abc",
          answer: "Option D",
        }),
      );
    });

    it("should correctly parse permission customId: permission:<taskId>:<permissionId>:<action>", async () => {
      const task = createMockTask({ id: "task-99", workerId: "w-7" });
      vi.mocked(taskManager.getTask).mockReturnValue(task);

      const interaction = createMockButtonInteraction(
        "permission:task-99:perm-xyz:grant",
        "user-allowed-2",
      );

      await handler.handleButton(interaction);

      const [workerId, msg] = vi.mocked(workerRegistry.sendToWorker).mock.calls[0];
      expect(workerId).toBe("w-7");
      expect(msg.payload).toEqual(
        expect.objectContaining({
          permissionId: "perm-xyz",
          granted: true,
        }),
      );
    });
  });
});
