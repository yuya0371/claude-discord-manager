import {
  Client,
  GatewayIntentBits,
  ChatInputCommandInteraction,
  TextChannel,
  Events,
} from "discord.js";
import { Task } from "@claude-discord/common";
import { CommandHandler } from "./commands.js";
import { buildTaskEmbed } from "./embeds.js";
import { TaskManager } from "../task/manager.js";

export interface DiscordBotConfig {
  token: string;
  guildId: string;
  allowedUserIds: string[];
  statusChannelId: string;
}

/**
 * Discord Bot初期化とイベントハンドリング
 */
export class DiscordBot {
  private client: Client;
  private commandHandler: CommandHandler | null = null;
  private statusChannelId: string;

  constructor(
    private readonly config: DiscordBotConfig,
    private readonly taskManager: TaskManager,
    private readonly workerRegistry: import("../worker/registry.js").WorkerRegistry
  ) {
    this.statusChannelId = config.statusChannelId;

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
      if (!interaction.isChatInputCommand()) return;

      try {
        await this.commandHandler!.handleInteraction(interaction);
      } catch (error) {
        console.error("Error handling interaction:", error);
        if (interaction.replied || interaction.deferred) {
          await interaction
            .followUp({
              content: "An error occurred while processing the command.",
              ephemeral: true,
            })
            .catch(console.error);
        } else {
          await interaction
            .reply({
              content: "An error occurred while processing the command.",
              ephemeral: true,
            })
            .catch(console.error);
        }
      }
    });

    // タスクイベントコールバックを設定
    this.setupTaskCallbacks();

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
        // Embed投稿はcommands.tsのhandleAsk内で実施済み
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
}
