import {
  Client,
  GatewayIntentBits,
  ChatInputCommandInteraction,
  TextChannel,
  Events,
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
} from "./embeds.js";
import { TaskManager } from "../task/manager.js";
import { WorkerRegistry } from "../worker/registry.js";

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
      },
      onTaskStarted: async (task) => {
        await this.updateTaskEmbed(task);
      },
      onTaskStreamUpdate: async (task) => {
        await this.updateTaskEmbed(task);
      },
      onTaskCompleted: async (task) => {
        await this.updateTaskEmbed(task);
      },
      onTaskFailed: async (task) => {
        await this.updateTaskEmbed(task);
      },
      onTaskCancelled: async (task) => {
        await this.updateTaskEmbed(task);
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
   * Worker接続/切断コールバックをセットアップ
   */
  private setupWorkerCallbacks(): void {
    const existingDisconnectCb = this.workerRegistry.onWorkerDisconnected;

    this.workerRegistry.onWorkerConnected = (worker) => {
      this.postWorkerConnectedNotification(worker).catch(console.error);
    };

    this.workerRegistry.onWorkerDisconnected = (workerId, hadRunningTask) => {
      this.postWorkerDisconnectedNotification(workerId).catch(console.error);
      if (existingDisconnectCb) {
        existingDisconnectCb(workerId, hadRunningTask);
      }
    };
  }

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
