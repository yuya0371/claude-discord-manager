import {
  Client,
  GatewayIntentBits,
  ChatInputCommandInteraction,
  TextChannel,
  Events,
  Message,
} from "discord.js";
import {
  Task,
  TaskQuestionPayload,
  TaskPermissionPayload,
} from "@claude-discord/common";
import { CommandHandler } from "./commands.js";
import { ButtonHandler } from "./buttons.js";
import {
  buildTaskEmbed,
  buildWorkerConnectedEmbed,
  buildWorkerDisconnectedEmbed,
  buildStatusSummaryEmbed,
  isLongResult,
  splitTextForDiscord,
} from "./embeds.js";
import { TaskManager } from "../task/manager.js";
import { WorkerRegistry } from "../worker/registry.js";

/** ステータスサマリーの更新間隔（30秒） */
const STATUS_SUMMARY_UPDATE_INTERVAL_MS = 30_000;

export interface DiscordBotConfig {
  token: string;
  guildId: string;
  allowedUserIds: string[];
  statusChannelId: string;
  workersChannelId: string;
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

  /** ピン留めステータスサマリーメッセージのID */
  private statusSummaryMessageId: string | null = null;
  /** ステータスサマリー定期更新タイマー */
  private statusSummaryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: DiscordBotConfig,
    private readonly taskManager: TaskManager,
    private readonly workerRegistry: WorkerRegistry
  ) {
    this.statusChannelId = config.statusChannelId;
    this.workersChannelId = config.workersChannelId;

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
      this.statusChannelId
    );

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
      },
      onTaskFailed: async (task) => {
        await this.updateTaskEmbed(task);
        await this.updateStatusSummary();
      },
      onTaskCancelled: async (task) => {
        await this.updateTaskEmbed(task);
        await this.updateStatusSummary();
      },
      onTaskQuestion: async (taskId, payload) => {
        const channel = this.client.channels.cache.get(this.statusChannelId);
        if (channel && channel.isTextBased() && "send" in channel) {
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
      await message.edit({ embeds: [embed] });
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
      await message.edit({ embeds: [embed] });
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
      await (channel as TextChannel).send({ embeds: [embed] });
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
      await (channel as TextChannel).send({ embeds: [embed] });
    } catch (error) {
      console.error("Failed to post worker disconnected notification:", error);
    }
  }
}
