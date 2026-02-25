import { EmbedBuilder, Colors } from "discord.js";
import {
  Task,
  TaskStatus,
  TokenUsage,
  TokenUsageRecord,
  WorkerInfo,
  WorkerStatus,
  TeamInfo,
  DISCORD_EMBED_MAX_LENGTH,
  DISCORD_MESSAGE_MAX_LENGTH,
} from "@claude-discord/common";
import {
  TokenSummary,
  WorkerTokenSummary,
} from "../token/tracker.js";

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

  // セッションID（継続可能な場合のみ表示）
  if (task.sessionId && task.status === TaskStatus.Completed) {
    embed.addFields({
      name: "Session",
      value: `\`${task.sessionId.substring(0, 16)}...\` (use \`continue: True\` to resume)`,
      inline: true,
    });
  }

  embed.setTimestamp(task.createdAt);
  embed.setFooter({ text: `Requested by ${task.requestedBy}` });

  return embed;
}

/**
 * Worker一覧のEmbed生成（強化版）
 */
export function buildWorkersEmbed(workers: WorkerInfo[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("Worker List")
    .setTimestamp();

  if (workers.length === 0) {
    embed.setDescription("No workers connected.");
    return embed;
  }

  const now = Date.now();
  for (const w of workers) {
    const statusIcon =
      w.status === WorkerStatus.Online
        ? "ONLINE"
        : w.status === WorkerStatus.Busy
          ? "BUSY"
          : "OFFLINE";

    const connectedAgo = formatDuration(now - w.connectedAt);
    const heartbeatAgo = formatDuration(now - w.lastHeartbeat);
    const heartbeatStatus = (now - w.lastHeartbeat) > 60_000 ? " (stale)" : "";

    const infoLines: string[] = [
      `Status: **${statusIcon}**`,
      `OS: ${w.os} | Node: ${w.nodeVersion} | CLI: ${w.claudeCliVersion}`,
      `Connected: ${connectedAgo} ago | Heartbeat: ${heartbeatAgo} ago${heartbeatStatus}`,
    ];

    if (w.currentTaskId) {
      infoLines.push(`Current Task: **${w.currentTaskId}**`);
    }

    if (w.allowedDirs.length > 0) {
      infoLines.push(`Dirs: ${w.allowedDirs.join(", ")}`);
    }

    embed.addFields({
      name: `[${statusIcon}] ${w.name}`,
      value: infoLines.join("\n"),
    });
  }

  const onlineCount = workers.filter(
    (w) => w.status === WorkerStatus.Online
  ).length;
  const busyCount = workers.filter(
    (w) => w.status === WorkerStatus.Busy
  ).length;

  embed.setFooter({
    text: `Total: ${workers.length} | Online: ${onlineCount} | Busy: ${busyCount}`,
  });

  return embed;
}

/**
 * ステータスサマリーEmbed生成（ピン留め用の定期更新メッセージ）
 */
export function buildStatusSummaryEmbed(
  workers: WorkerInfo[],
  runningTasks: Task[],
  queuedTasks: Task[]
): EmbedBuilder {
  const now = Date.now();

  const onlineCount = workers.filter(
    (w) => w.status === WorkerStatus.Online
  ).length;
  const busyCount = workers.filter(
    (w) => w.status === WorkerStatus.Busy
  ).length;

  // 全体ステータスに応じた色
  let color: number;
  if (workers.length === 0) {
    color = Colors.Grey;
  } else if (queuedTasks.length > 0 && onlineCount === 0) {
    color = Colors.Red; // キューにタスクがあるが利用可能なWorkerがない
  } else if (busyCount > 0) {
    color = Colors.Blue; // 実行中
  } else {
    color = Colors.Green; // アイドル
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("System Status")
    .setTimestamp();

  // Workers セクション
  if (workers.length === 0) {
    embed.addFields({
      name: "Workers",
      value: "No workers connected.",
    });
  } else {
    const workerLines: string[] = [];
    for (const w of workers) {
      const icon =
        w.status === WorkerStatus.Online
          ? "[ OK ]"
          : w.status === WorkerStatus.Busy
            ? "[BUSY]"
            : "[OFF ]";
      const taskInfo = w.currentTaskId ? ` -> ${w.currentTaskId}` : "";
      workerLines.push(`${icon} ${w.name}${taskInfo}`);
    }
    embed.addFields({
      name: `Workers (${onlineCount} online, ${busyCount} busy)`,
      value: "```\n" + workerLines.join("\n") + "\n```",
    });
  }

  // Running Tasks セクション
  if (runningTasks.length > 0) {
    const taskLines = runningTasks.map((t) => {
      const elapsed = formatDuration(now - (t.startedAt ?? t.createdAt));
      const promptShort = t.prompt.substring(0, 40) + (t.prompt.length > 40 ? "..." : "");
      return `${t.id} (${elapsed}) ${promptShort}`;
    });
    embed.addFields({
      name: `Running Tasks (${runningTasks.length})`,
      value: "```\n" + truncateText(taskLines.join("\n"), 1018) + "\n```",
    });
  }

  // Queued Tasks セクション
  if (queuedTasks.length > 0) {
    const queueLines = queuedTasks.slice(0, 10).map((t, i) => {
      const promptShort = t.prompt.substring(0, 40) + (t.prompt.length > 40 ? "..." : "");
      return `#${i + 1} ${t.id}: ${promptShort}`;
    });
    if (queuedTasks.length > 10) {
      queueLines.push(`... and ${queuedTasks.length - 10} more`);
    }
    embed.addFields({
      name: `Queue (${queuedTasks.length})`,
      value: "```\n" + truncateText(queueLines.join("\n"), 1018) + "\n```",
    });
  }

  if (runningTasks.length === 0 && queuedTasks.length === 0) {
    embed.addFields({
      name: "Tasks",
      value: "No active tasks.",
    });
  }

  embed.setFooter({
    text: `Last updated`,
  });

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
        name: "/alias",
        value: [
          "プロジェクトエイリアスを管理します。",
          "`/alias add name:<名前> path:<パス> [worker:<Worker名>]`",
          "`/alias remove name:<名前>`",
          "`/alias list`",
        ].join("\n"),
      },
      {
        name: "/token",
        value: [
          "トークン使用量を表示します。",
          "`view`: summary (既定) / detail / worker",
        ].join("\n"),
      },
      {
        name: "/teams",
        value: "アクティブなAgent Teamsの一覧を表示します。",
      },
      {
        name: "/notify",
        value: [
          "通知レベルを設定します。",
          "`level` (必須): all / important / none",
          "**all**: 全イベントで@メンション",
          "**important** (default): エラー・質問のみ@メンション",
          "**none**: @メンションなし",
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

/**
 * トークン数を見やすくフォーマットする (例: 1,234 or 1.2M)
 */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  return count.toLocaleString();
}

// ─── Token Usage Embeds ───

/**
 * 今日のトークン使用量サマリーEmbed生成
 */
export function buildTokenSummaryEmbed(
  todaySummary: TokenSummary,
  cumulativeSummary: TokenSummary
): EmbedBuilder {
  const today = new Date();
  const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}`;

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("Token Usage Summary")
    .setDescription(`Date: **${dateStr}**`)
    .setTimestamp();

  const todayTotal =
    todaySummary.totalInput + todaySummary.totalOutput;

  embed.addFields(
    {
      name: "Today",
      value: [
        `Tasks: **${todaySummary.taskCount}**`,
        `Total: **${formatTokenCount(todayTotal)}** tokens`,
        `Input: ${formatTokenCount(todaySummary.totalInput)}`,
        `Output: ${formatTokenCount(todaySummary.totalOutput)}`,
        `Cache Read: ${formatTokenCount(todaySummary.totalCacheRead)}`,
        `Cache Write: ${formatTokenCount(todaySummary.totalCacheWrite)}`,
      ].join("\n"),
    },
    {
      name: "Cumulative",
      value: [
        `Tasks: **${cumulativeSummary.taskCount}**`,
        `Total: **${formatTokenCount(cumulativeSummary.totalInput + cumulativeSummary.totalOutput)}** tokens`,
        `Input: ${formatTokenCount(cumulativeSummary.totalInput)}`,
        `Output: ${formatTokenCount(cumulativeSummary.totalOutput)}`,
      ].join("\n"),
    }
  );

  return embed;
}

/**
 * タスク別トークン使用量詳細Embed生成
 */
export function buildTokenDetailEmbed(
  records: TokenUsageRecord[]
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("Token Usage - Task Detail")
    .setTimestamp();

  if (records.length === 0) {
    embed.setDescription("No token usage records for today.");
    return embed;
  }

  // 最新20件を表示
  const recentRecords = records.slice(-20);
  const lines: string[] = [];

  for (const r of recentRecords) {
    const total = r.usage.inputTokens + r.usage.outputTokens;
    const time = new Date(r.timestamp);
    const timeStr = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
    lines.push(
      `\`${timeStr}\` **${r.taskId}** (${r.workerId}): ${formatTokenCount(total)} [In:${formatTokenCount(r.usage.inputTokens)} Out:${formatTokenCount(r.usage.outputTokens)}]`
    );
  }

  if (records.length > 20) {
    lines.unshift(`_Showing latest 20 of ${records.length} records_\n`);
  }

  embed.setDescription(truncateText(lines.join("\n"), 4096));

  return embed;
}

