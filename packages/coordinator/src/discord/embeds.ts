import { EmbedBuilder, Colors } from "discord.js";
import {
  Task,
  TaskStatus,
  WorkerInfo,
  WorkerStatus,
  DISCORD_EMBED_MAX_LENGTH,
  DISCORD_MESSAGE_MAX_LENGTH,
} from "@claude-discord/common";

/** 長文判定の閾値 */
const LONG_TEXT_THRESHOLD = DISCORD_MESSAGE_MAX_LENGTH;
/** Embedの要約表示文字数 */
const SUMMARY_LENGTH = 500;

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
    if (task.resultText.length > LONG_TEXT_THRESHOLD) {
      // 長文: 要約表示 + スレッド案内
      const summary = task.resultText.substring(0, SUMMARY_LENGTH) + "...";
      const note = task.discordThreadId
        ? "\n\n_Full output available in thread below._"
        : "";
      embed.addFields({
        name: "Result (summary)",
        value: truncateText(summary + note, 1024),
      });
    } else {
      embed.addFields({
        name: "Result",
        value: truncateText(task.resultText, 1024),
      });
    }
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
 * Worker接続通知のEmbed生成
 */
export function buildWorkerConnectedEmbed(worker: WorkerInfo): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(`[Connected] ${worker.name}`)
    .addFields(
      { name: "OS", value: worker.os, inline: true },
      { name: "Node.js", value: worker.nodeVersion, inline: true },
      { name: "Claude CLI", value: worker.claudeCliVersion, inline: true },
      { name: "Default CWD", value: worker.defaultCwd }
    )
    .setTimestamp();
}

/**
 * Worker切断通知のEmbed生成
 */
export function buildWorkerDisconnectedEmbed(
  workerName: string,
  reason: string
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(`[Disconnected] ${workerName}`)
    .addFields({ name: "Reason", value: reason })
    .setTimestamp();
}

/**
 * /help コマンドのEmbed生成
 */
export function buildHelpEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("Claude Code Discord Manager - Help")
    .setDescription("Discord から Claude Code CLI をリモート操作するBotです。")
    .addFields(
      {
        name: "/task",
        value: [
          "Claudeにタスクを依頼します。",
          "`prompt` (必須): プロンプト",
          "`worker`: 実行先Worker名",
          "`directory`: 作業ディレクトリ",
          "`mode`: 権限モード (acceptEdits / auto / confirm)",
          "`team`: Agent Teamsモードで実行",
          "`continue`: 前回セッションを継続",
          "`attachment`: 添付ファイル（8MB以下）",
        ].join("\n"),
      },
      {
        name: "/workers",
        value: "接続中のWorker一覧と状態を表示します。",
      },
      {
        name: "/status",
        value: [
          "タスクの状態を表示します。",
          "`task_id`: 特定タスクの詳細を表示（省略時は一覧）",
        ].join("\n"),
      },
      {
        name: "/cancel",
        value: [
          "実行中またはキュー内のタスクをキャンセルします。",
          "`task_id` (必須): キャンセルするタスクID",
        ].join("\n"),
      },
      {
        name: "/help",
        value: "このヘルプメッセージを表示します。",
      },
      {
        name: "権限モード",
        value: [
          "**acceptEdits** (default): ファイル編集は自動許可、Bash実行はDiscordで確認",
          "**auto**: 全操作を自動許可",
          "**confirm**: 全操作をDiscordで確認",
        ].join("\n"),
      }
    )
    .setTimestamp();
}

/**
 * 結果テキストが長文か判定する
 */
export function isLongResult(text: string | null): boolean {
  if (!text) return false;
  return text.length > LONG_TEXT_THRESHOLD;
}

/**
 * 長文テキストをDiscordメッセージの最大長に合わせて分割する
 * コードブロック内で分割されないよう考慮する
 */
export function splitTextForDiscord(text: string): string[] {
  const maxLen = DISCORD_MESSAGE_MAX_LENGTH;
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // 改行位置で分割を試みる
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0 || splitAt < maxLen * 0.5) {
      // 改行が見つからないか遠すぎる場合はmaxLenで切る
      splitAt = maxLen;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
    // 先頭の改行を除去
    if (remaining.startsWith("\n")) {
      remaining = remaining.substring(1);
    }
  }

  return chunks;
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
