import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  REST,
  Routes,
} from "discord.js";
import {
  PermissionMode,
  TaskStatus,
  FileAttachment,
  FILE_MAX_SIZE_BYTES,
} from "@claude-discord/common";
import { TaskManager, TaskCreateOptions } from "../task/manager.js";
import { WorkerRegistry } from "../worker/registry.js";
import { buildTaskEmbed, buildWorkersEmbed, buildHelpEmbed } from "./embeds.js";

/**
 * スラッシュコマンドの定義と登録
 */
export class CommandHandler {
  private commands: SlashCommandBuilder[];

  constructor(
    private readonly taskManager: TaskManager,
    private readonly workerRegistry: WorkerRegistry,
    private readonly allowedUserIds: string[],
    private readonly statusChannelId: string
  ) {
    this.commands = this.buildCommands();
  }

  /**
   * スラッシュコマンドをDiscord APIに登録する
   */
  async registerCommands(token: string, guildId: string): Promise<void> {
    const rest = new REST({ version: "10" }).setToken(token);
    const clientId = Buffer.from(token.split(".")[0], "base64").toString();

    const commandData = this.commands.map((cmd) => cmd.toJSON());

    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commandData,
    });

    console.log(
      `Registered ${commandData.length} slash commands for guild ${guildId}`
    );
  }

  /**
   * インタラクションをハンドリングする
   */
  async handleInteraction(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    // ユーザー認証チェック
    if (!this.allowedUserIds.includes(interaction.user.id)) {
      await interaction.reply({
        content: "Permission denied.",
        ephemeral: true,
      });
      return;
    }

    const commandName = interaction.commandName;

    switch (commandName) {
      case "task":
        await this.handleTask(interaction);
        break;
      case "workers":
        await this.handleWorkers(interaction);
        break;
      case "status":
        await this.handleStatus(interaction);
        break;
      case "cancel":
        await this.handleCancel(interaction);
        break;
      case "help":
        await this.handleHelp(interaction);
        break;
      default:
        await interaction.reply({
          content: `Unknown command: ${commandName}`,
          ephemeral: true,
        });
    }
  }

  // --- Command definitions ---

  private buildCommands(): SlashCommandBuilder[] {
    const taskCmd = new SlashCommandBuilder()
      .setName("task")
      .setDescription("Claudeにタスクを依頼する")
      .addStringOption((option) =>
        option
          .setName("prompt")
          .setDescription("プロンプト")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("worker")
          .setDescription("実行先Worker名")
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName("directory")
          .setDescription("作業ディレクトリ")
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("権限モード")
          .setRequired(false)
          .addChoices(
            { name: "acceptEdits", value: "acceptEdits" },
            { name: "auto", value: "auto" },
            { name: "confirm", value: "confirm" }
          )
      )
      .addBooleanOption((option) =>
        option
          .setName("team")
          .setDescription("Agent Teamsモードで実行")
          .setRequired(false)
      )
      .addBooleanOption((option) =>
        option
          .setName("continue")
          .setDescription("前回セッションを継続")
          .setRequired(false)
      )
      .addAttachmentOption((option) =>
        option
          .setName("attachment")
          .setDescription("添付ファイル（8MB以下）")
          .setRequired(false)
      ) as SlashCommandBuilder;

    const workersCmd = new SlashCommandBuilder()
      .setName("workers")
      .setDescription("接続中のWorker一覧を表示する");

    const statusCmd = new SlashCommandBuilder()
      .setName("status")
      .setDescription("タスク状況を表示する")
      .addStringOption((option) =>
        option
          .setName("task_id")
          .setDescription("特定タスクの詳細表示")
          .setRequired(false)
      ) as SlashCommandBuilder;

    const cancelCmd = new SlashCommandBuilder()
      .setName("cancel")
      .setDescription("タスクをキャンセルする")
      .addStringOption((option) =>
        option
          .setName("task_id")
          .setDescription("キャンセルするタスクID")
          .setRequired(true)
      ) as SlashCommandBuilder;

    const helpCmd = new SlashCommandBuilder()
      .setName("help")
      .setDescription("利用可能なコマンドと使い方を表示する");

    return [taskCmd, workersCmd, statusCmd, cancelCmd, helpCmd];
  }

  // --- Command handlers ---

  private async handleTask(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const prompt = interaction.options.getString("prompt", true);
    const workerName = interaction.options.getString("worker");
    const directory = interaction.options.getString("directory");
    const modeStr = interaction.options.getString("mode");
    const teamMode = interaction.options.getBoolean("team") ?? false;
    const continueSession =
      interaction.options.getBoolean("continue") ?? false;
    const discordAttachment = interaction.options.getAttachment("attachment");

    let permissionMode: PermissionMode = PermissionMode.AcceptEdits;
    if (modeStr) {
      permissionMode = modeStr as PermissionMode;
    }

    // 添付ファイルのサイズ検証
    const attachments: FileAttachment[] = [];
    if (discordAttachment) {
      if (discordAttachment.size > FILE_MAX_SIZE_BYTES) {
        await interaction.reply({
          content: `Attachment "${discordAttachment.name}" is too large (${Math.round(discordAttachment.size / 1024 / 1024)}MB). Max: ${FILE_MAX_SIZE_BYTES / 1024 / 1024}MB.`,
          ephemeral: true,
        });
        return;
      }
      attachments.push({
        fileName: discordAttachment.name,
        mimeType: discordAttachment.contentType ?? "application/octet-stream",
        size: discordAttachment.size,
        cdnUrl: discordAttachment.url,
        localPath: null,
      });
    }

    // エフェメラルで即座に応答
    const attachNote = attachments.length > 0
      ? ` (with ${attachments.length} file)`
      : "";
    await interaction.reply({
      content: `Task accepted${attachNote}: "${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}"`,
      ephemeral: true,
    });

    const options: TaskCreateOptions = {
      prompt,
      requestedBy: interaction.user.id,
      workerId: workerName,
      cwd: directory,
      permissionMode,
      teamMode,
      continueSession,
      attachments,
    };

    const task = this.taskManager.createTask(options);

    // #statusチャンネルにEmbed投稿
    const channel = interaction.client.channels.cache.get(
      this.statusChannelId
    );
    if (channel && channel.isTextBased() && "send" in channel) {
      const embed = buildTaskEmbed(task);
      const msg = await channel.send({ embeds: [embed] });
      this.taskManager.setDiscordMessageId(task.id, msg.id);
    }

    // コールバックを発火
    if (this.taskManager.callbacks?.onTaskQueued) {
      await this.taskManager.callbacks.onTaskQueued(task);
    }

    // ディスパッチ試行
    await this.taskManager.dispatchNext();
  }

  private async handleWorkers(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const workers = this.workerRegistry.getAllWorkers();
    const embed = buildWorkersEmbed(workers);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  private async handleStatus(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const taskId = interaction.options.getString("task_id");

    if (taskId) {
      const task = this.taskManager.getTask(taskId);
      if (!task) {
        await interaction.reply({
          content: `Task "${taskId}" not found.`,
          ephemeral: true,
        });
        return;
      }
      const embed = buildTaskEmbed(task);
      await interaction.reply({ embeds: [embed], ephemeral: true });
    } else {
      // 実行中タスクを優先表示
      const allTasks = this.taskManager.getAllTasks();
      const runningTasks = allTasks.filter(
        (t) => t.status === TaskStatus.Running
      );
      const queuedTasks = allTasks.filter(
        (t) => t.status === TaskStatus.Queued
      );
      const recentCompleted = allTasks
        .filter(
          (t) =>
            t.status === TaskStatus.Completed ||
            t.status === TaskStatus.Failed ||
            t.status === TaskStatus.Cancelled
        )
        .slice(-5);

      const lines: string[] = [];
      if (runningTasks.length > 0) {
        lines.push("**Running:**");
        for (const t of runningTasks) {
          lines.push(
            `- ${t.id}: ${t.prompt.substring(0, 50)}... (Worker: ${t.workerId})`
          );
        }
      }
      if (queuedTasks.length > 0) {
        lines.push("**Queued:**");
        for (const t of queuedTasks) {
          lines.push(`- ${t.id}: ${t.prompt.substring(0, 50)}...`);
        }
      }
      if (recentCompleted.length > 0) {
        lines.push("**Recent:**");
        for (const t of recentCompleted) {
          lines.push(`- ${t.id} [${t.status}]: ${t.prompt.substring(0, 50)}...`);
        }
      }

      if (lines.length === 0) {
        lines.push("No tasks.");
      }

      await interaction.reply({
        content: lines.join("\n"),
        ephemeral: true,
      });
    }
  }

  private async handleHelp(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const embed = buildHelpEmbed();
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  private async handleCancel(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const taskId = interaction.options.getString("task_id", true);
    const task = this.taskManager.getTask(taskId);

    if (!task) {
      await interaction.reply({
        content: `Task "${taskId}" not found.`,
        ephemeral: true,
      });
      return;
    }

    if (
      task.status === TaskStatus.Completed ||
      task.status === TaskStatus.Failed ||
      task.status === TaskStatus.Cancelled
    ) {
      await interaction.reply({
        content: `Task "${taskId}" has already finished (${task.status}).`,
        ephemeral: true,
      });
      return;
    }

    const success = await this.taskManager.cancelTask(
      taskId,
      "User requested cancellation"
    );
    if (success) {
      await interaction.reply({
        content: `Task "${taskId}" has been cancelled.`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: `Failed to cancel task "${taskId}".`,
        ephemeral: true,
      });
    }
  }
}