/**
 * Worker別トークン使用量Embed生成
 */
export function buildTokenWorkerEmbed(
  workerSummaries: WorkerTokenSummary[]
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle("Token Usage - By Worker")
    .setTimestamp();

  if (workerSummaries.length === 0) {
    embed.setDescription("No token usage records for today.");
    return embed;
  }

  for (const ws of workerSummaries) {
    const total = ws.summary.totalInput + ws.summary.totalOutput;
    embed.addFields({
      name: ws.workerId,
      value: [
        `Tasks: **${ws.summary.taskCount}** | Total: **${formatTokenCount(total)}**`,
        `Input: ${formatTokenCount(ws.summary.totalInput)} | Output: ${formatTokenCount(ws.summary.totalOutput)}`,
        `Cache Read: ${formatTokenCount(ws.summary.totalCacheRead)} | Cache Write: ${formatTokenCount(ws.summary.totalCacheWrite)}`,
      ].join("\n"),
    });
  }

  return embed;
}

/**
 * タスク完了時のトークン使用量通知Embed生成
 */
export function buildTokenUsageNotificationEmbed(
  taskId: string,
  workerId: string,
  usage: TokenUsage,
  prompt: string
): EmbedBuilder {
  const total = usage.inputTokens + usage.outputTokens;
  const promptDisplay =
    prompt.length > 100 ? prompt.substring(0, 100) + "..." : prompt;

  return new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`Token Usage - ${taskId}`)
    .setDescription(promptDisplay)
    .addFields(
      {
        name: "Total",
        value: `**${formatTokenCount(total)}** tokens`,
        inline: true,
      },
      {
        name: "Worker",
        value: workerId,
        inline: true,
      },
      {
        name: "Breakdown",
        value: [
          `Input: ${formatTokenCount(usage.inputTokens)}`,
          `Output: ${formatTokenCount(usage.outputTokens)}`,
          `Cache Read: ${formatTokenCount(usage.cacheReadTokens)}`,
          `Cache Write: ${formatTokenCount(usage.cacheWriteTokens)}`,
        ].join("\n"),
      }
    )
    .setTimestamp();
}

