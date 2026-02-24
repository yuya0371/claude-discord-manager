import { EmbedBuilder, Colors } from "discord.js";
import {
  Task,
  TaskStatus,
  WorkerInfo,
  WorkerStatus,
  DISCORD_EMBED_MAX_LENGTH,
} from "@claude-discord/common";

/**
 * タスクステータスのEmbed生成ヘルパー
 */
export function buildTaskEmbed(task: Task): EmbedBuilder {
  const embed = new EmbedBuilder();

  // ステータスに応じた色とタイトル
  switch (task.status) {
    case TaskStatus.Queued:
      embed.setColor(Colors.Yellow);
      embed.setTitle(`[Queued] Task ${task.id}`);
      break;
    case TaskStatus.Running:
      embed.setColor(Colors.Blue);
      embed.setTitle(`[Running] Task ${task.id}`);
      break;
    case TaskStatus.Completed:
      embed.setColor(Colors.Green);
      embed.setTitle(`[Completed] Task ${task.id}`);
      break;
    case TaskStatus.Failed:
      embed.setColor(Colors.Red);
      embed.setTitle(`[Failed] Task ${task.id}`);
      break;
    case TaskStatus.Cancelled:
      embed.setColor(Colors.Grey);
      embed.setTitle(`[Cancelled] Task ${task.id}`);
      break;
  }

  // プロンプト（最大200文字で切り詰め）
  const promptDisplay =
    task.prompt.length > 200
      ? task.prompt.substring(0, 200) + "..."
      : task.prompt;
  embed.addFields({ name: "Prompt", value: promptDisplay });

  // Worker
  if (task.workerId) {
    embed.addFields({
      name: "Worker",
      value: task.workerId,
      inline: true,
    });
  }

  // 権限モード
  embed.addFields({
    name: "Mode",
    value: task.permissionMode,
    inline: true,
  });

  // ツール履歴（最新10件）
  if (task.toolHistory.length > 0) {
    const recentTools = task.toolHistory.slice(-10);
    const toolLines = recentTools.map((t) => {
      const statusIcon =
        t.status === "running"
          ? "..."
          : t.status === "completed"
            ? "ok"
            : "err";
      return `[${statusIcon}] ${t.summary}`;
    });
    const toolText = toolLines.join("\n");
    const truncated =
      toolText.length > 1024
        ? toolText.substring(0, 1021) + "..."
        : toolText;
    embed.addFields({ name: "Tools", value: "```\n" + truncated + "\n```" });
  }

  // 結果テキスト（ステータスがcompleted/failedの場合）
  if (task.status === TaskStatus.Completed && task.resultText) {
    const resultDisplay = truncateText(task.resultText, 1024);
    embed.addFields({ name: "Result", value: resultDisplay });
  }

  if (task.status === TaskStatus.Failed && task.errorMessage) {
    embed.addFields({ name: "Error", value: task.errorMessage });
  }

  // トークン使用量
  if (
    task.tokenUsage.inputTokens > 0 ||
    task.tokenUsage.outputTokens > 0
  ) {
    const tokenText =
      `In: ${task.tokenUsage.inputTokens.toLocaleString()} | ` +
      `Out: ${task.tokenUsage.outputTokens.toLocaleString()}`;
    embed.addFields({ name: "Tokens", value: tokenText, inline: true });
  }

  // 時間情報
  if (task.startedAt && task.completedAt) {
    const durationMs = task.completedAt - task.startedAt;
    const durationSec = Math.round(durationMs / 1000);
    embed.addFields({
      name: "Duration",
      value: `${durationSec}s`,
      inline: true,
    });
  }

  embed.setTimestamp(task.createdAt);
  embed.setFooter({ text: `Requested by ${task.requestedBy}` });

  return embed;
}

/**
 * Worker一覧のEmbed生成
 */
export function buildWorkersEmbed(workers: WorkerInfo[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("Worker List");

  if (workers.length === 0) {
    embed.setDescription("No workers connected.");
    return embed;
  }

  const lines: string[] = [];
  for (const w of workers) {
    const statusIcon =
      w.status === WorkerStatus.Online
        ? "[ONLINE]"
        : w.status === WorkerStatus.Busy
          ? "[BUSY]"
          : "[OFFLINE]";

    lines.push(`${statusIcon} ${w.name}`);
    lines.push(`  OS: ${w.os} | Node: ${w.nodeVersion}`);
    lines.push(`  Claude CLI: ${w.claudeCliVersion}`);

    if (w.currentTaskId) {
      lines.push(`  Task: ${w.currentTaskId}`);
    }

    const connectedAgo = formatDuration(Date.now() - w.connectedAt);
    lines.push(`  Connected: ${connectedAgo} ago`);
    lines.push("");
  }

  const onlineCount = workers.filter(
    (w) => w.status !== WorkerStatus.Offline
  ).length;
  lines.push(`Total: ${workers.length} (Online: ${onlineCount})`);

  const description = lines.join("\n");
  embed.setDescription(
    "```\n" + truncateText(description, DISCORD_EMBED_MAX_LENGTH - 10) + "\n```"
  );

  return embed;
}

/**
 * テキストを指定長に切り詰め
 */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + "...";
}

/**
 * ミリ秒を人間が読める時間文字列に変換
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
