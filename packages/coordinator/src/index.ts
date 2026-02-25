import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { DiscordBot, DiscordBotConfig } from "./discord/bot.js";
import { WsServer, WsServerConfig } from "./ws/server.js";
import { TaskQueue } from "./task/queue.js";
import { TaskManager } from "./task/manager.js";
import { WorkerRegistry } from "./worker/registry.js";
import { ProjectAliasManager } from "./project/aliases.js";

// ルートの .env を明示的に読み込む
function findEnvFile(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), ".env");
}
dotenv.config({ path: findEnvFile() });

/**
 * Coordinator Bot アプリケーション全体の起動・シャットダウン制御
 */
class CoordinatorApp {
  private discordBot: DiscordBot | null = null;
  private wsServer: WsServer | null = null;
  private taskManager: TaskManager | null = null;
  private workerRegistry: WorkerRegistry | null = null;

  async start(): Promise<void> {
    console.log("Starting Coordinator Bot...");

    // 環境変数のバリデーション
    const env = this.loadEnv();

    // Worker Registry 初期化
    this.workerRegistry = new WorkerRegistry(env.coordinatorSecret);

    // Task Queue & Manager 初期化
    const queue = new TaskQueue();
    this.taskManager = new TaskManager(queue, this.workerRegistry);

    // Worker切断時のコールバック設定
    this.workerRegistry.onWorkerDisconnected = async (
      workerId: string,
      hadRunningTask: boolean
    ) => {
      if (hadRunningTask) {
        await this.taskManager!.handleWorkerDisconnect(workerId);
      }
    };

    // WebSocket サーバー起動
    const wsConfig: WsServerConfig = {
      port: env.wsPort,
    };
    this.wsServer = new WsServer(wsConfig, this.workerRegistry, this.taskManager);
    await this.wsServer.start();

    // Project Alias Manager 初期化
    const aliasFilePath = path.join(process.cwd(), "data", "aliases.json");
    const aliasManager = new ProjectAliasManager(aliasFilePath);

    // Discord Bot 起動
    const botConfig: DiscordBotConfig = {
      token: env.discordToken,
      guildId: env.guildId,
      allowedUserIds: env.allowedUserIds,
      statusChannelId: env.channelStatus,
      workersChannelId: env.channelWorkers,
      tokenUsageChannelId: env.channelTokenUsage,
    };
    this.discordBot = new DiscordBot(
      botConfig,
      this.taskManager,
      this.workerRegistry,
      aliasManager
    );
    await this.discordBot.start();

    console.log("Coordinator Bot started successfully");
  }

  async stop(): Promise<void> {
    console.log("Stopping Coordinator Bot...");

    if (this.discordBot) {
      await this.discordBot.stop();
    }
    if (this.wsServer) {
      await this.wsServer.stop();
    }
    if (this.workerRegistry) {
      this.workerRegistry.destroy();
    }
    if (this.taskManager) {
      this.taskManager.destroy();
    }

    console.log("Coordinator Bot stopped");
  }

  private loadEnv(): EnvConfig {
    const discordToken = process.env.DISCORD_BOT_TOKEN;
    if (!discordToken) throw new Error("DISCORD_BOT_TOKEN is required");

    const guildId = process.env.GUILD_ID;
    if (!guildId) throw new Error("GUILD_ID is required");

    const allowedUserIdsRaw = process.env.ALLOWED_USER_IDS;
    if (!allowedUserIdsRaw) throw new Error("ALLOWED_USER_IDS is required");
    const allowedUserIds = allowedUserIdsRaw.split(",").map((id) => id.trim());

    const channelStatus = process.env.CHANNEL_STATUS;
    if (!channelStatus) throw new Error("CHANNEL_STATUS is required");

    const channelWorkers = process.env.CHANNEL_WORKERS;
    if (!channelWorkers) throw new Error("CHANNEL_WORKERS is required");

    const wsPort = parseInt(process.env.WS_PORT ?? "8765", 10);

    const coordinatorSecret = process.env.COORDINATOR_SECRET;
    if (!coordinatorSecret)
      throw new Error("COORDINATOR_SECRET is required");

    // オプショナル: #token-usage チャンネル
    const channelTokenUsage = process.env.CHANNEL_TOKEN_USAGE ?? undefined;

    return {
      discordToken,
      guildId,
      allowedUserIds,
      channelStatus,
      channelWorkers,
      wsPort,
      coordinatorSecret,
      channelTokenUsage,
    };
  }
}

interface EnvConfig {
  discordToken: string;
  guildId: string;
  allowedUserIds: string[];
  channelStatus: string;
  channelWorkers: string;
  wsPort: number;
  coordinatorSecret: string;
  channelTokenUsage?: string;
}

// --- Application entry point ---

const app = new CoordinatorApp();

app.start().catch((error) => {
  console.error("Failed to start Coordinator Bot:", error);
  process.exit(1);
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`Received ${signal}`);
  try {
    await app.stop();
  } catch (error) {
    console.error("Error during shutdown:", error);
  }
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