// ─── Team Embeds ───

/**
 * チーム更新通知のEmbed生成
 */
export function buildTeamUpdateEmbed(teamInfo: TeamInfo): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle(`[Team] ${teamInfo.teamName}`)
    .setTimestamp();

  // メンバー一覧
  if (teamInfo.members.length > 0) {
    const memberLines = teamInfo.members.map((m) => {
      const statusIcon =
        m.status === "active" ? "[ACT]" : m.status === "idle" ? "[IDL]" : "[OFF]";
      return `${statusIcon} ${m.name} (${m.agentType})`;
    });
    embed.addFields({
      name: `Members (${teamInfo.members.length})`,
      value: "```\n" + truncateText(memberLines.join("\n"), 1018) + "\n```",
    });
  }

  // タスク一覧
  if (teamInfo.tasks.length > 0) {
    const taskLines = teamInfo.tasks.slice(0, 15).map((t) => {
      const statusIcon =
        t.status === "completed"
          ? "[DONE]"
          : t.status === "in_progress"
            ? "[RUN ]"
            : "[WAIT]";
      const owner = t.owner ? ` (${t.owner})` : "";
      return `${statusIcon} ${t.subject}${owner}`;
    });
    if (teamInfo.tasks.length > 15) {
      taskLines.push(`... and ${teamInfo.tasks.length - 15} more`);
    }
    embed.addFields({
      name: `Tasks (${teamInfo.tasks.length})`,
      value: "```\n" + truncateText(taskLines.join("\n"), 1018) + "\n```",
    });
  }

  // 最近のメッセージ（最新5件）
  if (teamInfo.recentMessages.length > 0) {
    const msgLines = teamInfo.recentMessages.slice(-5).map((m) => {
      const summaryShort =
        m.summary.length > 60
          ? m.summary.substring(0, 60) + "..."
          : m.summary;
      return `**${m.from}** -> **${m.to}**: ${summaryShort}`;
    });
    embed.addFields({
      name: "Recent Messages",
      value: truncateText(msgLines.join("\n"), 1024),
    });
  }

  embed.setFooter({ text: `Worker: ${teamInfo.workerId}` });

  return embed;
}

/**
 * アクティブチーム一覧のEmbed生成（/teams コマンド用）
 */
export function buildTeamsListEmbed(teams: TeamInfo[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle("Active Teams")
    .setTimestamp();

  if (teams.length === 0) {
    embed.setDescription("No active teams.");
    return embed;
  }

  for (const team of teams) {
    const memberNames = team.members.map((m) => m.name).join(", ");
    const runningTasks = team.tasks.filter((t) => t.status === "in_progress").length;
    const totalTasks = team.tasks.length;
    const completedTasks = team.tasks.filter((t) => t.status === "completed").length;

    embed.addFields({
      name: team.teamName,
      value: [
        `Worker: **${team.workerId}**`,
        `Members: ${memberNames || "none"}`,
        `Tasks: ${completedTasks}/${totalTasks} completed (${runningTasks} running)`,
      ].join("\n"),
    });
  }

  embed.setFooter({ text: `Total: ${teams.length} team(s)` });

  return embed;
}
