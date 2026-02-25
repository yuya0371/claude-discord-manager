import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  REST,
  Routes,
} from "discord.js";
import {
  PermissionMode,
  TaskStatus,
  FileAttachment,
  TeamInfo,
  FILE_MAX_SIZE_BYTES,
} from "@claude-discord/common";
import { TaskManager, TaskCreateOptions } from "../task/manager.js";
import { WorkerRegistry } from "../worker/registry.js";
import { ProjectAliasManager } from "../project/aliases.js";
import { TokenTracker } from "../token/tracker.js";
import { NotificationSettings } from "../notification/settings.js";
import {
  buildTaskEmbed,
  buildWorkersEmbed,
  buildHelpEmbed,
  buildTokenSummaryEmbed,
  buildTokenDetailEmbed,
  buildTokenWorkerEmbed,
  buildTeamsListEmbed,
} from "./embeds.js";

/**
 * スラッシュコマンドの定義と登録
 */
export class CommandHandler {
  private commands: SlashCommandBuilder[];

  /** アクティブなチーム情報を取得するコールバック */
  public teamsProvider: (() => TeamInfo[]) | null = null;

  constructor(
    private readonly taskManager: TaskManager,
    private readonly workerRegistry: WorkerRegistry,
    private readonly allowedUserIds: string[],
    private readonly statusChannelId: string,
    private readonly aliasManager?: ProjectAliasManager,
    private readonly tokenTracker?: TokenTracker,
    private readonly notificationSettings?: NotificationSettings
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
   * オートコンプリートをハンドリングする
   */
  async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);

    if (focused.name === "worker") {
      const workers = this.workerRegistry.getAllWorkers();
      const input = focused.value.toLowerCase();
      const choices = workers
        .map((w) => ({ name: `${w.name} (${w.status})`, value: w.name }))
        .filter((c) => c.value.toLowerCase().includes(input))
        .slice(0, 25);
      await interaction.respond(choices);
    }
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
      case "alias":
        await this.handleAlias(interaction);
        break;
      case "token":
        await this.handleToken(interaction);
        break;
      case "teams":
        await this.handleTeams(interaction);
        break;
      case "notify":
        await this.handleNotify(interaction);
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
          .setAutocomplete(true)
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

