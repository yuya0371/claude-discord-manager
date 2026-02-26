import {
  Client,
  DiscordAPIError,
  GatewayIntentBits,
  ChatInputCommandInteraction,
  TextChannel,
  Events,
  Message,
  RESTJSONErrorCodes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import {
  Task,
  TaskStatus,
  TaskQuestionPayload,
  TaskPermissionPayload,
  TeamInfo,
  TeamUpdatePayload,
} from "@claude-discord/common";
import { CommandHandler } from "./commands.js";
import { ButtonHandler } from "./buttons.js";
import {
  buildTaskEmbed,
  buildWorkerConnectedEmbed,
  buildWorkerDisconnectedEmbed,
  buildStatusSummaryEmbed,
  buildTokenUsageNotificationEmbed,
  buildTeamUpdateEmbed,
  buildTeamsListEmbed,
  buildScheduleResultEmbed,
  isLongResult,
  splitTextForDiscord,
} from "./embeds.js";
import { TaskManager } from "../task/manager.js";
import { WorkerRegistry } from "../worker/registry.js";
import { ProjectAliasManager } from "../project/aliases.js";
import { TokenTracker } from "../token/tracker.js";
import { ScheduleManager } from "../scheduler/manager.js";
import {
  NotificationSettings,
  NotificationEventType,
} from "../notification/settings.js";

/** ステータスサマリーの更新間隔（30秒） */
const STATUS_SUMMARY_UPDATE_INTERVAL_MS = 30_000;

/** Discord APIリトライの最大回数 */
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Discord API 呼び出しをレート制限対応のリトライ付きで実行する。
 * 429 (Rate Limited) の場合は retry_after を待って再試行する。
 */
async function withDiscordRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = MAX_RETRY_ATTEMPTS
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DiscordAPIError) {
        // レート制限: retry_after ms 待って再試行
        if (error.status === 429) {
          const retryAfter = (error as DiscordAPIError & { retryAfter?: number }).retryAfter ?? 1000;
          const waitMs = typeof retryAfter === "number" ? retryAfter : 1000;
          console.warn(
            `[DiscordBot] Rate limited on ${label}, retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        // Unknown Message / Unknown Channel は再試行しても無駄
        if (
          error.code === RESTJSONErrorCodes.UnknownMessage ||
          error.code === RESTJSONErrorCodes.UnknownChannel
        ) {
          throw error;
        }
      }

      // 最後の試行なら投げる
      if (attempt >= maxAttempts) {
        throw error;
      }

      // 指数バックオフで再試行
      const backoffMs = 1000 * Math.pow(2, attempt - 1);
      console.warn(
        `[DiscordBot] Error on ${label}, retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts}):`,
        error instanceof Error ? error.message : error
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // ここに到達しないはずだが TypeScript のため
  throw new Error(`withDiscordRetry: max attempts exhausted for ${label}`);
}

export interface DiscordBotConfig {
  token: string;
  guildId: string;
  allowedUserIds: string[];
  statusChannelId: string;
  workersChannelId: string;
  tokenUsageChannelId?: string;
  teamsChannelId?: string;
  scheduledChannelId?: string;
}

/**
 * Discord Bot初期化とイベントハンドリング
 */
export class DiscordBot {
  private client: Client;
  private commandHandler: CommandHandler | null = null;
  private buttonHandler: ButtonHandler | null = null;
  private statusChannelId: string;
  private workersChannelId: string;
  private tokenUsageChannelId: string | null;
  private teamsChannelId: string | null = null;
  private scheduledChannelId: string | null = null;

  /** トークン使用量トラッカー */
  private tokenTracker: TokenTracker;

  /** 通知設定 */
  private notificationSettings: NotificationSettings;

  /** アクティブなチーム情報のキャッシュ */
  private activeTeams: Map<string, TeamInfo> = new Map();

  /** スケジュールマネージャー */
  private scheduleManager: ScheduleManager | null = null;

  /** ピン留めステータスサマリーメッセージのID */
  private statusSummaryMessageId: string | null = null;
  /** ステータスサマリー定期更新タイマー */
  private statusSummaryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: DiscordBotConfig,
    private readonly taskManager: TaskManager,
    private readonly workerRegistry: WorkerRegistry,
    private readonly aliasManager?: ProjectAliasManager
  ) {
    this.statusChannelId = config.statusChannelId;
    this.workersChannelId = config.workersChannelId;
    this.tokenUsageChannelId = config.tokenUsageChannelId ?? null;
    this.teamsChannelId = config.teamsChannelId ?? null;
    this.scheduledChannelId = config.scheduledChannelId ?? null;
    this.tokenTracker = new TokenTracker();
    this.notificationSettings = new NotificationSettings();

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ],
    });
  }

  /**
   * Botを起動する
   */
  async start(): Promise<void> {
    // コマンドハンドラ初期化
    this.commandHandler = new CommandHandler(
      this.taskManager,
      this.workerRegistry,
      this.config.allowedUserIds,
      this.statusChannelId,
      this.aliasManager,
      this.tokenTracker,
      this.notificationSettings
    );

    // /teams コマンド用のチーム情報プロバイダを設定
    this.commandHandler.teamsProvider = () => this.getActiveTeams();

    // スケジュールマネージャーが設定されていれば渡す
    if (this.scheduleManager) {
      this.commandHandler.scheduleManager = this.scheduleManager;
    }

    // ボタンハンドラ初期化
    this.buttonHandler = new ButtonHandler(
      this.taskManager,
      this.workerRegistry,
      this.config.allowedUserIds,
      this.statusChannelId
    );

    // ready イベント
    this.client.once(Events.ClientReady, async (readyClient) => {
      console.log(`Discord Bot logged in as ${readyClient.user.tag}`);

      // スラッシュコマンド登録
      await this.commandHandler!.registerCommands(
        this.config.token,
        this.config.guildId
      );

      // ステータスサマリーのピン留めメッセージを初期化
      await this.initStatusSummary();

      // ステータスサマリーの定期更新を開始
      this.startStatusSummaryUpdater();
    });

    // interactionCreate イベント
    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          await this.commandHandler!.handleInteraction(interaction);
        } else if (interaction.isAutocomplete()) {
          await this.commandHandler!.handleAutocomplete(interaction);
        } else if (interaction.isButton()) {
          await this.buttonHandler!.handleButton(interaction);
        } else if (interaction.isModalSubmit()) {
          await this.buttonHandler!.handleModalSubmit(interaction);
        }
      } catch (error) {
        console.error("Error handling interaction:", error);
        if (interaction.isRepliable()) {
          if (interaction.replied || interaction.deferred) {
            await interaction
              .followUp({
                content: "An error occurred while processing the interaction.",
                ephemeral: true,
              })
              .catch(console.error);
          } else {
            await interaction
              .reply({
                content: "An error occurred while processing the interaction.",
                ephemeral: true,
              })
              .catch(console.error);
          }
        }
      }
    });

    // タスクイベントコールバックを設定
    this.setupTaskCallbacks();

    // Worker接続/切断コールバックを設定
    this.setupWorkerCallbacks();

    // Botにログイン
    await this.client.login(this.config.token);
  }

  /**
   * Botを停止する
   */
  async stop(): Promise<void> {
    if (this.statusSummaryTimer) {
      clearInterval(this.statusSummaryTimer);
      this.statusSummaryTimer = null;
    }
    if (this.buttonHandler) {
      this.buttonHandler.clearAllTimeouts();
    }
    this.client.destroy();
    console.log("Discord Bot stopped");
  }

  /**
   * Clientオブジェクトを取得（外部からチャンネルアクセスなどに使用）
   */
  getClient(): Client {
    return this.client;
  }

  /**
   * タスクのEmbed更新コールバックをセットアップ
   */
  private setupTaskCallbacks(): void {
    this.taskManager.callbacks = {
      onTaskQueued: async (task) => {
        // Embed投稿はcommands.tsのhandleTask内で実施済み
        // ステータスサマリーを即座に更新
        await this.updateStatusSummary();
      },
      onTaskStarted: async (task) => {
        await this.updateTaskEmbed(task);
        await this.updateStatusSummary();
      },
      onTaskStreamUpdate: async (task) => {
        await this.updateTaskEmbed(task);
      },
      onTaskCompleted: async (task) => {
        // 長文の場合はスレッド作成 → 全文投稿 → Embed再更新
        if (isLongResult(task.resultText)) {
          await this.handleLongResultOutput(task);
        }
        await this.updateTaskEmbed(task);
        await this.updateStatusSummary();

        // メンション通知
        await this.postMentionNotification(task, "completed");

        // トークン使用量を記録・通知
        if (task.workerId) {
          this.tokenTracker.record(task.id, task.workerId, task.tokenUsage);
          await this.postTokenUsageNotification(task);
        }

        // スケジューラーからのタスクなら #scheduled チャンネルに結果投稿
        if (task.requestedBy.startsWith("scheduler:")) {
          await this.postScheduleResultNotification(task);
        }
      },
      onTaskFailed: async (task) => {
        await this.updateTaskEmbed(task);
        await this.updateStatusSummary();

        // メンション通知
        await this.postMentionNotification(task, "error");

        // トークン使用量を記録（失敗時も記録する）
        if (task.workerId && (task.tokenUsage.inputTokens > 0 || task.tokenUsage.outputTokens > 0)) {
          this.tokenTracker.record(task.id, task.workerId, task.tokenUsage);
          await this.postTokenUsageNotification(task);
        }

        // スケジューラーからのタスクなら #scheduled チャンネルにもエラー通知
        if (task.requestedBy.startsWith("scheduler:")) {
          await this.postScheduleResultNotification(task);
        }
      },
      onTaskCancelled: async (task) => {
        await this.updateTaskEmbed(task);
        await this.updateStatusSummary();
      },
      onTaskQuestion: async (taskId, payload) => {
        const channel = this.client.channels.cache.get(this.statusChannelId);
        if (channel && channel.isTextBased() && "send" in channel) {
          // メンションテキストを生成して質問メッセージの前に投稿
          const mentionText = this.notificationSettings.buildMentionText(
            this.config.allowedUserIds,
            "question"
          );
          if (mentionText) {
            await (channel as TextChannel).send(mentionText);
          }
          await this.buttonHandler!.postQuestionMessage(
            channel as TextChannel,
            taskId,
            payload
          );
        }
      },
      onTaskPermission: async (taskId, payload) => {
        const channel = this.client.channels.cache.get(this.statusChannelId);
        if (channel && channel.isTextBased() && "send" in channel) {
          // メンションテキストを生成して権限確認メッセージの前に投稿
          const mentionText = this.notificationSettings.buildMentionText(
            this.config.allowedUserIds,
            "permission"
          );
          if (mentionText) {
            await (channel as TextChannel).send(mentionText);
          }
          await this.buttonHandler!.postPermissionMessage(
            channel as TextChannel,
            taskId,
            payload
          );
        }
      },
    };
  }

  /**
   * Discord上のタスクEmbedメッセージを更新する
   */
  private async updateTaskEmbed(task: Task): Promise<void> {
    if (!task.discordMessageId) return;

    try {
      const channel = this.client.channels.cache.get(this.statusChannelId);
      if (!channel || !channel.isTextBased()) return;

      const textChannel = channel as TextChannel;
      const message = await textChannel.messages
        .fetch(task.discordMessageId)
        .catch(() => null);
      if (!message) return;

      const embed = buildTaskEmbed(task);

      // 完了タスクにはセッション継続用の「返信」ボタンを追加
      const components: ActionRowBuilder<ButtonBuilder>[] = [];
      if (task.status === "completed" && task.sessionId) {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`reply:${task.id}:${task.sessionId}`)
            .setLabel("返信")
            .setStyle(ButtonStyle.Primary),
        );
        components.push(row);
      }

      await withDiscordRetry(
        () => message.edit({ embeds: [embed], components }),
        `updateTaskEmbed(${task.id})`
      );
    } catch (error) {
      console.error(`Failed to update task embed for ${task.id}:`, error);
    }
  }

  /**
   * 長文結果をスレッドに投稿する
   */
  private async handleLongResultOutput(task: Task): Promise<void> {
    if (!task.discordMessageId || !task.resultText) return;

    try {
      const channel = this.client.channels.cache.get(this.statusChannelId);
      if (!channel || !channel.isTextBased()) return;

      const textChannel = channel as TextChannel;
      const message = await textChannel.messages
        .fetch(task.discordMessageId)
        .catch(() => null);
      if (!message) return;

      // スレッドを作成
      const thread = await message.startThread({
        name: `${task.id} - Full Output`,
      });

      // タスクにスレッドIDを記録
      this.taskManager.setDiscordThreadId(task.id, thread.id);

      // 全文を分割して投稿
      const chunks = splitTextForDiscord(task.resultText);
      for (let i = 0; i < chunks.length; i++) {
        const header =
          chunks.length > 1 ? `**[${i + 1}/${chunks.length}]**\n` : "";
        await thread.send(header + chunks[i]);
      }
    } catch (error) {
      console.error(
        `Failed to create thread for long output (${task.id}):`,
        error
      );
    }
  }

  /**
   * Worker接続/切断コールバックをセットアップ
   */
  private setupWorkerCallbacks(): void {
    const existingDisconnectCb = this.workerRegistry.onWorkerDisconnected;

    this.workerRegistry.onWorkerConnected = (worker) => {
      this.postWorkerConnectedNotification(worker).catch(console.error);
      // 新しいWorkerが接続されたらキューからディスパッチを試行
      this.taskManager.handleWorkerConnected().catch(console.error);
      // ステータスサマリーを更新
      this.updateStatusSummary().catch(console.error);
    };

    this.workerRegistry.onWorkerDisconnected = (workerId, hadRunningTask) => {
      this.postWorkerDisconnectedNotification(workerId).catch(console.error);
      // ステータスサマリーを更新
      this.updateStatusSummary().catch(console.error);
      if (existingDisconnectCb) {
        existingDisconnectCb(workerId, hadRunningTask);
      }
    };
  }

  // ─── ステータスサマリー管理 ───

  /**
   * #status チャンネルにステータスサマリーのピン留めメッセージを作成/復元する
   */
  private async initStatusSummary(): Promise<void> {
    try {
      const channel = this.client.channels.cache.get(this.statusChannelId);
      if (!channel || !channel.isTextBased()) return;

      const textChannel = channel as TextChannel;

      // 既存のピン留めメッセージからBot自身のステータスサマリーを検索
      const pinnedMessages = await textChannel.messages.fetchPinned().catch(() => null);
      if (pinnedMessages) {
        const botId = this.client.user?.id;
        const existingSummary = pinnedMessages.find(
          (msg) =>
            msg.author.id === botId &&
            msg.embeds.length > 0 &&
            msg.embeds[0].title === "System Status"
        );

        if (existingSummary) {
          this.statusSummaryMessageId = existingSummary.id;
          console.log(`Found existing status summary message: ${existingSummary.id}`);
          // 既存メッセージを最新状態に更新
          await this.updateStatusSummary();
          return;
        }
      }

      // 新規作成
      const embed = buildStatusSummaryEmbed(
        this.workerRegistry.getAllWorkers(),
        this.taskManager.getRunningTasks(),
        this.taskManager.getQueuedTasks()
      );
      const msg = await textChannel.send({ embeds: [embed] });
      this.statusSummaryMessageId = msg.id;

      // ピン留め
      await msg.pin().catch((err) => {
        console.warn("Failed to pin status summary message:", err);
      });

      console.log(`Created and pinned status summary message: ${msg.id}`);
    } catch (error) {
      console.error("Failed to initialize status summary:", error);
    }
  }

  /**
   * ステータスサマリーメッセージを更新する
   */
  private async updateStatusSummary(): Promise<void> {
    if (!this.statusSummaryMessageId) return;

    try {
      const channel = this.client.channels.cache.get(this.statusChannelId);
      if (!channel || !channel.isTextBased()) return;

      const textChannel = channel as TextChannel;
      const message = await textChannel.messages
        .fetch(this.statusSummaryMessageId)
        .catch(() => null);

      if (!message) {
        // メッセージが削除されていた場合は再作成
        this.statusSummaryMessageId = null;
        await this.initStatusSummary();
        return;
      }

      const embed = buildStatusSummaryEmbed(
        this.workerRegistry.getAllWorkers(),
        this.taskManager.getRunningTasks(),
        this.taskManager.getQueuedTasks()
      );
      await withDiscordRetry(
        () => message.edit({ embeds: [embed] }),
        "updateStatusSummary"
      );
    } catch (error) {
      console.error("Failed to update status summary:", error);
    }
  }

  /**
   * ステータスサマリーの定期更新を開始する
   */
  private startStatusSummaryUpdater(): void {
    this.statusSummaryTimer = setInterval(() => {
      this.updateStatusSummary().catch(console.error);
    }, STATUS_SUMMARY_UPDATE_INTERVAL_MS);
  }

  // ─── Worker通知 ───

  /**
   * #workers チャンネルに Worker 接続通知を投稿
   */
  private async postWorkerConnectedNotification(
    worker: import("@claude-discord/common").WorkerInfo
  ): Promise<void> {
    try {
      const channel = this.client.channels.cache.get(this.workersChannelId);
      if (!channel || !channel.isTextBased()) return;

      const embed = buildWorkerConnectedEmbed(worker);
      await withDiscordRetry(
        () => (channel as TextChannel).send({ embeds: [embed] }),
        "postWorkerConnected"
      );
    } catch (error) {
      console.error("Failed to post worker connected notification:", error);
    }
  }

  /**
   * #workers チャンネルに Worker 切断通知を投稿
   */
  private async postWorkerDisconnectedNotification(
    workerName: string
  ): Promise<void> {
    try {
      const channel = this.client.channels.cache.get(this.workersChannelId);
      if (!channel || !channel.isTextBased()) return;

      const embed = buildWorkerDisconnectedEmbed(workerName, "Connection lost");
      await withDiscordRetry(
        () => (channel as TextChannel).send({ embeds: [embed] }),
        "postWorkerDisconnected"
      );
    } catch (error) {
      console.error("Failed to post worker disconnected notification:", error);
    }
  }

  // ─── Token Usage 通知 ───

  /**
   * #token-usage チャンネルにタスク完了時のトークン使用量を投稿する
   */
  private async postTokenUsageNotification(task: Task): Promise<void> {
    if (!this.tokenUsageChannelId) return;

    try {
      const channel = this.client.channels.cache.get(this.tokenUsageChannelId);
      if (!channel || !channel.isTextBased()) return;

      const embed = buildTokenUsageNotificationEmbed(
        task.id,
        task.workerId ?? "unknown",
        task.tokenUsage,
        task.prompt
      );
      await withDiscordRetry(
        () => (channel as TextChannel).send({ embeds: [embed] }),
        "postTokenUsageNotification"
      );
    } catch (error) {
      console.error("Failed to post token usage notification:", error);
    }
  }

  /**
   * TokenTrackerインスタンスを取得する
   */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  /**
   * NotificationSettingsインスタンスを取得する
   */
  getNotificationSettings(): NotificationSettings {
    return this.notificationSettings;
  }

  /**
   * タスク完了/失敗時にメンション通知を#statusチャンネルに投稿する
   */
  private async postMentionNotification(
    task: Task,
    eventType: NotificationEventType
  ): Promise<void> {
    const mentionText = this.notificationSettings.buildMentionText(
      this.config.allowedUserIds,
      eventType
    );
    if (!mentionText) return;

    try {
      const channel = this.client.channels.cache.get(this.statusChannelId);
      if (!channel || !channel.isTextBased()) return;

      const label = eventType === "completed" ? "completed" : "failed";
      await (channel as TextChannel).send(
        `${mentionText} Task **${task.id}** ${label}.`
      );
    } catch (error) {
      console.error("Failed to post mention notification:", error);
    }
  }

  // ─── Schedule 管理 ───

  /**
   * ScheduleManager を設定する
   */
  setScheduleManager(manager: ScheduleManager): void {
    this.scheduleManager = manager;
    // コマンドハンドラにも渡す
    if (this.commandHandler) {
      this.commandHandler.scheduleManager = manager;
    }

    // スケジュール実行時に #status にEmbed投稿する
    manager.onJobExecuted = async (_job, taskId) => {
      try {
        const task = this.taskManager.getTask(taskId);
        if (!task) return;

        const channel = this.client.channels.cache.get(this.statusChannelId);
        if (channel && channel.isTextBased() && "send" in channel) {
          const embed = buildTaskEmbed(task);
          const msg = await (channel as TextChannel).send({ embeds: [embed] });
          this.taskManager.setDiscordMessageId(taskId, msg.id);
        }
      } catch (error) {
        console.error(`Failed to post scheduled task embed:`, error);
      }
    };
  }

  /**
   * #scheduled チャンネルに定期タスクの結果を投稿する
   */
  private async postScheduleResultNotification(task: Task): Promise<void> {
    if (!this.scheduledChannelId) return;

    try {
      const channel = this.client.channels.cache.get(this.scheduledChannelId);
      if (!channel || !channel.isTextBased()) return;

      // requestedBy から jobName を抽出 ("scheduler:朝のAI記事" → "朝のAI記事")
      const jobName = task.requestedBy.replace("scheduler:", "");

      // 失敗タスクの場合はエラーメッセージを表示
      const isFailed = task.status === TaskStatus.Failed;
      const resultText = isFailed
        ? `**Error:** ${task.errorMessage ?? "Unknown error"}`
        : task.resultText;

      const embed = buildScheduleResultEmbed(
        jobName,
        task.id,
        resultText,
        task.prompt
      );

      // 失敗時は色とタイトルを変更
      if (isFailed) {
        embed.setColor(0xED4245); // Red
        embed.setTitle(`\u274C Scheduled Failed: ${jobName}`);
      }

      const msg = await withDiscordRetry(
        () => (channel as TextChannel).send({ embeds: [embed] }),
        "postScheduleResultNotification"
      );

      // 長文の場合はスレッドで全文投稿
      const fullText = isFailed ? task.errorMessage : task.resultText;
      if (isLongResult(fullText) && fullText) {
        const thread = await msg.startThread({
          name: `${jobName} - ${task.id} Full Output`,
        });
        const chunks = splitTextForDiscord(fullText);
        for (let i = 0; i < chunks.length; i++) {
          const header =
            chunks.length > 1 ? `**[${i + 1}/${chunks.length}]**\n` : "";
          await thread.send(header + chunks[i]);
        }
      }
    } catch (error) {
      console.error("Failed to post schedule result notification:", error);
    }
  }

  // ─── Team 通知 ───

  /**
   * team:update を受信した際のハンドラ
   */
  async handleTeamUpdate(_workerId: string, payload: TeamUpdatePayload): Promise<void> {
    const teamInfo = payload.teamInfo;

    // キャッシュに保存
    this.activeTeams.set(teamInfo.teamName, teamInfo);

    // #teams チャンネルに投稿
    await this.postTeamUpdateNotification(teamInfo);
  }

  /**
   * アクティブなチーム情報一覧を取得する
   */
  getActiveTeams(): TeamInfo[] {
    return Array.from(this.activeTeams.values());
  }

  /**
   * #teams チャンネルにチーム更新通知を投稿する
   */
  private async postTeamUpdateNotification(teamInfo: TeamInfo): Promise<void> {
    if (!this.teamsChannelId) return;

    try {
      const channel = this.client.channels.cache.get(this.teamsChannelId);
      if (!channel || !channel.isTextBased()) return;

      const embed = buildTeamUpdateEmbed(teamInfo);
      await withDiscordRetry(
        () => (channel as TextChannel).send({ embeds: [embed] }),
        "postTeamUpdateNotification"
      );
    } catch (error) {
      console.error("Failed to post team update notification:", error);
    }
  }
}