    const aliasCmd = new SlashCommandBuilder()
      .setName("alias")
      .setDescription("プロジェクトエイリアスの管理")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("エイリアスを追加する")
          .addStringOption((opt) =>
            opt.setName("name").setDescription("エイリアス名").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("path").setDescription("プロジェクトパス").setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName("worker")
              .setDescription("優先Worker名")
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("エイリアスを削除する")
          .addStringOption((opt) =>
            opt.setName("name").setDescription("エイリアス名").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("エイリアス一覧を表示する")
      ) as SlashCommandBuilder;

    const tokenCmd = new SlashCommandBuilder()
      .setName("token")
      .setDescription("トークン使用量を表示する")
      .addStringOption((option) =>
        option
          .setName("view")
          .setDescription("表示モード")
          .setRequired(false)
          .addChoices(
            { name: "summary", value: "summary" },
            { name: "detail", value: "detail" },
            { name: "worker", value: "worker" }
          )
      ) as SlashCommandBuilder;

    const teamsCmd = new SlashCommandBuilder()
      .setName("teams")
      .setDescription("アクティブなAgent Teamsの一覧を表示する");

    const notifyCmd = new SlashCommandBuilder()
      .setName("notify")
      .setDescription("通知レベルを設定する")
      .addStringOption((option) =>
        option
          .setName("level")
          .setDescription("通知レベル")
          .setRequired(true)
          .addChoices(
            { name: "all - 全イベントで@メンション", value: "all" },
            { name: "important - エラー・質問のみ@メンション", value: "important" },
            { name: "none - @メンションなし", value: "none" }
          )
      ) as SlashCommandBuilder;

    return [taskCmd, workersCmd, statusCmd, cancelCmd, helpCmd, aliasCmd, tokenCmd, teamsCmd, notifyCmd];
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

    // エイリアス解決
    let resolvedCwd: string | null = directory;
    let resolvedWorker: string | null = workerName;
    if (directory && this.aliasManager) {
      const resolved = this.aliasManager.resolve(directory);
      if (resolved === null) {
        // @付きだがエイリアスが見つからない
        await interaction.reply({
          content: `Alias "${directory}" not found. Use \`/alias list\` to see available aliases.`,
          ephemeral: true,
        });
        return;
      }
      resolvedCwd = resolved.resolvedPath;
      // エイリアスに優先Workerが設定されていて、コマンドでWorker未指定の場合
      if (!workerName && resolved.preferredWorker) {
        resolvedWorker = resolved.preferredWorker;
      }
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

    // セッション継続: sessionId を自動解決
    let sessionId: string | null = null;
    if (continueSession) {
      sessionId = this.taskManager.getLatestSessionId(resolvedWorker, resolvedCwd);
      if (!sessionId) {
        await interaction.reply({
          content: "No previous session found to continue. Run a task first, then use `continue: True`.",
          ephemeral: true,
        });
        return;
      }
    }

    // エフェメラルで即座に応答
    const attachNote = attachments.length > 0
      ? ` (with ${attachments.length} file)`
      : "";
    const continueNote = sessionId ? " (continuing session)" : "";
    await interaction.reply({
      content: `Task accepted${attachNote}${continueNote}: "${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}"`,
      ephemeral: true,
    });

    const options: TaskCreateOptions = {
      prompt,
      requestedBy: interaction.user.id,
      workerId: resolvedWorker,
      cwd: resolvedCwd,
      permissionMode,
      teamMode,
      continueSession,
      sessionId,
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
          const sessionTag = t.sessionId ? ` [session]` : "";
          lines.push(`- ${t.id} [${t.status}]: ${t.prompt.substring(0, 50)}...${sessionTag}`);
        }
      }

      // セッション継続可能なタスク
      const sessions = this.taskManager.getRecentSessions(5);
      if (sessions.length > 0) {
        lines.push("\n**Sessions (continuable):**");
        for (const s of sessions) {
          const promptShort = s.prompt.substring(0, 40) + (s.prompt.length > 40 ? "..." : "");
          lines.push(`- ${s.taskId}: ${promptShort} (${s.workerId ?? "any"})`);
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

  private async handleAlias(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!this.aliasManager) {
      await interaction.reply({
        content: "Alias feature is not enabled.",
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case "add": {
        const name = interaction.options.getString("name", true);
        const aliasPath = interaction.options.getString("path", true);
        const worker = interaction.options.getString("worker");

        const entry = this.aliasManager.add(name, aliasPath, worker);
        const workerNote = entry.preferredWorker
          ? ` (preferred worker: ${entry.preferredWorker})`
          : "";
        await interaction.reply({
          content: `Alias added: @${entry.alias} -> ${entry.path}${workerNote}`,
          ephemeral: true,
        });
        break;
      }

      case "remove": {
        const name = interaction.options.getString("name", true);
        const removed = this.aliasManager.remove(name);
        if (removed) {
          await interaction.reply({
            content: `Alias "@${name}" removed.`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: `Alias "@${name}" not found.`,
            ephemeral: true,
          });
        }
        break;
      }

      case "list": {
        const aliases = this.aliasManager.getAll();
        if (aliases.length === 0) {
          await interaction.reply({
            content: "No aliases configured.",
            ephemeral: true,
          });
        } else {
          const lines = aliases.map((a) => {
            const worker = a.preferredWorker
              ? ` (worker: ${a.preferredWorker})`
              : "";
            return `- @${a.alias} -> ${a.path}${worker}`;
          });
          await interaction.reply({
            content: `**Aliases:**\n${lines.join("\n")}`,
            ephemeral: true,
          });
        }
        break;
      }

      default:
        await interaction.reply({
          content: `Unknown subcommand: ${subcommand}`,
          ephemeral: true,
        });
    }
  }

  private async handleTeams(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const teams = this.teamsProvider ? this.teamsProvider() : [];
    const embed = buildTeamsListEmbed(teams);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  private async handleToken(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!this.tokenTracker) {
      await interaction.reply({
        content: "Token tracking is not enabled.",
        ephemeral: true,
      });
      return;
    }

    const view = interaction.options.getString("view") ?? "summary";

    switch (view) {
      case "detail": {
        const records = this.tokenTracker.getTaskDetails();
        const embed = buildTokenDetailEmbed(records);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        break;
      }

      case "worker": {
        const workerSummaries = this.tokenTracker.getWorkerSummaries();
        const embed = buildTokenWorkerEmbed(workerSummaries);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        break;
      }

      case "summary":
      default: {
        const todaySummary = this.tokenTracker.getTodaySummary();
        const cumulativeSummary = this.tokenTracker.getCumulativeSummary();
        const embed = buildTokenSummaryEmbed(todaySummary, cumulativeSummary);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        break;
      }
    }
  }

  private async handleNotify(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!this.notificationSettings) {
      await interaction.reply({
        content: "Notification settings are not enabled.",
        ephemeral: true,
      });
      return;
    }

    const level = interaction.options.getString("level", true);
    const userId = interaction.user.id;

    // NotifyLevel enum にキャスト
    const notifyLevel = level as import("@claude-discord/common").NotifyLevel;
    this.notificationSettings.setLevel(userId, notifyLevel);

    const descriptions: Record<string, string> = {
      all: "All events will mention you.",
      important: "Only errors and questions will mention you.",
      none: "You will not be mentioned.",
    };

    await interaction.reply({
      content: `Notification level set to **${level}**. ${descriptions[level] ?? ""}`,
      ephemeral: true,
    });
  }
}
